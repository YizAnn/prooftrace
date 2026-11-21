/* ProofTrace 寻证 AI Agent 内核
 * ------------------------------------------------------------
 * 单 Agent + 工具 + 多阶段研究。模型只能输出两类 JSON：
 *   {"action":"tool","tool":"get_company_profile","args":{...},"reason":"..."}
 *   {"action":"final","answer":"...","citations":[...],"followups":[...]}
 *
 * 约束：
 *  - 工具名、参数、调用轮数、时间、Token、资料条数全部由程序限制。
 *  - 只读/研究工具可自动执行；所有写业务数据的动作只生成“待确认提案”，
 *    由前端用户确认后才落到 localStorage，并由前端保留撤销快照。
 *  - 浏览器把当前真实业务上下文随请求传来；服务端不假设自己知道 localStorage。
 *  - 未配置模型、搜索不可用、网页读取失败都返回真实状态，不伪造结果。
 */
'use strict';

const { URL } = require('url');
const dns = require('dns');

const AGENT_VERSION = '1.3';
/* 预算按任务类型分配：轮次与 Token 同时约束，避免简单问答被复杂研究拖垮。 */
const TASK_BUDGETS = {
  simple:   { maxSteps: 4, tokenBudget: 18000, softTokens: 12000, toolTarget: 2, label: '简单问答' },
  explain:  { maxSteps: 5, tokenBudget: 24000, softTokens: 16000, toolTarget: 3, label: '评分解释' },
  research: { maxSteps: 6, tokenBudget: 36000, softTokens: 24000, toolTarget: 4, label: '单企业研究' },
  compare:  { maxSteps: 8, tokenBudget: 48000, softTokens: 32000, toolTarget: 6, label: '多企业比较' }
};
const MAX_STEPS = 4;          /* 兼容既有测试常量；实际使用 TASK_BUDGETS.simple */
const MAX_STEPS_EXPLAIN = 5;
const MAX_STEPS_RESEARCH = 6;
const MAX_STEPS_COMPARE = 8;
const MAX_WALL_MS = 240000;
const MAX_PROMPT_CHARS = 32000;
const MAX_TURN_CHARS = 18000;
const MAX_TOOL_CHARS = 3600;
const MAX_RECENT_TOOL_RESULTS = 2;
const MAX_TOKEN_BUDGET = 48000; /* 全局硬上限，实际取任务预算 */
const MAX_COMPANIES = 8;
const MAX_EVIDENCE = 80;
const MAX_MESSAGES = 14;
const MAX_TURN_MESSAGES = 6;
const MAX_BATCH_EVIDENCE = 20;

const VIEW_LABELS = {
  pool: '名单准入', queue: '今日待判', profile: '企业画像', evidence: '证据台账',
  conflicts: '冲突处置', ai: 'AI 解析', model: '评分与门槛', rules: '专家规则', sources: '数据来源', export: '导出交付'
};

/* ---------------- 基础工具 ---------------- */
function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function uniq(arr) { return arr.filter(function (x, i) { return arr.indexOf(x) === i; }); }
function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function asStr(x, n) { return clip(norm(x), n || 800); }
function asBool(x) { return x === true; }

/* 递归移除疑似密钥字段，避免浏览器误把密钥带进上下文再进入模型。 */
function sanitize(value, depth) {
  depth = depth || 0;
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.slice(0, 200).map(function (x) { return sanitize(x, depth + 1); });
  if (!isObj(value)) {
    if (typeof value === 'string') {
      return value.replace(/sk-[A-Za-z0-9_\-]{12,}/g, 'sk-***').slice(0, 8000);
    }
    return value;
  }
  const out = {};
  Object.keys(value).forEach(function (k) {
    if (/^(api[_-]?key|apikey|authorization|auth|password|secret|token)$/i.test(k)) return;
    out[k] = sanitize(value[k], depth + 1);
  });
  return out;
}

function numOrNull(x) { return x == null || x === '' ? null : (isFinite(Number(x)) ? Number(x) : null); }

/* 研究企业的评分字段要保留给模型做解释，但不能让模型改写分数：
   这里全部是只读快照，写入仍走 propose_* 工具并由用户确认。 */
function normalizeModel(m) {
  const out = {
    public: asBool(m.public), research: asBool(m.research),
    score: numOrNull(m.score), grade: asStr(m.grade, 8), suff: numOrNull(m.suff),
    counts: isObj(m.counts) ? m.counts : null,
    version: asStr(m.version, 40), ruleVersion: asStr(m.ruleVersion, 40),
    evaluationState: asStr(m.evaluationState, 20),
    technicalScore: numOrNull(m.technicalScore), acceptedScore: numOrNull(m.acceptedScore),
    candidateScore: numOrNull(m.candidateScore), formalScore: numOrNull(m.formalScore),
    acceptedGrade: asStr(m.acceptedGrade, 8), candidateGrade: asStr(m.candidateGrade, 8),
    formalGrade: asStr(m.formalGrade, 8), formalReady: asBool(m.formalReady),
    coverageNote: asStr(m.coverageNote, 300)
  };
  if (!out.research) return out;
  if (Array.isArray(m.metricLevels)) {
    out.metricLevels = m.metricLevels.slice(0, 8).map(function (x) {
      if (!isObj(x)) return null;
      return {
        key: asStr(x.key, 20), name: asStr(x.name, 40), dim: asStr(x.dim, 30),
        acceptedLevel: numOrNull(x.acceptedLevel), candidateLevel: numOrNull(x.candidateLevel),
        acceptedEvidence: (Array.isArray(x.acceptedEvidence) ? x.acceptedEvidence : []).slice(0, 20).map(function (y) { return asStr(y, 60); }),
        candidateEvidence: (Array.isArray(x.candidateEvidence) ? x.candidateEvidence : []).slice(0, 20).map(function (y) { return asStr(y, 60); }),
        documentCount: Number(x.documentCount || 0), reason: asStr(x.reason, 240)
      };
    }).filter(Boolean);
  }
  if (isObj(m.suffBreakdown)) {
    out.suffBreakdown = {
      suff: numOrNull(m.suffBreakdown.suff),
      parts: (Array.isArray(m.suffBreakdown.parts) ? m.suffBreakdown.parts : []).slice(0, 6).map(function (p) {
        if (!isObj(p)) return null;
        return { key: asStr(p.key, 20), name: asStr(p.name, 40), weight: numOrNull(p.weight),
          ratio: numOrNull(p.ratio), detail: asStr(p.detail, 120) };
      }).filter(Boolean)
    };
  }
  out.formalBlockers = (Array.isArray(m.formalBlockers) ? m.formalBlockers : []).slice(0, 12).map(function (b) {
    if (!isObj(b)) return null;
    return { key: asStr(b.key, 40), text: asStr(b.text, 240) };
  }).filter(Boolean);
  ['acceptedEvidence', 'pendingEvidence'].forEach(function (key) {
    out[key] = (Array.isArray(m[key]) ? m[key] : []).slice(0, 40).map(function (e) {
      if (!isObj(e)) return null;
      return { id: asStr(e.id, 60), title: asStr(e.title, 200), metric: asStr(e.metric, 20) };
    }).filter(Boolean);
  });
  out.scoreHistory = (Array.isArray(m.scoreHistory) ? m.scoreHistory : []).slice(-6).map(function (h) {
    if (!isObj(h)) return null;
    const snap = function (s) {
      if (!isObj(s)) return null;
      return { accepted: numOrNull(s.accepted), candidate: numOrNull(s.candidate),
        formal: numOrNull(s.formal), suff: numOrNull(s.suff) };
    };
    return {
      at: asStr(h.at, 30), trigger: asStr(h.trigger, 120), actor: asStr(h.actor, 40),
      ruleVersion: asStr(h.ruleVersion, 40), before: snap(h.before), after: snap(h.after),
      changes: (Array.isArray(h.changes) ? h.changes : []).slice(0, 8).map(function (x) {
        if (!isObj(x)) return null;
        return { metric: asStr(x.metric, 20), name: asStr(x.name, 40), from: numOrNull(x.from),
          to: numOrNull(x.to), weight: numOrNull(x.weight) };
      }).filter(Boolean),
      candidateChanges: (Array.isArray(h.candidateChanges) ? h.candidateChanges : []).slice(0, 8).map(function (x) {
        if (!isObj(x)) return null;
        return { metric: asStr(x.metric, 20), name: asStr(x.name, 40), from: numOrNull(x.from), to: numOrNull(x.to) };
      }).filter(Boolean)
    };
  }).filter(Boolean);
  return out;
}

function normalizeContext(raw) {
  const c = isObj(raw) ? raw : {};
  const companies = (Array.isArray(c.companies) ? c.companies : []).slice(0, MAX_COMPANIES).map(function (co) {
    if (!isObj(co)) return null;
    const evidences = (Array.isArray(co.evidences) ? co.evidences : []).slice(0, MAX_EVIDENCE).map(function (e) {
      if (!isObj(e)) return null;
      return {
        id: asStr(e.id, 60), title: asStr(e.title, 300), source: asStr(e.source, 160),
        url: asStr(e.url, 500), date: asStr(e.date, 30), grade: asStr(e.grade, 4),
        dim: asStr(e.dim, 30), metric: asStr(e.metric, 30), summary: asStr(e.summary, 500),
        quote: asStr(e.quote, 2400), reviewStatus: asStr(e.reviewStatus, 40),
        origin: asStr(e.origin, 30), candidate: asBool(e.candidate),
        documentId: asStr(e.sourceDocumentId || (e.document && e.document.id) || '', 80),
        facts: (Array.isArray(e.facts) ? e.facts : []).slice(0, 24).map(function (f) {
          if (!isObj(f)) return null;
          return {
            label: asStr(f.label, 120), value: f.value == null ? null : Number(f.value),
            unit: asStr(f.unit, 20), operator: asStr(f.operator, 20), subject: asStr(f.subject, 160),
            snippet: asStr(f.snippet, 400), date: asStr(f.date || e.date, 30),
            evidenceId: asStr(f.evidenceId || e.id, 60), documentId: asStr(f.documentId || e.sourceDocumentId || '', 80)
          };
        }).filter(Boolean)
      };
    }).filter(Boolean);
    const judgements = (Array.isArray(co.judgements) ? co.judgements : []).slice(0, 60).map(function (j) {
      if (!isObj(j)) return null;
      return {
        id: asStr(j.id, 60), title: asStr(j.title, 200), statement: asStr(j.statement, 700),
        evidenceIds: (Array.isArray(j.evidenceIds) ? j.evidenceIds : []).map(function (x) { return asStr(x, 60); }).filter(Boolean),
        status: asStr(j.status, 30), statusText: asStr(j.statusText, 60), candidate: asBool(j.candidate),
        reviewRequired: j.reviewRequired !== false,
        verification: isObj(j.verification) ? {
          relation: asStr(j.verification.relation, 30), label: asStr(j.verification.label, 60),
          reason: asStr(j.verification.reason, 500)
        } : null
      };
    }).filter(Boolean);
    const conflicts = (Array.isArray(co.conflicts) ? co.conflicts : []).slice(0, 40).map(function (x) {
      if (!isObj(x)) return null;
      return { id: asStr(x.id, 60), title: asStr(x.title, 200), nature: asStr(x.nature, 30),
        status: asStr(x.status, 30), affected: (Array.isArray(x.affected) ? x.affected : []).map(function (y) { return asStr(y, 60); }) };
    }).filter(Boolean);
    return {
      id: asStr(co.id, 60), name: asStr(co.name, 200), code: asStr(co.code, 60),
      dataSource: asStr(co.dataSource, 30), industry: asStr(co.industry, 60), segment: asStr(co.segment, 80),
      region: asStr(co.region, 40), city: asStr(co.city, 80), scale: asStr(co.scale, 30),
      founded: asStr(co.founded, 30), staff: co.staff == null ? null : Number(co.staff),
      summary: asStr(co.summary, 800), verdict: asStr(co.verdict, 400), stage: asStr(co.stage, 30),
      evidences: evidences, judgements: judgements, conflicts: conflicts,
      techEvaluation: isObj(co.techEvaluation) ? sanitize(co.techEvaluation) : null,
      model: isObj(co.model) ? normalizeModel(co.model) : null,
      snapshots: (Array.isArray(co.snapshots) ? co.snapshots : []).slice(0, 4).map(function (s) {
        return {
          asOf: asStr(s.asOf, 20), evidenceCount: Number(s.evidenceCount || 0),
          documentCount: Number(s.documentCount || 0), facts: Number(s.facts || 0),
          techSummary: asStr(s.techSummary, 500), metrics: Array.isArray(s.metrics) ? s.metrics.slice(0, 8) : [],
          claims: Array.isArray(s.claims) ? s.claims.slice(0, 40) : [], pendingClaims: Number(s.pendingClaims || 0)
        };
      }),
      archives: (Array.isArray(co.archives) ? co.archives : []).slice(0, 8).map(function (a) {
        return { version: asStr(a.version, 80), archivedAt: asStr(a.archivedAt, 40), reviewer: asStr(a.reviewer, 60),
          dataMode: asStr(a.dataMode, 30), aiGenerated: asBool(a.aiGenerated) };
      }),
      analysis: isObj(co.analysis) ? {
        status: asStr(co.analysis.status, 20), stale: asBool(co.analysis.stale),
        createdAt: asStr(co.analysis.createdAt, 40), model: asStr(co.analysis.model, 80),
        items: (Array.isArray(co.analysis.items) ? co.analysis.items : []).slice(0, 30).map(function (it) {
          return { section: asStr(it.section, 40), claim: asStr(it.claim, 500),
            evidenceIds: Array.isArray(it.evidenceIds) ? it.evidenceIds.map(function (x) { return asStr(x, 60); }) : [] };
        }),
        nextSteps: (Array.isArray(co.analysis.nextSteps) ? co.analysis.nextSteps : []).slice(0, 12).map(function (q) {
          return { question: asStr(q.question, 300), evidenceIds: Array.isArray(q.evidenceIds) ? q.evidenceIds : [] };
        })
      } : null
    };
  }).filter(Boolean);

  const companyIndex = (Array.isArray(c.companyIndex) ? c.companyIndex : []).slice(0, 200).map(function (x) {
    if (!isObj(x)) return null;
    return { id: asStr(x.id, 60), name: asStr(x.name, 200), industry: asStr(x.industry, 60),
      dataSource: asStr(x.dataSource, 30), stage: asStr(x.stage, 30) };
  }).filter(Boolean);

  return {
    page: asStr(c.page, 30), pageLabel: VIEW_LABELS[asStr(c.page, 30)] || asStr(c.pageLabel, 60),
    companyId: asStr(c.companyId, 60),
    selection: isObj(c.selection) ? {
      evidenceId: asStr(c.selection.evidenceId, 60), judgementId: asStr(c.selection.judgementId, 60),
      conflictId: asStr(c.selection.conflictId, 60)
    } : {},
    companies: companies, companyIndex: companyIndex,
    workspace: isObj(c.workspace) ? {
      poolCount: Number(c.workspace.poolCount || 0), directoryCount: Number(c.workspace.directoryCount || 0),
      queueCount: Number(c.workspace.queueCount || 0), dataMode: asStr(c.workspace.dataMode, 40),
      asOf: asStr(c.workspace.asOf, 40)
    } : {},
    rules: isObj(c.rules) ? sanitize(c.rules) : null,
    attachments: (Array.isArray(c.attachments) ? c.attachments : []).slice(0, 4).map(function (a) {
      if (!isObj(a)) return null;
      return { name: asStr(a.name, 120), sourceName: asStr(a.sourceName, 160), url: asStr(a.url, 500),
        date: asStr(a.date, 30), inputTextType: asStr(a.inputTextType, 30), text: String(a.text || '').slice(0, 12000) };
    }).filter(Boolean)
  };
}

