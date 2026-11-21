# ProofTrace AI 解析代理（最小可用）

## 作用

页面上的「AI 解析」把用户粘贴的**公开资料文本**发到本机代理，代理再调用 OpenAI 兼容的 `/chat/completions`，要求模型按固定 JSON 结构抽取：

- 企业或研究机构
- 技术、专利、产品、科研成果
- 关键数值、单位、比较词与时间
- 原文支持片段
- 证据支持的事实
- 尚需进一步核实的事项

代理只做转发、结构校验与片段比对，不做判断、不补写、不出分。文本可能是原文，也可能是人工改写或摘要；请求必须带上 `inputTextType`，系统不会自动抓取来源网址。

## 启动

需要 Node.js 18+（内置 `fetch`）。

### 推荐：Windows 一键启动

双击项目根目录的 `启动ProofTrace.cmd`。脚本会检查 Node.js 版本，读取磁盘上的服务/Agent 版本，从 8787 起扫描端口；只有版本完全匹配才复用现有服务，旧版本服务会被跳过而不是终止。启动后最多等待 20 秒健康检查，成功后打开正确地址。

首次使用不需要在命令行输入密钥。页面右上角“配置模型”会引导用户本人填写阿里百炼 API Key；服务端先用它发起一次最小真实请求验证，成功后用 Windows DPAPI（CurrentUser）加密保存到 `%LOCALAPPDATA%\ProofTrace\secret.bin`，并限制为当前用户可读。密钥不写入 HTML、localStorage、源码、日志或交付包。

命令行参数（可加在 cmd 后）：

```bat
启动ProofTrace.cmd -CheckOnly -NoBrowser
```

- `-CheckOnly`：只做版本与端口检查，不启动服务、不打开浏览器。
- `-NoBrowser`：启动成功后不自动打开浏览器。

### 手动启动

开发调试时可以通过环境变量注入密钥（仅限本机临时调试，不作为交付配置）：

```powershell
$env:AI_API_BASE="https://dashscope.aliyuncs.com/compatible-mode/v1"
$env:AI_API_KEY="sk-REPLACE_ME"
$env:AI_MODEL="qwen-plus"
node server/run_local.js
# 或 node server/server.js
```

Git Bash：

```bash
AI_API_BASE="https://dashscope.aliyuncs.com/compatible-mode/v1" \
AI_API_KEY="sk-REPLACE_ME" \
AI_MODEL="qwen-plus" \
node server/run_local.js
```

默认监听 `127.0.0.1:8787`；一键启动会在端口被占用时自动选择后续端口。前端通过同源 `location.origin` 发现当前服务。

未配置密钥时服务仍可启动，`/api/health` 返回 `configured:false`；Agent 与 AI 接口返回明确的 `model_unconfigured` / 503，页面引导配置，不会伪装已接入。离线浏览、企业档案、证据与报告功能不受影响。

## 接口

### GET /api/health

```json
{"ok":true,"service":"prooftrace-ai-proxy","version":"4.3","host":"127.0.0.1","port":8787,"node":"24.x","configured":true,"model":"qwen-plus","keySource":"dpapi","agent":{"version":"1.3"},"note":"已配置。"}
```

`configured=false` 时，`/api/ai/extract` 与 `/api/ai/analyze` 会返回 503，页面会明确显示“服务已启动，但模型未配置”，不会展示任何预置结论。前端“测试连接”按钮实际调用本接口，不会触发模型计费。

### POST /api/ai/extract

请求：

```json
{
  "text": "公开资料文本（至少 80 字，可为原文或人工摘要）",
  "sourceUrl": "https://...",
  "publishDate": "2026-07-15",
  "sourceName": "中国政府采购网·中标公告",
  "companyId": "acme",
  "companyName": "中科艾科米（北京）科技有限公司",
  "inputTextType": "source_verbatim"
}
```

`companyId` / `companyName` 必填，缺少时返回 400，避免在未绑定目标企业的情况下解析。`inputTextType` 取 `source_verbatim` / `user_paraphrase` / `unknown`。

成功：

