// 端到端验证：真实 Edge（headless）跑模拟超星页面，覆盖
//   1) 正常链式跳转   2) 完成即跳（约 1 秒）   3) 超时强制推进
//   4) 进度 ≥99% 判定  5) 悬浮面板 + 暂停按钮   6) 后台暂停恢复
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const USERSCRIPT = path.join(ROOT, 'chaoxing-auto-next.user.js');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9333;
const HOST = 'mooc1.chaoxing.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 迷你 CDP 客户端 ---------------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.exceptions.push(d.text + ' ' + ((d.exception && d.exception.description) || ''));
      }
    });
    ws.addEventListener('close', () => {
      for (const [, p] of this.pending) p.reject(new Error('ws closed'));
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' +
        ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ''));
    }
    return r.result.value;
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
}

async function waitHttp(url, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.text();
    } catch (e) { /* retry */ }
    await sleep(200);
  }
  throw new Error('timeout waiting for ' + url);
}

/* ---------------- 生成测试视频 ---------------- */

const RECORD_JS = `(async () => {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 180;
  const ctx = c.getContext('2d');
  const stream = c.captureStream(25);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start(100);
  const t0 = performance.now();
  await new Promise((r) => {
    (function frame() {
      const t = performance.now() - t0;
      ctx.fillStyle = 'hsl(' + (t / 8) + ',80%,45%)';
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = '#fff';
      ctx.font = '28px sans-serif';
      ctx.fillText((t / 1000).toFixed(1) + 's', 20, 60);
      if (t < 4000) requestAnimationFrame(frame); else r();
    })();
  });
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: 'video/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
})()`;

async function ensureClip(cdp, browserUrl, nodeUrl) {
  const clipPath = path.join(__dirname, 'clip.webm');
  if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 2000) return;
  await cdp.send('Page.navigate', { url: browserUrl + '/__blank' });
  await sleep(800);
  const b64 = await cdp.evaluate(RECORD_JS);
  const r = await fetch(nodeUrl + '/__clip', { method: 'POST', body: b64 });
  if (!r.ok) throw new Error('上传 clip 失败');
  const j = await r.json();
  console.log('生成测试视频：', j.bytes, 'bytes');
}

/* ---------------- 页面辅助 ---------------- */

async function openPage(browserUrl, cdpPort) {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?` + encodeURIComponent(browserUrl), { method: 'PUT' });
  const target = await res.json();
  const ws = await connect(target.webSocketDebuggerUrl);
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await sleep(900);
  const script = fs.readFileSync(USERSCRIPT, 'utf8');
  await cdp.evaluate(script);
  return { cdp, ws, targetId: target.id };
}

async function poll(fn, timeout, label) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e.message; }
    await sleep(250);
  }
  throw new Error('等待超时：' + label + '（最后结果：' + JSON.stringify(last) + '）');
}

/* ---------------- 主流程 ---------------- */

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok, extra });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  → ' + extra : ''));
}

async function closePage(p, port) {
  try { p.ws.close(); } catch (e) { /* ignore */ }
  try { await fetch(`http://127.0.0.1:${port}/json/close/` + p.targetId); } catch (e) { /* ignore */ }
}

function findEv(logs, t, k) {
  return logs.filter((x) => x.t === t && (!k || x.k === k));
}

