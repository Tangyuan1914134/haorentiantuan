import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const LIMIT = (name, fallback, max) => Math.max(1, Math.min(max, Number.parseInt(process.env[name] || '', 10) || fallback));
const PORT = LIMIT('PORT', 9090, 65535);
const HOST = '0.0.0.0';
const MAX_CONCURRENT = LIMIT('MAX_CONCURRENT', 3, 10);
const MAX_QUEUED = LIMIT('MAX_QUEUED', 30, 200);
const MAX_IMAGES = 5;
const JOB_TTL = 15 * 60 * 1000;
const API_BASE_URL = (process.env.API_BASE_URL || 'https://image.mlgb7.com/v1').replace(/\/+$/, '');
const API_KEY = process.env.IMAGE_API_KEY || '';
const API_ASYNC = process.env.IMAGE_ASYNC !== 'false';
const MAX_UPSTREAM_WAIT = LIMIT('MAX_UPSTREAM_WAIT_SECONDS', 540, 600) * 1000;
const COMPLETED_WITHOUT_IMAGES_RETRIES = LIMIT('COMPLETED_WITHOUT_IMAGES_RETRIES', 12, 30);
// Some gateways ignore async=true and return generated images directly after 60+ seconds.
// Keep the upstream POST alive without blocking the browser's own queued-job request.
const SUBMIT_TIMEOUT = LIMIT('UPSTREAM_SUBMIT_TIMEOUT_SECONDS', 240, 600) * 1000;
const POLL_TIMEOUT = LIMIT('UPSTREAM_POLL_TIMEOUT_SECONDS', 20, 90) * 1000;
const MODELS = (process.env.IMAGE_MODELS || 'gpt-image-2.5-sunburst,gpt-image-2.5-flare,gpt-image-2.5').split(',').map(s => s.trim()).filter(Boolean);
const RATIOS = ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'];
const QUALITY = ['auto','low','medium','high'];
const ALLOWED_IMAGE_HOSTS = new Set([new URL(API_BASE_URL).hostname, ...(process.env.IMAGE_ALLOWED_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean)]);
const SIGNING_SECRET = randomBytes(32).toString('hex'); // In-memory session identity; not persisted.
const jobs = new Map();
const waiting = [];
const ownerBusy = new Set();
let running = 0;
let completed = 0;
let failed = 0;