```json
{
  "ok": true,
  "model": "...",
  "createdAt": "2026-11-21T...",
  "elapsedMs": 1234,
  "usage": {},
  "targetCompany": {"id":"acme","name":"中科艾科米（北京）科技有限公司"},
  "inputTextType": "source_verbatim",
  "source": {"name":"...","url":"https://...","date":"2026-07-15","inputTextType":"source_verbatim","fetched":false},
  "verify": {"total": 8, "verified": 8},
  "data": {
    "organization": {},
    "subjectMatch": {"candidate":"", "matched":null, "basis":"", "snippet":"", "targetRole":"supplier|buyer|participant|publisher|other", "needsReview":true},
    "events": [{"amountRaw":"459.5万元", "amountValue":459.5, "amountUnit":"万元", "amountCny":4595000}],
    "technologies": [],
    "patents": [],
    "products": [],
    "researchResults": [],
    "quantities": [{"label":"温度", "operator":"<", "value":3, "unit":"K"}],
    "facts": [{"statement":"", "support":"strong|medium|weak", "snippet":"", "_snippetVerified":true, "_statementVerified":false, "_statementReviewRequired":true}],
    "pendingVerification": [],
    "warnings": []
  }
}
```

`verify` 只表示片段是否逐字出现在输入文本中，不表示事实已被核实。事实默认 `_statementVerified:false`，必须人工复核；服务端还会标出金额单位、比较词、否定关系、主体角色等与片段不一致的情况。

金额一致性规则（确定性检查，不依赖模型）：

- 原文可解析时，以 `amountRaw` 的数值和单位为准；与 `amountValue` / `amountUnit` 不一致会写 `amount_raw_value_mismatch` / `amount_raw_unit_mismatch`。
- 币种只认原文明确写出的部分。原文与结构化 `currency` 不一致写 `amount_currency_mismatch`；原文没有币种时写 `amount_currency_unknown`，不把“100 万”默认成人民币。
- `amountCny` 只由服务端按原文重新计算，并标记 `_amountCnySource:'computed'`；模型返回的 `amountCny` 不采信，差异写 `amount_cny_recomputed`。
- 非人民币金额（USD/EUR/HKD/JPY）`amountCny` 置 `null`，写 `amount_currency_not_cny`，不折算、不保存为人民币金额。
- 检查结果在 `_amountCheck`：`flags`、`labels`、`currency`、`currencyKnown`、`computedCny`、`reviewRequired`。
- `quantities` 缺少比较词时写 `operator_missing`；与片段不一致写 `operator_mismatch` / `operator_not_in_snippet`，结果在 `_operatorCheck`。

### POST /api/ai/analyze

根据本页证据生成“技术价值分析草稿”。只做归纳与待核问题整理，不做评分、估值或授信结论。

请求：

```json
{
  "companyId": "acme",
  "companyName": "中科艾科米（北京）科技有限公司",
  "evidence": [
    {"id":"EV-001", "title":"...", "summary":"...", "quote":"", "date":"2026-07-15",
     "source":"...", "url":"https://...", "grade":"B", "mark":"采信|存疑|待核实|未标记",
     "reviewStatus":"page_read", "origin":"manual", "inputTextType":"unknown",
     "caveat":"...", "impact":"...", "invalid":[], "conflict":false, "dataSource":"public"}
  ],
  "judgements": [{"id":"CL-TECH-01", "title":"...", "status":"...", "statusText":"...", "evidenceIds":["EV-001"]}],
  "boundaries": "仅使用公开资料；不输出评分、估值或授信结论"
}
```

约束：

- `evidence` 必填，1–30 条；`companyId` / `companyName` 必填。
- 模型只能引用 `evidence` 中实际存在的 `id`；不存在的 ID 会被服务端剔除并记入 `analysis.stats.invalidEvidenceIds`。
- 只引用不存在 ID 的条目会被丢弃；全部条目被丢弃时返回 502，不回落到预置文本。
- `mark` 为“存疑 / 待核实 / 未标记”的证据只能生成“调查线索”，`note` 强制带“仅作调查线索，不得作为已确认事实。”。
- 命中评分、估值、授信额度、贷款余额、投资建议等禁用词的条目会被丢弃。
- 每条判断固定 `reviewRequired:true`；`nextSteps` 可带证据 ID，也可为空。

