/* P6 Agent 契约测试：不启动 HTTP，不读取 API Key，直接测工具协议与确定性核验。 */
const assert = require('assert');
const agent = require('../server/agent.js');

const cases = [];
function T(name, fn){
  try { fn(); cases.push({name:name, pass:true}); }
  catch(e){ cases.push({name:name, pass:false, err:String(e && e.message || e)}); }
}

function baseContext(){
  return agent.normalizeContext({
    page:'evidence',
    companyId:'acme',
    companies:[{
      id:'acme', name:'中科示例科技有限公司', dataSource:'real', industry:'高端装备',
      summary:'公开资料研究样例',
      evidences:[
        {id:'EV-A', title:'专利申请清单', source:'材料A', url:'https://example.com/a', date:'2026-01-01',
          sourceDocumentId:'DOC-A', facts:[{label:'发明专利申请', value:30, unit:'项', snippet:'发明专利申请 30 项'}]},
        {id:'EV-B', title:'授权公告', source:'材料B', url:'https://example.com/b', date:'2026-01-02',
          sourceDocumentId:'DOC-B', facts:[{label:'发明专利授权', value:12, unit:'项', snippet:'授权发明专利 12 项'}]}
      ],
      judgements:[{id:'J-1', title:'专利判断', statement:'企业拥有发明专利', evidenceIds:['EV-A','EV-B']}],
      conflicts:[{id:'C-1', title:'口径差异', nature:'timing', status:'open'}]
    }],
    companyIndex:[{id:'acme', name:'中科示例科技有限公司'}],
    rules:{apiKey:'sk-should-not-leak', threshold:0.6}
  });
}

T('context_sanitizes_secret_fields', function(){
  const ctx = baseContext();
  const text = JSON.stringify(ctx);
  assert.ok(text.indexOf('sk-should-not-leak') < 0, '密钥不应进入模型上下文');
  assert.strictEqual(ctx.rules.threshold, 0.6);
});

T('context_requires_companies', function(){
  const ctx = agent.normalizeContext({page:'pool', companies:[]});
  assert.strictEqual(ctx.companies.length, 0);
});

T('unknown_tool_rejected', function(){
  const r = agent.validateArgs('delete_everything', {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('未知工具') >= 0);
});

T('missing_required_arg_rejected', function(){
  const r = agent.validateArgs('get_evidence', {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('evidenceId') >= 0);
});

T('wrong_arg_type_rejected', function(){
  const r = agent.validateArgs('compare_companies', {companyIds:'acme'});
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('字符串数组') >= 0);
});

T('max_steps_and_tools_declared', function(){
  assert.ok(agent.TASK_BUDGETS && agent.TASK_BUDGETS.simple && agent.TASK_BUDGETS.explain && agent.TASK_BUDGETS.research && agent.TASK_BUDGETS.compare, '缺少任务预算');
  assert.strictEqual(agent.TASK_BUDGETS.simple.maxSteps, 4);
  assert.strictEqual(agent.TASK_BUDGETS.explain.maxSteps, 5);
  assert.strictEqual(agent.TASK_BUDGETS.research.maxSteps, 6);
  assert.strictEqual(agent.TASK_BUDGETS.compare.maxSteps, 8);
  assert.ok(agent.TASK_BUDGETS.explain.tokenBudget > agent.TASK_BUDGETS.simple.tokenBudget);
  assert.ok(agent.TASK_BUDGETS.research.tokenBudget > agent.TASK_BUDGETS.explain.tokenBudget);
  assert.strictEqual(agent.TASK_BUDGETS.compare.maxSteps, agent.MAX_STEPS_COMPARE);
  assert.ok(agent.TASK_BUDGETS.compare.tokenBudget > agent.TASK_BUDGETS.simple.tokenBudget);
  assert.ok(agent.TOOL_SPECS.length === 21);
  ['get_current_context','search_workspace','get_company_profile','get_evidence','get_evaluation_rules',
   'compare_companies','compare_snapshots','search_public_sources','read_public_document',
   'extract_facts','verify_claims','analyze_technology','assess_evidence_gaps','critique_analysis',
   'generate_due_diligence_questions','propose_company','propose_evidence','propose_judgement',
   'propose_evaluation','generate_report','navigate_workspace'].forEach(function(n){
    assert.ok(agent.TOOL_SPECS.some(function(t){ return t.name === n; }), '缺少工具 ' + n);
  });
});

T('task_budgets_classify_four_kinds', function(){
  const ctx = { companies:[], attachments:[] };
  const k = function(q){ return agent.classifyTask([{role:'user',content:q}], ctx).kind; };
  assert.strictEqual(k('你好'), 'simple');
  assert.strictEqual(k('请解释当前评分为什么是 25 分，门槛和权重怎么算'), 'explain');
  assert.strictEqual(k('请比较两家企业的技术证据差异'), 'compare');
  assert.strictEqual(k('请做一轮完整尽调研究，逐条核验证据并生成报告'), 'research');
});

T('search_unavailable_is_honest', async function(){
  // 该用例在下方以异步方式单独执行；这里仅校验同步函数存在。
  assert.strictEqual(typeof agent.runTool, 'function');
});

T('verify_claim_30_granted_vs_30_applications_12_grants', function(){
  const ctx = baseContext();
  const r = agent.runTool('verify_claims', {companyId:'acme', claim:'企业拥有30项已授权发明专利'}, ctx, {}, {webSources:{}});
  assert.strictEqual(r.ok, true);
  assert.ok(r.scopeConflicts.length >= 1, '应识别申请/授权口径差异');
  const sc = r.scopeConflicts[0];
  assert.ok(sc.reason.indexOf('30') >= 0);
  assert.ok(sc.reason.indexOf('12') >= 0);
  assert.strictEqual(sc.canAssertNegative, false);
  assert.strictEqual(r.claimCheck.relation, 'timing');
  assert.ok(r.claimCheck.reason.indexOf('12') >= 0);
  assert.ok(r.claimCheck.evidenceIds.indexOf('EV-A') >= 0);
  assert.strictEqual(r.claimCheck.canAssertNegative, false);
});

T('verify_claim_within_grants_supported', function(){
  const ctx = baseContext();
  const r = agent.runTool('verify_claims', {claim:'企业拥有10项授权发明专利'}, ctx, {}, {webSources:{}});
  assert.strictEqual(r.claimCheck.relation, 'supports');
});

T('verify_missing_fact_stays_insufficient', function(){
  const ctx = baseContext();
  const r = agent.runTool('verify_claims', {claim:'企业拥有5项软件著作权'}, ctx, {}, {webSources:{}});
  assert.strictEqual(r.claimCheck.relation, 'insufficient');
  assert.ok(r.claimCheck.reason.indexOf('未取得') >= 0);
  assert.strictEqual(r.claimCheck.canAssertNegative, false);
});

T('proposal_is_pending_confirmation', function(){
  const ctx = baseContext();
  const state = {proposals:[], proposalSeq:0, webSources:{}};
  const r = agent.runTool('propose_evidence', {
    title:'授权公告', source:'材料B', url:'https://example.com/b', date:'2026-01-02',
    quote:'授权发明专利 12 项', metric:'patent', companyId:'acme'
  }, ctx, {}, state);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(state.proposals.length, 1);
  assert.strictEqual(state.proposals[0].requiresConfirmation, true);
});

T('propose_judgement_needs_real_evidence', function(){
  const ctx = baseContext();
  const state = {proposals:[], proposalSeq:0, webSources:{}};
  const r = agent.runTool('propose_judgement', {
    title:'不存在的判断', statement:'依据不存在证据', evidenceIds:['EV-NOT-FOUND'], companyId:'acme'
  }, ctx, {}, state);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('真实存在') >= 0);
  assert.strictEqual(state.proposals.length, 0);
});