/* ---------------- 工具定义 ---------------- */
const TOOL_SPECS = [
  { name: 'get_current_context', desc: '获取当前页面、当前企业、选中证据、对比上下文与数据规模。', args: {} },
  { name: 'search_workspace', desc: '按关键词检索工作台中的企业、证据、判断和冲突。', args: { query: 'string', limit: 'number?' } },
  { name: 'get_company_profile', desc: '读取指定企业的档案、技术评分（技术分/候选分/正式分）、指标定级、充分度、出分条件、冲突、快照与已有分析。', args: { companyId: 'string?' } },
  { name: 'get_evidence', desc: '读取一条或多条证据的原文片段、字段、来源、日期与核验状态；多条请一次传 evidenceIds，避免逐条读取。', args: { evidenceId: 'string?', evidenceIds: 'string[]?', companyId: 'string?' } },
  { name: 'get_evaluation_rules', desc: '读取当前评价规则：规则版本、指标、权重、0—4 级锚点、充分度门槛、正式出分条件与阶段重点。', args: {} },
  { name: 'compare_companies', desc: '按统一口径比较两家以上企业的证据、技术维度和商业化线索。', args: { companyIds: 'string[]' } },
  { name: 'compare_snapshots', desc: '比较企业两个历史时点的证据与判断，禁止使用未来信息。', args: { companyId: 'string?', from: 'string?', to: 'string?' } },
  { name: 'search_public_sources', desc: '联网检索公开资料。未启用或不可用时必须如实返回不可用。', args: { query: 'string', limit: 'number?' } },
  { name: 'read_public_document', desc: '读取一个公开网页的标题与正文摘要；不绕过登录或访问控制。', args: { url: 'string' } },
  { name: 'extract_facts', desc: '把用户粘贴的公开资料抽取为结构化事实，并与原文逐字校验。', args: { text: 'string', sourceUrl: 'string', publishDate: 'string', sourceName: 'string?', companyId: 'string?' } },
  { name: 'verify_claims', desc: '跨文档核验声明与事实，识别支持、部分支持、冲突、统计口径差异和证据不足。', args: { companyId: 'string?', claim: 'string?' } },
  { name: 'analyze_technology', desc: '基于真实证据生成分维度技术价值分析草稿。', args: { companyId: 'string?', focus: 'string?' } },
  { name: 'assess_evidence_gaps', desc: '判断现有资料能支持哪些结论、缺哪些证据。', args: { companyId: 'string?' } },
  { name: 'critique_analysis', desc: '以银行审慎尽调视角反向检查分析中的推理跳跃与证据问题。', args: { companyId: 'string?', analysis: 'string?' } },
  { name: 'generate_due_diligence_questions', desc: '根据真实研究缺口生成尽调问题。', args: { companyId: 'string?', limit: 'number?' } },
  { name: 'propose_company', desc: '提出新建企业档案，需用户确认。', args: { name: 'string', industry: 'string?', region: 'string?', summary: 'string?' } },
  { name: 'propose_evidence', desc: '提出新增证据，需用户确认；必须带来源网址与原文片段。', args: { title: 'string', source: 'string', url: 'string', date: 'string', quote: 'string', metric: 'string?', statement: 'string?', companyId: 'string?' } },
  { name: 'propose_judgement', desc: '提出新增或调整技术判断，需用户确认。', args: { title: 'string', statement: 'string', evidenceIds: 'string[]', companyId: 'string?' } },
  { name: 'propose_evaluation', desc: '提出评价指标候选等级及依据，需用户确认。', args: { metric: 'string', level: 'string', evidenceIds: 'string[]', reason: 'string?', companyId: 'string?' } },
  { name: 'generate_report', desc: '提出生成研究报告并跳转导出页，需用户确认。', args: { companyId: 'string?', scope: 'string?' } },
  { name: 'navigate_workspace', desc: '建议打开企业、证据、评价或报告页面。', args: { view: 'string', companyId: 'string?', evidenceId: 'string?' } }
];
const TOOL_NAMES = TOOL_SPECS.map(function (t) { return t.name; });

function validateArgs(name, raw) {
  const spec = TOOL_SPECS.filter(function (t) { return t.name === name; })[0];
  if (!spec) return { ok: false, error: '未知工具：' + name };
  const a = isObj(raw) ? raw : {};
  const keys = Object.keys(spec.args);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const type = spec.args[k];
    const optional = type.charAt(type.length - 1) === '?';
    const base = optional ? type.slice(0, -1) : type;
    const v = a[k];
    if (v == null || v === '') {
      if (!optional) return { ok: false, error: '缺少参数 ' + k };
      continue;
    }
    if (base === 'string' && typeof v !== 'string') return { ok: false, error: '参数 ' + k + ' 应为字符串' };
    if (base === 'number' && typeof v !== 'number') return { ok: false, error: '参数 ' + k + ' 应为数字' };
    if (base === 'string[]' && (!Array.isArray(v) || v.some(function (x) { return typeof x !== 'string'; }))) {
      return { ok: false, error: '参数 ' + k + ' 应为字符串数组' };
    }
  }
  if (name === 'get_evidence') {
    const single = !!a.evidenceId;
    const batch = Array.isArray(a.evidenceIds) && a.evidenceIds.length > 0;
    if (!single && !batch) return { ok: false, error: '缺少参数 evidenceId 或 evidenceIds' };
    if (batch && a.evidenceIds.length > MAX_BATCH_EVIDENCE) {
      return { ok: false, error: '单次最多读取 ' + MAX_BATCH_EVIDENCE + ' 条证据，请分批读取' };
    }
  }
  return { ok: true, args: a };
}

/* ---------------- 通用查找 ---------------- */
function companyById(ctx, id) {
  const cid = id || ctx.companyId;
  return ctx.companies.filter(function (c) { return c.id === cid; })[0] || null;
}
function evidenceById(c, id) {
  return (c && c.evidences || []).filter(function (e) { return e.id === id; })[0] || null;
}
function allEvidenceMap(ctx) {
  const map = {};
  ctx.companies.forEach(function (c) {
    c.evidences.forEach(function (e) { map[c.id + ':' + e.id] = { company: c, evidence: e }; });
  });
  return map;
}
function knownIds(ctx) {
  const ids = { evidence: {}, judgement: {}, conflict: {} };
  ctx.companies.forEach(function (c) {
    c.evidences.forEach(function (e) { ids.evidence[e.id] = c.id; });
    c.judgements.forEach(function (j) { ids.judgement[j.id] = c.id; });
    c.conflicts.forEach(function (x) { ids.conflict[x.id] = c.id; });
  });
  return ids;
}
function findEvidenceAnywhere(ctx, id) {
  for (let i = 0; i < ctx.companies.length; i++) {
    const e = evidenceById(ctx.companies[i], id);
    if (e) return { company: ctx.companies[i], evidence: e };
  }
  return null;
}
function metricLabel(key) {
  const map = { patent: '专利与知识产权', rd: '研发活动', advancement: '技术先进性', product: '产品化', adoption: '客户采用', other: '其他技术线索' };
  return map[key] || key || '未分类';
}

/* ---------------- 纯规则工具 ---------------- */
function toolCurrentContext(ctx) {
  const c = companyById(ctx);
  return {
    page: ctx.page, pageLabel: ctx.pageLabel, companyId: ctx.companyId,
    currentCompany: c ? { id: c.id, name: c.name, industry: c.industry, segment: c.segment,
      dataSource: c.dataSource, evidenceCount: c.evidences.length, judgementCount: c.judgements.length,
      conflictCount: c.conflicts.length } : null,
    selection: ctx.selection, companyPool: ctx.companyIndex.length,
    workspace: ctx.workspace,
    attachments: ctx.attachments.map(function (a) { return { name: a.name, sourceName: a.sourceName, url: a.url, date: a.date, chars: a.text.length }; })
  };
}

function toolSearchWorkspace(ctx, args) {
  const q = norm(args.query).toLowerCase();
  if (!q) return { ok: false, error: '检索词为空' };
  const limit = Math.max(1, Math.min(20, Number(args.limit) || 8));
  const hits = [];
  const add = function (type, company, id, label, extra) {
    if (hits.length >= limit * 4) return;
    hits.push(Object.assign({ type: type, companyId: company.id, companyName: company.name, id: id, label: label }, extra || {}));
  };
  ctx.companies.forEach(function (c) {
    if ((c.name + ' ' + c.code + ' ' + c.industry + ' ' + c.segment).toLowerCase().indexOf(q) >= 0) {
      add('company', c, c.id, c.name, { industry: c.industry, dataSource: c.dataSource });
    }
    c.evidences.forEach(function (e) {
      if ((e.title + ' ' + e.summary + ' ' + e.quote + ' ' + e.source).toLowerCase().indexOf(q) >= 0) {
        add('evidence', c, e.id, e.title, { date: e.date, grade: e.grade, metric: e.metric, status: e.reviewStatus });
      }
    });
    c.judgements.forEach(function (j) {
      if ((j.title + ' ' + j.statement).toLowerCase().indexOf(q) >= 0) {
        add('judgement', c, j.id, j.title, { status: j.statusText, candidate: j.candidate });
      }
    });
    c.conflicts.forEach(function (x) {
      if ((x.title + ' ' + x.nature).toLowerCase().indexOf(q) >= 0) {
        add('conflict', c, x.id, x.title, { nature: x.nature, status: x.status });
      }
    });
  });
  return { ok: true, query: args.query, count: hits.length, hits: hits.slice(0, limit) };
}

function toolCompanyProfile(ctx, args, state) {
  const c = companyById(ctx, args.companyId);
  if (!c) return { ok: false, error: '上下文中没有该企业，请先切换或新建企业卷宗' };
  const cache = state && state.cache && state.cache.profile;
  if (cache && cache[c.id]) return Object.assign({}, cache[c.id], { cached: true });
  const result = {
    ok: true,
    company: {
      id: c.id, name: c.name, code: c.code, dataSource: c.dataSource, industry: c.industry, segment: c.segment,
      region: c.region, city: c.city, scale: c.scale, founded: c.founded, staff: c.staff,
      summary: c.summary, verdict: c.verdict, stage: c.stage,
      evidenceCount: c.evidences.length, judgementCount: c.judgements.length,
      conflicts: c.conflicts, techEvaluation: c.techEvaluation, model: c.model,
      snapshots: c.snapshots.map(function (s) {
        return { asOf: s.asOf, evidenceCount: s.evidenceCount, documentCount: s.documentCount,
          facts: s.facts, techSummary: s.techSummary, pendingClaims: s.pendingClaims };
      }),
      archives: c.archives, analysis: c.analysis,
      evidences: c.evidences.map(function (e) {
        return { id: e.id, title: e.title, date: e.date, grade: e.grade, metric: e.metric,
          source: e.source, url: e.url, status: e.reviewStatus, summary: clip(e.summary, 240) };
      }),
      judgements: c.judgements
    }
  };
  if (cache) cache[c.id] = result;
  return result;
}

function toolEvidence(ctx, args, state) {
  const ids = Array.isArray(args.evidenceIds) && args.evidenceIds.length ? args.evidenceIds : [args.evidenceId];
  const cache = state && state.cache && state.cache.evidence;
  const items = [];
  const missing = [];
  ids.forEach(function (id) {
    const cacheKey = (args.companyId || '') + ':' + id;
    if (cache && cache[cacheKey]) { items.push(Object.assign({}, cache[cacheKey], { cached: true })); return; }
    const found = args.companyId
      ? (function () { const c = companyById(ctx, args.companyId); const e = evidenceById(c, id); return e ? { company: c, evidence: e } : null; })()
      : findEvidenceAnywhere(ctx, id);
    if (!found) { missing.push(id); return; }
    const e = found.evidence;
    const item = {
      company: { id: found.company.id, name: found.company.name },
      evidence: {
        id: e.id, title: e.title, source: e.source, url: e.url, date: e.date, grade: e.grade,
        metric: e.metric, summary: e.summary, quote: e.quote, reviewStatus: e.reviewStatus,
        origin: e.origin, facts: e.facts
      }
    };
    items.push(item);
    if (cache) cache[cacheKey] = item;
  });
  if (!items.length) return { ok: false, error: '证据 ID 不存在于当前上下文：' + missing.join('、') };
  if (!Array.isArray(args.evidenceIds) && items.length === 1) {
    return { ok: true, company: items[0].company, evidence: items[0].evidence };
  }
  return {
    ok: true, count: items.length, items: items, missing: missing,
    note: '批量读取只返回已存在的证据；缺失 ID 列入 missing，不推测内容。'
  };
}

