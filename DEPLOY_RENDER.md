# ProofTrace P8.4 — Render 公网部署操作说明

本文档说明如何把 `ProofTrace_P8_4_Integrated` 以**最小侵入式**方式部署到 Render。现有 UI、企业名录、证据核验、专家评分、报告导出与 AI Agent 逻辑均未改动；本次只新增部署清单、公网访客模式、限流/预算与 SSRF 加固。

> 约定：仓库根目录 = 本目录（`ProofTrace_P8_4_Integrated`）。外层解压目录 `ProofTrace_P8.4_20261122 2` 不入库、不上传。

---

## 1. 部署形态概览

- 纯 Node.js（内置 `http`/`dns`/`fetch`），**无第三方 npm 依赖**，`npm install` 仅为兼容 Render 构建流程。
- 同一个 `server/server.js` 支持两种模式，由监听地址自动判定：
  - **本机模式**（`HOST=127.0.0.1`，默认）：行为与原来完全一致，页面可首次配置密钥、DPAPI 加密保存。
  - **公网模式**（`HOST=0.0.0.0`，Render 启动方式）：
    - 未设 `PROOFTRACE_AUTH_TOKEN` → **访客模式**：浏览器同源访问只读名录/核验/评分/导出，AI 接口受控开放；
    - 设了 `PROOFTRACE_AUTH_TOKEN` → **令牌模式**：所有 `/api/*` 需携带 `Bearer <token>`。
- 前端静态页面、离线名录 JSON、Agent SSE 流式响应均由同一服务同源下发，不跨域。

## 2. 环境变量清单

### 2.1 必需 / 推荐（Render 控制台 Environment 或 render.yaml）

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `AI_API_KEY` | AI 功能需要 | 无 | 模型上游 API Key。**只从服务端环境变量读取**，不写入前端 HTML、localStorage、日志或仓库；公网模式不读取本机密钥文件/DPAPI。 |
| `AI_API_BASE` | 否 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容接口地址（`/chat/completions` 由服务端拼接）。 |
| `AI_MODEL` | 否 | `qwen-plus` | 模型名称。 |
| `HOST` | 公网必填 | `127.0.0.1` | Render 必须设为 `0.0.0.0`，否则外部无法连接。 |
| `PORT` | 否（平台注入） | `8787` | Render 自动注入，**不要在控制台手动固定**；服务监听该端口。 |

### 2.2 访客限流与预算（公网模式生效，本机模式不启用）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PROOFTRACE_VISITOR_RPM` | `60` | 单 IP 每分钟全部 API 请求上限（只读 + AI）。 |
| `PROOFTRACE_VISITOR_DAILY_CALLS` | `20` | 单 IP 每日 AI 计费接口调用上限（`/api/ai/extract`、`/api/ai/analyze`、`/api/agent/chat`）。 |
| `PROOFTRACE_DAILY_AI_CALLS` | `100` | 整站每日 AI 计费接口全局上限，防止上游额度被耗尽。 |
| `PROOFTRACE_RATE_LIMIT` | `240` | 全局单 IP 每分钟基础限流（原有逻辑，保留）。 |
| `PROOFTRACE_ENABLE_PROBE` | `0` | 公网默认**禁用** `/api/probe` 网址探测；确需开启置 `1`（已带 SSRF 防护）。 |

### 2.3 可选 / 鉴权与上游行为

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PROOFTRACE_AUTH_TOKEN` | 空 | 留空 = 访客模式；填写后 = 令牌模式，前端以外的调用必须带 `Authorization: Bearer <token>`。 |
| `AI_TIMEOUT_MS` | `90000` | 单次模型调用超时（毫秒）。 |
| `AGENT_SEARCH_MODE` | `off` | Agent 联网搜索模式；`off` 时如实提示不可用，不伪造结果。 |
| `AI_SEARCH_ENABLED` | 未设置 | 设 `1` 且 `AGENT_SEARCH_MODE` 未显式指定时，搜索模式回落为 `dashscope`。 |
| `AI_SEARCH_ENDPOINT` | DashScope 默认搜索地址 | 联网搜索上游端点（仅搜索模式启用时使用）。 |
| `AI_API_KEY_FILE` | 无 | **仅本机模式**可用；公网模式被忽略，不读取磁盘密钥文件。 |

> 限流/预算计数为**进程内内存态**：Render 免费实例冷启动、休眠唤醒或扩容后计数会重置；如需跨实例持久配额，需另接外部存储（本期未做）。

## 3. 部署前本地检查

在项目根目录（`ProofTrace_P8_4_Integrated`）执行：

```powershell
node --check server/server.js
node --check server/agent.js
node tests/server_startup_test.js
node tests/public_visitor_smoke_test.js
node tests/agent_contract_tests.js
node tests/agent_runtime_tests.js
node tests/p7_scoring_agent_tests.js
```

预期：公网访客冒烟测试 6 项全部 `passAll: true`；Agent 契约/运行时/P7 评分测试 `passAll: true`。

> 已知环境现象：`server_startup_test.js` 第一条在**本机已保存 DPAPI 密钥**的机器上可能显示 `configured=true` 而失败；这是本机既有凭据导致，与本次公网改造无关，换干净环境或清除本机凭据后即恢复 `configured=false` 断言。

## 4. GitHub 仓库准备（需你手动确认后执行）

> ⚠️ 按你的要求：**我没有创建任何代码仓库**。以下步骤需要你本人操作；建议首次使用 **Private（私有）仓库**，确认无敏感信息后再考虑公开。

1. 确认仓库根目录内容为 `ProofTrace_P8_4_Integrated` 内部文件（`server/`、`data/`、`tests/`、`tools/`、`index.html`、`home.html`、`package.json`、`render.yaml` 等），**不要**把外层 `ProofTrace_P8.4_20261122 2` 目录提交进去。
2. 该目录已附带 `.gitignore`，排除 `node_modules/`、`.env*`、日志与本机 `secret.bin`。
3. 本地初始化并推送（示例，仓库地址以你在 GitHub 新建的为准）：

```powershell
cd "ProofTrace_P8_4_Integrated"
git init
git add .
git commit -m "ProofTrace P8.4: Render public visitor-mode adaptation"
# 关联你本人创建的私有仓库后：
# git remote add origin <your-private-repo-url>
# git push -u origin main
```

4. 推送前自查：仓库内不得出现真实 `AI_API_KEY`、`secret.bin`、`.env` 文件。

## 5. Render 部署（二选一）

### 方式 A：Blueprint 自动识别（推荐）

1. 登录 Render 控制台 → **New** → **Blueprint**。
2. 连接第 4 步的仓库；Render 自动读取根目录 `render.yaml`。
3. 蓝图中 `AI_API_KEY`、`PROOFTRACE_AUTH_TOKEN` 标记为 `sync:false`，需要在弹出的环境变量面板手动填写；其余变量已在蓝图内给默认值。
4. 计划选择 **Free**（免费），确认不要选付费实例。
5. 点击 **Apply / Create**，等待构建与部署完成。

### 方式 B：手动新建 Web Service

1. **New** → **Web Service** → 连接仓库。
2. 配置项：
   - **Runtime**：Node
   - **Build Command**：`npm install`
   - **Start Command**：`node server/server.js`
   - **Health Check Path**：`/api/health`
   - **Plan**：Free
3. Environment 中按第 2 节填写变量，至少设置：
   - `HOST=0.0.0.0`
   - `AI_API_KEY=<你的模型密钥>`
   - `AI_API_BASE`、`AI_MODEL`（如沿用默认百炼可不动）
4. 保存后触发首次部署。

## 6. 部署后验证清单

部署完成后访问 Render 分配的公网域名（形如 `https://prooftrace-xxxx.onrender.com`）：

