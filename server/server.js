#!/usr/bin/env node
/*
 * ProofTrace 最小 AI 解析代理
 * ------------------------------------------------------------
 * 仅做一件事：把前端粘贴的公开资料转发给 OpenAI 兼容的 /chat/completions，
 * 要求模型按固定 JSON 结构抽取，再把结果原样返回给页面复核。
 *
 * 安全约束：
 *  - API Key 只从环境变量、显式密钥文件或 Windows DPAPI 凭据读取；
 *    页面通过本地 /api/setup/key 提交，服务端验证后加密保存，不写入代码、日志或前端。
 *  - 默认只监听 127.0.0.1，避免把代理暴露到局域网。
 *  - 只允许固定路径；普通解析请求体限制 256KB，Agent 上下文请求限制 1MB。
 *  - 模型返回的片段由前端与输入原文逐字比对；服务端再做一次校验并给出计数。
 *  - 失败时返回明确错误，绝不返回预置分析结果。
 *
 * 启动：
 *   node server/run_local.js        # 首次在页面“配置模型”中录入密钥
 *   （也可用 AI_API_KEY / AI_API_KEY_FILE / AI_MODEL 环境变量覆盖）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { URL } = require('url');
const secureStore = require('./secure_store.js');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK = /^(127\.0\.0\.1|localhost|::1)$/i.test(HOST);
const PUBLIC_MODE = !LOOPBACK;
const PUBLIC_AUTH_TOKEN = process.env.PROOFTRACE_AUTH_TOKEN || '';
/* 公网模式两种形态：
   - 未设置 PROOFTRACE_AUTH_TOKEN：访客模式，浏览器同源可访问只读与受控 AI 接口；
     页面密钥配置/删除接口禁用，AI 调用受限流与每日预算约束。
   - 设置了 PROOFTRACE_AUTH_TOKEN：令牌模式，所有 /api 请求需携带 Bearer 令牌。
   本机 loopback 行为保持不变。 */
if (PUBLIC_MODE && !PUBLIC_AUTH_TOKEN) {
  console.warn('[prooftrace] 公网访客模式：未设置 PROOFTRACE_AUTH_TOKEN；密钥配置/删除接口已禁用，AI 调用受限流与每日预算约束。');
} else if (PUBLIC_MODE && PUBLIC_AUTH_TOKEN) {
  console.warn('[prooftrace] 公网令牌模式：所有 /api 请求需携带 Bearer PROOFTRACE_AUTH_TOKEN。');
}
/* 兼容旧配置：AI_API_BASE 可以只写主机，启动时补全兼容路径。 */
let API_BASE = (process.env.AI_API_BASE || '').replace(/\/+$/, '');
if (!API_BASE) API_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
/* 密钥优先级：环境变量 > 显式密钥文件 > Windows DPAPI 凭据。
   不读取浏览器 localStorage、聊天记录或源码。 */
let API_KEY = process.env.AI_API_KEY || '';
let KEY_SOURCE = API_KEY ? 'environment' : 'none';
/* 公网模式只接受环境变量注入的密钥；密钥文件与 DPAPI 凭据均为本机机制，不在公网读取。 */
if (!API_KEY && !PUBLIC_MODE && process.env.AI_API_KEY_FILE) {
  try { API_KEY = fs.readFileSync(process.env.AI_API_KEY_FILE, 'utf8').trim(); KEY_SOURCE = 'key_file'; }
  catch (e) { console.error('[prooftrace] 无法读取 AI_API_KEY_FILE，请检查路径与权限'); }
}
let API_MODEL = process.env.AI_MODEL || '';
if (!API_KEY && LOOPBACK) {
  try {
    const saved = secureStore.loadSecret();
    if (saved && saved.key) {
      API_KEY = saved.key;
      KEY_SOURCE = 'credential';
      if (!API_MODEL && saved.model) API_MODEL = saved.model;
    }
  } catch (e) { /* 凭据不存在或无法解密时保持未配置，不输出密钥内容。 */ }
}
if (!API_MODEL) API_MODEL = 'qwen-plus';
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 90000);
const MAX_BODY = 1024 * 1024;
const agent = require('./agent.js');

/* ---------------- 北京官方公告企业名录（离线文件，只读） ---------------- */
const REGISTRY_FILE = path.join(__dirname, '..', 'data', 'beijing_companies.json');
let REGISTRY_CACHE = null;
function loadRegistry(force) {
  if (REGISTRY_CACHE && !force) return REGISTRY_CACHE;
  const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  if (!data || !Array.isArray(data.companies)) throw new Error('名录文件结构不正确');
  REGISTRY_CACHE = data;
  return data;
}
function registryListType(company) {
  const names = (company.qualificationTypes || []).concat((company.qualifications || []).map(function(q){ return q && q.category; }));
  if (names.some(function(n){ return /专精特新/.test(String(n || '')); })) return 'zjtx';
  if (names.some(function(n){ return /创新型/.test(String(n || '')); })) return 'innovative';
  return 'other';
}
function registryRecord(company, data) {
  const quals = (company.qualifications || []).slice().sort(function(a, b){
    return String((b && b.noticeDate) || '').localeCompare(String((a && a.noticeDate) || ''));
  });
  const latest = quals[0] || {};
  return {
    id: company.id,
    name: company.name,
    credit_code: company.creditCode || '',
    district: company.district || '',
    list_type: registryListType(company),
    year: String(latest.noticeDate || '').slice(0, 4),
    batch: latest.batch || '',
    cert_no: null,
    title: '北京市经济和信息化局公告名单',
    fetched_at: (data.asOf || '') + 'T00:00:00Z'
  };
}
function registryStats() {
  const data = loadRegistry(false);
  const companies = data.companies || [];
  let zjtx = 0, innovative = 0, both = 0;
  companies.forEach(function(c){
    const t = registryListType(c);
    if (t === 'zjtx') zjtx++;
    else if (t === 'innovative') innovative++;
    if (t === 'zjtx' && (c.qualificationTypes || []).some(function(x){ return /创新型/.test(String(x || '')); })) both++;
  });
  return {
    ok: true,
    records: companies.length,
    snapshots: data.sourceCount || 0,
    companies: companies.length,
    hightech: 0,
    zjtx: zjtx,
    innovative: innovative,
    overlap: both,
    byYear: [{ year: '2026', list_type: 'innovative', n: innovative }, { year: '2026', list_type: 'zjtx', n: zjtx }],
    lastSnapshot: {
      title: '北京市经济和信息化局 2026 年创新型中小企业与专精特新中小企业公告名单',
      fetched_at: (data.asOf || '') + 'T00:00:00Z',
      sha256: ''
    },
    ingesting: false,
    mode: 'offline-official-attachments'
  };
}

const SYSTEM_PROMPT = [
  '你是严谨的公开资料信息抽取器。只做抽取，不做评价、不推断、不补写。',
  '必须遵守：',
  '1. 只能使用 USER_TEXT 中明确出现的信息；不得引入任何外部知识。',
  '2. 每条记录的 snippet 必须是 USER_TEXT 中逐字出现的连续片段（允许去掉首尾空白），不得改写、拼接或概括。',
  '3. 不得生成、猜测或补全任何网址、专利号、证书编号、金额、日期。原文没有就留空或不输出该条目。',
  '4. 不确定的内容放入 pendingVerification，不要放入 facts；无法确认主体是否对应时，subjectMatch 的 matched 置为 null。',
  '5. 不要输出评分、等级、投资建议或企业优劣判断，不要输出任何网址。',
  '6. 只输出一个 JSON 对象，不要输出 Markdown 代码块或解释文字。'
].join('\n');

