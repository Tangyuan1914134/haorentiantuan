import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

function listen(server) {
  return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
}
function stop(server) {return new Promise(resolve=>server.close(resolve));}

let generationRequests=0;
let editRequests=0;
const upstream=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const send=data=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  if(req.method==='POST' && url.pathname==='/v1/images/generations'){
    generationRequests++;
    const chunks=[];for await(const b of req) chunks.push(b);
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.ok(data.prompt);
    assert.equal(url.searchParams.get('async'),'true');
    if(data.prompt.includes('delayed-sync')){
      await new Promise(resolve=>setTimeout(resolve,1200));
      return send({data:[{b64_json:'aGVsbG8='}]});
    }
    return send({status:'queued',task_id:data.prompt.includes('slow')?'slow':'gen1'});
  }
  if(req.method==='POST' && url.pathname==='/v1/images/edits'){
    editRequests++;
    const chunks=[];for await(const b of req) chunks.push(b);
    assert.match(req.headers['content-type'],/multipart\/form-data/);
    return send({status:'queued',task_id:'edit1'});
  }
  if(url.pathname==='/api/image-tasks'){
    if(url.searchParams.get('ids')==='slow')return send({status:'processing',task_id:'slow'});
    return send({status:'completed',data:[{b64_json:'aGVsbG8='}]});
  }
  res.writeHead(404);res.end();
});
const upstreamPort=await listen(upstream);
process.env.NODE_ENV='test';
process.env.PORT='9099';
process.env.IMAGE_API_KEY='test-token';
process.env.API_BASE_URL='http://127.0.0.1:'+upstreamPort+'/v1';
process.env.IMAGE_ASYNC='true';
delete process.env.UPSTREAM_SUBMIT_TIMEOUT_SECONDS;
const app=await import('../server.mjs');
const appPort=await listen(app.server);
const base='http://127.0.0.1:'+appPort;
const json=(path,options)=>fetch(base+path,options).then(async r=>({status:r.status,cookie:r.headers.get('set-cookie'),data:await r.json()}));
let cookie='';
test.after(async()=>{await stop(app.server);await stop(upstream);});
test('解析同步图片、异步任务与失败',()=>{
  assert.equal(app.SUBMIT_TIMEOUT,240_000);
  assert.equal(app.parseUpstream({data:[{b64_json:'abcd'}]}).kind,'done');
  assert.equal(app.parseUpstream({task_id:'t1',status:'queued'}).kind,'async');
  assert.equal(app.parseUpstream({status:'failed',error:{message:'bad'}}).kind,'error');
});
test('兼容中转站嵌套和 camelCase 任务响应',()=>{
  assert.deepEqual(app.parseUpstream({success:true,data:{taskId:'nested-task',status:'queued'}}),{kind:'async',id:'nested-task',status:'queued'});
  assert.deepEqual(app.parseUpstream({code:0,data:{task:{id:'inner-task',state:'in_progress'}}}),{kind:'async',id:'inner-task',status:'in_progress'});
  const result=app.parseUpstream({success:true,data:{result:{data:[{url:'https://cdn.example.test/result.png'}]}}});
  assert.equal(result.kind,'done');
  assert.deepEqual(result.images,['https://cdn.example.test/result.png']);
  const failed=app.parseUpstream({data:{task:{taskId:'bad-task',status:'failed',fail_reason:'model overloaded'}}});
  assert.equal(failed.kind,'error');
  assert.match(failed.message,/model overloaded/);
});
test('首页、健康检查、匿名 cookie、无敏感配置输出',async()=>{
  const page=await fetch(base+'/');assert.equal(page.status,200);
  assert.match(await page.text(),/好人天团/);
  assert.equal((await fetch(base+'/styles.css')).status,200);
  assert.equal((await fetch(base+'/app.js')).status,200);
  const health=await json('/api/health');assert.equal(health.status,200);
  assert.equal(health.data.storage,'memory-only');
  cookie=health.cookie.split(';')[0];
  const config=await json('/api/config',{headers:{Cookie:cookie}});
  assert.equal(config.data.configured,true);
  assert.equal(JSON.stringify(config.data).includes('test-token'),false);
});
const post = (prompt,images=[])=>json('/api/jobs',{method:'POST',headers:{'content-type':'application/json',Cookie:cookie},body:JSON.stringify({prompt,options:{model:'gpt-image-2.5-sunburst',count:1},images})});
async function waitFor(id){
  for(let n=0;n<25;n++){
    const r=await json('/api/jobs/'+id,{headers:{Cookie:cookie}});
    if(['succeeded','failed','cancelled'].includes(r.data?.job?.status))return r.data.job;
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw Error('Timeout waiting on task '+id);
}
test('文本生成：入队、异步轮询、内存结果与访客隔离',async()=>{
  const p=await post('画一只橘猫');
  assert.equal(p.status,202);
  const id=p.data.job.id;
  const busy=await post('同时提交第二个');assert.equal(busy.status,429);
  const someone=await json('/api/jobs/'+id);assert.equal(someone.status,404);
  const result=await waitFor(id);
  assert.equal(result.status,'succeeded');
  assert.equal(result.images.length,1);
  assert.match(result.images[0],/^data:image\/png;base64,/);
  assert.equal(generationRequests,1);
});
test('上游忽略 async 参数、延迟后直接返回图片时仍成功',async()=>{
  const p=await post('delayed-sync kitten');
  assert.equal(p.status,202);
  const result=await waitFor(p.data.job.id);
  assert.equal(result.status,'succeeded');
  assert.equal(result.images.length,1);
  assert.ok(result.submitMs>=1000);
  assert.equal(result.polls,0);
});
test('参考图编辑通过 multipart 发送到上游',async()=>{
  const p=await post('把背景换成蓝色',['data:image/png;base64,aGVsbG8=']);
  assert.equal(p.status,202);
  const result=await waitFor(p.data.job.id);
  assert.equal(result.status,'succeeded');
  assert.equal(editRequests,1);
});
test('取消长期运行任务',async()=>{
  const p=await post('slow request');
  assert.equal(p.status,202);
  const id=p.data.job.id;
  const cancel=await json('/api/jobs/'+id+'/cancel',{method:'POST',headers:{Cookie:cookie}});
  assert.equal(cancel.data.job.status,'cancelled');
  const view=await json('/api/jobs/'+id,{headers:{Cookie:cookie}});
  assert.equal(view.data.job.status,'cancelled');
});
