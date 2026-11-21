# P7.2 测试脚本

Node 契约/运行时/评分/启动测试直接运行：

```bash
node tests/agent_contract_tests.js
node tests/agent_runtime_tests.js
node tests/p7_scoring_agent_tests.js
node tests/server_startup_test.js
```

浏览器回归使用本机 Edge + CDP：

```bash
node tests/cdp_test.js tests/browser_tests.js
```

截图与录屏脚本依赖 Playwright。本仓库未附带 `recording/node_modules`；如需重跑，请在本机安装 Playwright 后，将脚本中的 `../recording/node_modules/playwright` 改为 `playwright`。

真实模型调用记录脚本在用户本人配置 API Key 后运行：

```bash
PROOFTRACE_BASE=http://127.0.0.1:8790 node tests/_p72_live_agent.js
```