function toolEvaluationRules(ctx, args, state) {
  if (state && state.cache && state.cache.rules) return Object.assign({}, state.cache.rules, { cached: true });
  const result = { ok: true, rules: ctx.rules || { note: '前端未提供评价规则快照，不能假设具体门槛或权重' } };
  if (state && state.cache) state.cache.rules = result;
  return result;
}

function toolCompareCompanies(ctx, args) {
  const ids = (args.companyIds || []).slice(0, 5);
  const list = ids.map(function (id) { return companyById(ctx, id); }).filter(Boolean);
  if (list.length < 2) return { ok: false, error: '至少需要两家在当前上下文中的企业；未建档企业请先新建卷宗并补充资料' };
  const row = function (c) {
    const metrics = {};
    c.evidences.forEach(function (e) {
      const k = e.metric || 'other';
      metrics[k] = metrics[k] || { evidence: 0, documents: {}, latest: '' };
      metrics[k].evidence++;
      metrics[k].documents[e.documentId || e.id] = 1;
      if (e.date > metrics[k].latest) metrics[k].latest = e.date;
    });
    return {
      id: c.id, name: c.name, dataSource: c.dataSource, industry: c.industry, segment: c.segment,
      comparability: c.dataSource === 'simulated' ? '模拟数据，不可与真实企业直接排名' : '研究/公开资料',
      evidence: c.evidences.length,
      evidencesWithUrl: c.evidences.filter(function (e) { return /^https?:\/\//i.test(e.url); }).length,
      independentDocuments: uniq(c.evidences.map(function (e) { return e.documentId || e.id; })).length,
      judgements: c.judgements.length,
      confirmedJudgements: c.judgements.filter(function (j) { return j.status === 'confirmed'; }).length,
      openConflicts: c.conflicts.filter(function (x) { return x.status !== 'resolved'; }).length,
      metrics: Object.keys(metrics).map(function (k) {
        return { key: k, name: metricLabel(k), evidence: metrics[k].evidence,
          documents: Object.keys(metrics[k].documents).length, latest: metrics[k].latest };
      }),
      techEvaluation: c.techEvaluation, model: c.model, verdict: c.verdict
    };
  };
  return {
    ok: true,
    note: '比较只使用双方实际存在的证据；证据数量不等于技术质量，模拟企业与真实企业分别标注。',
    companies: list.map(row),
    incomparable: list.length >= 2 && list.some(function (c) { return c.dataSource === 'simulated'; }) && list.some(function (c) { return c.dataSource !== 'simulated'; })
  };
}

function toolCompareSnapshots(ctx, args) {
  const c = companyById(ctx, args.companyId);
  if (!c) return { ok: false, error: '上下文中没有该企业' };
  const snaps = c.snapshots.slice();
  if (snaps.length < 2) return { ok: false, error: '当前没有两个时点的快照数据' };
  const from = args.from ? snaps.filter(function (s) { return s.asOf === args.from; })[0] : snaps[0];
  const to = args.to ? snaps.filter(function (s) { return s.asOf === args.to; })[0] : snaps[snaps.length - 1];
  if (!from || !to) return { ok: false, error: '指定时点不存在于快照中' };
  const prev = {}; from.claims.forEach(function (x) { prev[x.id] = true; });
  return {
    ok: true, companyId: c.id, companyName: c.name, from: from, to: to,
    addedClaims: to.claims.filter(function (x) { return !prev[x.id]; }),
    note: '快照由前端按证据发布日期生成；本工具不补充任何未来信息。'
  };
}

/* ---------------- 证据核验（确定性） ---------------- */
function scopeBase(label) {
  const t = norm(label).replace(/[（(].*?[)）]/g, '');
  return t.replace(/申请|授权|有效|公开|受理|数量|总数|累计|其中|已|共|合计|数|量|件|项/g, '').replace(/\s+/g, '') || t;
}
function scopeOf(label) {
  const t = norm(label);
  if (/申请|受理|公开未授权|未授权/.test(t)) return 'application';
  if (/授权|有效|在权|维持/.test(t)) return 'grant';
  return 'unspecified';
}
function collectFacts(c) {
  const out = [];
  (c.evidences || []).forEach(function (e) {
    (e.facts || []).forEach(function (f) {
      if (f.value == null || !isFinite(Number(f.value))) return;
      out.push({
        label: f.label, value: Number(f.value), unit: f.unit || '', operator: f.operator || '',
        subject: f.subject || c.name, evidenceId: e.id, documentId: e.documentId || e.sourceDocumentId || e.id,
        date: f.date || e.date, source: e.source, base: scopeBase(f.label), scope: scopeOf(f.label)
      });
    });
  });
  return out;
}
function parseClaim(claim, c) {
  const t = norm(claim);
  const num = /(\d+(?:\.\d+)?)/.exec(t);
  if (!num) return null;
  const baseM = /(发明专利|实用新型|外观设计|专利|软件著作权|软著|著作权)/.exec(t);
  return {
    value: Number(num[1]), base: baseM ? baseM[1].replace('软著', '软件著作权').replace('专利', '专利') : '',
    scope: /未授权|申请|受理/.test(t) ? 'application' : (/授权|有效|在权/.test(t) ? 'grant' : 'unspecified'),
    text: t
  };
}
function toolVerifyClaims(ctx, args) {
  const c = companyById(ctx, args.companyId);
  if (!c) return { ok: false, error: '上下文中没有该企业' };
  const facts = collectFacts(c);
  const groups = {};
  facts.forEach(function (f) {
    const k = f.base || f.label;
    groups[k] = groups[k] || [];
    groups[k].push(f);
  });
  const relations = [];
  const scopeConflicts = [];
  Object.keys(groups).forEach(function (base) {
    const arr = groups[base];
    const docs = uniq(arr.map(function (f) { return f.documentId; }));
    const scopes = uniq(arr.map(function (f) { return f.scope; }));
    if (scopes.indexOf('application') >= 0 && scopes.indexOf('grant') >= 0) {
      const apps = arr.filter(function (f) { return f.scope === 'application'; });
      const grants = arr.filter(function (f) { return f.scope === 'grant'; });
      const maxApp = Math.max.apply(null, apps.map(function (f) { return f.value; }));
      const grantsList = grants.map(function (f) { return f.value + (f.unit || '') + '（' + f.evidenceId + '）'; });
      scopeConflicts.push({
        base: base, relation: 'timing', label: '统计口径不同',
        reason: base + '同时存在申请量与授权量：申请 ' + maxApp + (apps[0].unit || '') + '（' + apps.map(function (f) { return f.evidenceId; }).join('、') + '），授权 ' + grantsList.join('、') + '。申请量不能表述为授权量。',
        evidenceIds: uniq(apps.concat(grants).map(function (f) { return f.evidenceId; })),
        independentSources: uniq(arr.map(function (f) { return f.documentId; })).length,
        canAssertNegative: false
      });
    }
    if (docs.length >= 2) {
      const values = uniq(arr.map(function (f) { return f.scope + ':' + f.value + (f.unit || ''); }));
      if (values.length > 1 && scopes.indexOf('application') < 0) {
        relations.push({
          base: base, relation: 'conflict', label: '实质冲突',
          reason: base + '在不同来源中的数值不一致：' + arr.map(function (f) { return f.value + (f.unit || '') + '（' + f.evidenceId + '）'; }).join('、'),
          evidenceIds: uniq(arr.map(function (f) { return f.evidenceId; })), canAssertNegative: false
        });
      } else {
        relations.push({
          base: base, relation: docs.length >= 2 ? 'supports' : 'partial',
          label: docs.length >= 2 ? '多来源支持' : '单一来源',
          reason: base + '由 ' + docs.length + ' 个独立来源文档支持。',
          evidenceIds: uniq(arr.map(function (f) { return f.evidenceId; })), canAssertNegative: false
        });
      }
    }
  });
  let claimCheck = null;
  if (args.claim) {
    const claim = parseClaim(args.claim, c);
    if (claim && claim.base) {
      const arr = facts.filter(function (f) { return f.base === claim.base || f.label.indexOf(claim.base) >= 0; });
      const grants = arr.filter(function (f) { return f.scope === 'grant'; });
      const apps = arr.filter(function (f) { return f.scope === 'application'; });
      if (claim.scope === 'grant' && grants.length) {
        const maxGrant = Math.max.apply(null, grants.map(function (f) { return f.value; }));
        const ok = claim.value <= maxGrant;
        claimCheck = {
          claim: args.claim, relation: ok ? 'supports' : 'timing',
          label: ok ? '授权量有证据支持' : '统计口径冲突',
          reason: ok
            ? '声明 ' + claim.value + ' 项授权，现有授权证据最大值为 ' + maxGrant + ' 项（' + grants.map(function (f) { return f.evidenceId; }).join('、') + '）。'
            : '声明 ' + claim.value + ' 项已授权，但授权证据最大值为 ' + maxGrant + ' 项（' + grants.map(function (f) { return f.evidenceId; }).join('、') + '）；申请量 ' + (apps.length ? Math.max.apply(null, apps.map(function (f) { return f.value; })) : '未取得') + ' 项不能当作授权量。',
          evidenceIds: uniq(grants.concat(apps).map(function (f) { return f.evidenceId; })),
          canAssertNegative: false
        };
      } else if (!arr.length) {
        claimCheck = { claim: args.claim, relation: 'insufficient', label: '证据不足', reason: '未取得与该声明对应的数值事实，不能确认或否认。', evidenceIds: [], canAssertNegative: false };
      }
    }
  }
  return {
    ok: true, companyId: c.id, companyName: c.name,
    documents: uniq(facts.map(function (f) { return f.documentId; })).length,
    facts: facts.length, scopeConflicts: scopeConflicts, relations: relations.slice(0, 30),
    claimCheck: claimCheck,
    note: '核验只基于工作台已有证据与数值事实；缺少资料时保留“证据不足”，不推断企业造假。'
  };
}

function toolAssessGaps(ctx, args) {
  const c = companyById(ctx, args.companyId);
  if (!c) return { ok: false, error: '上下文中没有该企业' };
  const metrics = ['patent', 'rd', 'advancement', 'product', 'adoption'];
  const present = {};
  c.evidences.forEach(function (e) { present[e.metric || 'other'] = true; });
  const noUrl = c.evidences.filter(function (e) { return !/^https?:\/\//i.test(e.url); });
  const pending = c.judgements.filter(function (j) { return j.status !== 'confirmed' && !j.candidate; });
  const candidate = c.judgements.filter(function (j) { return j.candidate; });
  const openConflicts = c.conflicts.filter(function (x) { return x.status !== 'resolved'; });
  const canSupport = [];
  c.judgements.filter(function (j) { return j.status === 'confirmed'; }).forEach(function (j) {
    canSupport.push({ id: j.id, title: j.title, evidenceIds: j.evidenceIds });
  });
  const out = {
    ok: true, companyId: c.id, companyName: c.name,
    supportedConclusions: canSupport,
    missingMetrics: metrics.filter(function (k) { return !present[k]; }).map(function (k) { return { key: k, name: metricLabel(k) }; }),
    evidenceWithoutUrl: noUrl.map(function (e) { return { id: e.id, title: e.title, source: e.source }; }).slice(0, 12),
    pendingJudgements: pending.map(function (j) { return { id: j.id, title: j.title, status: j.statusText, reason: j.verification && j.verification.reason }; }).slice(0, 16),
    candidateJudgements: candidate.length,
    openConflicts: openConflicts.map(function (x) { return { id: x.id, title: x.title, nature: x.nature }; }),
    stageUnknown: !c.industry || !c.stage,
    note: '缺口只说明资料不足，不等于企业存在问题；未知指标不按 0 分处理。'
  };
  const m = c.model;
  if (m && m.research) {
    out.scoring = {
      evaluationState: m.evaluationState,
      technicalScore: m.technicalScore, acceptedScore: m.acceptedScore,
      candidateScore: m.candidateScore, formalScore: m.formalScore,
      suff: m.suff, ruleVersion: m.ruleVersion,
      suffBreakdown: m.suffBreakdown || null,
      formalBlockers: m.formalBlockers || []
    };
    out.metricStatus = (m.metricLevels || []).map(function (x) {
      return { key: x.key, name: x.name, dim: x.dim,
        acceptedLevel: x.acceptedLevel, candidateLevel: x.candidateLevel,
        acceptedEvidence: x.acceptedEvidence || [], candidateEvidence: x.candidateEvidence || [],
        reason: x.reason,
        gap: x.acceptedLevel == null
          ? (x.candidateLevel != null ? '有候选证据但未采信' : '未取得该类证据')
          : (x.acceptedLevel < 3 ? '已有可核证据，可补第二来源提升定级' : '') };
    });
    out.unacceptedEvidence = (m.pendingEvidence || []).map(function (e) { return { id: e.id, title: e.title, metric: e.metric }; });
  }
  return out;
}

function toolDueDiligenceQuestions(ctx, args) {
  const c = companyById(ctx, args.companyId);
  if (!c) return { ok: false, error: '上下文中没有该企业' };
  const limit = Math.max(3, Math.min(10, Number(args.limit) || 6));
  const qs = [];
  const push = function (q, reason, ids, extra) {
    const item = { question: q, reason: reason, evidenceIds: ids || [], problem: reason };
    if (extra) Object.keys(extra).forEach(function (k) { item[k] = extra[k]; });
    qs.push(item);
  };
  const present = {};
  const byMetric = {};
  c.evidences.forEach(function (e) {
    present[e.metric || 'other'] = true;
    (byMetric[e.metric || 'other'] = byMetric[e.metric || 'other'] || []).push(e);
  });
  const ids = function (k) { return (byMetric[k] || []).map(function (e) { return e.id; }).slice(0, 4); };
  const m = c.model && c.model.research ? c.model : null;
  const lv = function (k) {
    const row = m && (m.metricLevels || []).filter(function (x) { return x.key === k; })[0];
    return row ? { accepted: row.acceptedLevel, candidate: row.candidateLevel } : null;
  };
  /* 有模型时以“已采信定级”判断缺口；候选证据存在但未采信仍应生成建议。 */
  const acceptedNull = function (k) {
    const row = lv(k);
    return row ? row.accepted == null : !present[k];
  };
  const metricItem = function (k, q, reason, extra) {
    const level = lv(k);
    push(q, reason, ids(k), Object.assign({
      metric: k, metricName: metricLabel(k),
      existingEvidence: ids(k),
      currentLevel: level,
      impact: '影响“' + metricLabel(k) + '”定级和按权重计算的参考分；不改变其他指标。',
      ifUnavailable: '若无法取得，该项保持未知，不按 0 分处理，也不得计入正式分。'
    }, extra || {}));
  };
  const hasCand = function (k) { const r = lv(k); return !!(r && r.candidate != null); };
  if (present.patent && !acceptedNull('patent')) {
    metricItem('patent', '核心专利的专利权人、共同研发方与当前法律状态是否已逐项核对？',
      '专利数量不能替代权属与有效性核验。未标注来源的清单不会提升定级。',
      { neededMaterial: '专利号/受理号、授权公告或登记簿副本', verification: '在国家知识产权局或官方登记渠道核对权利人、法律状态与缴费记录' });
  } else if (present.patent) {
    metricItem('patent', '已导入的专利证据尚未人工采信，权属与法律状态由谁确认？',
      '候选证据只能影响候选分，不能进入正式分。',
      { neededMaterial: '专利号/受理号、授权公告或登记簿副本', verification: '在国家知识产权局或官方登记渠道核对权利人、法律状态与缴费记录',
        impact: '采信后才会计入“专利与知识产权”定级；未采信时正式分不变。' });
  } else {
    metricItem('patent', '能否提供可核验的专利或软件著作权登记信息？',
      '当前未取得知识产权证据，无法判断技术资产。',
      { neededMaterial: '专利受理通知书、授权证书或软著登记证书（含登记号）', verification: '官方登记渠道核验编号与权利人' });
  }
  if ((present.product || hasCand('product')) && !present.adoption) {
    metricItem('product', '已登记的产品是否形成实际交付、验收或收入？',
      '产品化线索不等同于商业化，缺少客户采用证据会限制技术转化维度。',
      { neededMaterial: '销售合同、交付单、验收单或发票汇总（可脱敏）', verification: '抽取 1—2 笔与产品型号对应的交付记录' });
  }
  if (present.adoption || hasCand('adoption')) {
    metricItem('adoption', '中标记录是否已签署合同并完成验收？',
      '中标公告不能直接当作收入或交付，申请/中标与验收是不同口径。',
      { neededMaterial: '中标通知书、合同首页与签章页、验收单', verification: '核对合同主体、金额口径与验收时间' });
  }
  if (acceptedNull('rd')) {
    metricItem('rd', '研发团队规模、研发投入与在研项目如何验证？',
      present.rd ? '研发证据尚未采信或来源不足，研发与先进性维度无法计入正式分。' : '缺少研发活动证据，研发与先进性维度无法成立。',
      { neededMaterial: '研发项目立项书、研发人员名单（可脱敏）、研发费用辅助账', verification: '抽查立项与人员社保/工时记录的一致性' });
  }
  if (acceptedNull('advancement')) {
    metricItem('advancement', hasCand('advancement') ? '技术先进性证据尚未采信，检测机构资质与样品对应关系是否已核对？' : '技术先进性的第三方依据是什么？',
      hasCand('advancement') ? '候选先进性证据不能进入正式分，需要采信或补充独立来源。' : '当前只有企业自述，缺少可核验的性能或鉴定材料。',
      { neededMaterial: '第三方检测报告、技术鉴定意见或权威奖项', verification: '核对检测机构资质、样品型号与报告编号' });
  }
  c.conflicts.filter(function (x) { return x.status !== 'resolved'; }).slice(0, 2).forEach(function (x) {
    push('请核实冲突 ' + x.id + '：' + x.title + '，应以哪份原始材料为准？', '该冲突尚未处置。', x.affected || [], {
      metric: 'multiple', metricName: '跨指标',
      neededMaterial: '冲突双方的原始材料与发布主体说明',
      verification: '逐份核对发布主体、日期、统计口径（申请/授权、含税/不含税）',
      impact: '未处置的实质冲突会阻断正式出分；口径差异可标注后保留。',
      ifUnavailable: '无法核实时保持存疑，不计入正式分。'
    });
  });
  c.judgements.filter(function (j) { return j.candidate; }).slice(0, 2).forEach(function (j) {
    push('候选判断“' + j.title + '”是否已取得独立来源支持？', '该判断尚未纳入正式画像。', j.evidenceIds || [], {
      metric: 'other', metricName: '判断纳入',
      neededMaterial: '第二个独立来源或原始文件',
      verification: '比对独立来源的表述与数据口径',
      impact: '纳入后才会进入正式画像与评分依据。',
      ifUnavailable: '保持候选状态，不影响正式结论。'
    });
  });
  if (!c.stage) push('企业的育种期/育苗期/育材期应如何认定？', '发展阶段没有依据，评价重点无法确定。', [], {
    metric: 'other', metricName: '发展阶段',
    neededMaterial: '成立时间、团队规模、研发阶段说明',
    verification: '与工商登记、社保人数和项目进度交叉核对',
    impact: '影响阶段重点与材料清单，不直接改变技术分。',
    ifUnavailable: '阶段保持未知，不做阶段化推断。'
  });
  if (m && m.formalBlockers && m.formalBlockers.length) {
    m.formalBlockers.slice(0, 3).forEach(function (b) {
      push('正式出分条件未满足：' + b.text + '，如何补齐或处置？', '技术分与正式条件分开判断；充分度门槛不是分数及格线。', [], {
        metric: 'multiple', metricName: '出分条件',
        neededMaterial: b.key === 'suff' ? '可追溯来源的第二/第三份材料' : '对应指标的可核证据或冲突处置记录',
        verification: '按规则版本 ' + (m.ruleVersion || '') + ' 逐项核对',
        impact: '只影响能否进入正式评价，不会自动提高技术分。',
        ifUnavailable: '维持参考状态，输出部分评价并标注未知项。'
      });
    });
  }
  return { ok: true, companyId: c.id, companyName: c.name, questions: qs.slice(0, limit),
    ruleVersion: m ? m.ruleVersion : null,
    note: '建议由现有证据缺口、冲突和出分条件生成，未使用模型推测；不得承诺提分或授信。' };
}

/* ---------------- 联网搜索 ---------------- */
function searchMode() {
  const m = norm(process.env.AGENT_SEARCH_MODE || (process.env.AI_SEARCH_ENABLED === '1' ? 'dashscope' : 'off')).toLowerCase();
  return ['off', 'dashscope'].indexOf(m) >= 0 ? m : 'off';
}

async function searchDashScope(query, limit, deps) {
  if (!deps.API_KEY) return { available: false, reason: '未配置 API Key，无法调用联网搜索', results: [] };
  const endpoint = norm(process.env.AI_SEARCH_ENDPOINT) || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 45000);
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + deps.API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: deps.API_MODEL,
        input: { messages: [
          { role: 'system', content: '你是企业公开资料检索助手。只做检索与摘录，不评价企业优劣。' },
          { role: 'user', content: '检索并概括以下公开资料：' + query + '。请给出可核验来源，不编造网址。' }
        ] },
        parameters: {
          result_format: 'message', enable_search: true,
          search_options: { forced_search: true, search_strategy: 'max', enable_source: true, enable_citation: true }
        }
      })
    });
    const raw = await r.text();
    let j = null;
    try { j = JSON.parse(raw); } catch (e) {}
    if (!r.ok) {
      const msg = (j && (j.message || (j.error && j.error.message))) || ('搜索接口 HTTP ' + r.status);
      const err = new Error(msg); err.status = r.status; err.code = 'search_upstream_error';
      throw err;
    }
    const out = (j && (j.output || j)) || {};
    const choice = out.choices && out.choices[0];
    const answer = choice && choice.message && choice.message.content || '';
    const info = out.search_info || out.searchInfo || null;
    const list = (info && (info.search_results || info.searchResults)) || [];
    const results = list.slice(0, Math.max(1, Math.min(10, limit))).map(function (x) {
      return {
        title: asStr(x.title, 300), url: asStr(x.url, 800), siteName: asStr(x.site_name || x.siteName, 120),
        snippet: asStr(x.snippet || x.summary, 600), publishedAt: asStr(x.publish_date || x.published_at, 40),
        sourceType: 'search_result'
      };
    });
    if (!results.length) {
      return { available: false, reason: '搜索接口已返回，但 search_info.search_results 为空：未检索到可核验来源', results: [], modelSummary: clip(answer, 1200) };
    }
    return {
      available: true, query: query, results: results, modelSummary: clip(answer, 2000),
      retrievedAt: new Date().toISOString(), sourceType: 'search_result',
      note: '标题、网址与检索时间来自搜索接口真实返回；摘要区分为搜索摘要与模型概括，未经网页正文逐字核对。'
    };
  } finally { clearTimeout(timer); }
}