| 检查项 | 操作 / 预期 |
| --- | --- |
| 健康检查 | `GET /api/health` → `200`，`ok:true`，`publicMode:true`，`setup.canSetup:false`，`visitor` 含 rpm/每日上限。 |
| 首页 | 打开根路径 → 工作台正常渲染，无 401 报错；右上角不出现可提交密钥的“配置模型”入口（公网已禁用）。 |
| 企业名录 | 名录页加载出 6190 条左右离线记录；搜索/核验（如“一城一家”）返回命中。 |
| 专家评分 | 切换到模型/评分视图，四维分与等级正常显示（纯前端确定性计算，不依赖上游模型）。 |
| AI 对话（未配密钥时） | Agent 对话返回明确的“模型未配置”错误，不伪装结论；流式通道 `text/event-stream` 正常建立。 |
| AI 对话（已配密钥） | 粘贴公开资料可完成抽取/分析草稿；连续调用达到单 IP 每日上限后返回 `429 budget_ip`；全局达上限返回 `429 budget_global`。 |
| 流式响应 | Agent 对话为 SSE（`event: open/tool/final/error`），断流时有“未收到最终结果”的前端提示。 |
| 报告导出 | 服务端无 `/api/export` 路由时前端自动回落**本地导出**（HTML/CSV/压缩包），浏览器触发下载；不依赖服务端生成文档。 |
| 禁用接口 | `POST /api/setup/key`、`POST /api/setup/clear` → `403 setup_disabled_public`；`POST /api/probe`（默认）→ `403 probe_disabled_public`。 |
| SSRF | 即使开启 probe，探测 `127.0.0.1`、`169.254.169.254`、`10.x`、`192.168.x` 等地址会被拒绝。 |

## 7. 安全边界与残留风险

已做：
- 公网模式禁用页面写密钥/删凭据；密钥只走服务端环境变量；响应与日志不回显密钥。
- 访客限流、单 IP 每日 AI 次数、整站每日 AI 全局预算。
- `/api/probe` 拒绝本机/内网/链路本地/保留域名与解析地址，重定向逐跳校验（最多 3 跳），公网默认关闭。
- 请求体上限沿用 1MB；模型超时沿用 90 秒；片段逐字比对、企业绑定、失败即失败等原有约束不变。

残留风险（需知悉）：
- 内存态配额在实例重启/休眠后重置；免费实例有冷启动与休眠限制。
- SSRF 防护存在 DNS 重绑定（TOCTOU）理论窗口：校验解析结果与实际请求之间域名可能切换；probe 已默认关闭，风险可控。
- 上游模型额度/欠费由你的百炼（或其他兼容渠道）账户侧管控，应用层预算只是第二道防线。
- 本服务不承担登录鉴权与多租户隔离；如需区分操作者，请在上游反向代理/平台层加访问控制，或设置 `PROOFTRACE_AUTH_TOKEN` 进入令牌模式。

## 8. 回滚与本地恢复

- 本地开发/使用不受影响：双击 `启动ProofTrace.cmd`（等价 `node server/run_local.js`），仍监听 `127.0.0.1:8787`，页面首次配置密钥与 DPAPI 保存逻辑保持原样。
- Render 回滚：在 Deployments 页选择上一次部署版本 Rollback；环境变量改动可随时在 Environment 面板调整后手动触发 Rebuild。
- 本次未删除任何原有文件；新增文件清单见交付总结。