const USER_TEMPLATE = [
  '请从下面的公开资料原文中抽取结构化信息。',
  '',
  '来源名称：{SOURCE_NAME}',
  '来源网址（仅作标识，禁止在输出中改写或新增网址）：{SOURCE_URL}',
  '发布日期：{PUBLISH_DATE}',
  '目标企业（本次分析对象）：{COMPANY_NAME}（ID: {COMPANY_ID}）',
  '',
  'USER_TEXT:',
  '"""',
  '{TEXT}',
  '"""',
  '',
  '输出 JSON，字段如下（没有内容的数组返回 []，没有的字符串返回 ""，没有的数值返回 null）：',
  '{',
  '  "organization": {"name": "", "type": "企业|研究机构|高校|其他", "confidence": "high|medium|low", "note": ""},',
  '  "entities": [{"name": "", "type": "企业|研究机构|高校|政府机关|其他", "role": "供应商|采购人|参与单位|发布机构|其他", "snippet": "", "confidence": "high|medium|low"}],',
  '  "subjectMatch": {"candidate": "", "matched": null, "basis": "", "snippet": "", "targetRole": "supplier|buyer|participant|publisher|other", "needsReview": true},',
  '  "events": [{"type": "award|contract|publication|qualification|loan|other", "date": "", "counterparty": "", "amountRaw": "", "amountValue": null, "amountUnit": "", "amountCny": null, "currency": "CNY", "subjectRole": "supplier|buyer|participant|other", "snippet": ""}],',
  '  "technologies": [{"name": "", "description": "", "snippet": ""}],',
  '  "patents": [{"number": "", "title": "", "applicant": "", "status": "", "snippet": ""}],',
  '  "products": [{"name": "", "description": "", "snippet": ""}],',
  '  "researchResults": [{"title": "", "venue": "", "date": "", "snippet": ""}],',
  '  "quantities": [{"label": "", "operator": "", "value": null, "unit": "", "time": "", "snippet": ""}],',
  '  "facts": [{"statement": "", "support": "strong|medium|weak", "statementType": "direct|paraphrase|attribution", "subjectRole": "supplier|buyer|publisher|participant|other", "snippet": ""}],',
  '  "pendingVerification": [{"item": "", "reason": ""}],',
  '  "warnings": []',
  '}',
  '',
  '抽取要求：',
  '- subjectMatch 判断文中主体是否为目标企业（COMPANY_NAME），不是判断来源名称是否同名；不确定时 matched=null 并说明 basis，targetRole 写目标企业在材料中的角色。',
  '- events 只记录原文明确的采购、中标、合同、发布、资质、融资等事件；金额没有写就留空。',
  '- 金额必须保留原文单位：amountRaw 写原文（如“459.5万元”），amountValue 只写数字（459.5），amountUnit 写单位（万元/亿元/元）。不得把“459.5万元”改写成 459.5 元；无法确定单位时 amountUnit 留空，不要默认按元解释。',
  '- 比较词和范围词必须保留：quantities 的 operator 写“<”“≤”“>”“≥”“约”“不超过”“至少”等原文语义，不得只留数值。',
  '- facts 的 statement 是概括，不等于原文；snippet 只用于核对文字是否出现。主体角色、否定词、金额单位、比较词必须与原文一致；无法确认时放入 pendingVerification。'
].join('\n');

/* ---------------- 金额与比较词的确定性检查 ---------------- */
const AMOUNT_UNITS = ['亿美元', '亿欧元', '亿港元', '亿日元', '亿元', '万美元', '万欧元', '万港元', '万日元', '万元', '千元', '元', '亿', '万'];
const AMOUNT_UNIT_RE = new RegExp('([0-9]+(?:\\.[0-9]+)?)\\s*(' + AMOUNT_UNITS.join('|') + ')?');
const CURRENCY_ALIASES = {
  '人民币': 'CNY', 'CNY': 'CNY', 'RMB': 'CNY',
  '美元': 'USD', 'USD': 'USD', 'US$': 'USD',
  '欧元': 'EUR', 'EUR': 'EUR', '€': 'EUR',
  '港元': 'HKD', '港币': 'HKD', 'HKD': 'HKD', 'HK$': 'HKD',
  '日元': 'JPY', 'JPY': 'JPY', '円': 'JPY'
};
const AMOUNT_FLAG_LABELS = {
  amount_raw_value_mismatch: '金额原文数值与结构化数值不一致',
  amount_raw_unit_mismatch: '金额原文单位与结构化单位不一致',
  amount_currency_mismatch: '金额原文币种与结构化币种不一致',
  amount_currency_unknown: '币种未注明，暂按人民币展示，需人工确认',
  amount_currency_not_cny: '非人民币金额，不折算为人民币',
  amount_unit_unknown: '原文未注明金额单位，不按“元”解释',
  amount_unit_not_convertible: '金额单位无法确定换算关系',
  amount_cny_recomputed: '模型人民币换算与程序计算不一致，已按程序重算'
};
const OPERATOR_FLAG_LABELS = {
  operator_missing: '未提供比较词，按精确值处理，需人工确认',
  operator_mismatch: '比较词与原文片段不一致',
  operator_not_in_snippet: '比较词未在原文片段中出现'
};

function normCurrency(v){
  const raw = norm(v);
  if (!raw) return '';
  const up = raw.toUpperCase();
  return CURRENCY_ALIASES[raw] || CURRENCY_ALIASES[up] || up;
}

function unitCurrency(unit){
  const u = norm(unit);
  if (/美元/.test(u)) return 'USD';
  if (/欧元/.test(u)) return 'EUR';
  if (/港元|港币/.test(u)) return 'HKD';
  if (/日元/.test(u)) return 'JPY';
  /* 只有明确出现“元/人民币”的写法才视为人民币；裸“万/亿”币种未知，需人工确认。 */
  if (/元|人民币/.test(u)) return 'CNY';
  return '';
}

function parseAmountRaw(raw){
  const t = norm(raw);
  const m = AMOUNT_UNIT_RE.exec(t);
  if (!m) return null;
  let currency = '';
  if (/美元|USD|US\$/i.test(t)) currency = 'USD';
  else if (/欧元|EUR|€/i.test(t)) currency = 'EUR';
  else if (/港元|港币|HKD|HK\$/i.test(t)) currency = 'HKD';
  else if (/日元|JPY|円/i.test(t)) currency = 'JPY';
  else if (/人民币|CNY|RMB/i.test(t)) currency = 'CNY';
  else if (m[2]) currency = unitCurrency(m[2]);
  return { value: Number(m[1]), unit: m[2] || '', currency: currency };
}

function canonicalOperator(s){
  const t = norm(s);
  if (/(<=|≤|不超过|不高于|至多)/.test(t)) return '≤';
  if (/(>=|≥|不低于|至少|不少于)/.test(t)) return '≥';
  if (/(<|＜|低于|小于|少于|不足)/.test(t)) return '<';
  if (/(>|＞|高于|大于|超过)/.test(t)) return '>';
  if (/(约|大约|近|左右|上下)/.test(t)) return '约';
  return '';
}

function addFlag(flags, f){
  if (flags.indexOf(f) < 0) flags.push(f);
}

function checkAmount(event){
  const raw = norm(event.amountRaw);
  const parsed = raw ? parseAmountRaw(raw) : null;
  const modelCurrency = normCurrency(event.currency);
  const rawCurrency = parsed && parsed.currency ? parsed.currency : '';
  /* 只有原文明确写出的币种才算已确认；模型给的币种只作线索，仍需人工核对。 */
  const currencyKnown = !!rawCurrency;
  const currency = rawCurrency || modelCurrency || 'CNY';
  const flags = [];

  if (parsed) {
    if (event.amountValue == null) event.amountValue = parsed.value;
    else if (Math.abs(Number(event.amountValue) - parsed.value) > 1e-9) addFlag(flags, 'amount_raw_value_mismatch');
    if (!norm(event.amountUnit)) event.amountUnit = parsed.unit;
    else if (parsed.unit && norm(event.amountUnit) !== parsed.unit) addFlag(flags, 'amount_raw_unit_mismatch');
  }
  event.amountUnit = norm(event.amountUnit);
  event.currency = currency;

  if (rawCurrency && modelCurrency && rawCurrency !== modelCurrency) addFlag(flags, 'amount_currency_mismatch');
  if (!rawCurrency && (event.amountValue != null || parsed)) addFlag(flags, 'amount_currency_unknown');
  if (event.amountValue != null && !event.amountUnit) addFlag(flags, 'amount_unit_unknown');
  event._amountUnitUnknown = !!(event.amountValue != null && !event.amountUnit);

  if (currency !== 'CNY') {
    /* 非人民币金额不能作为人民币金额保存；模型返回的 amountCny 一律丢弃。 */
    event.amountCny = null;
    addFlag(flags, 'amount_currency_not_cny');
  } else if (!rawCurrency && !modelCurrency) {
    /* 原文与结构化结果均未给出币种时不折算，避免把“100 万”默默当成人民币。 */
    if (event.amountCny != null) addFlag(flags, 'amount_cny_recomputed');
    delete event.amountCny;
  } else {
    /* 人民币标准化金额以原文为准：原文可解析时用原文数值与单位，不采用模型的结构化数值。 */
    const baseValue = parsed ? parsed.value : event.amountValue;
    const baseUnit = parsed && parsed.unit ? parsed.unit : event.amountUnit;
    const cny = cnyOf(baseValue, baseUnit);
    if (cny == null && event.amountValue != null && event.amountUnit) addFlag(flags, 'amount_unit_not_convertible');
    if (cny != null) {
      if (event.amountCny != null && Math.abs(Number(event.amountCny) - cny) > 0.5) addFlag(flags, 'amount_cny_recomputed');
      /* 标准化人民币金额只采用确定性计算，不采用模型返回值。 */
      event.amountCny = cny;
      event._amountCnySource = 'computed';
    } else {
      if (event.amountCny != null) addFlag(flags, 'amount_cny_recomputed');
      delete event.amountCny;
    }
  }

  const uniqFlags = uniq(flags);
  event._amountCheck = {
    flags: uniqFlags,
    labels: uniqFlags.map(function(f){ return AMOUNT_FLAG_LABELS[f] || f; }),
    currency: currencyKnown ? currency : '',
    currencyKnown: currencyKnown,
    computedCny: currency === 'CNY' && currencyKnown && event.amountCny != null ? event.amountCny : null,
    reviewRequired: uniqFlags.length > 0,
    note: uniqFlags.length
      ? '金额原文、数值、单位或币种存在需要人工核对的地方。'
      : '金额字段与原文一致；人民币金额由程序换算。'
  };
  event._amountReviewRequired = uniqFlags.length > 0;
  return event;
}

