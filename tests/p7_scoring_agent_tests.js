/* P7：Agent 读到的评分上下文、规则与尽调建议结构。
   只验证服务端确定性部分，不调用真实模型。 */
const agent = require('../server/agent.js');

const CASES = [];
function T(name, fn){ CASES.push({name:name, fn:fn}); }
function assert(v, msg){ if(!v) throw new Error(msg); }

function ctx(){
  return {
    page:'model', pageLabel:'评分与门槛', companyId:'c1',
    selection:{evidenceId:'E1'},
    companies:[{
      id:'c1', name:'测试仪器有限公司', dataSource:'research', industry:'精密仪器', region:'北京',
      evidences:[
        {id:'E1', title:'发明专利授权公告', source:'国家知识产权局', url:'https://example.com/1',
          date:'2026-02-01', grade:'A', metric:'patent', quote:'授权发明专利 3 项。', reviewStatus:'accepted'},
        {id:'E2', title:'研发项目立项', source:'企业官网', url:'https://example.com/2',
          date:'2026-03-01', grade:'B', metric:'rd', quote:'在研项目 2 项。', reviewStatus:'accepted'},
        {id:'E3', title:'第三方检测报告', source:'检测机构', url:'https://example.com/3',
          date:'2026-04-01', grade:'A', metric:'advancement', quote:'灵敏度达到 0.1ppm。', reviewStatus:'pending'}
      ],
      judgements:[], conflicts:[],
      techEvaluation:null,
      model:{
        public:true, research:true, score:null, grade:'—', suff:0.61,
        ruleVersion:'PT-TECH-RESEARCH-2026.11-r1', evaluationState:'reference',
        technicalScore:62, acceptedScore:62, candidateScore:71, formalScore:null,
        acceptedGrade:'C+', candidateGrade:'B-', formalGrade:null,
        formalReady:false,
        metricLevels:[
          {key:'patent', name:'专利与知识产权', dim:'技术资产', acceptedLevel:3, candidateLevel:3,
            acceptedEvidence:['E1'], candidateEvidence:['E1'], documentCount:2, reason:'多源可核'},
          {key:'rd', name:'研发活动', dim:'研发与先进性', acceptedLevel:2, candidateLevel:2,
            acceptedEvidence:['E2'], candidateEvidence:['E2'], documentCount:1, reason:'可核'},
          {key:'advancement', name:'技术先进性', dim:'研发与先进性', acceptedLevel:null, candidateLevel:2,
            acceptedEvidence:[], candidateEvidence:['E3'], documentCount:0, reason:'有候选证据但未采信'},
          {key:'product', name:'产品化', dim:'技术转化', acceptedLevel:null, candidateLevel:null,
            acceptedEvidence:[], candidateEvidence:[], documentCount:0, reason:'未取得该类证据'},
          {key:'adoption', name:'客户采用', dim:'技术转化', acceptedLevel:null, candidateLevel:null,
            acceptedEvidence:[], candidateEvidence:[], documentCount:0, reason:'未取得该类证据'}
        ],
        suffBreakdown:{suff:0.61, parts:[
          {key:'metric', name:'技术指标覆盖', weight:0.4, ratio:0.4, detail:'2 / 5 项指标有证据'},
          {key:'accepted', name:'已采信证据', weight:0.25, ratio:0.4, detail:'2 条已采信'},
          {key:'url', name:'来源网址可追溯', weight:0.2, ratio:1, detail:'3 / 3 条有来源网址'},
          {key:'doc', name:'独立来源文档', weight:0.15, ratio:0.67, detail:'2 个独立文档'}
        ]},
        formalBlockers:[{key:'metrics', text:'已采信指标只有 2 / 5 项，至少需要 3 项'}],
        acceptedEvidence:[{id:'E1', title:'发明专利授权公告', metric:'patent'}, {id:'E2', title:'研发项目立项', metric:'rd'}],
        pendingEvidence:[{id:'E3', title:'第三方检测报告', metric:'advancement'}],
        scoreHistory:[{
          at:'2026-11-21 10:00', trigger:'导入 AI 解析证据 1 条', actor:'王经理',
          ruleVersion:'PT-TECH-RESEARCH-2026.11-r1',
          before:{accepted:50, candidate:50, formal:null, suff:0.50},
          after:{accepted:62, candidate:71, formal:null, suff:0.61},
          changes:[{metric:'rd', name:'研发活动', from:1, to:2, weight:0.2}],
          candidateChanges:[{metric:'advancement', name:'技术先进性', from:1, to:2}]
        }],
        counts:{confirmed:0, pending:2, review:0, blocked:0, none:0}
      },
      snapshots:[], archives:[], analysis:null
    }],
    companyIndex:[{id:'c1', name:'测试仪器有限公司', industry:'精密仪器', dataSource:'research'}],
    workspace:{queueCount:1, dataMode:'研究企业', asOf:'2026-11-21'},
    rules:{
      research:{version:'PT-TECH-RESEARCH-2026.11-r1', gate:0.6, minMetrics:3, minAccepted:3,
        weights:{patent:0.28, rd:0.2, advancement:0.16, product:0.18, adoption:0.18},
        anchors:[{lv:0, name:'无记录', rule:'保持未知'}], gateMeaning:'证据充分度门槛，不是技术得分及格线'},
      verificationLabels:{},
      boundaries:['技术评分只能由确定性规则计算，模型不得改写']
    },
    attachments:[]
  };
}
function norm(){
  return agent.normalizeContext(ctx());
}
function deps(){
  return {API_KEY:'', API_BASE:'', API_MODEL:'', callChat:function(){ throw new Error('不应调用模型'); }};
}

