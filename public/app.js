const $ = id => document.getElementById(id);
const dbName = 'haoren-tiantu-local-v1';
const storeName = 'sessions';
const elements = {
  list: $('session-list'), messages: $('chat-messages'), empty: $('empty-state'),
  scroll: $('main-scroll'), sidebar: $('sidebar'), backdrop: $('mobile-backdrop'),
  send: $('send'), sendLabel: $('send-label'), prompt: $('prompt'),
  attachments: $('attachments'), upload: $('image-upload'), toast: $('toast'),
  model: $('model'), ratio: $('ratio'), quality: $('quality'), count: $('count')
};
let database;
let sessions=[];
let current=newSession();
let mode='generate';
let attachments=[];
let config={models:['gpt-image-2.5-sunburst','gpt-image-2.5-flare','gpt-image-2.5'],configured:false};
let working=false;
let runningId=null;
let toastTimer;

function newSession(){
  return {id:crypto.randomUUID(),title:'新灵感',created:Date.now(),updated:Date.now(),messages:[]};
}
function openDb(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(dbName,1);
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(storeName))db.createObjectStore(storeName,{keyPath:'id'});};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function tx(mode,fn){
  if(!database)return;
  return new Promise((resolve,reject)=>{
    const t=database.transaction(storeName,mode);
    const request=fn(t.objectStore(storeName));
    t.oncomplete=()=>resolve(request?.result);
    t.onerror=()=>reject(t.error);
  });
}
async function save(){
  current.updated=Date.now();
  await tx('readwrite',s=>s.put(current));
  const i=sessions.findIndex(s=>s.id===current.id);
  if(i!==-1)sessions[i]=current;else sessions.unshift(current);
  renderSessions();
}
const allSessions=()=>tx('readonly',s=>s.getAll());
function showToast(message){
  clearTimeout(toastTimer);
  elements.toast.textContent=message;
  elements.toast.classList.add('show');
  toastTimer=setTimeout(()=>elements.toast.classList.remove('show'),3800);
}
function closeMenu(){
  elements.sidebar.classList.remove('open');
  elements.backdrop.classList.remove('show');
}
function renderSessions(){
  elements.list.replaceChildren();
  $('session-count').textContent=String(sessions.length);
  for(const session of [...sessions].sort((a,b)=>b.updated-a.updated)){
    const button=document.createElement('button');
    button.className='session'+(session.id===current.id?' active':'');
    button.type='button';button.title=session.title;
    const icon=document.createElement('span');icon.className='session-icon';icon.textContent='✦';
    const label=document.createElement('span');label.textContent=session.title;
    button.append(icon,label);
    button.addEventListener('click',()=>{if(working){showToast('请先等待或取消当前任务');return;}current=session;attachments=[];render();closeMenu();resumePending();});
    elements.list.append(button);
  }
}
function makeAvatar(role){
  const element=document.createElement('div');element.className='avatar';element.textContent=role==='user'?'✍':'✳';return element;
}
function makeLabel(text){
  const el=document.createElement('div');el.className='message-label';el.textContent=text;return el;
}
function imageCard(src,i){
  const div=document.createElement('div');div.className='result-item';
  const img=document.createElement('img');img.loading='lazy';img.alt='生成图片 '+(i+1);img.src=src;
  img.addEventListener('click',()=>lightbox(src));
  const buttons=document.createElement('div');buttons.className='result-actions';
  const saveBtn=document.createElement('button');saveBtn.type='button';saveBtn.textContent='↓ 下载';
  saveBtn.addEventListener('click',()=>{const a=document.createElement('a');a.href=src;a.download='好人天团-'+Date.now()+'-'+(i+1)+(src.includes('image/jpeg')?'.jpg':src.includes('image/webp')?'.webp':'.png');document.body.appendChild(a);a.click();a.remove();});
  const editBtn=document.createElement('button');editBtn.type='button';editBtn.textContent='✎ 用这张改图';
  editBtn.addEventListener('click',()=>{setMode('edit');attachments=[src];renderAttachments();elements.prompt.focus();elements.prompt.scrollIntoView({behavior:'smooth',block:'end'});});
  buttons.append(saveBtn,editBtn);div.append(img,buttons);return div;
}
function lightbox(src){
  const overlay=document.createElement('div');overlay.className='lightbox';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-label','查看图片');
  const img=document.createElement('img');img.src=src;img.alt='查看大图';
  overlay.append(img);overlay.addEventListener('click',()=>overlay.remove());
  document.body.append(overlay);
  const key=e=>{if(e.key==='Escape'){overlay.remove();window.removeEventListener('keydown',key);}};
  window.addEventListener('keydown',key,{once:true});
}
// Static artwork: no downloaded animation assets or extra requests.
const WAITING_TIPS=[
  '小画笔正在打草稿，稍等好点子长出来 ✨',
  '把云朵折成纸飞机，再给想象一点时间 ☁',
  '调一调颜色，让这幅画更有故事感 🎨',
  '不需要一直盯着页面，回到这里会继续显示进度 🐾',
  '创作时间由上游决定，这里的计时是真实经过时间 ⏳',
  '星星正在排队，准备降落到画纸上 ✦'
];
function createWaitingScene(msg){
  const scene=document.createElement('div');
  scene.className='waiting-scene';
  // All HTML here is static. Never interpolate user prompts or upstream responses into HTML.
  scene.innerHTML=`<div class="sketch-area" aria-hidden="true">
    <span class="floating-star star-one">✦</span><span class="floating-star star-two">✧</span>
    <div class="sketch-sheet"><div class="sketch-sun">✳</div><div class="sketch-mountain">⌁⌁</div><div class="sketch-smile">◡</div></div>
    <span class="sketch-pencil">✏️</span><span class="sketch-trace">· · ·</span>
  </div>
  <div class="waiting-title"><strong>灵感正在变成画面</strong><span class="working-heartbeat">创作中 <span class="heartbeat-dot"></span></span></div>
  <div class="waiting-step-list" aria-label="创作阶段">
    <span data-step="submitting"><span class="step-check">01</span> 接收想法</span>
    <span class="steps-connector">→</span>
    <span data-step="generating"><span class="step-check">02</span> AI 绘制</span>
    <span class="steps-connector">→</span>
    <span data-step="delivering"><span class="step-check">03</span> 作品送达</span>
  </div>
  <div class="waiting-detail"><span class="status-spinner"></span><span data-progress-text>正在连接上游...</span></div>
  <div class="waiting-footer"><span class="waiting-tip" data-waiting-tip></span><span class="waiting-time" data-waiting-time>00:00</span></div>`;
  updateWaitingScene(msg,scene);
  return scene;
}
function updateWaitingScene(msg,scene){
  scene ||= [...elements.messages.querySelectorAll('article.message')].find(el=>el.dataset.messageId===msg.id)?.querySelector('.waiting-scene');
  if(!scene)return;
  const phase=msg.phase||'submitting';
  const steps=['submitting','generating','delivering'];
  const active=Math.max(0,steps.indexOf(phase));
  scene.querySelectorAll('[data-step]').forEach((el,i)=>{
    el.classList.toggle('active',i===active);
    el.classList.toggle('complete',i<active);
  });
  scene.querySelector('[data-progress-text]').textContent=msg.progress||'正在等待上游回应...';
  const elapsed=Math.max(0,Math.floor((Date.now()-(msg.time||Date.now()))/1000));
  const minutes=String(Math.floor(elapsed/60)).padStart(2,'0');
  const seconds=String(elapsed%60).padStart(2,'0');
  scene.querySelector('[data-waiting-time]').textContent=minutes+':'+seconds;
  const hint=elapsed>=60 && phase==='submitting'
    ? '提交已等待超过 1 分钟，仍在等上游确认；若超时会提示原因'
    : WAITING_TIPS[Math.floor(elapsed/9)%WAITING_TIPS.length];
  scene.querySelector('[data-waiting-tip]').textContent=hint;
}
function tickWaitingScenes(){
  for(const msg of current.messages){
    if(msg.role==='assistant'&&['pending','queued','running'].includes(msg.status))updateWaitingScene(msg);
  }
}
setInterval(tickWaitingScenes,1000);
function renderMessages(){
  elements.messages.replaceChildren();
  const hasMessages=current.messages.length>0;
  elements.empty.hidden=hasMessages;elements.messages.hidden=!hasMessages;
  for(const msg of current.messages){
    const section=document.createElement('article');section.className='message '+msg.role;section.dataset.messageId=msg.id;
    const bubble=document.createElement('div');bubble.className='bubble';
    bubble.append(makeLabel(msg.role==='user'?'你 · 灵感发起人':'✳ 好人天团 · 创作助手'));
    if(msg.role==='user'){
      const text=document.createElement('p');text.className='message-text';text.textContent=msg.prompt;bubble.append(text);
      if(msg.refs){const refs=document.createElement('div');refs.className='bubble-info';refs.textContent='▧ 参考图片 '+msg.refs+' 张';bubble.append(refs);}
    } else {
      if(msg.status==='pending'||msg.status==='queued'||msg.status==='running'){
        bubble.append(createWaitingScene(msg));
      }else if(msg.status==='failed'){
        const div=document.createElement('div');div.className='bubble-error';div.textContent='✕ '+(msg.error||'生成失败');bubble.append(div);
      }else if(msg.status==='cancelled'){
        const div=document.createElement('div');div.className='bubble-info';div.textContent='已取消这次创作';bubble.append(div);
      }else if(msg.status==='succeeded'){
        const label=document.createElement('div');label.className='bubble-info';label.textContent='✓ 创作完成 · '+(msg.images?.length||0)+' 张';bubble.append(label);
        const grid=document.createElement('div');grid.className='result-grid';
        for(const [i,src] of (msg.images||[]).entries())grid.append(imageCard(src,i));
        bubble.append(grid);
      }
    }
    section.append(makeAvatar(msg.role),bubble);elements.messages.append(section);
  }
}
function renderAttachments(){
  elements.attachments.replaceChildren();
  elements.attachments.hidden=attachments.length===0;
  for(const [i,src] of attachments.entries()){
    const div=document.createElement('div');div.className='attachment';
    const img=document.createElement('img');img.src=src;img.alt='参考图片 '+(i+1);
    const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','移除参考图片');
    remove.addEventListener('click',()=>{attachments.splice(i,1);renderAttachments();});
    div.append(img,remove);elements.attachments.append(div);
  }
}
function lastImage(){
  for(let i=current.messages.length-1;i>=0;i--){
    const m=current.messages[i];if(m.role==='assistant'&&m.status==='succeeded'&&m.images?.length)return m.images[0];
  }
  return null;
}
function setMode(value){
  mode=value;
  $('mode-generate').classList.toggle('active',mode==='generate');
  $('mode-edit').classList.toggle('active',mode==='edit');
  $('mode-generate').setAttribute('aria-selected',String(mode==='generate'));
  $('mode-edit').setAttribute('aria-selected',String(mode==='edit'));
  $('mode-hint').textContent=mode==='generate'?'描述你的脑洞':'上传图片，或者沿用上一次作品';
  elements.prompt.placeholder=mode==='generate'?'今天想画点什么？比如：一只在月亮上吃拉面的柴犬...':'想把图片改成什么样？比如：改成星空背景，保留主体形状...';
  if(mode==='edit'&&attachments.length===0){
    const image=lastImage();if(image){attachments=[image];renderAttachments();}
  }
}
function render(){
  renderSessions();renderMessages();renderAttachments();setMode(mode);
}
function setWorking(flag){
  working=flag;elements.send.disabled=false;
  elements.sendLabel.textContent=flag?'取消创作':'开始创作';
  elements.send.classList.toggle('cancel-mode',flag);
}
async function api(url,options={}){
  const response=await fetch(url,{cache:'no-store',credentials:'same-origin',...options});
  const data=await response.json().catch(()=>({error:'服务器未返回 JSON'}));
  if(!response.ok)throw Error(data.error||('HTTP '+response.status));
  return data;
}
function scrolldown(){requestAnimationFrame(()=>elements.scroll.scrollTop=elements.scroll.scrollHeight);}
async function submit(){
  if(working){await cancelActive();return;}
  const prompt=elements.prompt.value.trim();
  if(!prompt){showToast('先写点想画的内容吧！');elements.prompt.focus();return;}
  if(!config.configured){showToast('服务端尚未配置生图 API Key');return;}
  let references=mode==='edit'?attachments.slice():[];
  if(mode==='edit'&&!references.length){const image=lastImage();if(image)references=[image];}
  if(mode==='edit'&&!references.length){showToast('改图模式需要先上传或选择一张参考图片');return;}
  current.title=current.messages.length?current.title:prompt.slice(0,24);
  const user={id:crypto.randomUUID(),role:'user',prompt,refs:references.length,time:Date.now()};
  const answer={id:crypto.randomUUID(),role:'assistant',status:'pending',phase:'submitting',progress:'正在提交任务',time:Date.now(),jobId:null};
  current.messages.push(user,answer);
  elements.prompt.value='';
  attachments=[];renderAttachments();renderMessages();scrolldown();setWorking(true);
  try{
    await save();
    const body={prompt,images:references,options:{model:elements.model.value,ratio:elements.ratio.value,quality:elements.quality.value,count:Number(elements.count.value)}};
    const {job}=await api('/api/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    answer.jobId=job.id;runningId=job.id;
    answer.status=job.status;answer.phase=job.phase||'submitting';answer.progress=job.progress;
    await save();updateWaitingScene(answer);scrolldown();
    await pollJob(answer);
  }catch(err){
    answer.status='failed';answer.error=err.message;answer.progress='';
    showToast(err.message);await save();renderMessages();
  }finally{
    runningId=null;setWorking(false);updateHealth();
  }
}
async function pollJob(answer) {
  const jobId=answer.jobId;
  if(!jobId)throw Error('任务尚未建立');
  for(;;){
    const {job}=await api('/api/jobs/'+encodeURIComponent(jobId));
    answer.status=job.status;answer.phase=job.phase||answer.phase;answer.progress=job.progress;
    if(job.status==='succeeded'){
      answer.images=job.images||[];
      answer.status='succeeded';await save();renderMessages();scrolldown();showToast('✦ 图片创作完成！');
      return;
    }
    if(job.status==='failed')throw Error(job.error||'上游生成失败');
    if(job.status==='cancelled'){answer.status='cancelled';await save();renderMessages();return;}
    // Keep the same DOM node: rebuilding on each poll would restart the pencil animation.
    updateWaitingScene(answer);
    $('queue-info').textContent='排队中 '+job.waiting+' · 创作中 '+job.active;
    await new Promise(resolve=>setTimeout(resolve,2300));
  }
}
async function cancelActive(){
  if(!runningId){showToast('任务正在提交，请稍后再取消');return;}
  try {
    await api('/api/jobs/'+encodeURIComponent(runningId)+'/cancel',{method:'POST'});
    const pending=current.messages.find(m=>m.jobId===runningId);if(pending){pending.status='cancelled';pending.progress='';await save();renderMessages();}
    showToast('已请求取消生成');
  } catch(err){showToast('取消失败：'+err.message);}
}
async function resumePending(){
  const pending=current.messages.findLast(m=>m.role==='assistant'&&['pending','running','queued'].includes(m.status));
  if(!pending)return;
  if(!pending.jobId){pending.status='failed';pending.error='上次刷新时任务尚未提交，请重新生成';await save();renderMessages();return;}
  runningId=pending.jobId;setWorking(true);
  try{await pollJob(pending);}
  catch(err){pending.status='failed';pending.error='任务未能恢复：'+err.message;await save();renderMessages();}
  finally{runningId=null;setWorking(false);}
}
async function updateHealth(){
  try{
    const response=await api('/api/config');
    config=response;
    $('server-status').textContent=response.configured?'创作服务器在线':'尚未配置 API';
    $('status-dot').className='status-dot '+(response.configured?'online':'offline');
    $('queue-info').textContent='排队中 '+response.waiting+' · 创作中 '+response.active;
    const oldModel=elements.model.value;
    if(elements.model.options.length===0||elements.model.options.length!==response.models.length){
      elements.model.replaceChildren();
      for(const model of response.models){const option=document.createElement('option');option.value=option.textContent=model;elements.model.append(option);}
      if(response.models.includes(oldModel))elements.model.value=oldModel;
    }
  }catch {
    $('server-status').textContent='服务器离线';$('status-dot').className='status-dot offline';
  }
}
async function addFiles(fileList){
  const selected=[...fileList];
  for(const file of selected){
    if(attachments.length>=5){showToast('最多上传 5 张参考图');break;}
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){showToast('仅支持 PNG / JPEG / WebP');continue;}
    if(file.size>10*1024*1024){showToast('单张图片最大 10MB');continue;}
    const data=await new Promise((resolve,reject)=>{
      const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=()=>reject(fr.error);fr.readAsDataURL(file);
    });
    attachments.push(data);
  }
  elements.upload.value='';
  if(attachments.length)setMode('edit');
  renderAttachments();
}
async function deleteCurrent(){
  if(working)return showToast('先取消当前任务再删除');
  if(!current.messages.length)return showToast('当前还没有聊天记录');
  if(!confirm('确定删除当前会话及其全部本地图片？此操作无法恢复。'))return;
  await tx('readwrite',s=>s.delete(current.id));
  sessions=sessions.filter(s=>s.id!==current.id);
  current=newSession();attachments=[];render();showToast('当前会话已删除');
}
async function clearAll(){
  if(working)return showToast('先取消当前任务再清空历史');
  if(!confirm('确定删除该浏览器中全部聊天和生成图片？无法恢复。'))return;
  await tx('readwrite',s=>s.clear());
  sessions=[];current=newSession();attachments=[];render();
  $('settings-dialog').close();showToast('本地历史已清空');
}