function checkQuantity(q){
  const snippetOp = canonicalOperator(q.snippet);
  const op = norm(q.operator);
  q.operator = op;
  const flags = [];
  if (!op) {
    if (snippetOp) {
      q.operator = snippetOp;
      addFlag(flags, 'operator_missing');
      q._operatorDetected = snippetOp;
    } else if (q.value != null) {
      addFlag(flags, 'operator_missing');
    }
  } else {
    const modelOp = canonicalOperator(op) || op;
    if (snippetOp && modelOp !== snippetOp) addFlag(flags, 'operator_mismatch');
    if (!snippetOp && norm(q.snippet)) addFlag(flags, 'operator_not_in_snippet');
  }
  q._operatorCheck = {
    flags: flags,
    labels: flags.map(function(f){ return OPERATOR_FLAG_LABELS[f] || f; }),
    reviewRequired: flags.length > 0,
    note: flags.length ? '比较词缺失或与片段不一致，需人工核对。' : '比较词与片段一致。'
  };
  q._operatorReviewRequired = flags.length > 0;
  return q;
}

/* ---------------- AI 技术价值分析草稿 ---------------- */
const ANALYSIS_SECTIONS = [
  { key: 'technicalCapability', title: '技术能力与技术路线' },
  { key: 'technologyAssets', title: '技术资产与权属' },
  { key: 'rdAdvancement', title: '研发及技术先进性线索' },
  { key: 'commercialization', title: '成果转化与商业化线索' },
  { key: 'whyWatch', title: '值得进一步关注的原因' },
  { key: 'gapsAndNextSteps', title: '证据不足与下一步尽调问题' }
];
const ANALYSIS_SYSTEM_PROMPT = [
  '你是银行科技金融尽调助手，只根据用户提供的证据清单生成“技术价值分析草稿”。',
  '必须遵守：',
  '1. 每一条肯定性判断必须引用 evidenceIds，且只能使用 EVIDENCE_JSON 中实际存在的证据 ID；不得编造、改写或推测证据 ID。',
  '2. 证据 mark 为“存疑”“待核实”或“未标记”时，只能作为调查线索，必须明确注明状态，不得写成已确认事实。',
  '3. 不得输出综合评分、技术价值等级、企业估值、授信额度、贷款建议、投资建议或企业优劣结论。',
  '4. 区分“证据显示的事实”和“基于证据的推断”；没有证据支撑的推测只能放入 nextSteps，作为待核问题。',
  '5. 只输出一个 JSON 对象，不要输出 Markdown 代码块、表格或解释文字。'
].join('\n');

const ANALYSIS_TEMPLATE = [
  '目标企业：{COMPANY_NAME}（ID: {COMPANY_ID}）',
  '',
  'EVIDENCE_JSON（唯一可引用的事实来源；id 为证据编号）：',
  '"""',
  '{EVIDENCE_JSON}',
  '"""',
  '',
  'JUDGEMENT_JSON（现有判断及状态，仅作上下文；不能替代证据引用）：',
  '"""',
  '{JUDGEMENT_JSON}',
  '"""',
  '',
  'APPLICABLE_BOUNDARIES（适用边界与限制）：',
  '"""',
  '{BOUNDARIES}',
  '"""',
  '',
  '请输出以下 JSON：',
  '{',
  '  "items": [',
  '    {"section": "technicalCapability|technologyAssets|rdAdvancement|commercialization|whyWatch|gapsAndNextSteps",',
  '     "claim": "一句到三句中文分析", "evidenceIds": ["EV-001"], "confidence": "high|medium|low", "note": ""}',
  '  ],',
  '  "nextSteps": [{"question": "下一步尽调问题", "evidenceIds": ["EV-001"]}],',
  '  "warnings": []',
  '}',
  '',
  '写作要求：',
  '- 六个 section 都要尽量覆盖；没有证据支撑的 section 可以留空，不要编造。',
  '- technicalCapability、technologyAssets、rdAdvancement、commercialization、whyWatch 中的每一条都必须至少引用一个真实证据 ID。',
  '- gapsAndNextSteps 可以提出没有证据直接支撑的问题，但不得把问题写成已确认事实。',
  '- 引用“存疑/待核实/未标记”证据时，note 写明“仅作调查线索”。',
  '- 不输出任何评分、估值、授信或投资建议。'
].join('\n');

function buildAnalysisPrompt(payload){
  return ANALYSIS_TEMPLATE
    .replace('{COMPANY_NAME}', payload.companyName || '未指定目标企业')
    .replace('{COMPANY_ID}', payload.companyId || '未指定')
    .replace('{EVIDENCE_JSON}', JSON.stringify(payload.evidence || [], null, 1))
    .replace('{JUDGEMENT_JSON}', JSON.stringify(payload.judgements || [], null, 1))
    .replace('{BOUNDARIES}', payload.boundaries || '公开资料未下载原始网页或 PDF；待核实/存疑证据只能作为调查线索。');
}

const ANALYSIS_BANNED = /(综合评分|评分|得分|估值|授信|贷款建议|贷款余额|目标价|投资建议|买入|卖出|技术价值等级)/;

function analysisStatusOf(ids, byId){
  const marks = ids.map(function(id){ return (byId[id] && byId[id].mark) || '未标记'; });
  if (marks.some(function(m){ return m === '存疑'; })) return 'doubtful';
  if (marks.some(function(m){ return m === '待核实' || m === '未标记'; })) return 'pending';
  return 'confirmed';
}

function analysisStatusText(st){
  return st === 'confirmed' ? '引用证据已采信；AI 判断仍待人工复核'
    : (st === 'doubtful' ? '含存疑证据，仅作调查线索' : '含待核实/未标记证据，仅作调查线索');
}

/* 只保留合法证据 ID；不存在的 ID 不会进入草稿。 */
function normalizeAnalysis(raw, evidence){
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模型返回不是 JSON 对象');
  const byId = {};
  (evidence || []).forEach(function(e){ if (e && e.id) byId[e.id] = e; });
  const validSections = {};
  ANALYSIS_SECTIONS.forEach(function(s){ validSections[s.key] = true; });
  const items = Array.isArray(raw.items) ? raw.items : [];
  const nextSteps = Array.isArray(raw.nextSteps) ? raw.nextSteps : [];
  const invalidIds = {};
  const dropped = [];
  const cleanItems = [];

  items.forEach(function(it){
    if (!it || typeof it !== 'object') return;
    const section = norm(it.section);
    const claim = norm(it.claim);
    if (!validSections[section] || claim.length < 8) { dropped.push('section_or_claim_invalid'); return; }
    if (ANALYSIS_BANNED.test(claim) || ANALYSIS_BANNED.test(norm(it.note))) { dropped.push('banned_conclusion'); return; }
    const rawIds = Array.isArray(it.evidenceIds) ? it.evidenceIds : [];
    const ids = uniq(rawIds.map(norm).filter(function(id){ return !!byId[id]; }));
    rawIds.map(norm).forEach(function(id){ if (id && !byId[id]) invalidIds[id] = true; });
    if (!ids.length && section !== 'gapsAndNextSteps') { dropped.push('missing_evidence'); return; }
    const status = ids.length ? analysisStatusOf(ids, byId) : 'pending';
    const note = norm(it.note);
    cleanItems.push({
      section: section,
      claim: claim,
      evidenceIds: ids,
      evidenceStatus: status,
      evidenceStatusText: analysisStatusText(status),
      confidence: ['high','medium','low'].indexOf(norm(it.confidence)) >= 0 ? norm(it.confidence) : 'low',
      note: status === 'confirmed' ? note : ('仅作调查线索，不得作为已确认事实。' + (note ? ' ' + note : '')),
      reviewRequired: true
    });
  });

  const cleanSteps = [];
  nextSteps.forEach(function(it){
    if (!it || typeof it !== 'object') return;
    const q = norm(it.question);
    if (q.length < 6) return;
    if (ANALYSIS_BANNED.test(q)) { dropped.push('banned_conclusion'); return; }
    const rawIds = Array.isArray(it.evidenceIds) ? it.evidenceIds : [];
    const ids = uniq(rawIds.map(norm).filter(function(id){ return !!byId[id]; }));
    rawIds.map(norm).forEach(function(id){ if (id && !byId[id]) invalidIds[id] = true; });
    cleanSteps.push({ question: q, evidenceIds: ids, reviewRequired: true });
  });

  if (!cleanItems.length) throw new Error('模型返回中没有可用的、带合法证据引用的分析条目');

  const sections = ANALYSIS_SECTIONS.map(function(s){
    return {
      key: s.key,
      title: s.title,
      items: cleanItems.filter(function(x){ return x.section === s.key; })
    };
  });
  const cited = {};
  cleanItems.forEach(function(x){ x.evidenceIds.forEach(function(id){ cited[id] = true; }); });
  return {
    sections: sections,
    nextSteps: cleanSteps.slice(0, 8),
    warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).map(norm).filter(Boolean).slice(0, 6),
    stats: {
      inputEvidence: (evidence || []).length,
      citedEvidence: Object.keys(cited).length,
      items: cleanItems.length,
      droppedItems: dropped.length,
      invalidEvidenceIds: Object.keys(invalidIds)
    }
  };
}

