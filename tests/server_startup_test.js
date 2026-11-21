/* 启动链路回归：验证 run_local.js 真的监听端口，并验证 /api/health 的 configured 状态。 */
const assert = require('assert');
const http = require('http');

function getJson(port, path) {
  return new Promise(function (resolve, reject) {
    const req = http.get({ host: '127.0.0.1', port: port, path: path, timeout: 4000 }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', function () { req.destroy(new Error('health timeout')); });
    req.on('error', reject);
  });
}

function waitListening(server) {
  return new Promise(function (resolve, reject) {
    if (server.listening) return resolve(server.address());
    const timer = setTimeout(function () { reject(new Error('服务未在 5 秒内监听端口')); }, 5000);
    server.once('listening', function () { clearTimeout(timer); resolve(server.address()); });
    server.once('error', function (e) { clearTimeout(timer); reject(e); });
  });
}

function close(server) {
  return new Promise(function (resolve) { server.close(function () { resolve(); }); });
}

function clearServerModules() {
  ['../server/server.js', '../server/run_local.js'].forEach(function (p) {
    try { delete require.cache[require.resolve(p)]; } catch (e) {}
  });
}

(async function () {
  const results = [];
  function T(name, fn) {
    return Promise.resolve().then(fn).then(function (detail) {
      results.push({ name: name, pass: true, detail: detail || null });
    }).catch(function (e) {
      results.push({ name: name, pass: false, err: String(e && e.message || e) });
    });
  }

  await T('run_local_starts_without_key', async function () {
    clearServerModules();
    process.env.PORT = '0';
    process.env.HOST = '127.0.0.1';
    delete process.env.AI_API_KEY;
    delete process.env.AI_API_KEY_FILE;
    const server = require('../server/run_local.js');
    const addr = await waitListening(server);
    const res = await getJson(addr.port, '/api/health');
    await close(server);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.service, 'prooftrace-ai-proxy');
    assert.strictEqual(res.body.configured, false);
    assert.strictEqual(addr.address, '127.0.0.1');
    assert.strictEqual(res.body.port, addr.port);
    return { address: addr.address, port: addr.port, configured: res.body.configured, note: res.body.note };
  });

  await T('run_local_starts_with_key', async function () {
    clearServerModules();
    process.env.PORT = '0';
    process.env.HOST = '127.0.0.1';
    process.env.AI_API_KEY = 'sk-startup-contract-test';
    const server = require('../server/run_local.js');
    const addr = await waitListening(server);
    const res = await getJson(addr.port, '/api/health');
    await close(server);
    delete process.env.AI_API_KEY;
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.configured, true);
    assert.strictEqual(res.body.model, 'qwen-plus');
    return { configured: res.body.configured, model: res.body.model, address: addr.address };
  });

  const fails = results.filter(function (r) { return !r.pass; });
  console.log(JSON.stringify({ cases: results, passAll: fails.length === 0 }, null, 2));
  process.exitCode = fails.length ? 1 : 0;
})().catch(function (e) {
  console.log(JSON.stringify({ cases: [{ name: 'startup_harness', pass: false, err: String(e && e.stack || e) }], passAll: false }, null, 2));
  process.exitCode = 1;
});
