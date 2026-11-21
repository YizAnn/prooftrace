/* Edge headless + CDP test harness (no external deps) */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PAGE = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-edge-'));
const WINDOW_SIZE = process.env.CDP_WINDOW || '1440,1000';

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function freePort(){
  return new Promise(function(resolve, reject){
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function(){
      const p = s.address().port;
      s.close(function(){ resolve(p); });
    });
  });
}

async function getJSON(url){
  const r = await fetch(url);
  return r.json();
}

(async () => {
  const PORT = await freePort();
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--allow-file-access-from-files', '--window-size=' + WINDOW_SIZE, 'about:blank'
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60; i++){
    try { targets = await getJSON('http://127.0.0.1:' + PORT + '/json'); break; }
    catch(e){ await sleep(300); }
  }
  if (!targets) throw new Error('Edge did not start');

  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const logs = [];
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)){
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown'){
      errors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description || ''));
    } else if (msg.method === 'Runtime.consoleAPICalled'){
      logs.push(msg.params.type + ': ' + msg.params.args.map(a => a.value || a.description || '').join(' '));
    } else if (msg.method === 'Log.entryAdded'){
      logs.push('log/' + msg.params.entry.level + ': ' + msg.params.entry.text);
    }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Page.navigate', { url: PAGE });
  await sleep(2500);

  const testFile = process.argv[2] || 'tests/browser_tests.js';
  const testSrc = fs.readFileSync(testFile, 'utf8');
  const res = await send('Runtime.evaluate', {
    expression: testSrc,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });

  const out = { result: res.result && res.result.value, exception: res.exceptionDetails ? res.exceptionDetails.text : null, errors, logs: logs.slice(0, 50) };
  const outFile = process.argv[3] || 'tests/browser_result.json';
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));

  ws.close();
  child.kill();
  process.exit(0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