(async () => {
  const server = await startServer(0);
  const mockNode = server.url;
  const mockHost = server.url.replace('127.0.0.1', HOST);
  // 每个场景用独立子域，隔离 localStorage 里的“上次进度”
  const origin = (id) => server.url.replace('127.0.0.1', id + '.' + HOST);
  console.log('模拟站点：', mockHost);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxauto-'));
  const edge = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    '--user-data-dir=' + userDataDir,
    '--remote-debugging-port=' + CDP_PORT,
    '--host-resolver-rules=MAP *.chaoxing.com 127.0.0.1',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`);
    console.log('Edge 已启动');

    const genRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
    const genTarget = await genRes.json();
    const genWs = await connect(genTarget.webSocketDebuggerUrl);
    const genCdp = new CDP(genWs);
    await genCdp.send('Page.enable');
    await genCdp.send('Runtime.enable');
    await ensureClip(genCdp, mockHost, mockNode);
    genWs.close();

    /* ---------- 场景 1：正常链式跳转 ---------- */
    console.log('\n[1] 播完 → 平台标记 → 自动进下一个（跳过测验）');
    {
      const p = await openPage(`${origin('s1')}/?mode=normal&pid=s1`, CDP_PORT);
      const logs = await poll(() => server.getLogs('s1').some((x) => x.t === 'ended' && x.k === 't5') ? server.getLogs('s1') : null,
        60000, '三个视频依次播完');
      const opens = logs.filter((x) => x.t === 'open').map((x) => x.k);
      check('自动打开 t3', opens.includes('t3'), JSON.stringify(opens));
      check('跳过测验 t4', !opens.includes('t4'));
      check('自动打开 t5', opens.includes('t5'));
      await poll(async () => {
        const st = JSON.parse(await p.cdp.evaluate(`(function(){
          var o={}; document.querySelectorAll('[data-taskid]').forEach(function(r){ o[r.dataset.taskid]=!!r.querySelector('.icon_Completed'); });
          return JSON.stringify(o);
        })()`));
        return (st.t2 && st.t3 && st.t5 && !st.t4) ? st : null;
      }, 10000, '平台写回完成状态');
      const done = await p.cdp.evaluate(`(function(){
        var o={}; document.querySelectorAll('[data-taskid]').forEach(function(r){ o[r.dataset.taskid]=!!r.querySelector('.icon_Completed'); });
        return JSON.stringify(o);
      })()`);
      const d = JSON.parse(done);
      check('t2/t3/t5 均被标记完成', d.t2 && d.t3 && d.t5, done);
      check('t4 仍未完成', d.t4 === false);
      check('无脚本异常', p.cdp.exceptions.length === 0, p.cdp.exceptions.join(' | '));
      await closePage(p, CDP_PORT);
    }

    /* ---------- 场景 2：完成即跳 ---------- */
    console.log('\n[2] 任务点被标记完成 → 约 1 秒后跳走（不等视频结束）');
    {
      const p = await openPage(`${origin('s2')}/?mode=markdone&pid=s2`, CDP_PORT);
      const logs = await poll(() => server.getLogs('s2').some((x) => x.t === 'open' && x.k === 't3') ? server.getLogs('s2') : null,
        20000, '标记完成后自动跳转');
      const marked = findEv(logs, 'marked', 't2')[0];
      const opened = findEv(logs, 'open', 't3')[0];
      const delta = opened.ts - marked.ts;
      check('标记完成到跳转约 1 秒', delta >= 400 && delta <= 2600, delta + 'ms');
      check('没有等视频结束（无 ended:t2）', findEv(logs, 'ended', 't2').length === 0);

      const panel = await p.cdp.evaluate(`(function(){
        var h = document.getElementById('cxauto-panel-host');
        if (!h || !h.shadowRoot) return null;
        var t = h.shadowRoot.textContent || '';
        return JSON.stringify({ has: true, text: t.slice(0, 80), buttons: h.shadowRoot.querySelectorAll('button').length });
      })()`);
      const pj = panel ? JSON.parse(panel) : null;
      check('悬浮面板已挂载', !!(pj && pj.has));
      check('面板有 4 个按钮（暂停/下一个/重扫/诊断）', !!(pj && pj.buttons >= 4), pj && pj.buttons);

      const toggled = await p.cdp.evaluate(`(function(){
        var h=document.getElementById('cxauto-panel-host');
        var b=h.shadowRoot.querySelector('#btn-pause');
        b.click();
        var off = window.__cxauto.cfg.enabled === false;
        b.click();
        var on = window.__cxauto.cfg.enabled === true;
        return JSON.stringify({off:off,on:on});
      })()`);
      const tj = JSON.parse(toggled);
      check('暂停按钮能停/能继续', tj.off && tj.on, toggled);
      await closePage(p, CDP_PORT);
    }

    /* ---------- 场景 3：平台不标记 → 超时强制 ---------- */
    console.log('\n[3] 平台不标记完成 → 6 秒超时后强制推进');
    {
      const p = await openPage(`${origin('s3')}/?mode=nomark&pid=s3`, CDP_PORT);
      const logs = await poll(() => server.getLogs('s3').some((x) => x.t === 'open' && x.k === 't3') ? server.getLogs('s3') : null,
        30000, '超时后强制跳转');
      const ended = findEv(logs, 'ended', 't2')[0];
      const opened = findEv(logs, 'open', 't3')[0];
      const delta = opened.ts - ended.ts;
      check('ended 后约 6~8 秒强制跳走', delta >= 5500 && delta <= 9000, delta + 'ms');
      const done = await p.cdp.evaluate(`!!document.querySelector('[data-taskid="t2"] .icon_Completed')`);
      check('平台确实没标记 t2 完成', done === false);
      await closePage(p, CDP_PORT);
    }

    /* ---------- 场景 4：按进度比例判定播完 ---------- */
    console.log('\n[4] 进度到设定比例（这里调成 50%）→ 不等 ended 就判定播完');
    {
      const p = await openPage(`${origin('s4')}/?mode=nomark&pid=s4`, CDP_PORT);
      // 把阈值调成 50%、把超时调短，验证“按比例判定”这条路径
      await p.cdp.evaluate(`window.__cxauto.set('endProgress', 0.5); window.__cxauto.set('forceAdvanceMs', 800); true`);
      const logs = await poll(() => server.getLogs('s4').some((x) => x.t === 'open' && x.k === 't3') ? server.getLogs('s4') : null,
        20000, '进度达标后跳转');
      const boot = findEv(logs, 'boot')[0];
      const opened = findEv(logs, 'open', 't3')[0];
      const endedBefore = findEv(logs, 'ended', 't2').filter((x) => x.ts < opened.ts);
      check('进度达标后跳转（3~9s）', opened.ts - boot.ts > 2000 && opened.ts - boot.ts < 9000,
        (opened.ts - boot.ts) + 'ms');
      check('跳转发生在 ended 之前', endedBefore.length === 0);
      await closePage(p, CDP_PORT);
    }

    /* ---------- 场景 5：被页面暂停 → 自动恢复 ---------- */
    console.log('\n[5] 页面/站点把视频暂停 → 自动恢复（不抢用户主动暂停）');
    {
      const p = await openPage(`${origin('s5')}/?mode=normal&pid=s5`, CDP_PORT);
      const playing = `(function(){
        var f=document.querySelector('iframe');
        if(!f||!f.contentDocument) return false;
        var v=f.contentDocument.querySelector('video');
        return !!(v && !v.paused && !v.ended && v.currentTime > 0.2);
      })()`;
      await poll(async () => p.cdp.evaluate(playing), 20000, '首个视频起播');

      // 1) 前台被站点暂停（就是你“点一下别处”时发生的事）
      const paused1 = await p.cdp.evaluate(`(function(){
        var v=document.querySelector('iframe').contentDocument.querySelector('video');
        v.pause();
        return v.paused;
      })()`);
      check('已模拟站点在前台暂停', paused1 === true);
      const resumed1 = await poll(async () => p.cdp.evaluate(playing), 12000, '前台自动恢复');
      check('前台被暂停后自动恢复播放', resumed1 === true);

      // 2) 切后台再暂停
      const paused2 = await p.cdp.evaluate(`(function(){
        Object.defineProperty(document,'hidden',{configurable:true,get:function(){return true;}});
        Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'hidden';}});
        document.dispatchEvent(new Event('visibilitychange'));
        var v=document.querySelector('iframe').contentDocument.querySelector('video');
        v.pause();
        return v.paused;
      })()`);
      check('已模拟切后台并暂停', paused2 === true);

      // 后台时 currentTime 不再增长，用 paused 判断即可
      const resumed2 = await poll(async () => p.cdp.evaluate(`(function(){
        var v=document.querySelector('iframe').contentDocument.querySelector('video');
        return v ? (!v.paused && !v.ended) : false;
      })()`), 12000, '后台自动恢复');
      check('隐藏状态下自动恢复播放', resumed2 === true);

      // 3) 连续多次暂停（模拟站点反复打断，比如全屏切换中的连环检测）
      let allResumed = true;
      for (let i = 0; i < 3; i++) {
        await p.cdp.evaluate(`(function(){
          var v=document.querySelector('iframe').contentDocument.querySelector('video');
          if (v) v.pause();
          return true;
        })()`);
        const ok = await poll(async () => p.cdp.evaluate(`(function(){
          var v=document.querySelector('iframe').contentDocument.querySelector('video');
          return v ? (!v.paused && !v.ended) : false;
        })()`), 12000, '连续恢复 #' + (i + 1)).catch(() => false);
        if (!ok) allResumed = false;
        await sleep(300);
      }
      check('连续多次被打断都能恢复', allResumed === true);

      await closePage(p, CDP_PORT);
    }

    /* ---------- 场景 6：目录异步渲染（超星真实情况） ---------- */
    console.log('\n[6] 目录延迟 2.5 秒才出现 → 脚本仍要接管');
    {
      const p = await openPage(`${origin('s6')}/mycourse/studentstudy?mode=normal&pid=s6&late=1`, CDP_PORT);
      // 目录还没出来时，面板就应该已经挂上
      await sleep(1500);
      const panelEarly = await p.cdp.evaluate(`!!document.getElementById('cxauto-panel-host')`);
      check('目录未出现时面板已挂载', panelEarly === true);

      const logs = await poll(() => server.getLogs('s6').some((x) => x.t === 'open' && x.k === 't3') ? server.getLogs('s6') : null,
        30000, '目录出现后接管并跳转');
      check('目录出现后能接管任务点', logs.some((x) => x.t === 'open' && x.k === 't3'));
      check('页面无脚本异常', p.cdp.exceptions.length === 0, p.cdp.exceptions.join(' | '));
      await closePage(p, CDP_PORT);
    }

    if (results.every((r) => r.ok)) console.log('\n全部通过');
  } catch (e) {
    console.error('\n测试执行失败：', e);
  } finally {
    edge.kill();
    await server.close();
    await sleep(300);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
  process.exit(failed.length ? 1 : 0);
})();