const LOCAL_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
function cors(res) {
  const req = res._req;
  const origin = req && req.headers ? String(req.headers.origin || '') : '';
  let allowOrigin = false;
  /* 本机页面与 file://（Origin: null）始终放行；公网同源部署时，Origin 的 host 与请求 Host 一致才放行。 */
  if (origin === 'null' || LOCAL_ORIGIN_RE.test(origin)) {
    allowOrigin = true;
  } else if (PUBLIC_MODE && origin) {
    try {
      const o = new URL(origin);
      const host = String(req.headers.host || '');
      if (o.host === host) allowOrigin = true;
    } catch (e) { /* 非法 Origin 不放行。 */ }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  cors(res);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* 简易限流：单机默认 240 次/分钟；公网部署可按需调低。 */
const RATE = { windowMs: 60000, max: Number(process.env.PROOFTRACE_RATE_LIMIT || 240), hits: new Map() };
function rateLimited(req) {
  const ip = (req.socket && req.socket.remoteAddress) || 'local';
  const now = Date.now();
  const rec = RATE.hits.get(ip);
  if (!rec || now - rec.at > RATE.windowMs) {
    RATE.hits.set(ip, { at: now, n: 1 });
    if (RATE.hits.size > 500) RATE.hits.clear();
    return false;
  }
  rec.n++;
  return rec.n > RATE.max;
}

/* ---------------- 公网访客限流与预算（仅 PUBLIC_MODE 生效，本地模式不启用） ---------------- */
const VISITOR = {
  rpm: Number(process.env.PROOFTRACE_VISITOR_RPM || 60),
  dailyPerIp: Number(process.env.PROOFTRACE_VISITOR_DAILY_CALLS || 20),
  globalDaily: Number(process.env.PROOFTRACE_DAILY_AI_CALLS || 100),
  minute: new Map(),   // ip -> { at, n }
  daily: new Map(),    // ip -> { day, n }
  global: { day: '', n: 0 }
};
function visitorToday() { return new Date().toISOString().slice(0, 10); }
function visitorIp(req) { return (req.socket && req.socket.remoteAddress) || 'local'; }
function visitorRateLimited(req) {
  if (!PUBLIC_MODE) return false;
  const ip = visitorIp(req);
  const now = Date.now();
  const rec = VISITOR.minute.get(ip);
  if (!rec || now - rec.at > RATE.windowMs) {
    VISITOR.minute.set(ip, { at: now, n: 1 });
  } else {
    rec.n++;
    if (rec.n > VISITOR.rpm) return true;
  }
  if (VISITOR.minute.size > 1000) VISITOR.minute.clear();
  return false;
}
/* 返回 null 表示放行；否则返回预算错误信息。只在 AI 计费类接口上检查。 */
function visitorBudgetBlock(req) {
  if (!PUBLIC_MODE) return null;
  const day = visitorToday();
  const ip = visitorIp(req);
  if (VISITOR.global.day !== day) VISITOR.global = { day: day, n: 0 };
  if (VISITOR.global.n >= VISITOR.globalDaily) {
    return { code: 'budget_global', message: '今日公网 AI 调用总量已达预算上限，请稍后再来。' };
  }
  let d = VISITOR.daily.get(ip);
  if (!d || d.day !== day) { d = { day: day, n: 0 }; VISITOR.daily.set(ip, d); }
  if (d.n >= VISITOR.dailyPerIp) {
    return { code: 'budget_ip', message: '您今日的 AI 试用次数已达上限，请明日再试。' };
  }
  return null;
}
function visitorConsume(req) {
  if (!PUBLIC_MODE) return;
  const day = visitorToday();
  const ip = visitorIp(req);
  if (VISITOR.global.day !== day) VISITOR.global = { day: day, n: 0 };
  VISITOR.global.n++;
  let d = VISITOR.daily.get(ip);
  if (!d || d.day !== day) { d = { day: day, n: 0 }; VISITOR.daily.set(ip, d); }
  d.n++;
}
function visitorQuotaInfo() {
  return {
    rpm: VISITOR.rpm,
    dailyPerIp: VISITOR.dailyPerIp,
    globalDaily: VISITOR.globalDaily,
    probeEnabled: !(PUBLIC_MODE && process.env.PROOFTRACE_ENABLE_PROBE !== '1')
  };
}

function authorized(req) {
  if (LOOPBACK) return true;
  /* 访客模式（未配置令牌）：浏览器同源请求放行；令牌模式下必须携带 Bearer 令牌。 */
  if (!PUBLIC_AUTH_TOKEN) return true;
  const h = String(req.headers.authorization || '');
  return h === 'Bearer ' + PUBLIC_AUTH_TOKEN;
}

function fail(res, code, message, detail, meta) {
  const error = { message: message };
  if (detail) error.detail = String(detail).slice(0, 500);
  if (meta && typeof meta === 'object') {
    Object.keys(meta).forEach(function (k) {
      if (meta[k] != null && k !== 'message' && k !== 'detail') error[k] = meta[k];
    });
  }
  send(res, code, { ok: false, error: error });
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体超过 1MB 限制'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/* 与前端规则一致：片段必须能在原文中逐字找到（忽略空白差异）。 */
function verifySnippets(data, text) {
  const hay = norm(text);
  let total = 0;
  let verified = 0;
  const keys = ['entities', 'events', 'technologies', 'patents', 'products', 'researchResults', 'quantities', 'facts'];
  keys.forEach(function (k) {
    const arr = Array.isArray(data[k]) ? data[k] : [];
    arr.forEach(function (x) {
      if (!x || typeof x !== 'object') return;
      total++;
      const sn = norm(x.snippet);
      if (sn && hay.indexOf(sn) >= 0) {
        x._snippetVerified = true;
        verified++;
      } else {
        x._snippetVerified = false;
      }
    });
  });
  if (data.subjectMatch && typeof data.subjectMatch === 'object' && norm(data.subjectMatch.snippet)) {
    total++;
    const ok = hay.indexOf(norm(data.subjectMatch.snippet)) >= 0;
    data.subjectMatch._snippetVerified = ok;
    if (ok) verified++;
  }
  return { total: total, verified: verified };
}

/* 金额、比较词、否定词与主体动作的确定性检查。
   只做“陈述 vs 片段”的一致性提示，不替代人工事实核验。 */
const FACT_FLAG_LABELS = {
  amount_value_not_in_snippet: '金额数值未在片段中出现',
  amount_unit_mismatch: '金额单位与片段不一致',
  operator_mismatch: '比较词或范围词与片段不一致',
  operator_dropped: '片段有比较词，陈述未保留',
  negation_not_aligned: '否定关系与片段不一致',
  positive_claim_negated: '陈述为肯定，片段为否定',
  role_or_action_not_in_snippet: '主体动作或角色未在片段中出现'
};

function uniq(arr) {
  return arr.filter(function (x, i) { return arr.indexOf(x) === i; });
}

function operatorFamilies(s) {
  const t = norm(s);
  const out = [];
  if (/(<=|≤|不超过|不高于|至多)/.test(t)) out.push('le');
  if (/(>=|≥|不低于|至少|不少于)/.test(t)) out.push('ge');
  if (/(<|＜|低于|小于|少于|不足)/.test(t)) out.push('lt');
  if (/(>|＞|高于|大于|超过)/.test(t)) out.push('gt');
  if (/(约|大约|近|左右|上下)/.test(t)) out.push('approx');
  return uniq(out);
}

function amountTokens(s) {
  const t = norm(s);
  const re = /([0-9]+(?:\.[0-9]+)?)\s*(亿元|万元|千元|元|亿|万|%|K|k|pm|nm|mm|μm|um|人|项|套|件)/g;
  const out = [];
  let m;
  while ((m = re.exec(t))) out.push({ value: Number(m[1]), unit: m[2] });
  return out;
}

function checkFactStatement(statement, snippet) {
  const st = norm(statement);
  const sn = norm(snippet);
  const flags = [];
  if (!st || !sn) return { flags: ['statement_or_snippet_empty'], labels: ['陈述或片段为空'], note: '陈述或片段为空，不能核对。' };

  const stOps = operatorFamilies(st);
  const snOps = operatorFamilies(sn);
  stOps.forEach(function (f) {
    if (snOps.indexOf(f) < 0) flags.push('operator_mismatch');
  });
  if (snOps.length && !stOps.length) flags.push('operator_dropped');

  const stAmts = amountTokens(st);
  const snAmts = amountTokens(sn);
  stAmts.forEach(function (a) {
    const sameValue = snAmts.filter(function (b) { return b.value === a.value; });
    if (!sameValue.length) flags.push('amount_value_not_in_snippet');
    else if (!sameValue.some(function (b) { return b.unit === a.unit; })) flags.push('amount_unit_mismatch');
  });

  const NEG = /(尚未|没有|未曾|并未|不存在|未提供|未确认|未披露|未完成|未验收|未支付|未回款)/;
  if (NEG.test(st) !== NEG.test(sn)) flags.push('negation_not_aligned');
  ['验收', '完成', '支付', '回款', '确认', '获得', '履约', '交付'].forEach(function (k) {
    const positive = st.indexOf(k) >= 0 && !NEG.test(st);
    const negated = new RegExp('(尚未|没有|未曾|并未|未)[^。；，]{0,8}' + k).test(sn);
    if (positive && negated) flags.push('positive_claim_negated');
  });

  ['发布', '刊载', '中标', '采购', '供应', '签订', '入选', '获得', '授权', '转让', '披露', '报道'].forEach(function (k) {
    if (st.indexOf(k) >= 0 && sn.indexOf(k) < 0) flags.push('role_or_action_not_in_snippet');
  });

  const uniqFlags = uniq(flags);
  return {
    flags: uniqFlags,
    labels: uniqFlags.map(function (f) { return FACT_FLAG_LABELS[f] || f; }),
    note: uniqFlags.length
      ? '片段已匹配，但陈述的金额单位、比较词、否定关系或主体动作需人工核对。'
      : '片段已匹配；陈述仍为人工待核，不表示事实已核实。'
  };
}

function cnyOf(value, unit) {
  if (value == null || !isFinite(Number(value))) return null;
  const v = Number(value);
  if (unit === '亿元' || unit === '亿') return v * 100000000;
  if (unit === '万元' || unit === '万') return v * 10000;
  if (unit === '千元') return v * 1000;
  if (unit === '元') return v;
  return null;
}

/* 统一金额、比较词与事实核对标记；不默默把无单位金额当成“元”。 */
function normalizeExtractedData(data) {
  (data.events || []).forEach(function (x) {
    if (!x || typeof x !== 'object') return;
    if (x.amountValue == null && x.amount != null) x.amountValue = x.amount;
    checkAmount(x);
  });
  (data.quantities || []).forEach(function (x) {
    if (x && typeof x === 'object') checkQuantity(x);
  });
  (data.facts || []).forEach(function (x) {
    if (!x || typeof x !== 'object') return;
    x._statementVerified = false;
    x._statementReviewRequired = true;
    x._statementCheck = checkFactStatement(x.statement, x.snippet);
  });
  if (data.subjectMatch && typeof data.subjectMatch === 'object') {
    data.subjectMatch.targetRole = norm(data.subjectMatch.targetRole);
  }
  return data;
}

function badShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '模型返回不是 JSON 对象';
  const must = ['entities', 'events', 'technologies', 'patents', 'products', 'researchResults', 'quantities', 'facts', 'pendingVerification'];
  for (const k of must) {
    if (data[k] == null) data[k] = [];
    if (!Array.isArray(data[k])) return '字段 ' + k + ' 不是数组';
  }
  if (data.organization == null) data.organization = {};
  if (data.subjectMatch == null || typeof data.subjectMatch !== 'object' || Array.isArray(data.subjectMatch)) {
    data.subjectMatch = { candidate: '', matched: null, basis: '', snippet: '', needsReview: true };
  }
  if (data.subjectMatch.matched !== true && data.subjectMatch.matched !== false) data.subjectMatch.matched = null;
  if (!Array.isArray(data.warnings)) data.warnings = [];
  return null;
}

/* 从模型回复中取出 JSON；允许内容被代码块包裹，但拒绝夹带解释文本。 */
function extractJson(content) {
  let s = String(content || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch (e) {}
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(s.slice(i, j + 1)); } catch (e) {}
  }
  throw new Error('模型未返回可解析的 JSON');
}

function buildUserPrompt(payload) {
  return USER_TEMPLATE
    .replace('{SOURCE_NAME}', payload.sourceName || '未填写')
    .replace('{SOURCE_URL}', payload.sourceUrl)
    .replace('{PUBLISH_DATE}', payload.publishDate)
    .replace('{COMPANY_NAME}', payload.companyName || '未指定目标企业')
    .replace('{COMPANY_ID}', payload.companyId || '未指定')
    .replace('{TEXT}', payload.text);
}

async function callChat(systemPrompt, userPrompt, maxTokens, override) {
  const o = override || {};
  const base = String(o.base || API_BASE).replace(/\/+$/, '');
  const key = o.key || API_KEY;
  const model = o.model || API_MODEL;
  const url = base + '/chat/completions';
  const body = {
    model: model,
    temperature: 0,
    max_tokens: maxTokens || 2400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };

  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  const started = Date.now();
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const raw = await r.text();
    let j = null;
    try { j = JSON.parse(raw); } catch (e) {}
    if (!r.ok) {
      const msg = (j && j.error && (j.error.message || j.error)) || ('上游 HTTP ' + r.status);
      const err = new Error(msg);
      err.status = r.status;
      err.code = r.status === 401 ? 'upstream_auth'
        : (r.status === 403 ? 'upstream_forbidden'
        : (r.status === 429 ? 'upstream_rate_limit'
        : (r.status === 402 ? 'upstream_quota' : 'upstream_error')));
      throw err;
    }
    if (!j || !j.choices || !j.choices[0] || !j.choices[0].message) {
      const err = new Error('上游返回缺少 choices[0].message');
      err.code = 'invalid_response';
      throw err;
    }
    return {
      content: j.choices[0].message.content,
      model: j.model || model,
      usage: j.usage || null,
      searchInfo: j.search_info || null,
      elapsedMs: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callModel(payload) {
  return callChat(SYSTEM_PROMPT, buildUserPrompt(payload), 2400);
}

/* 把上游失败归类为前端可识别的稳定错误码；不改变原始错误文本。 */
function upstreamErrorMeta(e) {
  if (!e) return { code: 'unknown' };
  if (e.name === 'AbortError') return { code: 'timeout' };
  if (e.code) return { code: e.code, upstreamStatus: e.status || null };
  if (e.name === 'TypeError') return { code: 'upstream_unreachable' };
  return { code: 'unknown' };
}

async function handleExtract(req, res) {
  if (!API_KEY || !API_BASE || !API_MODEL) {
    return fail(res, 503, '服务端未配置模型。请在页面“配置模型”中填写 API Key，验证通过后加密保存并自动生效。', null, { code:'model_unconfigured', configured:false });
  }

  let payload;
  try { payload = await readBody(req); }
  catch (e) { return fail(res, 400, e.message); }

  const text = String(payload.text || '');
  const sourceUrl = String(payload.sourceUrl || '').trim();
  const publishDate = String(payload.publishDate || '').trim();
  const sourceName = String(payload.sourceName || '').trim();
  const companyId = String(payload.companyId || '').trim();
  const companyName = String(payload.companyName || '').trim();
  const inputTextType = ['source_verbatim', 'user_paraphrase', 'unknown'].indexOf(payload.inputTextType) >= 0
    ? payload.inputTextType : 'unknown';

  if (text.trim().length < 80) return fail(res, 400, '资料正文至少 80 字');
  if (!/^https?:\/\//i.test(sourceUrl)) return fail(res, 400, '来源网址必须以 http:// 或 https:// 开头');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishDate)) return fail(res, 400, '发布日期格式应为 YYYY-MM-DD');
  if (!companyId || !companyName) return fail(res, 400, '缺少目标企业 companyId / companyName，拒绝在未绑定企业的情况下解析');

  let out;
  try {
    out = await callModel({ text: text, sourceUrl: sourceUrl, publishDate: publishDate, sourceName: sourceName,
      companyId: companyId, companyName: companyName });
  } catch (e) {
    if (e && e.name === 'AbortError') return fail(res, 504, '模型调用超时（' + TIMEOUT_MS + 'ms）', null, { code: 'timeout' });
    return fail(res, 502, '模型调用失败：' + (e.message || '未知错误'), null, upstreamErrorMeta(e));
  }

  let data;
  try { data = extractJson(out.content); }
  catch (e) { return fail(res, 502, '模型返回无法解析：' + e.message + '。原始内容片段：' + String(out.content || '').slice(0, 200), null, { code: 'invalid_response' }); }

  const shape = badShape(data);
  if (shape) return fail(res, 502, '模型返回结构不符合要求：' + shape, null, { code: 'invalid_response' });

  /* 来源强制使用用户填写的网址；模型输出中的任何网址都不采信。 */
  data.organization = data.organization || {};
  normalizeExtractedData(data);
  const verify = verifySnippets(data, text);

  return send(res, 200, {
    ok: true,
    model: out.model,
    createdAt: new Date().toISOString(),
    elapsedMs: out.elapsedMs,
    usage: out.usage,
    targetCompany: { id: companyId, name: companyName },
    inputTextType: inputTextType,
    source: { name: sourceName || sourceUrl, url: sourceUrl, date: publishDate, inputTextType: inputTextType, fetched: false },
    verify: verify,
    data: data
  });
}

/* AI 技术价值分析草稿：只接收证据清单，不接收密钥；返回内容必须引用合法证据 ID。 */
async function handleAnalyze(req, res) {
  if (!API_KEY || !API_BASE || !API_MODEL) {
    return fail(res, 503, '服务端未配置模型。请在页面“配置模型”中填写 API Key，验证通过后加密保存并自动生效。', null, { code:'model_unconfigured', configured:false });
  }

  let payload;
  try { payload = await readBody(req); }
  catch (e) { return fail(res, 400, e.message); }

  const companyId = String(payload.companyId || '').trim();
  const companyName = String(payload.companyName || '').trim();
  if (!companyId || !companyName) return fail(res, 400, '缺少目标企业 companyId / companyName，拒绝生成未绑定企业的分析草稿');

  const rawEvidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  if (!rawEvidence.length) return fail(res, 400, '缺少证据清单，拒绝在没有证据的情况下生成分析');
  if (rawEvidence.length > 30) return fail(res, 400, '证据清单超过 30 条，请先筛选后再生成');

  const seen = {};
  const evidence = [];
  rawEvidence.forEach(function(e){
    if (!e || typeof e !== 'object') return;
    const id = norm(e.id);
    if (!id || seen[id]) return;
    seen[id] = true;
    const mark = ['采信','存疑','待核实'].indexOf(norm(e.mark)) >= 0 ? norm(e.mark) : '未标记';
    evidence.push({
      id: id,
      title: norm(e.title).slice(0, 300),
      summary: norm(e.summary).slice(0, 800),
      quote: norm(e.quote).slice(0, 800),
      date: norm(e.date).slice(0, 40),
      source: norm(e.source).slice(0, 200),
      url: norm(e.url).slice(0, 500),
      grade: norm(e.grade).slice(0, 4),
      mark: mark,
      reviewStatus: norm(e.reviewStatus).slice(0, 40),
      origin: norm(e.origin).slice(0, 40),
      inputTextType: ['source_verbatim','user_paraphrase','unknown'].indexOf(e.inputTextType) >= 0 ? e.inputTextType : 'unknown',
      caveat: norm(e.caveat).slice(0, 600),
      impact: norm(e.impact).slice(0, 400),
      invalid: (Array.isArray(e.invalid) ? e.invalid : []).map(norm).filter(Boolean).slice(0, 8),
      conflict: !!e.conflict,
      dataSource: norm(e.dataSource).slice(0, 40)
    });
  });
  if (!evidence.length) return fail(res, 400, '证据清单没有可用条目');

  const evidenceIds = {};
  evidence.forEach(function(e){ evidenceIds[e.id] = true; });
  const judgements = (Array.isArray(payload.judgements) ? payload.judgements : []).slice(0, 20).map(function(j){
    return {
      id: norm(j && j.id).slice(0, 80),
      title: norm(j && j.title).slice(0, 300),
      status: norm(j && j.status).slice(0, 40),
      statusText: norm(j && j.statusText).slice(0, 80),
      evidenceIds: (Array.isArray(j && j.evidenceIds) ? j.evidenceIds : []).map(norm).filter(function(id){ return evidenceIds[id]; })
    };
  });

  let out;
  try {
    out = await callChat(ANALYSIS_SYSTEM_PROMPT, buildAnalysisPrompt({
      companyId: companyId,
      companyName: companyName,
      evidence: evidence,
      judgements: judgements,
      boundaries: String(payload.boundaries || '').trim().slice(0, 2000)
    }), 3000);
  } catch (e) {
    if (e && e.name === 'AbortError') return fail(res, 504, '模型调用超时（' + TIMEOUT_MS + 'ms）', null, { code: 'timeout' });
    return fail(res, 502, '模型调用失败：' + (e.message || '未知错误'), null, upstreamErrorMeta(e));
  }

  let raw;
  try { raw = extractJson(out.content); }
  catch (e) { return fail(res, 502, '模型返回无法解析：' + e.message + '。原始内容片段：' + String(out.content || '').slice(0, 200), null, { code: 'invalid_response' }); }

  let analysis;
  try { analysis = normalizeAnalysis(raw, evidence); }
  catch (e) { return fail(res, 502, '模型返回不符合分析草稿要求：' + e.message, null, { code: 'invalid_response' }); }

  return send(res, 200, {
    ok: true,
    model: out.model,
    createdAt: new Date().toISOString(),
    elapsedMs: out.elapsedMs,
    usage: out.usage,
    targetCompany: { id: companyId, name: companyName },
    inputEvidenceIds: evidence.map(function(e){ return e.id; }),
    reviewRequired: true,
    analysis: analysis
  });
}

/* ---------------- 首次配置与安全密钥 ---------------- */
function setupStatus() {
  return {
    ok: true, configured: !!(API_KEY && API_BASE && API_MODEL),
    keySource: KEY_SOURCE, model: API_MODEL || null,
    base: API_BASE, secureStore: LOOPBACK && process.platform === 'win32' ? 'windows-dpapi' : 'environment-only',
    loopback: LOOPBACK, publicMode: PUBLIC_MODE, canSetup: LOOPBACK && !PUBLIC_MODE
  };
}
function localPageRequest(req) {
  const origin = String(req.headers.origin || '');
  return LOOPBACK && (origin === 'null' || !origin || LOCAL_ORIGIN_RE.test(origin));
}
function handleSetupStatus(res) { return send(res, 200, setupStatus()); }

async function handleSetupKey(req, res) {
  if (PUBLIC_MODE) return fail(res, 403, '公网部署已禁用页面密钥配置；API Key 由服务端环境变量 AI_API_KEY 提供。', null, { code: 'setup_disabled_public' });
  if (!localPageRequest(req)) return fail(res, 403, '首次配置只能在运行本机服务的电脑上完成', null, { code: 'setup_forbidden' });
  let payload;
  try { payload = await readBody(req); } catch (e) { return fail(res, 400, e.message); }
  const key = String(payload.key || '').trim();
  const model = String(payload.model || 'qwen-plus').trim();
  const base = String(payload.base || API_BASE || '').trim().replace(/\/+$/, '');
  if (key.length < 20 || key.length > 240 || /\s/.test(key)) {
    return fail(res, 400, 'API Key 格式不正确：应为不含空格的密钥字符串', null, { code: 'bad_key' });
  }
  if (!/^[A-Za-z0-9._\-]{2,48}$/.test(model)) return fail(res, 400, '模型名称不合法', null, { code: 'bad_model' });
  if (!/^https:\/\/[A-Za-z0-9.\-]+\/[A-Za-z0-9._\-\/]*$/.test(base)) {
    return fail(res, 400, '接口地址必须是 https:// 开头的兼容地址', null, { code: 'bad_base' });
  }
  /* 先真实调用一次极小的请求，确认密钥与模型可用；失败不保存。 */
  try {
    await callChat('你是连通性检查助手，只输出 JSON。', '{"check":true}', 16,
      { key: key, model: model, base: base });
  } catch (e) {
    const meta = upstreamErrorMeta(e);
    const msg = (e && e.name === 'AbortError') ? '模型服务连接超时' : ('密钥验证失败：' + (e && e.message || '未知错误'));
    return fail(res, 502, msg, null, Object.assign({ code: meta.code || 'setup_verify_failed' }, meta));
  }
  try {
    secureStore.saveSecret(key, model);
  } catch (e) {
    return fail(res, 500, '密钥验证通过，但安全存储失败：' + (e && e.message || '未知错误') + '。未保存密钥。',
      null, { code: 'secure_store_failed' });
  }
  API_KEY = key;
  API_MODEL = model;
  API_BASE = base;
  KEY_SOURCE = 'credential';
  return send(res, 200, Object.assign({ verified: true, savedAt: new Date().toISOString() }, setupStatus()));
}

function handleSetupClear(req, res) {
  if (PUBLIC_MODE) return fail(res, 403, '公网部署已禁用凭据删除接口；如需更换密钥，请在平台环境变量中调整后重启服务。', null, { code: 'setup_disabled_public' });
  if (!localPageRequest(req)) return fail(res, 403, '只能在本机清除凭据', null, { code: 'setup_forbidden' });
  if (KEY_SOURCE === 'environment') {
    return fail(res, 409, '当前密钥来自环境变量，服务无法代为清除。请关闭服务并移除环境变量后重新启动。', null, { code: 'env_key' });
  }
  try { secureStore.clearSecret(); } catch (e) {}
  API_KEY = '';
  KEY_SOURCE = 'none';
  return send(res, 200, setupStatus());
}

/* ---------------- 静态页面（与服务同源，避免 file:// 与地址漂移） ---------------- */
const STATIC_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveStatic(req, res, pathname) {
  let rel = null;
  if (pathname === '/' || pathname === '/index.html') rel = 'index.html';
  else if (pathname === '/home.html') rel = 'home.html';
  else if (/^\/data\/[A-Za-z0-9_.\-]+\.(js|json)$/.test(pathname)) rel = pathname.slice(1);
  else if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return true; }
  if (!rel) return false;
  const root = path.join(__dirname, '..');
  const file = path.join(root, rel);
  if (file.indexOf(root) !== 0 || !fs.existsSync(file)) { fail(res, 404, '未找到该文件'); return true; }
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
  return true;
}

function handleRegistryStats(res) {
  try { return send(res, 200, registryStats()); }
  catch (e) { return fail(res, 500, '读取北京企业名录失败：' + (e && e.message ? e.message : '未知错误'), null, { code: 'registry_unavailable' }); }
}

function handleRegistryList(res, urlObj) {
  try {
    const data = loadRegistry(false);
    const q = String(urlObj.searchParams.get('q') || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(urlObj.searchParams.get('limit') || 8)));
    const offset = Math.max(0, Number(urlObj.searchParams.get('offset') || 0));
    let rows = data.companies || [];
    if (q) {
      rows = rows.filter(function(c){
        return [c.name, c.creditCode, c.district].join(' ').toLowerCase().indexOf(q) >= 0;
      });
    }
    return send(res, 200, {
      ok: true,
      total: rows.length,
      limit: limit,
      offset: offset,
      records: rows.slice(offset, offset + limit).map(function(c){ return registryRecord(c, data); })
    });
  } catch (e) {
    return fail(res, 500, '读取北京企业名录失败：' + (e && e.message ? e.message : '未知错误'), null, { code: 'registry_unavailable' });
  }
}

async function handleRegistryCheck(req, res) {
  let payload;
  try { payload = await readBody(req); }
  catch (e) { return fail(res, 400, e.message); }
  const q = norm(payload.q);
  if (!q) return fail(res, 400, '请输入企业名称、统一社会信用代码或证书编号');
  try {
    const data = loadRegistry(false);
    const lower = q.toLowerCase();
    const hits = (data.companies || []).filter(function(c){
      return [c.name, c.creditCode].join(' ').toLowerCase().indexOf(lower) >= 0;
    });
    return send(res, 200, {
      ok: true,
      query: q,
      hits: hits.length,
      records: hits.slice(0, 50).map(function(c){ return registryRecord(c, data); }),
      checkedAt: new Date().toISOString()
    });
  } catch (e) {
    return fail(res, 500, '核验失败：' + (e && e.message ? e.message : '未知错误'), null, { code: 'registry_unavailable' });
  }
}

function handleIngestRun(res) {
  /* 稳定的离线导入：读取已核验的官方公告附件抽取结果，不访问外网、不伪造记录。
     公网访客不强制重建 7.6MB 名录缓存，避免共享缓存被反复解析；本机模式仍可手动重载。 */
  try {
    const data = loadRegistry(!PUBLIC_MODE);
    return send(res, 200, {
      ok: true,
      started: true,
      mode: 'offline-official-attachments',
      records: data.recordCount || (data.companies || []).length,
      sourceCount: data.sourceCount || 0,
      sourceOkCount: data.sourceOkCount || 0,
      finished_at: new Date().toISOString(),
      note: PUBLIC_MODE
        ? '公网模式使用离线名录缓存，不重新导入、不访问外网，未新增或虚构企业。'
        : '已重新载入本地官方公告名单抽取结果；未访问外网，未新增或虚构企业。'
    });
  } catch (e) {
    return fail(res, 500, '导入失败：' + (e && e.message ? e.message : '未知错误'), null, { code: 'ingest_failed' });
  }
}

function handleSources(res) {
  try {
    const data = loadRegistry(false);
    const sources = (data.sources || []).map(function(s){
      return {
        id: s.source,
        status: s.status,
        extracted: s.extracted || 0,
        last_ingest: (data.asOf || '') + 'T00:00:00Z',
        mode: 'offline-official-attachments'
      };
    });
    return send(res, 200, {
      ok: true,
      asOf: data.asOf || null,
      sourceCount: data.sourceCount || 0,
      sourceOkCount: data.sourceOkCount || 0,
      sources: sources
    });
  } catch (e) {
    return fail(res, 500, '读取来源失败：' + (e && e.message ? e.message : '未知错误'), null, { code: 'registry_unavailable' });
  }
}

/* SSRF 防护：拒绝本机、内网、链路本地与保留地址；与 Agent 网页读取工具同一套口径。 */
function probePrivateHost(h) {
  const host = String(h || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === '::1' || host === '[::1]' || /^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^::ffff:/i.test(host)) return true;
  if (/^0\./.test(host)) return true;
  return false;
}
async function probeAssertPublic(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (e) { throw new Error('网址格式不合法'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('只允许探测 http/https 网址');
  if (probePrivateHost(u.hostname)) throw new Error('出于安全原因，不允许探测本机或内网地址');
  let addrs = [];
  try { addrs = await dns.promises.lookup(u.hostname, { all: true, verbatim: true }); }
  catch (e) { throw new Error('域名解析失败，未发起请求'); }
  if (!addrs.length || addrs.some(function (a) { return probePrivateHost(a.address); })) {
    throw new Error('域名解析到本机或内网地址，已拒绝');
  }
  return u;
}

async function handleProbe(req, res) {
  if (PUBLIC_MODE && process.env.PROOFTRACE_ENABLE_PROBE !== '1') {
    return fail(res, 403, '公网部署已禁用网址探测接口。', null, { code: 'probe_disabled_public' });
  }
  let payload;
  try { payload = await readBody(req); }
  catch (e) { return fail(res, 400, e.message); }
  const rawUrl = String(payload.url || '').trim();
  if (!/^https?:\/\//i.test(rawUrl)) return fail(res, 400, 'url 必须以 http:// 或 https:// 开头');
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(function(){ ctrl.abort(); }, 8000);
  let cur;
  try {
    cur = await probeAssertPublic(rawUrl);
    let r = null;
    let hops = 0;
    while (true) {
      r = await fetch(cur.href, {
        method: 'HEAD', redirect: 'manual', signal: ctrl.signal,
        headers: { 'User-Agent': 'ProofTrace-Probe/1.0' }
      });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        hops++;
        if (hops > 3) {
          return send(res, 200, { ok: false, status: r.status, ms: Date.now() - started, url: cur.href, hops: hops, message: '重定向次数过多，已停止跟进' });
        }
        cur = new URL(loc, cur);
        await probeAssertPublic(cur.href);
        continue;
      }
      break;
    }
    return send(res, 200, { ok: r.ok, status: r.status, ms: Date.now() - started, url: cur.href, hops: hops });
  } catch (e) {
    return send(res, 200, { ok: false, status: null, ms: Date.now() - started, url: rawUrl,
      message: (e && e.name === 'AbortError') ? '超时' : String((e && e.message) || '未连通') });
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(function (req, res) {
  res._req = req;
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  let pathname;
  let urlObj;
  try { urlObj = new URL(req.url, 'http://localhost'); pathname = urlObj.pathname; }
  catch (e) { return fail(res, 400, '请求路径不合法'); }

  if (pathname.indexOf('/api/') === 0 && !authorized(req)) {
    return fail(res, 401, '需要访问令牌（公网部署请通过反向代理配置鉴权）', null, { code: 'unauthorized' });
  }
  if (pathname.indexOf('/api/') === 0 && rateLimited(req)) {
    return fail(res, 429, '请求过于频繁，请稍后重试', null, { code: 'rate_limited' });
  }
  if (pathname.indexOf('/api/') === 0 && visitorRateLimited(req)) {
    return fail(res, 429, '访客请求过于频繁，请稍后重试', null, { code: 'visitor_rate_limited' });
  }

  /* AI 计费类接口：公网访客受每日调用次数与全局预算约束；仅在模型已配置（会产生上游费用）时扣减预算。 */
  const AI_SPEND_ROUTES = ['/api/ai/extract', '/api/ai/analyze', '/api/agent/chat'];
  if (AI_SPEND_ROUTES.indexOf(pathname) >= 0) {
    const block = visitorBudgetBlock(req);
    if (block) return fail(res, 429, block.message, null, { code: block.code });
    if (API_KEY && API_BASE && API_MODEL) visitorConsume(req);
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      service: 'prooftrace-ai-proxy',
      version: '4.4',
      host: (function(){ const a = server.address(); return a && a.address ? a.address : HOST; })(),
      port: (function(){ const a = server.address(); return a && a.port ? a.port : PORT; })(),
      node: process.versions.node,
      configured: !!(API_KEY && API_BASE && API_MODEL),
      model: API_MODEL || null,
      keySource: KEY_SOURCE,
      publicMode: PUBLIC_MODE,
      visitor: visitorQuotaInfo(),
      setup: setupStatus(),
      ingesting: false,
      registry: { mode: 'offline-official-attachments', file: path.relative(path.join(__dirname, '..'), REGISTRY_FILE) },
      note: configuredNote(),
      agent: {
        version: agent.AGENT_VERSION,
        maxSteps: agent.MAX_STEPS,
        taskBudgets: agent.TASK_BUDGETS,
        tools: agent.TOOL_SPECS.map(function (t) { return t.name; }),
        tokenStrategy: 'task-budget + compact-context + recent-tool-results + partial-conclusion',
        searchMode: (process.env.AGENT_SEARCH_MODE || (process.env.AI_SEARCH_ENABLED === '1' ? 'dashscope' : 'off')),
        searchSourceReturn: 'DashScope 原生接口 search_info.search_results；OpenAI 兼容接口不返回来源'
      }
    });
  }

  if (req.method === 'GET' && pathname === '/api/setup/status') {
    return handleSetupStatus(res);
  }
  if (req.method === 'POST' && pathname === '/api/setup/key') {
    handleSetupKey(req, res).catch(function (e) {
      if (!res.headersSent) fail(res, 500, '保存密钥失败：' + (e && e.message || '未知错误'));
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/setup/clear') {
    return handleSetupClear(req, res);
  }

  if (req.method === 'POST' && pathname === '/api/ai/extract') {
    handleExtract(req, res).catch(function (e) {
      fail(res, 500, '服务端内部错误：' + (e && e.message ? e.message : '未知错误'));
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/ai/analyze') {
    handleAnalyze(req, res).catch(function (e) {
      fail(res, 500, '服务端内部错误：' + (e && e.message ? e.message : '未知错误'));
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/agent/chat') {
    agent.handleAgentChat(req, res, {
      API_KEY: API_KEY, API_BASE: API_BASE, API_MODEL: API_MODEL, TIMEOUT_MS: TIMEOUT_MS,
      callChat: callChat, callModel: callModel, readBody: readBody, send: send, fail: fail,
      cors: cors,
      extractJson: extractJson, badShape: badShape, normalizeExtractedData: normalizeExtractedData,
      verifySnippets: verifySnippets, upstreamErrorMeta: upstreamErrorMeta,
      SYSTEM_PROMPT: SYSTEM_PROMPT, ANALYSIS_SYSTEM_PROMPT: ANALYSIS_SYSTEM_PROMPT,
      buildAnalysisPrompt: buildAnalysisPrompt, normalizeAnalysis: normalizeAnalysis
    }).catch(function (e) {
      if (!res.headersSent) fail(res, 500, 'Agent 服务内部错误：' + (e && e.message ? e.message : '未知错误'));
      else { try { res.end(); } catch (ignored) {} }
    });
    return;
  }

  /* 北京官方公告名录：离线文件读取，稳定可用，不依赖外部站点。 */
  if (req.method === 'GET' && pathname === '/api/registry/stats') {
    return handleRegistryStats(res);
  }
  if (req.method === 'GET' && pathname === '/api/registry/list') {
    return handleRegistryList(res, urlObj);
  }
  if (req.method === 'POST' && pathname === '/api/registry/check') {
    handleRegistryCheck(req, res).catch(function(e){
      if (!res.headersSent) fail(res, 500, '核验服务内部错误：' + (e && e.message ? e.message : '未知错误'));
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/ingest/run') {
    return handleIngestRun(res);
  }
  if (req.method === 'GET' && pathname === '/api/sources') {
    return handleSources(res);
  }
  if (req.method === 'POST' && pathname === '/api/probe') {
    handleProbe(req, res).catch(function(e){
      if (!res.headersSent) fail(res, 500, '探测服务内部错误：' + (e && e.message ? e.message : '未知错误'));
    });
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, pathname)) return;

  fail(res, 404, '未找到该接口。可用：GET /api/health、GET /api/setup/status、POST /api/setup/key、POST /api/setup/clear、GET /api/registry/stats、GET /api/registry/list、POST /api/registry/check、POST /api/ingest/run、GET /api/sources、POST /api/probe、POST /api/ai/extract、POST /api/ai/analyze、POST /api/agent/chat');
});

function configuredNote() {
  if (!API_KEY) return '缺少 API Key：请在页面“配置模型”中完成首次配置';
  if (!API_BASE) return '缺少 AI_API_BASE';
  if (!API_MODEL) return '缺少 AI_MODEL';
  if (KEY_SOURCE === 'credential') return '已配置。密钥由 Windows DPAPI 加密，仅当前用户可解密。';
  if (KEY_SOURCE === 'key_file') return '已配置。密钥来自仅本机可读的密钥文件。';
  return '已配置。密钥来自当前服务进程环境变量。';
}

function checkNodeVersion() {
  const major = parseInt(String(process.versions.node).split('.')[0], 10);
  if (!(major >= 18)) {
    console.error('[prooftrace] 需要 Node.js 18 或以上，当前版本：' + process.versions.node);
    return false;
  }
  return true;
}

/* 统一启动入口：server.js 与 run_local.js 都调用这里，避免 require.main 判断导致不启动。 */
function startServer(options) {
  const opts = options || {};
  const port = opts.port != null ? opts.port : PORT;
  const host = opts.host || HOST;
  if (!checkNodeVersion()) return server;

  let settled = false;
  server.once('error', function (err) {
    settled = true;
    if (err && err.code === 'EADDRINUSE') {
      console.error('[prooftrace] 启动失败：端口 ' + port + ' 已被占用。请关闭占用程序，或设置 PORT 后重试。');
    } else {
      console.error('[prooftrace] 启动失败：' + (err && err.message ? err.message : '未知错误'));
    }
    process.exitCode = 1;
    if (typeof opts.onError === 'function') opts.onError(err);
  });

  server.listen(port, host, function () {
    if (settled) return;
    const addr = server.address();
    const shownHost = addr && addr.address ? addr.address : host;
    const shownPort = addr && addr.port ? addr.port : port;
    console.log('[prooftrace] listening on http://' + shownHost + ':' + shownPort);
    console.log('[prooftrace] model configured: ' + (!!(API_KEY && API_BASE && API_MODEL)));
    console.log('[prooftrace] ' + configuredNote());
    if (!API_KEY || !API_BASE || !API_MODEL) {
      console.log('[prooftrace] 未配置模型：AI 解析与分析草稿将返回 503，页面会明确显示失败；离线功能仍可用。');
    }
    if (typeof opts.onListening === 'function') opts.onListening(server);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer: startServer,
  server: server,
  buildUserPrompt: buildUserPrompt,
  normalizeExtractedData: normalizeExtractedData,
  checkFactStatement: checkFactStatement,
  checkAmount: checkAmount,
  checkQuantity: checkQuantity,
  buildAnalysisPrompt: buildAnalysisPrompt,
  normalizeAnalysis: normalizeAnalysis,
  ANALYSIS_SECTIONS: ANALYSIS_SECTIONS,
  verifySnippets: verifySnippets,
  badShape: badShape,
  extractJson: extractJson,
  upstreamErrorMeta: upstreamErrorMeta,
  callChat: callChat,
  agent: agent
};