T('P7A1_context_keeps_score_fields', function(){
  const c = norm().companies[0];
  assert(c.model.ruleVersion === 'PT-TECH-RESEARCH-2026.11-r1', 'ruleVersion 丢失');
  assert(c.model.acceptedScore === 62 && c.model.candidateScore === 71, '分数丢失');
  assert(c.model.formalScore === null, '正式分为空应保持 null');
  assert(c.model.metricLevels.length === 5, '指标定级丢失');
  assert(c.model.metricLevels[2].acceptedLevel === null, '候选指标不应变成 0');
  assert(c.model.suffBreakdown.parts.length === 4, '充分度构成丢失');
  assert(c.model.formalBlockers[0].key === 'metrics', '出分条件丢失');
  assert(c.model.scoreHistory[0].trigger.indexOf('导入') === 0, '评分历史丢失');
  assert(c.model.acceptedEvidence.length === 2 && c.model.pendingEvidence.length === 1, '证据分组丢失');
});

T('P7A2_rules_expose_gate_and_weights', function(){
  const r = agent.runTool('get_evaluation_rules', {}, norm(), deps(), {cache:{}});
  assert(r.ok && r.rules.research, '规则未返回');
  assert(r.rules.research.gate === 0.6, '门槛丢失');
  assert(Math.abs(r.rules.research.weights.patent - 0.28) < 1e-9, '权重丢失');
  assert(r.rules.research.gateMeaning.indexOf('不是技术得分及格线') >= 0, '门槛口径缺失');
});

T('P7A3_gap_tool_reports_metric_state', function(){
  const r = agent.runTool('assess_evidence_gaps', {}, norm(), deps(), {cache:{}});
  assert(r.ok, '缺口工具失败');
  assert(r.scoring && r.scoring.evaluationState === 'reference', '评分状态缺失');
  assert(r.metricStatus.length === 5, '指标状态缺失');
  const adv = r.metricStatus.filter(function(x){ return x.key === 'advancement'; })[0];
  assert(adv.acceptedLevel === null && adv.candidateLevel === 2, '未采信指标状态不正确');
  assert(adv.gap.indexOf('未采信') >= 0, '缺口说明缺失');
  assert(r.scoring.formalBlockers.length === 1, '出分条件缺失');
});

T('P7A4_due_diligence_has_actionable_fields', function(){
  const r = agent.runTool('generate_due_diligence_questions', {}, norm(), deps(), {cache:{}});
  assert(r.ok && r.questions.length >= 3, '尽调建议过少');
  const patent = r.questions.filter(function(q){ return q.metric === 'patent'; })[0];
  assert(patent, '缺少专利建议');
  ['problem', 'metric', 'existingEvidence', 'neededMaterial', 'verification', 'impact', 'ifUnavailable'].forEach(function(k){
    assert(patent[k] != null && String(patent[k]).length > 0, '缺少字段 ' + k);
  });
  assert(r.questions.some(function(q){ return q.metric === 'advancement'; }), '未覆盖未采信指标');
  assert(r.ruleVersion === 'PT-TECH-RESEARCH-2026.11-r1', '规则版本缺失');
});

(async function(){
  let failed = 0;
  const out = [];
  for(const c of CASES){
    try{
      const r = await c.fn();
      out.push({name:c.name, pass:true, detail:r || null});
    }catch(e){
      failed++;
      out.push({name:c.name, pass:false, error:e.message});
    }
  }
  console.log(JSON.stringify({passAll:failed === 0, total:CASES.length, failed:failed, cases:out}, null, 2));
  process.exit(failed ? 1 : 0);
})();