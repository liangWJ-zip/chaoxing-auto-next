// 生成 README 用的面板截图：跑模拟站 + 真实 Edge，截取页面
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9335;
const HOST = 'mooc1.chaoxing.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await startServer(0);
const target = server.url.replace('127.0.0.1', HOST);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxshot-'));
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run',
  '--hide-scrollbars', '--window-size=1440,860', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=' + userDataDir, '--remote-debugging-port=' + PORT,
  '--host-resolver-rules=MAP *.chaoxing.com 127.0.0.1', 'about:blank'], { stdio: 'ignore' });

await sleep(3000);
const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?` + encodeURIComponent(target + '/mycourse/studentstudy?mode=normal&pid=shot'), { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));

let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable');
await send('Runtime.enable');
await sleep(1000);
const script = fs.readFileSync(path.join(ROOT, 'chaoxing-auto-next.user.js'), 'utf8');
await send('Runtime.evaluate', { expression: script, awaitPromise: true });
await sleep(6000);
await send('Runtime.evaluate', {
  expression: `(function(){
    var h = document.getElementById('cxauto-panel-host');
    if (h) { h.style.left = '1110px'; h.style.top = '70px'; h.style.bottom = ''; }
    return !!h;
  })()`
});
await sleep(800);
const shot = await send('Page.captureScreenshot', { format: 'png' });
const out = path.join(ROOT, 'docs', 'panel.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out, fs.statSync(out).size, 'bytes');

edge.kill();
await server.close();
await sleep(300);
try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(0);
