// 本地模拟页：结构尽量贴近超星「课程学习」页（左侧任务点 + iframe 播放器）
// 通过 ?mode= 控制平台行为：
//   normal   视频结束 → 平台 400ms 后标记完成
//   markdone 视频 1.2s 时平台就标记完成（不等结束）
//   nomark   平台从不标记完成（用来测“超时强制推进”）
//   progress 视频 1.5s 时跳到 99.5% 并暂停（不触发 ended）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIP = path.join(__dirname, 'clip.webm');

const ROWS = `
    <div class="posCatalog_select" data-taskid="t1" onclick="openPoint('t1','1.1 绪论')">
      <span class="posCatalog_name">1.1 绪论</span><span class="icon_Completed"></span></div>
    <div class="posCatalog_select" data-taskid="t2" onclick="openPoint('t2','1.2 第二节')">
      <span class="posCatalog_name">1.2 第二节</span></div>
    <div class="posCatalog_select" data-taskid="t3" onclick="openPoint('t3','1.3 第三节')">
      <span class="posCatalog_name">1.3 第三节</span></div>
    <div class="posCatalog_select" data-taskid="t4" onclick="openPoint('t4','1.4 章节测验')">
      <span class="posCatalog_name">1.4 章节测验</span></div>
    <div class="posCatalog_select" data-taskid="t5" onclick="openPoint('t5','1.5 第五节')">
      <span class="posCatalog_name">1.5 第五节</span></div>`;