$('new-chat').addEventListener('click',()=>{if(working)return showToast('请先完成或取消当前任务');current=newSession();attachments=[];mode='generate';elements.prompt.value='';render();closeMenu();elements.prompt.focus();});
$('delete-chat').addEventListener('click',deleteCurrent);
$('send').addEventListener('click',submit);
$('mode-generate').addEventListener('click',()=>{mode='generate';setMode(mode);});
$('mode-edit').addEventListener('click',()=>{mode='edit';setMode(mode);});
elements.upload.addEventListener('change',e=>addFiles(e.target.files).catch(err=>showToast(err.message)));
elements.prompt.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();submit();}});
document.querySelectorAll('[data-suggestion]').forEach(el=>el.addEventListener('click',()=>{elements.prompt.value=el.dataset.suggestion;elements.prompt.focus();}));
$('settings-trigger').addEventListener('click',()=>{$('settings-dialog').showModal();closeMenu();});
$('close-settings').addEventListener('click',()=>$('settings-dialog').close());
$('clear-history').addEventListener('click',clearAll);
$('mobile-menu').addEventListener('click',()=>{elements.sidebar.classList.add('open');elements.backdrop.classList.add('show');});
elements.backdrop.addEventListener('click',closeMenu);
async function bootstrap(){
  try{
    database=await openDb();
    sessions=await allSessions()||[];
    sessions.sort((a,b)=>b.updated-a.updated);
    current=sessions[0]||newSession();
    render();await updateHealth();resumePending();
    setInterval(updateHealth,20000);
  } catch(err){showToast('浏览器本地存储不可用：'+err.message);await updateHealth();}
}
bootstrap();
