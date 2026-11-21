/* 首页体验入口直达工作台测试（Edge headless + CDP，无外部依赖）。
   覆盖：未登录状态下，从首页 iframe 点击体验入口（主 CTA / 模块直达），
   复用现有 demoLogin() 演示身份直接进入工作台，不弹出登录框、无须填写五项登录信息。
   桌面视口与手机视口分别验证。 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PAGE = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-edge-entry-'));

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
async function getJSON(url){ const r = await fetch(url); return r.json(); }

/* 在顶层页面执行一次入口点击并回读工作台状态。 */
function caseExpression(selector, expectView){
  return '(async function(sel, expectView){' +
    'const f=document.getElementById("p8-home-frame");' +
    'if(!f||!f.contentWindow) return {pass:false,err:"no home iframe"};' +
    'const w=f.contentWindow, d=w.document;' +
    'let ready=false;' +
    'for(let i=0;i<50;i++){ ready=!!w.__p86BridgeReady; if(ready) break; await new Promise(r=>setTimeout(r,100)); }' +
    'if(!ready) return {pass:false,err:"home bridge not ready"};' +
    'let btn=null;' +
    'for(let i=0;i<50;i++){ btn=d.querySelector(sel); if(btn) break; await new Promise(r=>setTimeout(r,100)); }' +
    'if(!btn) return {pass:false,err:"selector not found: "+sel};' +
    'const before={loginHidden:document.getElementById("login").hidden,bodyView:document.body.dataset.view,hadUser:!!state.user};' +
    'btn.click();' +
    'await new Promise(r=>setTimeout(r,450));' +
    'const u=state.user||{};' +
    'const appHidden=document.getElementById("app").hidden;' +
    'const loginHidden=document.getElementById("login").hidden;' +
    'const bodyView=document.body.dataset.view;' +
    'const view=state.view;' +
    'const pass=!!u.role && appHidden===false && loginHidden===true && bodyView!=="login" && (!expectView||view===expectView);' +
    'return {pass:pass,selector:sel,expectView:expectView,before:before,after:{name:u.name,no:u.no,role:u.role,org:u.org,view:view,bodyView:bodyView,appHidden:appHidden,loginHidden:loginHidden}};' +
    '})(' + JSON.stringify(selector) + ',' + JSON.stringify(expectView || null) + ')';
}

(async () => {
  const PORT = await freePort();
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--allow-file-access-from-files', '--window-size=1440,1000', 'about:blank'
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
    ws.send(JSON.stringify({ id: mid, method: method, params: params || {} }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');

  const cases = {};
  async function runCase(label, selector, expectView, mobile){
    if (mobile){
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    } else {
      await send('Emulation.clearDeviceMetricsOverride', {});
    }
    await send('Runtime.evaluate', { expression: 'try{localStorage.clear()}catch(e){}' });
    await send('Page.navigate', { url: PAGE });
    await sleep(2500);
    const res = await send('Runtime.evaluate', {
      expression: caseExpression(selector, expectView),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    cases[label] = res.result && res.result.value;
    if (res.exceptionDetails) cases[label] = { pass:false, err: res.exceptionDetails.text };
  }

  /* 桌面端：头部“进入工作台”主 CTA → 今日待判队列 */
  await runCase('desktop_header_enter_workbench', '[data-action="landing-try"]', 'queue', false);
  /* 桌面端：模块直达“查看原始记录” → 证据中心 */
  await runCase('desktop_module_direct_evidence', '[data-p86-go="evidence"]', 'evidence', false);
  /* 手机端：首屏“开始寻证”主 CTA → 今日待判队列 */
  await runCase('mobile_hero_cta_enter_workbench', '[data-action="landing-try"]', 'queue', true);

  const out = {
    cases: cases,
    passAll: Object.keys(cases).every(k => cases[k] && cases[k].pass),
    exception: null,
    errors: errors,
    logs: logs.slice(0, 50)
  };

  const outFile = process.argv[2] || 'tests/entry_result.json';
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));

  ws.close();
  child.kill();
  process.exit(out.passAll ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