const INDEX = (mode, pid, late) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>课程学习</title>
<style>
  html,body{margin:0;height:100%;font:14px/1.5 "Microsoft YaHei",sans-serif;background:#f3f4f6}
  #app{display:flex;height:100%}
  #side{width:320px;background:#fff;border-right:1px solid #e5e7eb;overflow:auto}
  .prev_ul{padding:8px}
  .posCatalog_select{display:flex;align-items:center;gap:6px;padding:10px 8px;border-radius:6px;cursor:pointer}
  .posCatalog_select:hover{background:#f5f7fa}
  .posCatalog_select.active{background:#e8f0fe;color:#1a73e8}
  .posCatalog_name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .icon_Completed{width:12px;height:12px;border-radius:50%;background:#22c55e;flex:none}
  #main{flex:1;padding:16px;box-sizing:border-box}
  #iframe{width:100%;height:420px;border:1px solid #d1d5db;background:#000}
</style></head>
<body>
<div id="app">
  <div id="side"><div class="prev_ul" id="prev_ul">${late ? '' : ROWS}
  </div></div>
  <div id="main"><iframe id="iframe" src="/player.html?k=t2&name=1.2%20%E7%AC%AC%E4%BA%8C%E8%8A%82&mode=${mode}&pid=${pid}"></iframe></div>
</div>
<script>
  var MODE = ${JSON.stringify(mode)};
  var PID = ${JSON.stringify(pid)};
  var LATE = ${late ? 'true' : 'false'};
  var ROWS_HTML = ${JSON.stringify(ROWS)};
  window.__log = [];
  function ev(x){ x.pid = PID; x.ts = Date.now(); window.__log.push(x);
    fetch('/__log',{method:'POST',body:JSON.stringify(x)}).catch(function(){}); }
  window.ev = ev;
  // 模拟超星：目录异步渲染
  if (LATE) setTimeout(function(){ document.getElementById('prev_ul').innerHTML = ROWS_HTML; }, 2500);
  function markDone(k){
    var row=document.querySelector('[data-taskid="'+k+'"]');
    if(row && !row.querySelector('.icon_Completed')){
      var s=document.createElement('span'); s.className='icon_Completed'; row.appendChild(s);
    }
  }
  function openPoint(k,name){
    ev({t:'open',k:k});
    document.querySelectorAll('.posCatalog_select').forEach(function(d){d.classList.remove('active');});
    var row=document.querySelector('[data-taskid="'+k+'"]');
    if(row) row.classList.add('active');
    document.getElementById('iframe').src='/player.html?k='+k+'&name='+encodeURIComponent(name)+'&mode='+MODE+'&pid='+PID+'&r='+Math.random();
  }
  window.openPoint = openPoint;
  window.addEventListener('message',function(e){
    var d=e.data; if(!d||!d.k) return;
    if(d.type==='mock-ended'){
      ev({t:'ended',k:d.k});
      if(MODE!=='nomark') setTimeout(function(){ markDone(d.k); ev({t:'done',k:d.k}); },400);
    }
    if(d.type==='mock-markdone'){
      ev({t:'marked',k:d.k});
      markDone(d.k);
    }
  });
  ev({t:'boot'});
</script>
</body></html>`;

const PLAYER = `<!doctype html>
<html><head><meta charset="utf-8"><title>超星视频</title>
<style>
  html,body{margin:0;background:#000;color:#fff}
  #wrap{position:relative;width:640px;height:360px;margin:0 auto}
  video{width:100%;height:100%;display:block;background:#000}
  .vjs-big-play-button{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
    width:72px;height:72px;border-radius:50%;border:0;background:rgba(255,255,255,.92);
    color:#111;font-size:26px;cursor:pointer;line-height:1}
</style></head>
<body>
<div id="wrap">
  <video id="video" class="vjs-tech" src="/clip.webm" playsinline preload="auto"></video>
  <button class="vjs-big-play-button" type="button">▶</button>
</div>
<script>
(function(){
  var v=document.getElementById('video');
  var big=document.querySelector('.vjs-big-play-button');
  var q=new URLSearchParams(location.search);
  var k=q.get('k')||'';
  var mode=q.get('mode')||'normal';
  document.title=q.get('name')||'超星视频';
  big.addEventListener('click',function(){ var p=v.play(); if(p&&p.catch)p.catch(function(){}); });
  v.addEventListener('play',function(){ big.style.display='none'; });
  v.addEventListener('ended',function(){ try{ parent.postMessage({type:'mock-ended',k:k},'*'); }catch(e){} });
  if(mode==='markdone'){
    setTimeout(function(){ try{ parent.postMessage({type:'mock-markdone',k:k},'*'); }catch(e){} },3000);
  }
  if(mode==='progress'){
    setTimeout(function(){
      var D = (v.duration && isFinite(v.duration)) ? v.duration
            : (v.buffered && v.buffered.length ? v.buffered.end(v.buffered.length-1) : 4);
      try{ v.currentTime = D * 0.995; }catch(e){}
      try{ v.pause(); }catch(e){}
    },3500);
  }
})();
</script>
</body></html>`;

export function startServer(port = 0) {
  let logs = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/' || p === '/mycourse/studentstudy') {
      const mode = url.searchParams.get('mode') || 'normal';
      const pid = url.searchParams.get('pid') || 'x';
      const late = url.searchParams.get('late') === '1';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(INDEX(mode, pid, late));
      return;
    }
    if (p === '/__blank') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>blank</title><body>blank</body>');
      return;
    }
    if (p === '/player.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PLAYER);
      return;
    }
    if (p === '/clip.webm') {
      if (!fs.existsSync(CLIP)) { res.writeHead(404); res.end('no clip'); return; }
      res.writeHead(200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes' });
      fs.createReadStream(CLIP).pipe(res);
      return;
    }
    if (p === '/__clip' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          fs.writeFileSync(CLIP, Buffer.from(body, 'base64'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, bytes: fs.statSync(CLIP).size }));
        } catch (e) {
          res.writeHead(500); res.end(String(e));
        }
      });
      return;
    }
    if (p === '/__log') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try { logs.push(JSON.parse(body)); } catch (e) { /* ignore */ }
          res.writeHead(204); res.end();
        });
        return;
      }
      const pid = url.searchParams.get('pid');
      const out = pid ? logs.filter((x) => x.pid === pid) : logs;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }
    if (p === '/__reset') {
      logs = [];
      res.writeHead(204); res.end();
      return;
    }
    res.writeHead(404); res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        getLogs: (pid) => (pid ? logs.filter((x) => x.pid === pid) : logs),
        reset: () => { logs = []; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