async function toolSearchPublic(ctx, args, deps, state) {
  if ((state.searchUsed || 0) >= 2) {
    return { ok: false, error: '本次对话检索次数已达上限（1 次初始检索 + 1 轮补充），请基于已有结果收敛，缺口写清并交给用户补充资料' };
  }
  state.searchUsed = (state.searchUsed || 0) + 1;
  const mode = searchMode();
  if (mode === 'off') {
    return {
      ok: true, available: false, results: [], query: args.query,
      reason: '当前服务未启用可验证的联网搜索通道（AGENT_SEARCH_MODE=off）。',
      suggestion: '可粘贴公开原文到对话中继续抽取与核验；系统不会伪造搜索结果。',
      checkedAt: new Date().toISOString()
    };
  }
  try {
    const res = await searchDashScope(args.query, Number(args.limit) || 6, deps);
    if (res.available) {
      res.results.forEach(function (r) { if (/^https?:\/\//i.test(r.url)) state.webSources[r.url] = r; });
    }
    return Object.assign({ ok: true }, res);
  } catch (e) {
    return {
      ok: true, available: false, results: [], query: args.query,
      reason: '联网搜索调用失败：' + (e && e.message ? e.message : '未知错误'),
      errorCode: e && e.code || 'search_error', checkedAt: new Date().toISOString()
    };
  }
}

/* ---------------- 公开网页读取 ---------------- */
function privateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '::1' || h === '[::1]' || /^f[cd][0-9a-f]{2}:/i.test(h)) return true;
  if (/^::ffff:/i.test(h)) return true;
  if (/^0\./.test(h)) return true;
  return false;
}
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

async function toolReadPublic(ctx, args) {
  let u;
  try { u = new URL(args.url); } catch (e) { return { ok: false, error: '网址格式不合法' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: '只允许读取 http/https 公开网页' };
  if (privateHost(u.hostname)) return { ok: false, error: '出于安全原因，不读取本机或内网地址' };
  let addrs = [];
  try { addrs = await dns.promises.lookup(u.hostname, { all: true, verbatim: true }); }
  catch (e) { return { ok: true, fetched: false, url: u.href, error: '域名解析失败：' + (e && e.message || '未知错误'), note: '未发起请求，避免访问无法验证的目标。' }; }
  if (!addrs.length || addrs.some(function (a) { return privateHost(a.address); })) {
    return { ok: false, error: '出于安全原因，不读取解析到本机或内网地址的链接' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 15000);
  try {
    const r = await fetch(u.href, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': 'ProofTrace-Research/1.0 (public evidence reader)', 'Accept': 'text/html,text/plain,application/json' }
    });
    const type = String(r.headers.get('content-type') || '');
    if (!/text\/html|text\/plain|application\/json|application\/xml/i.test(type)) {
      return { ok: true, fetched: false, status: r.status, url: u.href,
        error: '返回内容类型为 ' + (type || '未知') + '，不是可读文本网页；未解析二进制文件。' };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 600 * 1024) {
      return { ok: true, fetched: false, status: r.status, url: u.href, error: '网页超过 600KB，已停止读取。' };
    }
    const html = buf.toString('utf8');
    const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const text = stripHtml(html);
    return {
      ok: true, fetched: r.ok, status: r.status, url: u.href, contentType: type,
      title: titleM ? stripHtml(titleM[1]).slice(0, 300) : '',
      text: clip(text, 6000), chars: text.length, fetchedAt: new Date().toISOString(),
      note: r.ok ? '已读取公开网页文本；这是网页原文摘录，不等于事实已核实。' : '网页返回非 2xx，内容可能不完整。'
    };
  } catch (e) {
    return { ok: true, fetched: false, url: u.href,
      error: (e && e.name === 'AbortError') ? '读取网页超时' : ('读取网页失败：' + (e && e.message || '未知错误')),
      note: '读取失败已如实返回，未使用缓存或生成的替代内容。' };
  } finally { clearTimeout(timer); }
}

/* ---------------- 模型辅助工具 ---------------- */
async function toolExtractFacts(ctx, args, deps, state) {
  if (state.extractUsed >= 1) return { ok: false, error: '本次对话已执行过一次资料抽取，请先使用结果或分多轮提交' };
  state.extractUsed++;
  const text = String(args.text || '');
  if (text.trim().length < 80) return { ok: false, error: '资料正文至少 80 字' };
  if (!/^https?:\/\//i.test(String(args.sourceUrl || ''))) return { ok: false, error: '来源网址必须以 http:// 或 https:// 开头' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.publishDate || ''))) return { ok: false, error: '发布日期格式应为 YYYY-MM-DD' };
  const c = companyById(ctx, args.companyId);
  if (!c) return { ok: false, error: '缺少可绑定的企业，请先新建卷宗' };
  const payload = {
    text: text, sourceUrl: args.sourceUrl, publishDate: args.publishDate,
    sourceName: args.sourceName || '', companyId: c.id, companyName: c.name
  };
  const out = await deps.callModel(payload);
  let data;
  try { data = deps.extractJson(out.content); }
  catch (e) { return { ok: false, error: '模型返回无法解析：' + e.message }; }
  const shape = deps.badShape(data);
  if (shape) return { ok: false, error: '模型返回结构不符合要求：' + shape };
  deps.normalizeExtractedData(data);
  const verify = deps.verifySnippets(data, text);
  const facts = (Array.isArray(data.facts) ? data.facts : []).filter(function (f) { return f && norm(f.statement); }).map(function (f) {
    return { statement: f.statement, snippet: f.snippet, support: f.support || '', verified: f._snippetVerified === true,
      flags: (f._statementCheck && f._statementCheck.flags) || [], labels: (f._statementCheck && f._statementCheck.labels) || [] };
  });
  state.lastExtraction = { companyId: c.id, facts: facts, verify: verify, sourceUrl: args.sourceUrl,
    sourceName: args.sourceName || '', publishDate: args.publishDate, textLength: text.length };
  return {
    ok: true, companyId: c.id, companyName: c.name,
    model: out.model, elapsedMs: out.elapsedMs, verify: verify,
    facts: facts.slice(0, 20),
    note: '只代表粘贴文本包含这些片段，不代表事实主体角色、金额口径或陈述本身已核实；导入需人工确认。'
  };
}

async function toolAnalyzeTechnology(ctx, args, deps, state) {
  if (state.analysisUsed >= 1) return { ok: false, error: '本次对话已生成过技术分析草稿，请直接讨论结果' };
  const c = companyById(ctx, args.companyId);
  if (!c) return { ok: false, error: '上下文中没有该企业' };
  const evidence = c.evidences.slice(0, 30).map(function (e) {
    return { id: e.id, title: e.title, summary: e.summary, quote: e.quote, date: e.date, source: e.source,
      url: e.url, grade: e.grade, mark: e.reviewStatus === 'accepted' ? '采信' : (e.reviewStatus === 'doubtful' ? '存疑' : '待核实'),
      reviewStatus: e.reviewStatus, origin: e.origin, caveat: '', impact: '', invalid: [], conflict: false, dataSource: c.dataSource };
  });
  if (!evidence.length) return { ok: false, error: '没有可引用的证据，不能生成技术分析' };
  state.analysisUsed++;
  const out = await deps.callChat(deps.ANALYSIS_SYSTEM_PROMPT, deps.buildAnalysisPrompt({
    companyId: c.id, companyName: c.name, evidence: evidence,
    judgements: c.judgements.map(function (j) { return { id: j.id, title: j.title, status: j.status, statusText: j.statusText, evidenceIds: j.evidenceIds }; }),
    boundaries: '公开资料研究模式；证据是否采信以工作台人工标记为准。' + (args.focus ? '本轮关注：' + args.focus : '')
  }), 3000);
  let raw;
  try { raw = deps.extractJson(out.content); }
  catch (e) { return { ok: false, error: '模型返回无法解析：' + e.message }; }
  let analysis;
  try { analysis = deps.normalizeAnalysis(raw, evidence); }
  catch (e) { return { ok: false, error: '模型返回不符合分析要求：' + e.message }; }
  return {
    ok: true, companyId: c.id, companyName: c.name, model: out.model, elapsedMs: out.elapsedMs,
    analysis: analysis, reviewRequired: true,
    note: '分析草稿必须引用真实证据 ID；纳入画像前需人工确认，不能替代授信结论。'
  };
}

async function toolCritique(ctx, args, deps, state) {
  if (state.critiqueUsed >= 1) return { ok: false, error: '本次对话已执行过一次反向审查' };
  const c = companyById(ctx, args.companyId);
  if (!c) return { ok: false, error: '上下文中没有该企业' };
  const evidence = c.evidences.slice(0, 30).map(function (e) {
    return { id: e.id, title: e.title, summary: e.summary, quote: e.quote, date: e.date, source: e.source, reviewStatus: e.reviewStatus };
  });
  if (!evidence.length) return { ok: false, error: '没有证据可供审查' };
  state.critiqueUsed++;
  const prompt = [
    '你是银行科技金融尽调的反向审查员。请检查下方企业已有分析与证据是否存在推理跳跃或证据不足。',
    '重点检查：技术领先性是否缺少同行比较；专利与产品是否真正相关；联合研究成果是否被误归为企业独立成果；中标是否被误当作交付或收入；冲突是否未解决。',
    '只输出一个 JSON 对象：{"issues":[{"issue":"问题","evidenceIds":["真实证据ID"],"severity":"high|medium|low","suggestion":"补充核验建议"}],"verdict":"整体审查结论"}',
    '不得输出评分、授信或投资建议。只能引用给定证据 ID。',
    '企业：' + c.name,
    '证据 JSON：' + JSON.stringify(evidence),
    '已有分析：' + clip(args.analysis || (c.analysis && JSON.stringify(c.analysis)) || '无', 6000)
  ].join('\n');
  const out = await deps.callChat('你是审慎的银行技术尽调反向审查员，只输出 JSON。', prompt, 1800);
  let raw;
  try { raw = deps.extractJson(out.content); }
  catch (e) { return { ok: false, error: '模型返回无法解析：' + e.message }; }
  const valid = {};
  evidence.forEach(function (e) { valid[e.id] = true; });
  const issues = (Array.isArray(raw.issues) ? raw.issues : []).slice(0, 10).map(function (x) {
    return { issue: asStr(x.issue, 300), evidenceIds: (Array.isArray(x.evidenceIds) ? x.evidenceIds : []).filter(function (id) { return valid[id]; }),
      severity: ['high', 'medium', 'low'].indexOf(x.severity) >= 0 ? x.severity : 'medium', suggestion: asStr(x.suggestion, 400) };
  }).filter(function (x) { return x.issue; });
  return { ok: true, companyId: c.id, companyName: c.name, issues: issues, verdict: asStr(raw.verdict, 600),
    model: out.model, reviewRequired: true };
}

/* ---------------- 提案工具 ---------------- */
function proposalBase(state, type, payload, summary) {
  const id = 'P' + (++state.proposalSeq);
  const p = { id: id, type: type, payload: payload, summary: summary, status: 'pending', createdAt: new Date().toISOString(), requiresConfirmation: true };
  state.proposals.push(p);
  return p;
}
function toolProposeCompany(ctx, args, state) {
  if (!norm(args.name)) return { ok: false, error: '企业名称不能为空' };
  const exists = ctx.companies.concat(ctx.companyIndex).some(function (c) { return c.name === args.name; });
  if (exists) return { ok: false, error: '工作台已存在同名企业，不能重复新建' };
  const p = proposalBase(state, 'create_company', {
    name: args.name, industry: args.industry || null, region: args.region || null,
    summary: args.summary || 'AI 研究提案，未录入字段保持未知，待人工补充公开资料。'
  }, '新建企业卷宗：' + args.name);
  return { ok: true, proposalId: p.id, status: p.status, summary: p.summary, note: '仅生成提案，用户确认后才会写入企业池。' };
}
function toolProposeEvidence(ctx, args, state) {
  if (!/^https?:\/\//i.test(args.url || '')) return { ok: false, error: '来源网址必须以 http:// 或 https:// 开头' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date || '')) return { ok: false, error: '发布日期格式应为 YYYY-MM-DD' };
  if (!norm(args.quote) || norm(args.quote).length < 8) return { ok: false, error: '必须提供可核对的原文片段' };
  const c = companyById(ctx, args.companyId);
  if (!c) return { ok: false, error: '上下文中没有可绑定企业' };
  if (state.lastExtraction && state.lastExtraction.companyId === c.id) {
    const okQuote = state.lastExtraction.facts.some(function (f) { return f.verified && (norm(f.snippet) === norm(args.quote) || norm(args.quote).indexOf(norm(f.snippet)) >= 0); });
    if (!okQuote) return { ok: false, error: '提案中的原文片段没有通过本次抽取的逐字校验，不能生成证据提案' };
  }
  const p = proposalBase(state, 'add_evidence', {
    companyId: c.id, companyName: c.name, title: args.title || 'AI 研究证据', source: args.source || 'AI 研究',
    url: args.url, date: args.date, quote: args.quote, metric: args.metric || 'other',
    statement: args.statement || args.title || '',
    verified: !!(state.lastExtraction && state.lastExtraction.companyId === c.id)
  }, '新增证据：' + (args.title || args.source || '未命名'));
  return { ok: true, proposalId: p.id, status: p.status, summary: p.summary, note: '证据以候选状态进入台账，需用户确认；确认后仍需人工判断是否采信。' };
}
function toolProposeJudgement(ctx, args, state) {
  const ids = knownIds(ctx);
  const companyId = args.companyId || ctx.companyId;
  const c = companyById(ctx, companyId);
  if (!c) return { ok: false, error: '上下文中没有该企业' };
  const validIds = (args.evidenceIds || []).filter(function (id) { return !!ids.evidence[id] && ids.evidence[id] === c.id; });
  if (!validIds.length) return { ok: false, error: '判断必须引用该企业真实存在的证据 ID' };
  if (!norm(args.statement)) return { ok: false, error: '判断内容不能为空' };
  const p = proposalBase(state, 'add_judgement', {
    companyId: c.id, companyName: c.name, title: args.title || args.statement.slice(0, 48),
    statement: args.statement, evidenceIds: validIds
  }, '新增候选判断：' + (args.title || args.statement.slice(0, 36)));
  return { ok: true, proposalId: p.id, status: p.status, summary: p.summary, note: '判断以候选状态进入画像，需用户确认；不计入已采信。' };
}
function toolProposeEvaluation(ctx, args, state) {
  const ids = knownIds(ctx);
  const c = companyById(ctx, args.companyId || ctx.companyId);
  if (!c) return { ok: false, error: '上下文中没有该企业' };
  if (['patent', 'rd', 'advancement', 'product', 'adoption'].indexOf(args.metric) < 0) return { ok: false, error: '未知评价指标' };
  if (!/^(强|中|弱|未知|observed|partial|unknown)$/.test(args.level || '')) return { ok: false, error: '等级只能为强/中/弱/未知' };
  const validIds = (args.evidenceIds || []).filter(function (id) { return !!ids.evidence[id] && ids.evidence[id] === c.id; });
  if (!validIds.length) return { ok: false, error: '评价候选必须引用真实证据' };
  const p = proposalBase(state, 'evaluation_note', {
    companyId: c.id, companyName: c.name, metric: args.metric, metricName: metricLabel(args.metric),
    level: args.level, evidenceIds: validIds, reason: args.reason || ''
  }, '评价候选：' + metricLabel(args.metric) + ' → ' + args.level);
  return { ok: true, proposalId: p.id, status: p.status, summary: p.summary, note: '仅记录候选等级与依据，不修改正式评分。' };
}
function toolGenerateReport(ctx, args, state) {
  const c = companyById(ctx, args.companyId);
  if (!c) return { ok: false, error: '上下文中没有该企业' };
  const p = proposalBase(state, 'report', {
    companyId: c.id, companyName: c.name, scope: args.scope || '研究报告'
  }, '生成研究报告：' + c.name);
  return { ok: true, proposalId: p.id, status: p.status, summary: p.summary, note: '用户确认后跳转导出页并生成报告。' };
}
function toolNavigate(ctx, args, state) {
  const view = String(args.view || '');
  if (!VIEW_LABELS[view]) return { ok: false, error: '未知页面：' + view };
  if (args.evidenceId) {
    const found = findEvidenceAnywhere(ctx, args.evidenceId);
    if (!found) return { ok: false, error: '证据 ID 不存在' };
  }
  return { ok: true, navigate: { view: view, label: VIEW_LABELS[view], companyId: args.companyId || null, evidenceId: args.evidenceId || null } };
}

/* ---------------- 工具执行器 ---------------- */
function runTool(name, args, ctx, deps, state) {
  switch (name) {
    case 'get_current_context': return toolCurrentContext(ctx);
    case 'search_workspace': return toolSearchWorkspace(ctx, args);
    case 'get_company_profile': return toolCompanyProfile(ctx, args, state);
    case 'get_evidence': return toolEvidence(ctx, args, state);
    case 'get_evaluation_rules': return toolEvaluationRules(ctx, args, state);
    case 'compare_companies': return toolCompareCompanies(ctx, args);
    case 'compare_snapshots': return toolCompareSnapshots(ctx, args);
    case 'search_public_sources': return toolSearchPublic(ctx, args, deps, state);
    case 'read_public_document': return toolReadPublic(ctx, args);
    case 'extract_facts': return toolExtractFacts(ctx, args, deps, state);
    case 'verify_claims': return toolVerifyClaims(ctx, args);
    case 'analyze_technology': return toolAnalyzeTechnology(ctx, args, deps, state);
    case 'assess_evidence_gaps': return toolAssessGaps(ctx, args);
    case 'critique_analysis': return toolCritique(ctx, args, deps, state);
    case 'generate_due_diligence_questions': return toolDueDiligenceQuestions(ctx, args);
    case 'propose_company': return toolProposeCompany(ctx, args, state);
    case 'propose_evidence': return toolProposeEvidence(ctx, args, state);
    case 'propose_judgement': return toolProposeJudgement(ctx, args, state);
    case 'propose_evaluation': return toolProposeEvaluation(ctx, args, state);
    case 'generate_report': return toolGenerateReport(ctx, args, state);
    case 'navigate_workspace': return toolNavigate(ctx, args, state);
    default: return { ok: false, error: '未知工具：' + name };
  }
}

/* ---------------- 提示词 ---------------- */
function toolCatalog() {
  return TOOL_SPECS.map(function (t) {
    const args = Object.keys(t.args).map(function (k) { return k + ':' + t.args[k]; }).join(', ');
    return '- ' + t.name + '(' + args + ')：' + t.desc;
  }).join('\n');
}

function modelBrief(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {
    research: !!m.research, evaluationState: m.evaluationState || '',
    technicalScore: m.technicalScore, acceptedScore: m.acceptedScore,
    candidateScore: m.candidateScore, formalScore: m.formalScore,
    grade: m.grade, acceptedGrade: m.acceptedGrade, candidateGrade: m.candidateGrade,
    formalGrade: m.formalGrade, formalReady: !!m.formalReady, suff: m.suff,
    ruleVersion: m.ruleVersion, coverageNote: clip(m.coverageNote, 180)
  };
  if (Array.isArray(m.metricLevels)) {
    out.metrics = m.metricLevels.slice(0, 8).map(function (x) {
      return { key: x.key, name: x.name, accepted: x.acceptedLevel, candidate: x.candidateLevel,
        docs: x.documentCount || 0, reason: clip(x.reason, 90) };
    });
  }
  if (m.suffBreakdown && Array.isArray(m.suffBreakdown.parts)) {
    out.suffParts = m.suffBreakdown.parts.slice(0, 6).map(function (p) {
      return { name: p.name, weight: p.weight, ratio: p.ratio, detail: clip(p.detail, 60) };
    });
  }
  if (Array.isArray(m.formalBlockers)) {
    out.blockers = m.formalBlockers.slice(0, 6).map(function (b) { return clip(b.text, 120); });
  }
  return out;
}

function systemPrompt(ctx, opts) {
  const o = opts || {};
  const b = o.task;
  const budgetLine = b ? ('本轮任务：' + b.label + '；最多 ' + b.maxSteps + ' 次模型决策，已执行 ' + (o.step || 0) + ' 次工具。') : '';
  const parts = [
    '你是“寻证 ProofTrace”的 AI 研究助理，服务银行科技金融客户经理。只基于工作台真实数据回答。',
    budgetLine,
    '',
    '协议：每轮只输出一个 JSON 对象，不要 Markdown 代码块或解释文字。',
    '取数：{"action":"tool","tool":"工具名","args":{...},"reason":"为什么需要"}',
    '结论：{"action":"final","answer":"Markdown 中文回答","citations":[{"id":"证据ID","kind":"evidence|judgement|conflict"}],"followups":["追问1","追问2","追问3"],"proposals":[]}',
    'citations 只能使用工具结果或上下文索引中真实出现的 ID。',
    '',
    '评分口径：',
    '- 只能引用上下文 model 中已算好的分数，不得自行计算或改写；没有就写“尚未形成”。',
    '- 技术分（accepted，只含人工采信）、候选分（candidate，含未采信，仅预判）、正式分（formal，需过出分条件）必须分开。',
    '- 0.60 是证据充分度门槛，不是技术得分及格线；技术分与充分度是两个独立维度。',
    '- 等级只由该指标的业务事实锚点决定；重复来源或同一事实多个网址不提高等级，证据数量只影响充分度。',
    '- 未采信证据只改变候选分；存疑、冲突证据不得转为正式分。已采信指标少于 2 项时只说缺什么，不用 0 分代替“未知”。',
    '',
    '边界：',
    '- 不编造企业、专利、客户、收入、网址；没有就写“未取得/证据不足”。',
    '- 不输出授信额度、审批结论、投资建议或企业优劣排名；不承诺提分。',
    '- 不修改业务数据，只能通过 propose_* 生成待用户确认的提案。',
    '- 不把申请量当授权量、中标当收入、联合研发当独立成果；无同行对照不判定行业领先。',
    '- 未启用搜索时如实说明不可用；联网检索最多 2 次。',
    '- 模拟企业与真实企业分别标注，不能直接排名。',
    '- 需要多条证据原文时，一次调用 get_evidence 并传 evidenceIds；不要逐条读取。',
    '- 读取企业档案、规则或比较结果后优先形成 final；只有具体结论缺原文才继续读证据。',
    '- 接近预算时先给出已有证据支持的部分结论，并列出未完成事项。',
    '',
    '可用工具：',
    toolCatalog(),
    '',
    '上下文（完整原文需调用 get_evidence）：',
    contextBrief(ctx, { compact: !!o.compact })
  ];
  return parts.join('\n');
}

function contextBrief(ctx, opts) {
  const o = opts || {};
  const c = companyById(ctx);
  if (o.compact) {
    const brief = {
      page: ctx.page, currentCompanyId: ctx.companyId,
      companyIndex: ctx.companyIndex.slice(0, 20),
      workspace: ctx.workspace
    };
    if (c) brief.currentCompany = {
      id: c.id, name: c.name, industry: c.industry, dataSource: c.dataSource,
      evidenceCount: c.evidences.length, judgementCount: c.judgements.length,
      model: modelBrief(c.model)
    };
    if (ctx.rules) brief.ruleVersion = ctx.rules.version || ctx.rules.ruleVersion || null;
    return JSON.stringify(brief);
  }
  const brief = {
    page: ctx.page, pageLabel: ctx.pageLabel,
    currentCompanyId: ctx.companyId,
    selection: ctx.selection,
    workspace: ctx.workspace,
    companyIndex: ctx.companyIndex.slice(0, 40),
    attachments: ctx.attachments.slice(0, 2).map(function (a) {
      return { name: a.name, sourceName: a.sourceName, url: a.url, date: a.date,
        chars: a.text.length, text: clip(a.text, 3000) };
    })
  };
  if (c) {
    brief.currentCompany = {
      id: c.id, name: c.name, code: c.code, industry: c.industry, segment: c.segment,
      region: c.region, city: c.city, dataSource: c.dataSource,
      summary: clip(c.summary, 320), verdict: clip(c.verdict, 240), stage: c.stage,
      evidenceCount: c.evidences.length,
      evidences: c.evidences.slice(0, 24).map(function (e) {
        return { id: e.id, title: clip(e.title, 70), date: e.date, metric: e.metric,
          source: clip(e.source, 30), status: e.reviewStatus, summary: clip(e.summary, 90) };
      }),
      judgements: c.judgements.slice(0, 12).map(function (j) {
        return { id: j.id, title: clip(j.title, 70), status: j.status, candidate: j.candidate,
          evidenceIds: j.evidenceIds.slice(0, 8) };
      }),
      conflicts: c.conflicts.slice(0, 6),
      model: modelBrief(c.model),
      snapshots: c.snapshots.slice(-3).map(function (s) { return { asOf: s.asOf, evidenceCount: s.evidenceCount, facts: s.facts }; }),
      analysis: c.analysis ? { status: c.analysis.status, stale: c.analysis.stale, items: c.analysis.items.length } : null
    };
  }
  if (ctx.rules) brief.rules = clip(JSON.stringify(ctx.rules), 7000);
  return JSON.stringify(brief);
}

function buildTurnPrompt(messages, toolLog, notes, info) {
  const recent = Math.max(1, MAX_RECENT_TOOL_RESULTS);
  const msgParts = [];
  messages.slice(-MAX_TURN_MESSAGES).forEach(function (m) {
    const role = m.role === 'assistant' ? '助理' : '用户';
    msgParts.push('[' + role + '] ' + clip(m.content, 1200));
  });
  const toolParts = [];
  toolLog.forEach(function (t, i) {
    const isRecent = i >= toolLog.length - recent;
    const args = t.args ? clip(JSON.stringify(t.args), 140) : '';
    if (!isRecent) {
      /* 旧结果只保留一行摘要，避免每轮重复发送全部原文。 */
      toolParts.push('[已读] ' + t.tool + (args ? ' ' + args : '') + ' → ' + summarizeToolResult(t.tool, t.result));
      return;
    }
    toolParts.push('[' + t.tool + '] ' + args + ' → ' +
      clip(JSON.stringify(compactToolResult(t.tool, t.result)), MAX_TOOL_CHARS));
  });
  const parts = [];
  parts.push('对话历史（从旧到新）：');
  parts.push(msgParts.join('\n') || '[用户] （无）');
  if (toolParts.length) {
    parts.push('');
    parts.push('已执行工具（旧结果已压缩为摘要，最近 ' + Math.min(recent, toolLog.length) + ' 条保留完整结构）：');
    parts.push(toolParts.join('\n'));
  }
  if (notes.length) {
    parts.push('');
    parts.push('协议与预算提示：');
    notes.forEach(function (n) { parts.push('- ' + n); });
  }
  if (info && info.remainingSteps != null) {
    parts.push('');
    parts.push('剩余模型决策：' + info.remainingSteps + ' 次；已用 Token：' + (info.tokens || 0) + '。');
  }
  parts.push('');
  parts.push('请继续：信息足够就输出 final；否则只输出一个 tool 动作。');
  let text = parts.join('\n');
  if (text.length > MAX_TURN_CHARS) {
    /* 优先保留最近内容：从最早的消息行开始丢弃。 */
    const lines = text.split('\n');
    while (lines.length > 12 && lines.join('\n').length > MAX_TURN_CHARS) {
      const idx = lines.findIndex(function (l) { return /^\[(用户|助理)\]/.test(l); });
      if (idx < 0) break;
      lines.splice(idx, 1);
    }
    text = lines.join('\n');
  }
  return text;
}

/* 粗略 Token 估算：中文约 1 字 1 token，英文/JSON 约 4 字符 1 token，取保守系数。 */
function estimateTokens(text) { return Math.ceil(String(text || '').length * 0.8); }

/* ---------------- 最终结果校验 ---------------- */
function validateFinal(raw, ctx, state) {
  const answer = String(raw && raw.answer || '').trim();
  if (!answer) return { ok: false, error: 'final 缺少 answer' };
  if (/可授信|建议授信|授信额度为|贷款建议|投资建议|买入|卖出/.test(answer)) {
    return { ok: false, error: '回答包含授信或投资结论，违反业务边界' };
  }
  const ids = knownIds(ctx);
  const citations = [];
  const dropped = [];
  (Array.isArray(raw.citations) ? raw.citations : []).slice(0, 24).forEach(function (x) {
    if (!isObj(x)) return;
    const kind = ['evidence', 'judgement', 'conflict', 'web'].indexOf(x.kind) >= 0 ? x.kind : 'evidence';
    if (kind === 'web') {
      const url = asStr(x.url || x.id, 800);
      if (state.webSources[url]) {
        citations.push({ kind: 'web', id: url, label: state.webSources[url].title || url, url: url });
      } else dropped.push(url);
      return;
    }
    const id = asStr(x.id, 80);
    if (ids[kind] && ids[kind][id]) {
      citations.push({ kind: kind, id: id, label: asStr(x.label, 200) || id, companyId: ids[kind][id] });
    } else dropped.push(id);
  });
  const followups = (Array.isArray(raw.followups) ? raw.followups : []).map(function (x) { return asStr(x, 120); }).filter(Boolean).slice(0, 3);
  const proposals = state.proposals.map(function (p) {
    return { id: p.id, type: p.type, summary: p.summary, status: p.status, requiresConfirmation: true, payload: p.payload };
  });
  return { ok: true, answer: answer, citations: citations, followups: followups, proposals: proposals, droppedCitations: dropped };
}

/* ---------------- 任务复杂度与澄清 ---------------- */
function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') return String(messages[i].content || '');
  }
  return '';
}
/* 预算按任务复杂度配置，不按用户情绪或模型自我判断扩张；12 轮是硬上限。 */
function classifyTask(messages, ctx) {
  const text = lastUserMessage(messages);
  let kind = 'simple';
  const compareAsk = /(比较|对比|差异|差别|横向|两家|多家|哪家|哪个更好)/.test(text);
  const explicitResearch = /(尽调|完整(的)?研究|做一轮|研究报告|生成报告|补齐材料|逐条核验|全面研究)/.test(text);
  const explainAsk = /(评分|分数|门槛|指标|权重|等级|归因|解释|为什么|怎么算|如何计算|依据|口径)/.test(text);
  const researchHints = /(材料|专利|证据|缺口|下一步|影响|核验|研究|报告)/.test(text);
  if (compareAsk) kind = 'compare';
  else if (explicitResearch) kind = 'research';
  else if (explainAsk) kind = 'explain';
  else if (researchHints || (ctx.attachments && ctx.attachments.length)) kind = 'research';
  const b = TASK_BUDGETS[kind];
  return { kind: kind, maxSteps: b.maxSteps, tokenBudget: b.tokenBudget,
    softTokens: b.softTokens, toolTarget: b.toolTarget, label: b.label };
}

function companyMentioned(text, name) {
  const n = norm(name);
  if (!n) return false;
  if (text.indexOf(n) >= 0) return true;
  const core = n.replace(/(股份有限公司|有限责任公司|有限公司|集团|公司)$/g, '');
  return core.length >= 4 && text.indexOf(core) >= 0;
}
/* 用户要求比较但对象不明确时，先澄清，不盲目执行。
   明确点名两家且都在上下文中才继续。 */
function detectCompareClarification(messages, ctx) {
  const last = lastUserMessage(messages);
  if (!/(比较|对比|差异|差别|横向|两家|多家|哪家|哪个更好)/.test(last)) return null;
  const recent = messages.slice(-6).map(function (m) { return String(m.content || ''); }).join(' ');
  const pool = [];
  ctx.companyIndex.forEach(function (x) { if (!pool.some(function (p) { return p.id === x.id; })) pool.push(x); });
  ctx.companies.forEach(function (x) { if (!pool.some(function (p) { return p.id === x.id; })) pool.push(x); });
  const named = pool.filter(function (x) { return companyMentioned(recent, x.name); });
  const currentForRef = companyById(ctx);
  if (currentForRef && /(当前企业|本企业|这家企业)/.test(last) && !named.some(function (x) { return x.id === currentForRef.id; })) {
    named.unshift({ id: currentForRef.id, name: currentForRef.name });
  }
  if (named.length >= 2) {
    const missingLoaded = named.filter(function (x) { return !ctx.companies.some(function (c) { return c.id === x.id; }); });
    if (missingLoaded.length) {
      return {
        need: true, reason: 'unloaded_target',
        question: '你提到的「' + missingLoaded.map(function (x) { return x.name; }).join('、') + '」没有载入本次上下文，无法读取其证据。请先在企业画像中切换到该企业，或选择下方已载入的企业再比较。',
        options: ctx.companies.map(function (c) { return c.name; }).slice(0, 8)
      };
    }
    return null;
  }
  const current = companyById(ctx);
  const candidates = ctx.companies
    .filter(function (c) { return !current || c.id !== current.id; })
    .map(function (c) { return c.name; })
    .concat(ctx.companyIndex
      .filter(function (x) { return (!current || x.id !== current.id) && !ctx.companies.some(function (c) { return c.id === x.id; }); })
      .map(function (x) { return x.name; }))
    .filter(function (n, i, arr) { return arr.indexOf(n) === i; })
    .slice(0, 8);
  if (!candidates.length) {
    return {
      need: true, reason: 'no_second_company',
      question: '工作台里还没有第二家企业可供比较。请先在名单中新建或载入另一家企业，再让我按统一口径比较。',
      options: []
    };
  }
  return {
    need: true, reason: 'missing_target',
    question: '请先指定要比较的第二家企业。当前上下文可以比较的是：' +
      (current ? current.name + '（当前）' : '—') + '；' + candidates.join('、') + '。' +
      '我会在双方证据都载入后再给出分维度差异，不会用未载入企业的资料猜测。',
    options: candidates
  };
}

/* 工具结果压缩：保留证据编号、关键事实与错误原因，避免逐条原文挤占上下文。 */
function compactToolResult(name, result) {
  if (!result || typeof result !== 'object') return result;
  if (result.ok === false) return { ok: false, error: result.error, cached: result.cached, repeated: result.repeated };
  if (name === 'get_company_profile' && result.company) {
    const c = result.company;
    return {
      ok: true, cached: result.cached,
      company: {
        id: c.id, name: c.name, dataSource: c.dataSource, industry: c.industry, segment: c.segment,
        stage: c.stage, verdict: c.verdict, model: c.model, techEvaluation: c.techEvaluation,
        conflicts: (c.conflicts || []).slice(0, 6),
        evidenceCount: (c.evidences || []).length,
        evidences: (c.evidences || []).slice(0, 40),
        judgements: (c.judgements || []).slice(0, 12),
        snapshots: (c.snapshots || []).slice(0, 3)
      }
    };
  }
  if (name === 'get_evidence') {
    const shrink = function (x) {
      if (!x) return x;
      const e = x.evidence || x;
      return { id: e.id, title: e.title, date: e.date, metric: e.metric, reviewStatus: e.reviewStatus,
        source: e.source, url: e.url, quote: clip(e.quote, 700), summary: clip(e.summary, 200),
        facts: (e.facts || []).slice(0, 12) };
    };
    if (result.items) return { ok: true, count: result.count, missing: result.missing, items: result.items.slice(0, MAX_BATCH_EVIDENCE).map(shrink) };
    if (result.evidence) return { ok: true, company: result.company, evidence: shrink(result.evidence) };
  }
  if (name === 'compare_companies' && result.companies) {
    return {
      ok: true, note: result.note, incomparable: result.incomparable,
      companies: result.companies.map(function (c) {
        return { id: c.id, name: c.name, dataSource: c.dataSource, comparability: c.comparability,
          evidence: c.evidence, evidencesWithUrl: c.evidencesWithUrl, independentDocuments: c.independentDocuments,
          judgements: c.judgements, confirmedJudgements: c.confirmedJudgements,
          openConflicts: c.openConflicts, metrics: c.metrics, model: c.model, verdict: c.verdict };
      })
    };
  }
  if (name === 'search_public_sources' && Array.isArray(result.results)) {
    return Object.assign({}, result, { results: result.results.slice(0, 5) });
  }
  if (name === 'read_public_document') {
    return Object.assign({}, result, { text: clip(result.text, 3000) });
  }
  return result;
}

function partialCitations(ctx, state) {
  const ids = knownIds(ctx);
  const seen = {};
  state.toolLog.forEach(function (t) {
    const text = JSON.stringify(t.result || {});
    Object.keys(ids.evidence).forEach(function (id) {
      if (!seen[id] && text.indexOf('"' + id + '"') >= 0) seen[id] = ids.evidence[id];
    });
  });
  return Object.keys(seen).slice(0, 20).map(function (id) {
    return { kind: 'evidence', id: id, label: id, companyId: seen[id] };
  });
}

/* 预算耗尽时的部分结论：只使用已执行工具的真实结果。
   若尚有余量，允许一次很小的“只输出 final”收敛调用；失败则退回确定性摘要。 */
async function synthesizePartial(ctx, state, reason, deps) {
  const c = companyById(ctx);
  const completed = [];
  const pending = [];
  state.toolLog.forEach(function (t) {
    if (t.result && t.result.ok !== false) completed.push(t.tool + '：' + summarizeToolResult(t.tool, t.result));
    else pending.push(t.tool + '：' + ((t.result && t.result.error) || '未知错误'));
  });
  const citations = partialCitations(ctx, state);
  const digest = {
    company: c ? { id: c.id, name: c.name } : null,
    model: c ? modelBrief(c.model) : null,
    tools: completed.slice(-8),
    failed: pending.slice(-4),
    proposalCount: state.proposals.length,
    reason: reason
  };

  if (deps && typeof deps.callChat === 'function' && (state.tokenBudget - state.tokens) > 4500) {
    const prompt = [
      '根据下面已经真实取得的工具结果，写给客户经理的部分研究结论。',
      '要求：先给已经能支持的结论；再列未完成事项；不补充未取得的数据；不编造分数；不承诺提分或授信。',
      '只输出 JSON：{"answer":"Markdown 回答","citations":[{"id":"证据ID","kind":"evidence"}],"followups":["追问1","追问2"]}',
      '可用证据 ID 只能取自下列：' + citations.map(function (x) { return x.id; }).join('、'),
      JSON.stringify(digest)
    ].join('\n');
    try {
      const out = await deps.callChat('你是严谨的银行科技金融研究助理，只输出 JSON。', prompt, 1200);
      state.modelRounds++;
      if (out && out.usage && typeof out.usage.total_tokens === 'number') state.tokens += out.usage.total_tokens;
      const raw = deps.extractJson(out.content);
      const checked = validateFinal(raw, ctx, state);
      if (checked.ok) {
        return {
          answer: checked.answer, citations: checked.citations.length ? checked.citations : citations,
          followups: checked.followups.length ? checked.followups : ['补充缺少的材料后再评价', '核对已读取证据原文'],
          completed: completed, unfinished: pending.concat(['完整归纳与结论校验']),
          toolCount: state.toolCalls, modelRounds: state.modelRounds
        };
      }
    } catch (e) { /* 收敛调用失败时退回确定性摘要，不影响已取得结果。 */ }
  }

  const model = c && c.model ? modelBrief(c.model) : null;
  const scoreLine = model && model.research
    ? '当前评分：技术分 ' + (model.technicalScore == null ? '尚未形成' : model.technicalScore) +
      '，候选分 ' + (model.candidateScore == null ? '—' : model.candidateScore) +
      '，正式分 ' + (model.formalScore == null ? '未出分' : model.formalScore) +
      '，证据充分度 ' + (model.suff == null ? '—' : Math.round(model.suff * 100) + '%') + '。'
    : '当前企业尚未形成技术评分。';
  const answer = [
    '## 部分研究结论',
    '',
    c ? ('企业：' + c.name + '。' + scoreLine) : '当前未绑定企业。',
    '',
    '### 已完成的读取',
    completed.length ? completed.map(function (x) { return '- ' + x; }).join('\n') : '- 尚未成功读取业务数据。',
    '',
    '### 尚未完成',
    pending.length ? pending.map(function (x) { return '- ' + x; }).join('\n') : '- 完整归纳与结论校验尚未完成。',
    '- 未完成的判断不写成确定事实，需要补充材料后再确认。',
    '',
    '### 下一步',
    '- 可指定要核验的指标或证据编号，下一轮只读取必要内容。',
    '- 缺少原始材料的维度会保持“未知”，不按 0 分处理。'
  ].join('\n');
  return {
    answer: answer, citations: citations,
    followups: ['补充缺少的材料后再评价', '核对已读取证据原文'],
    completed: completed, unfinished: pending.concat(['完整归纳与结论校验']),
    toolCount: state.toolCalls, modelRounds: state.modelRounds
  };
}

/* ---------------- 请求处理 ---------------- */
function sseInit(res, corsFn) {
  if (typeof corsFn === 'function') corsFn(res);
  else {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
}
function sseSend(res, event, data) {
  try {
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  } catch (e) {}
}
function sseEnd(res) { try { res.end(); } catch (e) {} }

async function handleAgentChat(req, res, deps) {
  const configured = !!(deps.API_KEY && deps.API_BASE && deps.API_MODEL);
  let payload;
  try { payload = await deps.readBody(req); }
  catch (e) { return deps.fail(res, 400, e.message, null, { code: 'bad_request' }); }

  const stream = payload.stream === true;
  if (stream) sseInit(res, deps.cors);

  const finish = function (code, obj) {
    if (!stream) return deps.send(res, code, obj);
    if (obj.ok === false) sseSend(res, 'error', obj);
    else sseSend(res, 'final', obj);
    sseEnd(res);
  };

  if (!configured) {
    return finish(503, {
      ok: false,
      error: {
        message: '服务端未配置模型。请在页面“配置模型”中填写 API Key，验证通过后会加密保存并自动生效。',
        code: 'model_unconfigured', configured: false
      }
    });
  }

  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
  const messages = rawMessages.slice(-MAX_MESSAGES).map(function (m) {
    return { role: ['user', 'assistant', 'system'].indexOf(m && m.role) >= 0 ? m.role : 'user', content: String(m && m.content || '').slice(0, 6000) };
  }).filter(function (m) { return m.content.trim(); });
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return finish(400, { ok: false, error: { message: '缺少最后一条用户消息', code: 'bad_request' } });
  }

  const ctx = normalizeContext(payload.context);
  if (!ctx.companyIndex.length) {
    ctx.companyIndex = ctx.companies.map(function (c) {
      return { id: c.id, name: c.name, industry: c.industry, dataSource: c.dataSource, stage: c.stage };
    });
  }
  if (!ctx.companies.length) {
    return finish(400, {
      ok: false,
      error: { message: '请求缺少工作台上下文。服务端不读取浏览器 localStorage，请由页面重新提交当前企业与证据上下文。', code: 'missing_context' }
    });
  }

  const task = classifyTask(messages, ctx);
  const state = {
    taskId: 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    startedAt: Date.now(), steps: 0, modelRounds: 0, toolCalls: 0, tokens: 0, toolLog: [],
    proposals: [], proposalSeq: 0, webSources: {},
    extractUsed: 0, analysisUsed: 0, critiqueUsed: 0, searchUsed: 0,
    maxSteps: task.maxSteps, taskKind: task.kind, taskLabel: task.label,
    tokenBudget: task.tokenBudget, softTokens: task.softTokens, toolTarget: task.toolTarget,
    cache: { profile: {}, evidence: {}, rules: null, tools: {} },
    toolSignatures: {}, forcedConvergence: false,
    rounds: [], stoppedBy: null
  };
  const prefs = isObj(payload.prefs) ? sanitize(payload.prefs) : {};
  const memory = (Array.isArray(payload.memory) ? payload.memory : []).slice(0, 8).map(function (m) {
    return { companyId: asStr(m.companyId, 60), summary: asStr(m.summary, 400), at: asStr(m.at, 40) };
  });
  const sysSuffix = (Object.keys(prefs).length ? '\n\n用户明确设置的工作偏好（仅辅助表达，不改变评价标准）：\n' + JSON.stringify(prefs)
    : '') + (memory.length ? '\n\n该企业已确认的研究记忆（按需引用，不得混用其他企业）：\n' + JSON.stringify(memory) : '');

  const protocolNotes = [];
  let lastContent = '';
  const emit = function (event, data) { if (stream) sseSend(res, event, data); };

  emit('open', { ok: true, model: deps.API_MODEL, agentVersion: AGENT_VERSION, maxSteps: task.maxSteps,
    complexity: task.kind, complexityLabel: task.label, searchMode: searchMode(), startedAt: new Date().toISOString() });

  /* 比较对象不明确时先澄清，避免带着唯一一家企业盲目执行。 */
  const clarify = detectCompareClarification(messages, ctx);
  if (clarify) {
    const obj = {
      ok: true, model: deps.API_MODEL, agentVersion: AGENT_VERSION, clarify: clarify,
      createdAt: new Date().toISOString(), elapsedMs: Date.now() - state.startedAt,
      answer: clarify.question, citations: [], followups: clarify.options,
      proposals: [], steps: [], droppedCitations: [],
      budget: { maxSteps: task.maxSteps, complexity: task.kind, modelRounds: 0, toolCalls: 0, elapsedMs: Date.now() - state.startedAt, tokens: 0 },
      reviewRequired: true
    };
    return finish(200, obj);
  }

  const READ_CACHE_TOOLS = {
    get_current_context: 1, search_workspace: 1, get_company_profile: 1, get_evidence: 1,
    get_evaluation_rules: 1, compare_companies: 1, compare_snapshots: 1,
    verify_claims: 1, assess_evidence_gaps: 1
  };
  let lastModel = deps.API_MODEL;

  try {
    for (let round = 0; round < state.maxSteps; round++) {
      if (Date.now() - state.startedAt > MAX_WALL_MS) { state.stoppedBy = 'timeout'; break; }
      if (state.tokens >= state.tokenBudget) { state.stoppedBy = 'budget'; break; }

      const compact = round > 0;
      const sys = systemPrompt(ctx, { task: task, step: state.steps, compact: compact }) + sysSuffix;
      const userPrompt = buildTurnPrompt(messages, state.toolLog, protocolNotes, {
        remainingSteps: state.maxSteps - state.steps, tokens: state.tokens
      });
      const promptEst = estimateTokens(sys) + estimateTokens(userPrompt);
      if (state.tokens + promptEst > state.tokenBudget) { state.stoppedBy = 'budget'; break; }
      if (state.tokens + promptEst > state.softTokens && !state.softNoteSent) {
        state.softNoteSent = true;
        protocolNotes.push('本轮 Token 已接近任务预算。请优先使用已有结果直接输出 final；确实缺少的关键原文才再读一次，并在回答中写明未完成事项。');
      }

      state.steps++;
      state.modelRounds++;
      let out;
      try {
        out = await deps.callChat(sys, userPrompt, 1600);
      } catch (e) {
        const meta = deps.upstreamErrorMeta(e);
        if (e && e.name === 'AbortError') meta.code = 'timeout';
        throw Object.assign(new Error('模型调用失败：' + (e && e.message || '未知错误')), { code: meta.code || 'upstream_error' });
      }
      lastContent = out.content;
      if (out.model) lastModel = out.model;
      const used = out.usage && typeof out.usage.total_tokens === 'number' ? out.usage.total_tokens : 0;
      state.tokens += used;
      state.rounds.push({ step: state.steps, promptChars: sys.length + userPrompt.length,
        estimatedTokens: promptEst, totalTokens: used });

      let action;
      try { action = deps.extractJson(out.content); }
      catch (e) {
        protocolNotes.push('上一轮输出不是合法 JSON。必须只输出一个 JSON 对象。');
        emit('protocol', { step: state.steps, content: clip(out.content, 400) });
        if (protocolNotes.length >= 2) {
          throw Object.assign(new Error('模型连续返回非 JSON 内容'), { code: 'agent_protocol_error', raw: clip(out.content, 500) });
        }
        continue;
      }

      if (action.action === 'tool') {
        const validate = validateArgs(action.tool, action.args);
        if (!validate.ok) {
          protocolNotes.push(validate.error + '。请检查工具参数后重试。');
          emit('tool', { step: state.steps, tool: action.tool || '—', status: 'rejected', error: validate.error });
          continue;
        }
        const toolEvent = { step: state.steps, tool: action.tool, reason: clip(action.reason, 200), startedAt: new Date().toISOString() };
        emit('tool', Object.assign({ status: 'running' }, toolEvent));
        const sig = action.tool + ':' + JSON.stringify(validate.args || {});
        state.toolSignatures[sig] = (state.toolSignatures[sig] || 0) + 1;
        if (state.toolSignatures[sig] >= 3) {
          state.stoppedBy = 'loop';
          protocolNotes.push('同一工具参数已连续调用三次，说明结果足够或任务不适合继续读取；请直接基于已有结果输出 final。');
          break;
        }
        let result;
        if (READ_CACHE_TOOLS[action.tool] && state.cache.tools[sig]) {
          result = Object.assign({}, state.cache.tools[sig], { cached: true });
          emit('tool', Object.assign({}, toolEvent, { status: 'ok', summary: '使用本次已读取结果', cached: true }));
        } else {
          try {
            result = await runTool(action.tool, validate.args, ctx, deps, state);
          } catch (e) {
            result = { ok: false, error: '工具执行失败：' + (e && e.message || '未知错误') };
          }
          if (READ_CACHE_TOOLS[action.tool] && result && result.ok !== false) {
            state.cache.tools[sig] = result;
          }
        }
        state.toolCalls++;
        toolEvent.status = result && result.ok === false ? 'error' : 'ok';
        toolEvent.summary = summarizeToolResult(action.tool, result);
        toolEvent.elapsedMs = Date.now() - new Date(toolEvent.startedAt).getTime();
        result = Object.assign({}, result, { repeated: state.toolSignatures[sig] > 1 });
        state.toolLog.push({ tool: action.tool, args: sanitize(validate.args), result: result, elapsedMs: toolEvent.elapsedMs });
        emit('tool', Object.assign({}, toolEvent, { result: sanitize(compactToolResult(action.tool, result)) }));

        if (state.toolSignatures[sig] >= 2) {
          protocolNotes.push('相同参数的 ' + action.tool + ' 已调用过，结果不会新增信息；请改用批量读取或基于已有结果输出 final。');
        }
        if (action.tool === 'compare_companies' && !state.forcedConvergence) {
          state.forcedConvergence = true;
          protocolNotes.push('比较结果已包含双方证据计数、指标分布与可比性。除非某条具体结论缺少原文，否则不要逐条 get_evidence，直接形成分维度结论并注明证据数量与口径。');
        }
        if (state.toolCalls >= Math.max(state.toolTarget, state.maxSteps - 1)) {
          protocolNotes.push('工具调用已接近本轮预算（' + state.toolCalls + ' 次）。下一轮必须输出 final；未完成事项写入回答的“未完成/下一步”。');
        }
        continue;
      }

      if (action.action === 'final') {
        const checked = validateFinal(action, ctx, state);
        if (!checked.ok) {
          protocolNotes.push(checked.error);
          emit('protocol', { step: state.steps, error: checked.error });
          if (protocolNotes.length >= 3) {
            throw Object.assign(new Error(checked.error), { code: 'agent_protocol_error' });
          }
          continue;
        }
        const finalPayload = {
          ok: true, partial: false, model: lastModel, agentVersion: AGENT_VERSION,
          createdAt: new Date().toISOString(), elapsedMs: Date.now() - state.startedAt,
          usage: { totalTokens: state.tokens, last: out.usage || null },
          answer: checked.answer, citations: checked.citations, followups: checked.followups,
          proposals: checked.proposals, droppedCitations: checked.droppedCitations,
          steps: state.toolLog.map(function (t) { return { tool: t.tool, args: t.args, summary: summarizeToolResult(t.tool, t.result),
            elapsedMs: t.elapsedMs, result: sanitize(compactToolResult(t.tool, t.result)) }; }),
          budget: budgetStats(state),
          task: { id: state.taskId, status: 'complete', resumable: false },
          context: { page: ctx.page, companyId: ctx.companyId,
            companyName: (companyById(ctx) || {}).name || null },
          search: { mode: searchMode(), available: Object.keys(state.webSources).length > 0 },
          reviewRequired: true
        };
        emit('final', finalPayload);
        return sseEnd(res);
      }

      protocolNotes.push('action 只能是 tool 或 final。');
      emit('protocol', { step: state.steps, error: '未知 action' });
      if (protocolNotes.length >= 3) {
        throw Object.assign(new Error('模型未按工具协议输出'), { code: 'agent_protocol_error' });
      }
    }

    const reason = state.stoppedBy === 'timeout' ? '时间上限'
      : (state.stoppedBy === 'budget' ? 'Token 预算' : (state.stoppedBy === 'loop' ? '重复读取' : '决策轮次上限'));
    emit('partial', { reason: reason, message: '研究达到' + reason + '，正在整理已完成的真实结果…' });
    const partial = await synthesizePartial(ctx, state, reason, deps);
    const partialPayload = {
      ok: true, partial: true, partialReason: reason, model: lastModel, agentVersion: AGENT_VERSION,
      createdAt: new Date().toISOString(), elapsedMs: Date.now() - state.startedAt,
      usage: { totalTokens: state.tokens },
      answer: partial.answer, citations: partial.citations, followups: partial.followups,
      proposals: state.proposals.map(function (p) { return { id: p.id, type: p.type, summary: p.summary, status: p.status, requiresConfirmation: true, payload: p.payload }; }),
      droppedCitations: [],
      steps: state.toolLog.map(function (t) { return { tool: t.tool, args: t.args, summary: summarizeToolResult(t.tool, t.result),
        elapsedMs: t.elapsedMs, result: sanitize(compactToolResult(t.tool, t.result)) }; }),
      budget: budgetStats(state),
      task: { id: state.taskId, status: 'partial', resumable: false, reason: reason,
        completedTools: partial.completed, unfinished: partial.unfinished },
      context: { page: ctx.page, companyId: ctx.companyId, companyName: (companyById(ctx) || {}).name || null },
      search: { mode: searchMode(), available: Object.keys(state.webSources).length > 0 },
      reviewRequired: true
    };
    emit('final', partialPayload);
    return sseEnd(res);
  } catch (e) {
    const code = (e && e.code) || 'agent_error';
    const message = (e && e.message) || 'AI 研究失败';
    /* 只要已经取得真实工具结果，就交付可用的部分结论，而不是只报错。
       没有成功工具结果时不伪造内容，只返回错误本身。 */
    const hasData = state.toolLog.some(function (t) { return t.result && t.result.ok !== false; });
    let partial = e && e.partial;
    if (!partial && hasData) {
      partial = await synthesizePartial(ctx, state, '研究未完成：' + message, deps);
    }
    if (partial && hasData) {
      const partialPayload = {
        ok: true, partial: true, partialReason: message, model: lastModel, agentVersion: AGENT_VERSION,
        createdAt: new Date().toISOString(), elapsedMs: Date.now() - state.startedAt,
        usage: { totalTokens: state.tokens },
        answer: partial.answer, citations: partial.citations, followups: partial.followups,
        proposals: state.proposals.map(function (p) { return { id: p.id, type: p.type, summary: p.summary, status: p.status, requiresConfirmation: true, payload: p.payload }; }),
        droppedCitations: [],
        steps: state.toolLog.map(function (t) { return { tool: t.tool, args: t.args, summary: summarizeToolResult(t.tool, t.result),
          elapsedMs: t.elapsedMs, result: sanitize(compactToolResult(t.tool, t.result)) }; }),
        budget: budgetStats(state),
        task: { id: state.taskId, status: 'partial', resumable: false, reason: message,
          completedTools: partial.completed, unfinished: partial.unfinished },
        context: { page: ctx.page, companyId: ctx.companyId, companyName: (companyById(ctx) || {}).name || null },
        search: { mode: searchMode(), available: Object.keys(state.webSources).length > 0 },
        reviewRequired: true, warning: message
      };
      emit('final', partialPayload);
      return sseEnd(res);
    }
    const out = {
      ok: false,
      error: { message: message, code: code, detail: e && e.raw ? String(e.raw) : undefined },
      budget: budgetStats(state),
      steps: state.toolLog.map(function (t) { return { tool: t.tool, args: t.args, summary: summarizeToolResult(t.tool, t.result), elapsedMs: t.elapsedMs }; }),
      lastModelContent: code === 'agent_protocol_error' ? clip(lastContent, 500) : undefined
    };
    return finish(code === 'agent_timeout' ? 504 : 502, out);
  }
}

function budgetStats(state) {
  return {
    maxSteps: state.maxSteps, complexity: state.taskKind, complexityLabel: state.taskLabel,
    modelRounds: state.modelRounds, toolCalls: state.toolCalls,
    elapsedMs: Date.now() - state.startedAt, tokens: state.tokens,
    tokenBudget: state.tokenBudget, promptChars: state.rounds.reduce(function (a, r) { return a + r.promptChars; }, 0),
    rounds: state.rounds
  };
}

function summarizeToolResult(tool, result) {
  if (!result || typeof result !== 'object') return '无结果';
  if (result.ok === false) return '失败：' + (result.error || '未知错误');
  if (tool === 'search_workspace') return '命中 ' + (result.count || 0) + ' 条';
  if (tool === 'get_evidence') {
    if (result.items) return '批量读取 ' + result.count + ' 条证据' + ((result.missing || []).length ? '，缺失 ' + result.missing.length + ' 条' : '');
    return '证据 ' + (result.evidence && result.evidence.id) + '：' + clip(result.evidence && result.evidence.title, 60);
  }
  if (tool === 'search_public_sources') return result.available ? ('检索到 ' + (result.results || []).length + ' 个来源') : ('不可用：' + result.reason);
  if (tool === 'read_public_document') return result.fetched ? ('已读取 ' + (result.chars || 0) + ' 字') : ('未读取：' + (result.error || '—'));
  if (tool === 'extract_facts') return '抽取 ' + ((result.facts || []).length) + ' 条，原文匹配 ' + ((result.verify && result.verify.verified) || 0) + '/' + ((result.verify && result.verify.total) || 0);
  if (tool === 'verify_claims') return '口径差异 ' + (result.scopeConflicts || []).length + ' 项，关系 ' + (result.relations || []).length + ' 项';
  if (tool === 'analyze_technology') return '生成 ' + ((result.analysis && result.analysis.stats && result.analysis.stats.items) || 0) + ' 条分析';
  if (tool === 'critique_analysis') return '审查问题 ' + ((result.issues || []).length) + ' 项';
  if (tool === 'assess_evidence_gaps') return '缺少指标 ' + ((result.missingMetrics || []).length) + ' 项';
  if (tool === 'generate_due_diligence_questions') return '生成 ' + ((result.questions || []).length) + ' 个问题';
  if (tool.indexOf('propose_') === 0) return '已生成待确认提案';
  if (tool === 'generate_report') return '已生成报告提案';
  if (tool === 'get_company_profile') return '读取 ' + ((result.company && result.company.name) || '企业档案');
  if (tool === 'compare_companies') return '比较 ' + ((result.companies || []).length) + ' 家企业';
  if (tool === 'compare_snapshots') return (result.from && result.from.asOf) + ' → ' + (result.to && result.to.asOf);
  if (tool === 'get_current_context' || tool === 'get_evaluation_rules') return '已读取';
  return '完成';
}

module.exports = {
  handleAgentChat: handleAgentChat,
  normalizeContext: normalizeContext,
  validateArgs: validateArgs,
  runTool: runTool,
  validateFinal: validateFinal,
  summarizeToolResult: summarizeToolResult,
  TOOL_SPECS: TOOL_SPECS,
  AGENT_VERSION: AGENT_VERSION,
  MAX_STEPS: MAX_STEPS,
  MAX_STEPS_EXPLAIN: MAX_STEPS_EXPLAIN,
  MAX_STEPS_RESEARCH: MAX_STEPS_RESEARCH,
  MAX_STEPS_COMPARE: MAX_STEPS_COMPARE,
  TASK_BUDGETS: TASK_BUDGETS,
  classifyTask: classifyTask,
  detectCompareClarification: detectCompareClarification,
  compactToolResult: compactToolResult,
  systemPrompt: systemPrompt,
  contextBrief: contextBrief,
  buildTurnPrompt: buildTurnPrompt,
  estimateTokens: estimateTokens,
  budgetStats: budgetStats
};