function json(res, status, body, headers={}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});
  res.end(data);
}
const failure = (res, status, message) => json(res,status,{error:message});

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c=>c.trim()).filter(Boolean).map(c => {
    const i=c.indexOf('='); return i<0 ? [c,''] : [c.slice(0,i),c.slice(i+1)];
  }));
}
function sign(id) {return createHmac('sha256',SIGNING_SECRET).update(id).digest('hex');}
function safeEqual(a,b) {
  const x=Buffer.from(String(a)), y=Buffer.from(String(b));
  return x.length===y.length && timingSafeEqual(x,y);
}
function visitor(req,res) {
  const value=parseCookies(req).hgt;
  if(value) {
    const match=/^([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(value);
    if(match && safeEqual(match[2],sign(match[1]))) return match[1];
  }
  const id=randomBytes(16).toString('hex');
  const secure=req.socket.encrypted || req.headers['x-forwarded-proto']==='https';
  const cookie='hgt='+id+'.'+sign(id)+'; Path=/; HttpOnly; SameSite=Lax'+(secure?'; Secure':'');
  res.setHeader('Set-Cookie',cookie);
  return id;
}
function corsOrigin(req) {
  const origin=req.headers.origin;
  if(!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
async function readJson(req,max=32*1024*1024) {
  if(!(req.headers['content-type']||'').startsWith('application/json')) throw Error('请求必须使用 JSON');
  const chunks=[];let len=0;
  for await(const chunk of req){
    len+=chunk.length;
    if(len>max) throw Error('请求体超过限制（32MB）');
    chunks.push(chunk);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch {throw Error('JSON 格式错误');}
}
function validate(input){
  const prompt=String(input?.prompt||'').trim();
  if(!prompt || prompt.length>4000) throw Error('请输入 1～4000 字的提示词');
  const settings=input?.options||{};
  const model=MODELS.includes(settings.model)?settings.model:MODELS[0];
  const ratio=RATIOS.includes(settings.ratio)?settings.ratio:'auto';
  const quality=QUALITY.includes(settings.quality)?settings.quality:'auto';
  const count=Number(settings.count||1);
  if(!Number.isInteger(count)||count<1||count>4)throw Error('单次最多生成 4 张');
  const images=Array.isArray(input?.images)?input.images:[];
  if(images.length>MAX_IMAGES)throw Error('最多添加 5 张参考图片');
  const files=images.map((item,i)=>{
    const match=/^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/]+={0,2})$/.exec(String(item));
    if(!match)throw Error('参考图片 '+(i+1)+' 必须是 PNG、JPEG 或 WebP');
    const bytes=Buffer.from(match[2],'base64');
    if(!bytes.length||bytes.byteLength>10*1024*1024)throw Error('每张参考图不得超过 10MB');
    return {type:match[1],bytes};
  });
  return {prompt,options:{model,ratio,quality,count},files};
}
function publicJob(job,results=false) {
  return {id:job.id,status:job.status,phase:job.phase||'queued',progress:job.progress,error:job.error,created:job.created,started:job.started,finished:job.finished,polls:job.polls||0,submitMs:job.submitMs||0,position:job.status==='queued'?waiting.indexOf(job.id)+1:0,active:running,waiting:waiting.length,...(results&&job.status==='succeeded'?{images:job.images}: {})};
}
function cleanup(){
  for(const [id,job] of jobs){
    if(['succeeded','failed','cancelled'].includes(job.status)&&Date.now()-job.finished>JOB_TTL) jobs.delete(id);
  }
}
setInterval(cleanup,60_000).unref();

function extractImages(data){
  const out=[];
  const urlKeys=['url','image_url','imageUrl','output_url','outputUrl','result_url','resultUrl','file_url','fileUrl','download_url','downloadUrl','uri'];
  const nestedKeys=['images','data','items','output','outputs','result','results','image','response','task','tasks','payload','content','artifacts','generated_images','generatedImages'];
  const relativeImageContainers=new Set(['images','data','output','outputs','result','results','image','content','artifacts','generated_images','generatedImages']);
  const walk=(x,depth=0,imageContext=false)=>{
    if(depth>8||x==null)return;
    if(typeof x==='string'){
      const value=x.trim();
      if(value.startsWith('data:image/')||/^https:\/\//i.test(value)||(imageContext&&/^\/(?!\/)/.test(value)))out.push(value);
      return;
    }
    if(Array.isArray(x)){for(const v of x)walk(v,depth+1,imageContext);return;}
    if(typeof x!=='object')return;
    if(typeof x.b64_json==='string'&&x.b64_json)out.push('data:image/png;base64,'+x.b64_json);
    if(typeof x.base64==='string'&&x.base64)out.push('data:image/png;base64,'+x.base64);
    for(const key of urlKeys){
      if(typeof x[key]==='string'&&x[key].trim()){
        const imageKey=key!=='url'&&key!=='uri';
        walk(x[key],depth+1,imageContext||imageKey);
      }
    }
    for(const key of nestedKeys){
      if(x[key]!=null)walk(x[key],depth+1,imageContext||relativeImageContainers.has(key));
    }
  };
  walk(data);
  return [...new Set(out)];
}
function parseUpstream(data) {
  const nodes=[];
  const seen=new Set();
  const walk=(value,path='$',depth=0)=>{
    if(!value||typeof value!=='object'||depth>8||seen.has(value))return;
    seen.add(value);
    nodes.push({value,path});
    if(Array.isArray(value)){
      for(let i=0;i<value.length;i++)walk(value[i],path+'['+i+']',depth+1);
      return;
    }
    for(const [key,child] of Object.entries(value)){
      if(child&&typeof child==='object')walk(child,path+'.'+key,depth+1);
    }
  };
  walk(data);
  const statusOf=value=>String(value?.status??value?.state??value?.task_status??value?.taskStatus??'').trim().toLowerCase().replace(/[\s-]+/g,'_');
  const success=new Set(['success','succeeded','completed','complete','done','finished','ready']);
  const pending=new Set(['queued','queue','pending','submitted','processing','in_progress','running','created','waiting','starting','accepted','generating','retrying']);
  const failures=new Set(['error','failed','failure','cancelled','canceled','aborted']);
  const statuses=nodes.map(n=>({ ...n, status:statusOf(n.value) })).filter(n=>n.status);
  const failed= statuses.find(n=>failures.has(n.status));
  if(failed){
    const detail=nodes.find(n=>n.value?.error||n.value?.fail_reason||n.value?.failReason||n.value?.error_message||n.value?.errorMessage);
    const err=detail?.value?.error;
    const message=err?.message||err?.detail||err||detail?.value?.fail_reason||detail?.value?.failReason||detail?.value?.error_message||detail?.value?.errorMessage||detail?.value?.message||failed.value?.message||'上游任务失败';
    return {kind:'error',message:String(message).slice(0,350)};
  }
  const images=extractImages(data);
  const pendingStatus=statuses.find(n=>pending.has(n.status));
  const terminalSuccess=statuses.find(n=>success.has(n.status));
  if(images.length&&(terminalSuccess||!pendingStatus))return {kind:'done',images};
  const explicitIdKeys=['task_id','taskId','taskID','job_id','jobId','request_id','requestId','task_uuid','taskUuid'];
  let taskId=null;
  for(const {value} of nodes){
    for(const key of explicitIdKeys){
      const candidate=value?.[key];
      if((typeof candidate==='string'||typeof candidate==='number')&&String(candidate).trim()){
        taskId=String(candidate);break;
      }
    }
    if(taskId)break;
  }
  if(!taskId){
    const withIdAndStatus=nodes.find(({value})=>{
      const id=value?.id;
      return (typeof id==='string'||typeof id==='number')&&String(id).trim()&&statusOf(value);
    });
    if(withIdAndStatus)taskId=String(withIdAndStatus.value.id);
  }
  if(taskId){
    if(terminalSuccess&&!images.length)return {kind:'pending',id:taskId,status:'completed-without-images'};
    return {kind:'async',id:taskId,status:pendingStatus?.status||statuses[0]?.status||''};
  }
  if(images.length)return {kind:'done',images};
  if(pendingStatus)return {kind:'pending',status:pendingStatus.status};
  const shape=nodes.filter(n=>!Array.isArray(n.value)).slice(0,5).map(({value,path})=>path+'['+Object.keys(value).slice(0,7).join(',')+']').join(' → ');
  return {kind:'error',message:'无法识别中转站返回的任务格式。响应字段：'+(shape||'空响应')+'。请核对上游异步 API 格式'};
}
async function requestJson(url,options){
  const response=await fetch(url,options);
  const txt=await response.text();
  let data;
  try {data=JSON.parse(txt);}catch {throw Error('上游返回 HTTP '+response.status+'（非 JSON）。'+(response.status===524?'中转站等待模型超时，建议使用支持异步任务的线路。':'请检查中转站状态。'));}
  if(!response.ok)throw Error('上游 HTTP '+response.status+'：'+String(data?.error?.message||data?.message||'请求失败').slice(0,180));
  return data;
}
// Every network request has its own deadline, in addition to the task's overall deadline.
// Never expose the Authorization header, prompts, images, or upstream response body in logs.
async function requestTimed(url,options,timeoutMs,label){
  const timeout=AbortSignal.timeout(timeoutMs);
  const linked=options.signal ? AbortSignal.any([options.signal,timeout]) : timeout;
  try{return await requestJson(url,{...options,signal:linked});}
  catch(err){
    if(timeout.aborted && !options.signal?.aborted)
      throw Error(label+'超过 '+Math.ceil(timeoutMs/1000)+' 秒。上游可能已受理任务，但尚未返回可查询的任务编号；请先查看中转站生成记录，不要立即重复提交。');
    throw err;
  }
}
const wait = (ms,signal)=>new Promise((resolve,reject)=>{
  if(signal.aborted)return reject(signal.reason||Error('已取消'));
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
  const abort=()=>{clearTimeout(timer);reject(signal.reason||Error('已取消'));};
  signal.addEventListener('abort',abort,{once:true});
});
async function materialize(items,signal){
  const out=[];
  for(const item of items){
    if(item.startsWith('data:image/')){
      if(item.length>28*1024*1024)throw Error('上游生成图片超过 20MB');
      out.push(item);continue;
    }
    const url=new URL(item,new URL(API_BASE_URL).origin);
    if(url.protocol!=='https:'||!ALLOWED_IMAGE_HOSTS.has(url.hostname))throw Error('图片 CDN 域名未授权：'+url.hostname+'（请配置 IMAGE_ALLOWED_HOSTS）');
    const response=await fetch(url,{signal,redirect:'error'});
    if(!response.ok)throw Error('下载结果图片失败 HTTP '+response.status);
    const type=(response.headers.get('content-type')||'').split(';')[0].toLowerCase();
    if(!['image/png','image/jpeg','image/webp'].includes(type))throw Error('上游图片格式不支持：'+type);
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.byteLength>20*1024*1024)throw Error('上游图片超过 20MB');
    out.push('data:'+type+';base64,'+bytes.toString('base64'));
  }
  return out;
}
async function generate(job,signal){
  const {prompt,options,files}=job.payload;
  const fields={model:options.model,prompt,n:options.count};
  if(options.ratio!=='auto')fields.aspect_ratio=options.ratio;
  if(options.quality!=='auto')fields.quality=options.quality;
  const headers={Authorization:'Bearer '+API_KEY};
  let body;
  if(files.length){
    body=new FormData();
    for(const [k,v] of Object.entries(fields))body.append(k,String(v));
    // Some compatible gateways inspect multipart fields instead of query parameters.
    if(API_ASYNC)body.append('async','true');
    for(const [i,file] of files.entries())body.append(files.length===1?'image':'image[]',new Blob([file.bytes],{type:file.type}),'reference-'+i+'.'+(file.type==='image/jpeg'?'jpg':file.type.split('/')[1]));
  }else {
    headers['Content-Type']='application/json';
    body=JSON.stringify(fields);
  }
  const endpoint=API_BASE_URL+(files.length?'/images/edits':'/images/generations')+(API_ASYNC?'?async=true':'');
  job.phase='submitting';
  job.progress='等待上游返回图片或任务编号';
  const started=Date.now();
  const response=await requestTimed(endpoint,{method:'POST',headers,body,signal},API_ASYNC?SUBMIT_TIMEOUT:MAX_UPSTREAM_WAIT,'上游提交请求');
  job.submitMs=Date.now()-started;
  let result=parseUpstream(response);
  console.info('[image-task]',job.id.slice(0,8),'submit_ms='+job.submitMs,'response='+result.kind,'mode='+(files.length?'edit':'generate'));
  if(result.kind==='error')throw Error(result.message);
  if(result.kind==='done'){
    job.phase='delivering';job.progress='图片已生成，正在整理作品';
    return materialize(result.images,signal);
  }
  if(!result.id)throw Error('上游没有返回可查询的任务编号，无法追踪生成结果');
  const taskId=result.id;
  const queryUrl=new URL('/api/image-tasks',new URL(API_BASE_URL).origin);
  queryUrl.searchParams.set('ids',taskId);
  const deadline=Date.now()+MAX_UPSTREAM_WAIT;
  let timeoutCount=0,completedWithoutImages=0;
  job.phase='generating';
  job.progress='任务已受理，正在等待模型生成';
  while(Date.now()<deadline){
    await wait(2500,signal);
    job.polls=(job.polls||0)+1;
    let state;
    try{
      state=await requestTimed(queryUrl,{headers:{Authorization:'Bearer '+API_KEY},signal},POLL_TIMEOUT,'查询上游任务');
      timeoutCount=0;
    }catch(err){
      if(signal.aborted)throw err;
      if(++timeoutCount<3){
        job.progress='查询暂时缓慢，正在重试（'+timeoutCount+'/2）';
        continue;
      }
      throw Error('连续 3 次查询上游失败：'+err.message);
    }
    result=parseUpstream(state);
    if(result.kind==='done'){
      job.phase='delivering';
      job.progress='图片已经生成，正在取回作品';
      console.info('[image-task]',job.id.slice(0,8),'polls='+job.polls,'phase=download');
      return materialize(result.images,signal);
    }
    if(result.kind==='error')throw Error(result.message);
    if(result.status==='completed-without-images'){
      completedWithoutImages++;
      if(completedWithoutImages>=COMPLETED_WITHOUT_IMAGES_RETRIES)
        throw Error('上游报告已完成，但连续 '+COMPLETED_WITHOUT_IMAGES_RETRIES+' 次查询都没有返回图片。请检查中转站生成记录。');
      job.progress='上游已完成，等待图片数据（'+completedWithoutImages+'/'+COMPLETED_WITHOUT_IMAGES_RETRIES+'）';
    }else{
      completedWithoutImages=0;
      job.progress='上游正在绘制作品 · 查询 '+job.polls+' 次';
    }
  }
  throw Error('等待生成超时。上游任务可能仍在运行；请在中转站核对记录。');
}
function pump(){
  while(running<MAX_CONCURRENT&&waiting.length){
    const id=waiting.shift(),job=jobs.get(id);
    if(!job||job.status!=='queued')continue;
    running++;job.status='running';job.phase='preparing';job.progress='正在准备画布';job.started=Date.now();
    const controller=new AbortController();job.controller=controller;
    const timer=setTimeout(()=>controller.abort(Error('任务已超过最长运行时间')),MAX_UPSTREAM_WAIT+20_000);
    (async()=>{
      try {
        job.images=await generate(job,controller.signal);
        if(job.status==='running'){job.status='succeeded';job.phase='done';job.progress='生成完成';completed++;}
      }catch(err){
        if(job.status==='running'){job.status='failed';job.phase='error';job.error=String(err?.message||err).slice(0,350);failed++;console.warn('[image-task]',job.id.slice(0,8),'failed:',job.error);}
      }finally{
        clearTimeout(timer);
        job.payload=null;job.controller=null;job.finished=Date.now();
        ownerBusy.delete(job.owner);
        running--;pump();
      }
    })().catch(err=>console.error('job execution error',err.message));
  }
}
async function handleApi(req,res,url){
  const id=visitor(req,res);
  if(!corsOrigin(req))return failure(res,403,'来源不受信任');
  if(url.pathname==='/api/health')return json(res,200,{ok:true,storage:'memory-only',mode:API_KEY?'upstream':'not-configured'});
  if(url.pathname==='/api/config')return json(res,200,{models:MODELS,ratios:RATIOS,qualities:QUALITY,maxImages:MAX_IMAGES,active:running,waiting:waiting.length,configured:Boolean(API_KEY),maxConcurrent:MAX_CONCURRENT});
  if(url.pathname==='/api/jobs'&&req.method==='POST'){
    if(!API_KEY)return failure(res,503,'尚未在 Render 中配置 IMAGE_API_KEY');
    if(ownerBusy.has(id))return failure(res,429,'当前浏览器已有任务在执行，请等待或取消');
    if(waiting.length>=MAX_QUEUED)return failure(res,429,'排队已满，请稍后重试');
    let input;
    try{input=validate(await readJson(req));}catch(err){return failure(res,400,err.message);}
    const job={id:randomUUID(),owner:id,status:'queued',phase:'queued',progress:'等待执行',created:Date.now(),started:0,finished:0,images:[],error:'',polls:0,submitMs:0,payload:input,controller:null};
    jobs.set(job.id,job);waiting.push(job.id);ownerBusy.add(id);pump();
    return json(res,202,{job:publicJob(job)});
  }
  const match=/^\/api\/jobs\/([0-9a-f-]{36})(\/cancel)?$/.exec(url.pathname);
  if(match){
    const job=jobs.get(match[1]);
    if(!job||job.owner!==id)return failure(res,404,'任务不存在、已过期或不属于当前浏览器');
    if(match[2]&&req.method==='POST'){
      if(job.status==='queued'){const i=waiting.indexOf(job.id);if(i!==-1)waiting.splice(i,1);}
      if(['running','queued'].includes(job.status)){
        job.status='cancelled';job.phase='cancelled';job.progress='已取消';job.error='';job.finished=Date.now();job.controller?.abort(Error('用户取消'));
        ownerBusy.delete(id);
      }
      return json(res,200,{job:publicJob(job)});
    }
    if(!match[2]&&req.method==='GET')return json(res,200,{job:publicJob(job,true)});
  }
  return failure(res,404,'接口不存在');
}
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'};
async function serveStatic(req,res,url){
  if(!['GET','HEAD'].includes(req.method))return failure(res,405,'方法不允许');
  const files=new Map([['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/styles.css','styles.css'],['/favicon.svg','favicon.svg']]);
  const name=files.get(url.pathname);if(!name)return failure(res,404,'页面不存在');
  try{
    const filename=join(PUBLIC,name);
    const data=await readFile(filename);
    res.writeHead(200,{'content-type':MIME[extname(name)]||'application/octet-stream','cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','content-security-policy':"default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
    res.end(req.method==='HEAD'?undefined:data);
  }catch{return failure(res,404,'文件不存在');}
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://local');
  try{
    if(url.pathname.startsWith('/api/'))await handleApi(req,res,url);
    else await serveStatic(req,res,url);
  }catch(e){failure(res,e?.message?.includes('超过限制')?413:500,'服务器请求失败：'+String(e?.message||e).slice(0,100));}
});
if(process.env.NODE_ENV!=='test'&&process.env.RUN_TEST_SERVER!=='false'){
  server.listen(PORT,HOST,()=>console.log('好人天团 listening on '+HOST+':'+PORT+' | memory-only | upstream '+(API_KEY?'configured':'missing')));
}
export {server,parseUpstream,extractImages,validate,SUBMIT_TIMEOUT,COMPLETED_WITHOUT_IMAGES_RETRIES};
