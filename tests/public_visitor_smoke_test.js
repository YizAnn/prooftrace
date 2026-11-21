/* 公网访客模式冒烟测试：
   - HOST=0.0.0.0 且未设 PROOFTRACE_AUTH_TOKEN 时进入访客模式，浏览器同源请求不应 401；
   - 页面密钥配置/删除接口在公网模式下禁用；
   - /api/probe 公网默认禁用；SSRF 防护拒绝本机/内网/链路本地地址；
   - AI 计费接口受每日预算闸门约束；
   - 本机 loopback 模式行为保持不变。 */
const assert = require('assert');
const http = require('http');

function request(port, method, pathname, body) {
  return new Promise(function (resolve, reject) {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: port, path: pathname, method: method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json: json });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
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

function clearServerModules() {
  ['../server/server.js', '../server/run_local.js'].forEach(function (p) {
    try { delete require.cache[require.resolve(p)]; } catch (e) {}
  });
}

(async function () {
  const results = [];
  const servers = [];
  function T(name, fn) {
    return Promise.resolve().then(fn).then(function (detail) {
      results.push({ name: name, pass: true, detail: detail || null });
    }).catch(function (e) {
      results.push({ name: name, pass: false, err: String(e && e.message || e) });
    });
  }

  /* 场景一：公网访客模式（0.0.0.0，无令牌；假密钥仅用于让预算扣减路径生效，不产生真实计费） */
  let publicAddr = null;
  await T('public_visitor_mode_health_and_static', async function () {
    clearServerModules();
    process.env.PORT = '0';
    process.env.HOST = '0.0.0.0';
    delete process.env.PROOFTRACE_AUTH_TOKEN;
    process.env.AI_API_KEY = 'sk-smoke-fake-not-real';
    delete process.env.AI_API_KEY_FILE;
    delete process.env.PROOFTRACE_ENABLE_PROBE;
    process.env.PROOFTRACE_VISITOR_DAILY_CALLS = '1';
    const server = require('../server/server.js').startServer();
    servers.push(server);
    publicAddr = await waitListening(server);

    const health = await request(publicAddr.port, 'GET', '/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.json.ok, true);
    assert.strictEqual(health.json.publicMode, true);
    assert.strictEqual(health.json.setup.canSetup, false);
    assert.strictEqual(health.json.setup.publicMode, true);
    assert.ok(health.json.visitor && health.json.visitor.dailyPerIp === 1);
    assert.strictEqual(health.json.visitor.probeEnabled, false);

    const home = await request(publicAddr.port, 'GET', '/');
    assert.strictEqual(home.status, 200);
    assert.ok(/text\/html/.test(home.headers['content-type'] || ''));

    const stats = await request(publicAddr.port, 'GET', '/api/registry/stats');
    assert.strictEqual(stats.status, 200);
    assert.ok(stats.json.records > 0);

    const list = await request(publicAddr.port, 'GET', '/api/registry/list?limit=8');
    assert.strictEqual(list.status, 200);
    assert.ok(Array.isArray(list.json.records));

    return { port: publicAddr.port, records: stats.json.records, configured: health.json.configured };
  });

  await T('public_disables_setup_key_and_clear', async function () {
    const key = await request(publicAddr.port, 'POST', '/api/setup/key', { key: 'sk-fake-key-for-test-only-00000000000000', model: 'qwen-plus' });
    assert.strictEqual(key.status, 403);
    assert.strictEqual(key.json.error.code, 'setup_disabled_public');
    const clear = await request(publicAddr.port, 'POST', '/api/setup/clear', {});
    assert.strictEqual(clear.status, 403);
    assert.strictEqual(clear.json.error.code, 'setup_disabled_public');
  });

  await T('public_probe_disabled_by_default', async function () {
    const probe = await request(publicAddr.port, 'POST', '/api/probe', { url: 'https://example.com/' });
    assert.strictEqual(probe.status, 403);
    assert.strictEqual(probe.json.error.code, 'probe_disabled_public');
  });

  await T('public_ai_budget_gate_blocks_after_quota', async function () {
    const body = { text: '这是一段用于触发 AI 计费路径的公开资料文本，长度超过八十字，仅用于验证公网预算闸门，不构成任何真实企业事实陈述。', sourceUrl: 'https://example.com/notice', publishDate: '2026-01-01', companyId: 'acme', companyName: '测试企业', inputTextType: 'unknown' };
    const first = await request(publicAddr.port, 'POST', '/api/ai/extract', body);
    /* 假密钥不会产生真实计费；首次调用应通过预算闸门（上游鉴权/不可达属预期失败），并计入访客预算。 */
    assert.notStrictEqual(first.status, 429);
    const second = await request(publicAddr.port, 'POST', '/api/ai/extract', body);
    assert.strictEqual(second.status, 429);
    assert.strictEqual(second.json.error.code, 'budget_ip');
  });

  /* 场景二：开启 probe 后，SSRF 防护拒绝内网/回环/链路本地地址。 */
  let probeAddr = null;
  await T('probe_ssrf_guard_rejects_private_targets', async function () {
    clearServerModules();
    process.env.PORT = '0';
    process.env.HOST = '0.0.0.0';
    process.env.PROOFTRACE_ENABLE_PROBE = '1';
    delete process.env.PROOFTRACE_AUTH_TOKEN;
    delete process.env.AI_API_KEY;
    const server = require('../server/server.js').startServer();
    servers.push(server);
    probeAddr = await waitListening(server);

    const loopback = await request(probeAddr.port, 'POST', '/api/probe', { url: 'http://127.0.0.1/' });
    assert.strictEqual(loopback.status, 200);
    assert.strictEqual(loopback.json.ok, false);
    assert.ok(/内网|本机/.test(loopback.json.message || ''));

    const metadata = await request(probeAddr.port, 'POST', '/api/probe', { url: 'http://169.254.169.254/latest/meta-data/' });
    assert.strictEqual(metadata.status, 200);
    assert.strictEqual(metadata.json.ok, false);

    const badScheme = await request(probeAddr.port, 'POST', '/api/probe', { url: 'file:///etc/passwd' });
    assert.strictEqual(badScheme.status, 400);
  });

  /* 场景三：本机 loopback 模式保持原有形态。 */
  await T('loopback_mode_unchanged', async function () {
    clearServerModules();
    process.env.PORT = '0';
    process.env.HOST = '127.0.0.1';
    delete process.env.PROOFTRACE_AUTH_TOKEN;
    delete process.env.AI_API_KEY;
    const server = require('../server/server.js').startServer();
    servers.push(server);
    const addr = await waitListening(server);
    const health = await request(addr.port, 'GET', '/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.json.publicMode, false);
    assert.strictEqual(health.json.setup.canSetup, true);
    assert.strictEqual(addr.address, '127.0.0.1');
  });

  servers.forEach(function (s) { try { s.close(); } catch (e) {} });

  const fails = results.filter(function (r) { return !r.pass; });
  console.log(JSON.stringify({ cases: results, passAll: fails.length === 0 }, null, 2));
  process.exitCode = fails.length ? 1 : 0;
})().catch(function (e) {
  console.log(JSON.stringify({ cases: [{ name: 'harness', pass: false, err: String(e && e.stack || e) }], passAll: false }, null, 2));
  process.exitCode = 1;
});