成功：

```json
{
  "ok": true,
  "model": "...",
  "createdAt": "2026-11-21T...",
  "elapsedMs": 1234,
  "reviewRequired": true,
  "inputEvidenceIds": ["EV-001"],
  "analysis": {
    "sections": [
      {"key":"technicalCapability", "title":"技术能力与技术路线", "items":[
        {"section":"technicalCapability", "claim":"...", "evidenceIds":["EV-001"],
         "evidenceStatus":"confirmed|pending|doubtful", "evidenceStatusText":"...",
         "confidence":"high|medium|low", "note":"...", "reviewRequired":true}
      ]},
      {"key":"technologyAssets", "title":"技术资产与权属", "items":[]},
      {"key":"rdAdvancement", "title":"研发及技术先进性线索", "items":[]},
      {"key":"commercialization", "title":"成果转化与商业化线索", "items":[]},
      {"key":"whyWatch", "title":"值得进一步关注的原因", "items":[]},
      {"key":"gapsAndNextSteps", "title":"证据不足与下一步尽调问题", "items":[]}
    ],
    "nextSteps": [{"question":"...", "evidenceIds":["EV-001"], "reviewRequired":true}],
    "warnings": [],
    "stats": {"inputEvidence":11, "citedEvidence":6, "items":9, "droppedItems":0, "invalidEvidenceIds":[]}
  }
}
```

失败：

```json
{"ok": false, "error": {"message": "模型调用失败：...", "code": "upstream_auth", "detail": "..."}}
```

`code` 用于前端区分失败原因，前端同时保留原始错误，便于排查：

- `timeout`：模型调用超时。
- `upstream_auth` / `upstream_forbidden` / `upstream_quota` / `upstream_rate_limit`：上游 401 / 403 / 402 / 429。
- `upstream_unreachable`：无法连接上游模型服务。
- `invalid_response`：上游返回缺少 `choices[0].message` 或不是合法 JSON。
- `upstream_error` / `unknown`：其他上游错误或无法判定。

## 安全与真实性约束

1. **密钥由用户本人配置，经 DPAPI 加密保存。** 前端 HTML、localStorage、导出文件均不保存密钥；日志与响应不输出密钥。仅开发调试可使用环境变量临时注入。
2. **公网监听分两种模式。** 非 loopback 监听时：未设置 `PROOFTRACE_AUTH_TOKEN` 为**访客模式**，浏览器同源可访问只读与受控 AI 接口，页面密钥配置/删除接口禁用，AI 调用受访客限流与每日预算约束；设置了 `PROOFTRACE_AUTH_TOKEN` 为**令牌模式**，所有 `/api` 请求需携带 `Bearer` 令牌。全局默认限流 240 次/分钟；访客模式另有单 IP 每分钟限流、单 IP 每日 AI 次数与全局每日 AI 次数预算。CORS 仅允许本机来源、`null` 与公网同源来源。
3. **来源网址强制使用用户填写值。** 模型输出里的任何 URL 都不会进入证据；网址只是标识，系统不会自动抓取网页。
4. **片段必须逐字匹配。** 服务端与前端各校验一次；未匹配的条目在前端标红并禁止导入。片段匹配只证明输入文本包含该句，不证明事实真实或陈述被片段蕴含。
5. **结果绑定目标企业。** 服务端把 `companyId` / `companyName` 写入提示词与结果；前端导入时校验请求快照，跨企业导入会被拒绝。
6. **失败即失败。** 超时、上游 4xx/5xx、返回非 JSON、结构不符都会返回明确错误，不会回落到预置结果。
7. **默认只监听本机。** 本地默认 `127.0.0.1:8787`；公网部署（如 Render）由平台注入 `PORT` 并显式设置 `HOST=0.0.0.0`。公网模式只从环境变量 `AI_API_KEY` 读取密钥，不读取本机密钥文件或 DPAPI 凭据。
8. **请求体上限 256KB**，避免误贴大文件。
