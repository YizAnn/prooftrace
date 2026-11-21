/* Agent 运行时编排测试：不调用真实模型，用受控的 callChat 序列验证 SSE 事件、轮数、协议与引用校验。 */
const agent = require('../server/agent.js');

const CASES = [];
function T(name, fn){ CASES.push({ name, fn }); }

function fakeRes(){
  const chunks = [];
  return {
    headersSent:false, status:0, headers:null, ended:false, chunks:chunks,
    setHeader:function(){},
    writeHead:function(code, headers){ this.status = code; this.headers = headers || {}; this.headersSent = true; },
    write:function(s){ chunks.push(String(s)); },
    end:function(){ this.ended = true; },
    text:function(){ return chunks.join(''); },
    events:function(){
      return this.text().split(/\n\n/).map(function(block){
        const ev = /event:\s*(\S+)/.exec(block);
        const data = /data:\s*([\s\S]*)/.exec(block);
        if (!ev) return null;
        let obj = null;
        try { obj = data ? JSON.parse(data[1]) : null; } catch (e) { obj = null; }
        return { event:ev[1], data:obj };
      }).filter(Boolean);
    }
  };
}
function fakeDeps(payload, replies){
  const calls = [];
  let i = 0;
  return {
    API_KEY:'test-key', API_BASE:'https://example.invalid', API_MODEL:'test-model', TIMEOUT_MS:1000,
    readBody:function(){ return Promise.resolve(payload); },
    send:function(res, code, obj){ res.status = code; res.json = obj; res.headersSent = true; res.end(); },
    fail:function(res, code, message){ res.status = code; res.json = { ok:false, error:{ message:message } }; res.headersSent = true; res.end(); },
    cors:function(res){ if (res.setHeader) res.setHeader('Access-Control-Allow-Origin', '*'); },
    callChat:function(sys, prompt){
      calls.push({ sys:sys, prompt:prompt });
      const reply = replies[Math.min(i, replies.length - 1)];
      i++;
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({ content:typeof reply === 'function' ? reply(i, prompt) : reply, usage:{ total_tokens:10 }, model:'test-model' });
    },
    extractJson:function(s){
      let t = String(s || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      return JSON.parse(t);
    },
    badShape:function(){ return false; },
    normalizeExtractedData:function(x){ return x; },
    verifySnippets:function(){ return []; },
    upstreamErrorMeta:function(e){ return { code:(e && e.code) || 'upstream_error' }; },
    SYSTEM_PROMPT:'sys', ANALYSIS_SYSTEM_PROMPT:'ana',
    buildAnalysisPrompt:function(){ return 'p'; },
    normalizeAnalysis:function(x){ return x; },
    calls:calls
  };
}
function baseContext(){
  return {
    page:'overview', pageLabel:'企业画像', companyId:'c1',
    selection:{ evidenceId:'' },
    companies:[{
      id:'c1', name:'测试科技有限公司', dataSource:'real', industry:'软件', region:'北京',
      evidences:[{ id:'E1', title:'发明专利证书', source:'国家知识产权局', url:'https://example.com/e1',
        date:'2026-01-01', grade:'A', dim:'技术', metric:'patent', quote:'该公司获发明专利授权3项。',
        reviewStatus:'accepted', facts:[{ label:'发明专利授权', value:3, unit:'项', operator:'=', subject:'该公司', evidenceId:'E1', date:'2026-01-01' }] }],
      judgements:[], conflicts:[], techEvaluation:null,
      model:{ public:true, score:null, grade:null, suff:0, version:'PT-TECH-2026.11-r1' },
      snapshots:[], archives:[], analysis:null
    }],
    companyIndex:[{ id:'c1', name:'测试科技有限公司', industry:'软件', dataSource:'real' }],
    workspace:{ queueCount:1 },
    rules:{ modelVersion:'PT-TECH-2026.11-r1', verificationLabels:{} },
    attachments:[]
  };
}
function payload(replies){
  return {
    messages:[{ role:'user', content:'请核验该公司专利情况' }],
    context:baseContext(),
    prefs:{ detail:'balanced' }, memory:[], stream:true
  };
}
async function run(replies){
  const res = fakeRes();
  const deps = fakeDeps(payload(), replies);
  await agent.handleAgentChat({ method:'POST' }, res, deps);
  return { res, deps, events:res.events() };
}

T('R1_tool_then_final_events', async function(){
  const r = await run([
    '{"action":"tool","tool":"get_current_context","args":{}}',
    '{"action":"final","answer":"根据证据 [E1]，该公司获发明专利授权 3 项。","citations":[{"id":"E1","kind":"evidence"}],"followups":["还需要补充哪些证据？"],"proposals":[]}'
  ]);
  const names = r.events.map(e => e.event);
  const toolEvents = r.events.filter(e => e.event === 'tool');
  const final = r.events.filter(e => e.event === 'final').pop();
  const running = toolEvents.some(e => e.data && e.data.status === 'running');
  const ok = toolEvents.some(e => e.data && e.data.status === 'ok' && e.data.tool === 'get_current_context');
  return { pass:names.indexOf('open') >= 0 && running && ok && !!final && final.data.ok === true &&
    final.data.citations.length === 1 && final.data.citations[0].id === 'E1' &&
    final.data.steps.length === 1 && r.deps.calls.length === 2,
    events:names, finalCitations:final && final.data.citations, calls:r.deps.calls.length };
});

T('R2_protocol_retry', async function(){
  const r = await run([
    '这不是 JSON',
    '{"action":"final","answer":"该公司专利证据有限，需要补充授权量与有效性证据。","citations":[{"id":"E1","kind":"evidence"}],"followups":[],"proposals":[]}'
  ]);
  const proto = r.events.filter(e => e.event === 'protocol');
  const final = r.events.filter(e => e.event === 'final').pop();
  return { pass:proto.length === 1 && !!final && final.data.ok === true && r.deps.calls.length === 2,
    protocolCount:proto.length, finalOk:!!final && final.data.ok === true, calls:r.deps.calls.length };
});

T('R3_protocol_error_after_repeats', async function(){
  const r = await run(['不是 JSON', '还是不是 JSON', '仍然不是 JSON']);
  const err = r.events.filter(e => e.event === 'error').pop();
  return { pass:!!err && err.data.error.code === 'agent_protocol_error', code:err && err.data.error.code };
});

T('R4_max_steps_guard', async function(){
  const r = await run(['{"action":"tool","tool":"get_current_context","args":{}}']);
  const fin = r.events.filter(e => e.event === 'final').pop();
  const okEvents = r.events.filter(e => e.event === 'tool' && e.data && e.data.status === 'ok').length;
  return { pass:!!fin && fin.data.ok === true && fin.data.partial === true &&
    fin.data.task && fin.data.task.status === 'partial' && okEvents >= agent.MAX_STEPS - 1,
    partial:fin && fin.data.partial, toolRounds:okEvents, maxSteps:agent.MAX_STEPS };
});

T('R5_unknown_citation_dropped', async function(){
  const r = await run([
    '{"action":"final","answer":"根据 [E404]，这里有结论。","citations":[{"id":"E404","kind":"evidence"},{"id":"E1","kind":"evidence"}],"followups":[],"proposals":[]}'
  ]);
  const final = r.events.filter(e => e.event === 'final').pop();
  const ids = final ? final.data.citations.map(c => c.id) : [];
  return { pass:ids.join(',') === 'E1' && (final.data.droppedCitations || []).indexOf('E404') >= 0,
    citations:ids, dropped:final && final.data.droppedCitations };
});

T('R6_credit_conclusion_blocked', async function(){
  const r = await run([
    '{"action":"final","answer":"建议授信，额度为 500 万元。","citations":[{"id":"E1","kind":"evidence"}],"followups":[],"proposals":[]}'
  ]);
  const err = r.events.filter(e => e.event === 'error').pop();
  const final = r.events.filter(e => e.event === 'final').pop();
  return { pass:!final && !!err && /授信|投资|结论/.test(err.data.error.message),
    code:err && err.data.error.code, message:err && err.data.error.message };
});

T('R7_tool_arg_validation_rejected', async function(){
  const r = await run([
    '{"action":"tool","tool":"get_evidence","args":{}}',
    '{"action":"final","answer":"证据读取参数缺失，未取得结论。","citations":[],"followups":[],"proposals":[]}'
  ]);
  const rejected = r.events.filter(e => e.event === 'tool' && e.data && e.data.status === 'rejected');
  const final = r.events.filter(e => e.event === 'final').pop();
  return { pass:rejected.length === 1 && !!final && final.data.ok === true,
    rejected:rejected.length, finalOk:!!final && final.data.ok === true };
});

T('R8_proposal_requires_confirmation', async function(){
  const r = await run([
    '{"action":"tool","tool":"propose_evidence","args":{"title":"专利授权证据","source":"国家知识产权局","url":"https://example.com/e2","date":"2026-02-01","quote":"该公司获发明专利授权3项。","metric":"patent","statement":"该公司获发明专利授权3项。"}}',
    '{"action":"final","answer":"已提交新增证据提案，需人工确认。","citations":[{"id":"E1","kind":"evidence"}],"followups":[],"proposals":[]}'
  ]);
  const final = r.events.filter(e => e.event === 'final').pop();
  const ps = final ? final.data.proposals : [];
  return { pass:ps.length === 1 && ps[0].requiresConfirmation === true && ps[0].status === 'pending',
    proposals:ps };
});

T('R9_missing_context_rejected', async function(){
  const res = fakeRes();
  const p = payload();
  p.context.companies = [];
  p.context.companyIndex = [];
  const deps = fakeDeps(p, ['{"action":"final","answer":"x","citations":[],"followups":[],"proposals":[]}']);
  await agent.handleAgentChat({}, res, deps);
  const err = res.events().filter(e => e.event === 'error').pop();
  return { pass:!!err && err.data.error.code === 'missing_context', code:err && err.data.error.code };
});

T('R10_private_url_blocked', async function(){
  const r = await agent.runTool('read_public_document', { url:'http://127.0.0.1:8787/api/health' }, baseContext(), {}, {});
  const r2 = await agent.runTool('read_public_document', { url:'http://localhost:8787/api/health' }, baseContext(), {}, {});
  return { pass:r.ok === false && /内网|本机/.test(r.error || '') && r2.ok === false && /内网|本机/.test(r2.error || ''),
    result:r, localhost:r2 };
});

T('R11_search_off_is_honest', async function(){
  delete process.env.AGENT_SEARCH_MODE;
  delete process.env.AI_SEARCH_ENABLED;
  const r = await agent.runTool('search_public_sources', { query:'示例企业 专利' }, baseContext(), {}, { webSources:{} });
  return { pass:r.ok === true && r.available === false && (r.results || []).length === 0 && /未启用|不可用/.test(r.reason || ''), result:r };
});

T('R12_search_supplement_cap', async function(){
  delete process.env.AGENT_SEARCH_MODE;
  delete process.env.AI_SEARCH_ENABLED;
  const st = { webSources:{}, searchUsed:0 };
  const r1 = await agent.runTool('search_public_sources', { query:'第一次检索' }, baseContext(), {}, st);
  const r2 = await agent.runTool('search_public_sources', { query:'补一轮' }, baseContext(), {}, st);
  const r3 = await agent.runTool('search_public_sources', { query:'再补一轮' }, baseContext(), {}, st);
  return { pass:r1.ok === true && r2.ok === true && r3.ok === false && /上限/.test(r3.error || '') && st.searchUsed === 2,
    first:r1.ok, second:r2.ok, third:r3.ok, thirdError:r3.error, used:st.searchUsed };
});

/* ---- P7 新增：预算、批量、澄清与部分报告 ---- */
function twoCompanyContext(){
  const ctx = baseContext();
  ctx.companies.push({
    id:'c2', name:'对比科技有限公司', dataSource:'real', industry:'材料', region:'上海',
    evidences:[{ id:'E2', title:'授权专利', source:'国家知识产权局', url:'https://example.com/e2',
      date:'2026-02-01', grade:'A', dim:'技术', metric:'patent', quote:'该公司获发明专利授权1项。',
      reviewStatus:'accepted', facts:[] }],
    judgements:[], conflicts:[], techEvaluation:null,
    model:{ public:true, score:null, grade:null, suff:0, version:'PT-TECH-2026.11-r1' },
    snapshots:[], archives:[], analysis:null
  });
  ctx.companyIndex.push({ id:'c2', name:'对比科技有限公司', industry:'材料', dataSource:'real' });
  return ctx;
}
async function runWith(context, text, replies){
  const res = fakeRes();
  const deps = fakeDeps({ messages:[{ role:'user', content:text }], context:context, prefs:{}, memory:[], stream:true }, replies);
  await agent.handleAgentChat({ method:'POST' }, res, deps);
  return { res, deps, events:res.events() };
}

T('P1_batch_evidence_single_tool_round', async function(){
  const r = await agent.runTool('get_evidence', { evidenceIds:['E1','E404'] }, baseContext(), {}, { cache:{ evidence:{} } });
  return { pass:r.ok === true && r.count === 1 && r.missing.join(',') === 'E404' &&
    r.items[0].evidence.id === 'E1', count:r.count, missing:r.missing };
});

T('P2_compare_budget_is_higher', async function(){
  const t1 = agent.classifyTask([{ role:'user', content:'请比较当前企业与另一家企业的技术证据，先说明可比性' }], baseContext());
  const t2 = agent.classifyTask([{ role:'user', content:'这家公司属于什么行业？' }], baseContext());
  return { pass:t1.maxSteps === agent.MAX_STEPS_COMPARE && t2.maxSteps === agent.MAX_STEPS &&
    t1.maxSteps > t2.maxSteps, compare:t1, simple:t2 };
});

T('P3_clarifies_missing_compare_target', async function(){
  const r = await runWith(baseContext(), '请比较当前企业和另一家企业的技术证据差异', ['{"action":"final","answer":"x","citations":[],"followups":[],"proposals":[]}']);
  const final = r.events.filter(e => e.event === 'final').pop();
  return { pass:final && final.data.ok === true && final.data.clarify && final.data.clarify.need === true &&
    /指定|选择|第二家/.test(final.data.answer) && r.deps.calls.length === 0,
    answer:final && final.data.answer, calls:r.deps.calls.length };
});

T('P4_partial_report_at_budget', async function(){
  const r = await runWith(twoCompanyContext(), '请比较当前企业与对比科技有限公司的技术证据差异', ['{"action":"tool","tool":"get_current_context","args":{}}']);
  const fin = r.events.filter(e => e.event === 'final').pop();
  const part = r.events.filter(e => e.event === 'partial').pop();
  const ok = fin && fin.data && fin.data.ok === true && fin.data.partial === true &&
    String(fin.data.answer || '').length > 20 &&
    fin.data.task && fin.data.task.status === 'partial' && fin.data.budget.modelRounds >= 3 &&
    (fin.data.task.reason === '重复读取' || fin.data.budget.modelRounds >= agent.MAX_STEPS_COMPARE);
  return { pass:!!ok && !!part, partial:fin && fin.data.partial, answerHead:String(fin && fin.data.answer || '').slice(0, 60),
    task:fin && fin.data.task, budget:fin && fin.data.budget };
});

T('P5_repeated_profile_uses_cache', async function(){
  const st = { cache:{ profile:{}, evidence:{}, rules:null } };
  const a = await agent.runTool('get_company_profile', { companyId:'c1' }, baseContext(), {}, st);
  const b = await agent.runTool('get_company_profile', { companyId:'c1' }, baseContext(), {}, st);
  return { pass:a.ok === true && a.cached !== true && b.ok === true && b.cached === true, first:a.cached, second:b.cached };
});

(async function(){
  const out = { cases:{}, meta:{ agentVersion:agent.AGENT_VERSION, maxSteps:agent.MAX_STEPS, toolCount:agent.TOOL_SPECS.length } };
  for (const c of CASES){
    try { out.cases[c.name] = await c.fn(); }
    catch(e){ out.cases[c.name] = { pass:false, err:String(e && e.stack || e) }; }
  }
  out.passAll = Object.keys(out.cases).every(k => out.cases[k] && out.cases[k].pass);
  out.total = Object.keys(out.cases).length;
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.passAll ? 0 : 1);
})();