T('final_drops_unknown_citations', function(){
  const ctx = baseContext();
  const state = {webSources:{}, proposals:[], proposalSeq:0};
  const checked = agent.validateFinal({
    action:'final', answer:'根据证据，企业有 12 项授权发明专利待人工核对。',
    citations:[{kind:'evidence', id:'EV-A'}, {kind:'evidence', id:'EV-NOT-FOUND'}],
    followups:['还需要核对什么证据？']
  }, ctx, state);
  assert.strictEqual(checked.ok, true);
  assert.strictEqual(checked.citations.length, 1);
  assert.strictEqual(checked.citations[0].id, 'EV-A');
  assert.ok(checked.droppedCitations.indexOf('EV-NOT-FOUND') >= 0);
});

T('final_blocks_credit_conclusion', function(){
  const ctx = baseContext();
  const state = {webSources:{}, proposals:[], proposalSeq:0};
  const checked = agent.validateFinal({
    action:'final', answer:'综合判断，建议授信额度 5000 万元。', citations:[], followups:[]
  }, ctx, state);
  assert.strictEqual(checked.ok, false);
  assert.ok(checked.error.indexOf('授信') >= 0);
});

T('navigate_rejects_unknown_evidence', function(){
  const ctx = baseContext();
  const r = agent.runTool('navigate_workspace', {view:'evidence', evidenceId:'EV-NOT-FOUND'}, ctx, {}, {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('不存在') >= 0);
});

T('navigate_accepts_real_evidence', function(){
  const ctx = baseContext();
  const r = agent.runTool('navigate_workspace', {view:'evidence', evidenceId:'EV-A'}, ctx, {}, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.navigate.evidenceId, 'EV-A');
});

const searchCase = {name:'search_default_returns_unavailable', pass:true};
agent.runTool('search_public_sources', {query:'示例企业 专利'}, baseContext(), {}, {webSources:{}})
  .then(function(r){
    try{
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.available, false);
      assert.ok(r.reason.indexOf('AGENT_SEARCH_MODE=off') >= 0);
      assert.ok(r.suggestion.indexOf('粘贴') >= 0);
      assert.strictEqual(Array.isArray(r.results), true);
      assert.strictEqual(r.results.length, 0);
    }catch(e){
      searchCase.pass = false;
      searchCase.err = String(e && e.message || e);
    }
    cases.push(searchCase);
    const fails = cases.filter(function(c){ return !c.pass; });
    console.log(JSON.stringify({cases:cases, passAll:fails.length === 0}, null, 2));
    process.exitCode = fails.length ? 1 : 0;
  })
  .catch(function(e){
    searchCase.pass = false;
    searchCase.err = String(e && e.message || e);
    cases.push(searchCase);
    console.log(JSON.stringify({cases:cases, passAll:false}, null, 2));
    process.exitCode = 1;
  });
