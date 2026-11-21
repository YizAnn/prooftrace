(async function(){
  const out = { cases: {}, meta: {} };
  const T = (name, fn) => {
    try { out.cases[name] = fn(); }
    catch(e){ out.cases[name] = { pass:false, err:String(e && e.stack || e) }; }
  };
  const companyById = id => COMPANIES.filter(x => x.id === id)[0];

  /* 登录态：使用风险审查员，便于覆盖复核/归档 */
  state.user = { name:'自动测试员', role:'风险审查员' };
  state.stages = {};
  state.authors = {};
  state.reviews = {};
  state.decisions = {};
  state.evals = {};
  COMPANIES.forEach(function(c){ computeCompanyModel(c, null, reviewState(c)); });
  render();

  out.meta.modelVersion = MODEL_VERSION.id;
  out.meta.companyCount = COMPANIES.length;
  out.meta.evidenceCount = COMPANIES.reduce((n,c)=>n+c.evidences.length,0);
  out.meta.sourceCount = SOURCES.length;
  out.meta.fieldTotal = SOURCE_FIELD_TOTAL;
  out.meta.companies = COMPANIES.map(function(c){
    return { id:c.id, suff:c.suff, dual:c.model.dual, score:c.score, grade:c.grade, vKey:c.vKey, pending:c.pendingDims };
  });

  /* C1 主评分 = 复算评分（逐户比较原始分与四维分） */
  T('C1_score_equals_recalc', function(){
    const rows = COMPANIES.filter(function(c){ return c.dataSource !== 'public'; }).map(function(c){
      const m = MODELS[c.id];
      const calc = calcSignalsModel(m.sig, m.arch);
      const dimsEq = calc.dims.every(function(d, i){ return d.score === c.dims[i].score; });
      return { id:c.id, rawModel:c.rawScore, rawRecalc:calc.raw, rawEq:calc.raw === c.rawScore, dimsEq:dimsEq };
    });
    return { pass: rows.every(r => r.rawEq && r.dimsEq), rows: rows };
  });

  /* C2 修改原始信号 → 分数按预期变化 */
  T('C2_signal_change_moves_score', function(){
    const c = companyById('yunshu');
    const m = MODELS[c.id];
    const baseSig = JSON.parse(JSON.stringify(m.sig));
    const key = Object.keys(baseSig).filter(function(k){ return baseSig[k] < 4; })[0];
    const upSig = Object.assign({}, baseSig); upSig[key] = 4;
    const downSig = Object.assign({}, baseSig); downSig[key] = 0;
    const base = calcSignalsModel(baseSig, m.arch).raw;
    const up = calcSignalsModel(upSig, m.arch).raw;
    const down = calcSignalsModel(downSig, m.arch).raw;
    return { pass: up >= base && down <= base && (up > base || down < base), key:key, base:base, up:up, down:down };
  });

  /* C3 证据缺失 → 不出分、不编造评价依据 */
  T('C3_missing_evidence_no_fabrication', function(){
    const c = companyById('yunshu');
    const savedCov = JSON.parse(JSON.stringify(MODELS[c.id].cov));
    const savedSuff = c.suff, savedScore = c.score, savedGrade = c.grade, savedVerdict = c.verdict;
    Object.keys(MODELS[c.id].cov).forEach(function(k){ MODELS[c.id].cov[k] = 'missing'; });
    computeCompanyModel(c, 0, { holds:[], holdMap:{}, covHeld:[], dualLoss:0, pending:[], marks:[] });
    const missingState = { suff:c.suff, score:c.score, grade:c.grade, verdict:c.verdict, confirmed:c.confirmed };
    const prevCompany = state.companyId;
    state.companyId = c.id;
    const pv = previewHtml();
    const fabricated = /模型参考分 \d+ 分/.test(pv) && missingState.score != null;
    const saysInsufficient = /证据不足|暂不确认|不确认技术价值/.test(pv);
    /* 恢复 */
    MODELS[c.id].cov = savedCov;
    state.companyId = prevCompany;
    computeCompanyModel(c, null, reviewState(c));
    return {
      pass: missingState.suff === 0 && missingState.score === null && !fabricated && saysInsufficient,
      missing: missingState, fabricated: fabricated, saysInsufficient: saysInsufficient,
      restored: { suff:c.suff === savedSuff, score:c.score === savedScore, grade:c.grade === savedGrade }
    };
  });

  /* C4 证据标为存疑 → 受影响结论进入待复核，且原始分不被随意改动 */
  T('C4_doubtful_evidence_triggers_pending', function(){
    const c = companyById('yunshu');
    const before = { raw:c.rawScore, suff:c.suff, dual:c.model.dual, vKey:c.vKey };
    state.evals[c.id + ':ys-2'] = { mark:'存疑', reason:'自动测试' };
    computeCompanyModel(c, null, reviewState(c));
    const after = { raw:c.rawScore, suff:c.suff, dual:c.model.dual, vKey:c.vKey, pendingDims:c.pendingDims, grade:c.grade };
    const prevCompany = state.companyId;
    state.companyId = c.id;
    const pv = previewHtml();
    const marked = /待复核/.test(pv);
    /* 恢复 */
    state.companyId = prevCompany;
    delete state.evals[c.id + ':ys-2'];
    computeCompanyModel(c, null, reviewState(c));
    return {
      /* C-03 已引用 ys-2；标存疑后由证据本身扣 ipq，冲突不再重复扣，因此 dual 不变 */
      pass: after.raw === before.raw && after.vKey === 'pending' && after.pendingDims.indexOf('技术资产') >= 0 && after.dual === before.dual && marked,
      before:before, after:after, previewHasPending:marked, dedupeOk: after.dual === before.dual
    };
  });

  /* C5 报告的维度 / 分数 / 身份 / 引用 / 规则版本与系统数据一致 */
  T('C5_report_consistency', function(){
    state.companyId = 'yunshu';
    const c = company();
    const dims = c.dims.map(function(d){ return d.name; });
    const pv = previewHtml();
    const doc = docDoc();
    const md = mdDoc();
    const csv = csvDoc();
    const man = JSON.parse(manifestDoc());
    const dimsOrderOk = dims.join(',') === '技术资产,技术转化,经营韧性,信用治理';
    const pvHasDims = dims.every(function(n){ return pv.indexOf(n) >= 0; });
    const docHasDims = dims.every(function(n){ return doc.indexOf(n) >= 0; });
    const versionOk = pv.indexOf(MODEL_VERSION.id) >= 0 && md.indexOf(MODEL_VERSION.id) >= 0 && doc.indexOf(MODEL_VERSION.id) >= 0 && csv.indexOf(MODEL_VERSION.id) >= 0 && man.model.id === MODEL_VERSION.id;
    const noLoanVerdict = !/可授信|不予授信|建议授信|授信额度为/.test(pv + md + doc);
    const scoreConsistent = md.indexOf(String(c.rawScore)) >= 0 && man.model.score === c.score;
    const evNoCount = (pv.match(/<td class="mono">E\d\d<\/td>/g) || []).length;
    const citationsOk = evNoCount === c.evidences.length;
    const beforeArchive = { preparer: doc.indexOf('自动测试员') >= 0, unreviewed: doc.indexOf('未复核') >= 0 };

    /* 归档后应出现复核人，且不再是“未复核” */
    state.stages[c.id] = 'archived';
    recordReview(c);
    const doc2 = docDoc();
    const afterArchive = { reviewer: doc2.indexOf('自动测试员') >= 0, unreviewedGone: doc2.indexOf('未复核') < 0, ridReviewed: reportIdentity(c).reviewed };
    /* 恢复 */
    state.stages = {};
    state.reviews = {};
    computeCompanyModel(c, null, reviewState(c));
    state.companyId = 'yunshu';
    return {
      pass: dimsOrderOk && pvHasDims && docHasDims && versionOk && noLoanVerdict && scoreConsistent && citationsOk && beforeArchive.preparer && beforeArchive.unreviewed && afterArchive.reviewer && afterArchive.unreviewedGone && afterArchive.ridReviewed,
      dims:dims, dimsOrderOk:dimsOrderOk, pvHasDims:pvHasDims, docHasDims:docHasDims, versionOk:versionOk,
      noLoanVerdict:noLoanVerdict, scoreConsistent:scoreConsistent, citations:evNoCount, citationsOk:citationsOk,
      beforeArchive:beforeArchive, afterArchive:afterArchive
    };
  });

  /* C6 主要页面可打开、切换、渲染 */
  T('C6_views_render', function(){
    const rows = [];
    for (const v of VIEWS){
      try {
        setView(v);
        const el = document.querySelector('.view[data-view="' + v + '"]');
        rows.push({ v:v, ok: !!el && el.innerHTML.length > 200, len: el ? el.innerHTML.length : 0 });
      } catch(e){
        rows.push({ v:v, ok:false, err:String(e) });
      }
    }
    return { pass: rows.every(r => r.ok), rows: rows };
  });

  /* C7 冲突“暂不采信” → 覆盖降档 + 双源扣减 + 维度待复核，但原始分不变 */
  T('C7_conflict_hold_linkage', function(){
    const c = companyById('yunshu');
    const before = { raw:c.rawScore, suff:c.suff, dual:c.model.dual, vKey:c.vKey };
    state.decisions[c.id + ':C-01'] = { choice:'hold', reason:'自动测试' };
    computeCompanyModel(c, null, reviewState(c));
    const after = { raw:c.rawScore, suff:c.suff, dual:c.model.dual, vKey:c.vKey, pendingDims:c.pendingDims };
    delete state.decisions[c.id + ':C-01'];
    computeCompanyModel(c, null, reviewState(c));
    return {
      pass: after.raw === before.raw && after.suff <= before.suff && after.dual < before.dual && after.vKey === 'pending' && after.pendingDims.length > 0,
      before:before, after:after
    };
  });

  /* C8 真实点击链路：证据台标存疑 → 提交 → 画像进入待复核 */
  const c8 = await (async function(){
    try {
      const c = companyById('yunshu');
      state.companyId = c.id;
      state.evals = {};
      state.decisions = {};
      computeCompanyModel(c, null, reviewState(c));
      setView('evidence');
      state.evId = 'ys-2';
      render();
      const btn = Array.from(document.querySelectorAll('[data-action="ev-mark-set"]')).filter(function(b){ return b.dataset.mark === '存疑'; })[0];
      if(!btn) return { pass:false, reason:'存疑按钮未找到' };
      btn.click();
      const note = document.getElementById('ev-note');
      if(!note) return { pass:false, reason:'判定依据输入框未找到' };
      note.value = '自动测试：登记号与官方公示不一致';
      const submit = document.querySelector('[data-action="ev-submit"]');
      if(!submit) return { pass:false, reason:'提交按钮未找到' };
      submit.click();
      const saved = state.evals[c.id + ':ys-2'];
      const recomputed = { pending:c.pendingDims, vKey:c.vKey, suff:c.suff };
      /* 点击导航切到画像页，确认真实交互可切换 */
      const nav = document.querySelector('[data-action="nav"][data-view="profile"]');
      if(nav) nav.click();
      const profileVisible = !!document.querySelector('.view[data-view="profile"].is-active');
      const profileText = profileVisible ? document.querySelector('.view[data-view="profile"]').textContent : '';
      /* 恢复 */
      delete state.evals[c.id + ':ys-2'];
      computeCompanyModel(c, null, reviewState(c));
      setView('evidence');
      return {
        pass: !!(saved && saved.mark === '存疑') && recomputed.pending.indexOf('技术资产') >= 0 && recomputed.vKey === 'pending' && profileVisible && /待复核|未确认/.test(profileText),
        saved:saved, recomputed:recomputed, profileVisible:profileVisible
      };
    } catch(e){ return { pass:false, err:String(e) }; }
  })();
  out.cases.C8_ui_click_flow = c8;

  /* ---------------- 本轮 P0 验收用例 ---------------- */

  /* P0A 三项冲突未处置（其中两项为实质冲突）时，评价不得确认 */
  T('P0A_substantive_conflicts_block_confirmation', function(){
    const c = companyById('yunshu');
    state.companyId = c.id;
    state.evals = state.evals || {};
    delete state.evals[c.id + ':ys-2'];
    state.decisions = state.decisions || {};
    ['C-01','C-02','C-03'].forEach(function(id){ delete state.decisions[c.id + ':' + id]; });
    computeCompanyModel(c, null, reviewState(c));
    const rv = reviewState(c);
    const blockingIds = rv.blocking.map(function(x){ return x.id; });
    const timingIds = rv.timing.map(function(x){ return x.id; });
    return {
      pass: c.confirmed === false && c.score === null && c.rawScore === 79
        && c.vKey === 'pending' && c.stage !== 'archived'
        && rv.blocking.length === 2 && blockingIds.indexOf('C-02') >= 0 && blockingIds.indexOf('C-03') >= 0
        && timingIds.indexOf('C-01') >= 0 && rv.holds.indexOf('技术资产') >= 0
        && c.model.blockingConflicts.length === 2,
      confirmed:c.confirmed, score:c.score, rawScore:c.rawScore, vKey:c.vKey,
      holds:rv.holds, blocking:blockingIds, timing:timingIds,
      open:rv.open.map(function(x){ return x.id; }), suff:c.suff, dual:c.model.dual
    };
  });

  /* P0B 完成必要人工处置后，在证据充分、双源合格前提下恢复确认 */
  T('P0B_manual_disposition_restores_confirmation', function(){
    const c = companyById('yunshu');
    state.companyId = c.id;
    const stamp = '2026-11-21 13:30';
    state.decisions[c.id + ':C-02'] = {choice:'a', reason:'自动测试：审计口径优先', by:'自动测试员', at:stamp};
    state.decisions[c.id + ':C-03'] = {choice:'a', reason:'自动测试：以专利登记簿为准', by:'自动测试员', at:stamp};
    computeCompanyModel(c, null, reviewState(c));
    const rv = reviewState(c);
    const blockers = archiveBlockers(c);
    const after = {
      confirmed:c.confirmed, score:c.score, grade:c.grade, rawScore:c.rawScore,
      pendingDims:(c.pendingDims || []).slice(), dual:c.model.dual, dualPass:c.model.dualPass,
      suff:c.suff, blocking:rv.blocking.length, blockers:blockers
    };
    /* 恢复为默认未处置状态，供后续用例使用 */
    delete state.decisions[c.id + ':C-02'];
    delete state.decisions[c.id + ':C-03'];
    computeCompanyModel(c, null, reviewState(c));
    return {
      pass: after.confirmed === true && after.score === 79 && after.pendingDims.length === 0
        && after.dual >= 4 && after.dualPass === true && after.suff >= 0.60
        && after.blocking === 0 && after.blockers.length === 0,
      after:after, restored:{confirmed:c.confirmed, score:c.score}
    };
  });

  /* P0E 归档门禁：存在未决实质冲突时，真实点击归档应被阻止并展示原因 */
  const p0e = (function(){
    try {
      state.user = { name:'自动测试员', role:'风险审查员' };
      state.companyId = 'yunshu';
      const c = companyById('yunshu');
      state.stages[c.id] = 'review';
      state.archives = state.archives || {};
      state.archives[c.id] = [];
      delete state.evals[c.id + ':ys-2'];
      delete state.decisions[c.id + ':C-02'];
      delete state.decisions[c.id + ':C-03'];
      computeCompanyModel(c, null, reviewState(c));
      setView('export');
      render();
      let btn = document.querySelector('[data-action="stage-archive"]');
      const usedFallback = !btn;
      if(!btn){
        btn = document.createElement('button');
        btn.setAttribute('data-action', 'stage-archive');
        document.body.appendChild(btn);
      }
      btn.click();
      if(usedFallback && btn.parentNode) btn.parentNode.removeChild(btn);
      const dlg = document.getElementById('dialog');
      const body = document.getElementById('dialog-body');
      const titleEl = document.getElementById('dialog-title');
      const visible = !!dlg && dlg.hidden === false;
      const text = (titleEl ? titleEl.textContent : '') + ' ' + (body ? body.textContent : '');
      const blocked = stageOf(c) === 'review' && state.archives[c.id].length === 0;
      closeDialog();
      setView('overview');
      return {
        pass: visible && /尚不满足归档条件/.test(text) && /C-02/.test(text) && blocked,
        dialogVisible:visible, blocked:blocked, stage:stageOf(c), usedFallback:usedFallback,
        textSnippet:text.slice(0, 160)
      };
    } catch(e){ return { pass:false, err:String(e && e.stack || e) }; }
  })();
  out.cases.P0E_archive_gate_blocks_open_conflicts = p0e;

  /* P0C 已归档报告遇核心证据存疑：转回待复核，历史快照保留 */
  const p0c = await (async function(){
    try {
      state.user = { name:'自动测试员', role:'风险审查员' };
      state.companyId = 'yunshu';
      const c = companyById('yunshu');
      state.evals = state.evals || {};
      delete state.evals[c.id + ':ys-2'];
      state.decisions = state.decisions || {};
      state.decisions[c.id + ':C-02'] = {choice:'a', reason:'自动测试：审计口径优先', by:'自动测试员', at:'2026-11-21 13:30'};
      state.decisions[c.id + ':C-03'] = {choice:'a', reason:'自动测试：以专利登记簿为准', by:'自动测试员', at:'2026-11-21 13:30'};
      state.decisions[c.id + ':C-01'] = {choice:'timing', reason:'自动测试：2024 年报与 2025 年 9 月不同时点', by:'自动测试员', at:'2026-11-21 13:30'};
      state.archives = state.archives || {};
      state.archives[c.id] = [];
      state.reviewFlags = state.reviewFlags || {};

      computeCompanyModel(c, null, reviewState(c));
      const preBlockers = archiveBlockers(c);
      recordAuthor(c);
      state.stages[c.id] = 'review';
      computeCompanyModel(c, null, reviewState(c));
      state.stages[c.id] = 'archived';
      recordReview(c);
      archiveCompany(c, reportIdentity(c));

      const historyBefore = state.archives[c.id].length;
      const archived = {
        stage:stageOf(c), reviewed:reportIdentity(c).reviewed,
        history:historyBefore,
        snapEval:state.archives[c.id][0].evals['ys-2']
      };

      /* 真实点击：证据台把核心专利证据标为存疑并提交 */
      setView('evidence');
      state.evId = 'ys-2';
      render();
      const btn = Array.from(document.querySelectorAll('[data-action="ev-mark-set"]')).filter(function(b){ return b.dataset.mark === '存疑'; })[0];
      if(!btn) return { pass:false, reason:'存疑按钮未找到', archived:archived };
      btn.click();
      const note = document.getElementById('ev-note');
      if(!note) return { pass:false, reason:'判定依据输入框未找到', archived:archived };
      note.value = '自动测试：登记号与官方公示不一致';
      const submit = document.querySelector('[data-action="ev-submit"]');
      if(!submit) return { pass:false, reason:'提交按钮未找到', archived:archived };
      submit.click();

      const rid = reportIdentity(c);
      const flag = state.reviewFlags[c.id] || null;
      const after = {
        stage:stageOf(c), reviewed:rid.reviewed, stale:rid.stale,
        history:state.archives[c.id].length,
        currentMark:(state.evals[c.id + ':ys-2'] || {}).mark || null,
        snapEvalStillNull:state.archives[c.id][0].evals['ys-2'] === null,
        reviewFlag:flag,
        confirmed:c.confirmed, score:c.score, vKey:c.vKey, pendingDims:(c.pendingDims || []).slice()
      };
      return {
        pass: preBlockers.length === 0 && archived.reviewed === true && archived.stage === 'archived'
          && archived.history === 1 && archived.snapEval === null
          && after.stage === 'review' && after.stale === true && after.reviewed === false
          && after.history === 1 && after.currentMark === '存疑' && after.snapEvalStillNull === true
          && !!flag && /证据/.test(flag.reason || '')
          && after.confirmed === false && after.vKey === 'pending',
        preBlockers:preBlockers, archived:archived, after:after
      };
    } catch(e){ return { pass:false, err:String(e && e.stack || e) }; }
  })();
  out.cases.P0C_archive_reopened_on_evidence_change = p0c;

  /* P0D 证据改变后，页面 / CSV / Word / Markdown / 交付包关键状态一致 */
  const p0d = (function(){
    try {
      state.companyId = 'yunshu';
      const c = companyById('yunshu');
      const rid = reportIdentity(c);
      const pv = previewHtml();
      const md = mdDoc();
      const csv = csvDoc();
      const doc = docDoc();
      const man = JSON.parse(manifestDoc());
      const pay = exportPayload();
      const label = DATA_MODE.label;
      const banned = ['官方开放接口记录','企业书面授权材料','官方开放接口已接入','企业授权资料已使用','内容由AI大模型生成'];
      const allText = pv + md + csv + doc + JSON.stringify(man) + JSON.stringify(pay);
      const bannedHits = banned.filter(function(s){ return allText.indexOf(s) >= 0; });
      const stages = {
        preview: pv.indexOf(rid.stageText) >= 0,
        md: md.indexOf(rid.stageText) >= 0,
        csv: csv.indexOf(rid.stageText) >= 0,
        doc: doc.indexOf(rid.stageText) >= 0,
        manifest: man.stage === rid.stageText,
        payload: pay.meta.stage === rid.stageText
      };
      const dataModeOk = pv.indexOf(label) >= 0 && md.indexOf(label) >= 0 && csv.indexOf(label) >= 0
        && doc.indexOf(label) >= 0 && man.dataMode === label && pay.meta.dataMode === label;
      const flags = {
        manStale: man.stale === true, payStale: pay.meta.stale === true,
        manAi: man.aiGenerated === false, payAi: pay.meta.aiGenerated === false,
        manLive: man.liveFetch === false, payLive: pay.meta.liveFetch === false,
        manHistory: Array.isArray(man.history) && man.history.length >= 1,
        payHistory: Array.isArray(pay.archives) && pay.archives.length >= 1,
        confirmedFalse: man.model.confirmed === false,
        reviewedFalse: man.identities.reviewed === false && pay.meta.reviewed === false
      };
      setView('export');
      const expEl = document.querySelector('.view[data-view="export"]');
      const exportText = expEl ? expEl.textContent : '';
      const uiOk = !!expEl && exportText.indexOf(rid.stageText) >= 0 && exportText.indexOf(label) >= 0;
      return {
        pass: Object.keys(stages).every(function(k){ return stages[k]; }) && dataModeOk
          && Object.keys(flags).every(function(k){ return flags[k]; }) && bannedHits.length === 0 && uiOk,
        stage:rid.stageText, stages:stages, dataModeOk:dataModeOk, flags:flags,
        bannedHits:bannedHits, uiOk:uiOk, history:rid.historyCount
      };
    } catch(e){ return { pass:false, err:String(e && e.stack || e) }; }
  })();
  out.cases.P0D_cross_report_status_consistency = p0d;

  /* P0F 新版本复核完成后才恢复“已复核”，且历史归档记录累加、不被覆盖 */
  const p0f = (function(){
    try {
      state.user = { name:'自动测试员', role:'风险审查员' };
      state.companyId = 'yunshu';
      const c = companyById('yunshu');
      if(stageOf(c) !== 'review') return { pass:false, reason:'前置状态不是待复核', stage:stageOf(c) };
      const before = { history:state.archives[c.id].length, reviewed:reportIdentity(c).reviewed };
      setView('evidence');
      state.evId = 'ys-2';
      render();
      const undo = document.querySelector('[data-action="ev-undo"][data-id="ys-2"]');
      if(!undo) return { pass:false, reason:'撤销按钮未找到', before:before };
      undo.click();
      const afterUndo = {
        mark:(state.evals[c.id + ':ys-2'] || null),
        confirmed:c.confirmed, score:c.score, pendingDims:(c.pendingDims || []).slice(), stage:stageOf(c)
      };
      setView('export');
      render();
      const btn = document.querySelector('[data-action="stage-archive"]');
      if(!btn) return { pass:false, reason:'归档按钮未找到', before:before, afterUndo:afterUndo };
      btn.click();
      const rid = reportIdentity(c);
      const after = {
        stage:stageOf(c), reviewed:rid.reviewed, history:rid.historyCount,
        flag:state.reviewFlags[c.id] || null,
        firstSnapshotStill:!!(state.archives[c.id][0] && state.archives[c.id][0].evals['ys-2'] === null)
      };
      return {
        pass: before.history === 1 && before.reviewed === false
          && afterUndo.mark === null && afterUndo.confirmed === true && afterUndo.pendingDims.length === 0
          && after.stage === 'archived' && after.reviewed === true && after.history === 2
          && after.flag === null && after.firstSnapshotStill === true,
        before:before, afterUndo:afterUndo, after:after
      };
    } catch(e){ return { pass:false, err:String(e && e.stack || e) }; }
  })();
  out.cases.P0F_rearchive_after_new_review = p0f;

  /* ===== 本轮：Part 1 回归 ===== */

  /* R1 同一企业多次归档编号唯一，历史快照编号保持稳定 */
  T('R1_archive_numbers_unique_stable', function(){
    const c = companyById('lixin');
    const saved = {
      stage: state.stages[c.id], archives: JSON.parse(JSON.stringify(state.archives[c.id] || [])),
      reviews: state.reviews[c.id] || null
    };
    state.stages[c.id] = 'draft';
    state.archives[c.id] = [];
    const n1 = nextReportNo(c);
    archiveCompany(c, {});
    const a1 = state.archives[c.id][0].reportNo;
    const n2 = nextReportNo(c);
    state.stages[c.id] = 'archived';
    archiveCompany(c, {});
    const a2 = state.archives[c.id][1].reportNo;
    const shown = reportNo(c);
    const histFirst = state.archives[c.id][0].reportNo;
    state.stages[c.id] = 'review';
    const histStill = state.archives[c.id][0].reportNo;
    /* 恢复 */
    state.archives[c.id] = saved.archives;
    state.stages[c.id] = saved.stage;
    if(saved.reviews) state.reviews[c.id] = saved.reviews;
    return {
      pass: n1 === a1 && n2 !== n1 && a2 !== a1 && shown === a2 && histFirst === n1 && histStill === n1,
      n1:n1, n2:n2, a1:a1, a2:a2, shown:shown
    };
  });

  /* R2 实质冲突、时点差异、一般待核分开统计，只有前者阻断 */
  T('R2_conflict_stats_separated', function(){
    const c = companyById('acme');
    const cs = conflictStats(c);
    const row = queueRows();
    const acmeRow = row.split('<tr class="is-click"').filter(function(x){ return x.indexOf('data-id="acme"') >= 0; })[0] || '';
    const blockers = archiveBlockers(c);
    const noBlocking = cs.openBlocking === 0 && blockers.length === 0;
    return {
      pass: cs.total === 4 && cs.openSubstantive === 0 && cs.openTiming === 1 && cs.openPending === 3
        && cs.openBlocking === 0 && cs.openUnknown === 0
        && acmeRow.indexOf('实质冲突') < 0 && acmeRow.indexOf('已标注') >= 0 && noBlocking,
      cs:cs, blockers:blockers, hasBlocking:acmeRow.indexOf('实质冲突') >= 0, hasAnnotated:acmeRow.indexOf('已标注') >= 0
    };
  });

  /* ===== 本轮：Part 5 验收 ===== */

  /* A1 五家模拟企业评分逻辑无回归；公共案例不进入出分排序 */
  T('A1_simulated_scoring_no_regression', function(){
    /* 锚点取自接入公开案例前的基线运行结果，用于发现评分回归。 */
    const expect = {
      yunshu:{suff:0.57, dual:4, score:null, grade:'—', vKey:'pending'},
      hengrui:{suff:0.72, dual:8, score:87, grade:'A', vKey:'pending'},
      mingtai:{suff:0.49, dual:0, score:null, grade:'—', vKey:'pending'},
      zhongke:{suff:0.61, dual:4, score:70, grade:'B', vKey:'pending'},
      lixin:{suff:0.76, dual:8, score:83, grade:'A-', vKey:'high'}
    };
    const sims = COMPANIES.filter(function(c){ return c.dataSource !== 'public'; });
    /* 隔离此前测试留下的证据标记与冲突处置，按干净状态复算基线锚点。 */
    const savedEvals = state.evals, savedDecisions = state.decisions;
    state.evals = {};
    state.decisions = {};
    sims.forEach(function(c){ computeCompanyModel(c, null, reviewState(c)); });
    const rows = sims.map(function(c){
      const m = MODELS[c.id];
      const calc = calcSignalsModel(m.sig, m.arch);
      const e = expect[c.id] || {};
      return {id:c.id, rawEq:calc.raw === c.rawScore, dimsEq:calc.dims.every(function(d,i){ return d.score === c.dims[i].score; }),
        suffEq:c.suff === e.suff, dualEq:c.model.dual === e.dual, scoreEq:c.score === e.score,
        gradeEq:c.grade === e.grade, vKeyEq:c.vKey === e.vKey};
    });
    const pub = companyById('acme');
    const result = {
      pass: sims.length === 5 && rows.every(function(r){ return r.rawEq && r.dimsEq && r.suffEq && r.dualEq && r.scoreEq && r.gradeEq && r.vKeyEq; })
        && pub.score === null && pub.grade === '—'
        && COMPANIES.filter(function(c){ return c.dataSource === 'public'; }).length === 1,
      rows:rows, publicScore:pub.score, publicGrade:pub.grade
    };
    state.evals = savedEvals;
    state.decisions = savedDecisions;
    sims.forEach(function(c){ computeCompanyModel(c, null, reviewState(c)); });
    return result;
  });

  /* A3 真实企业至少 6 条证据可追溯，且每条判断能关联证据 */
  T('A3_public_case_traceable_evidence', function(){
    const c = companyById('acme');
    const traceable = c.evidences.filter(function(e){ return !!e.url && !!(e.summary || e.quote || '').trim(); });
    const linked = (c.judgementRows || []).filter(function(j){ return j.linked.length > 0; });
    const urlsOk = c.evidences.every(function(e){ return !e.url || /^https?:\/\//.test(e.url); });
    const honestQuotes = c.evidences.every(function(e){ return e.origin === 'ai' || e.quote == null; });
    return {
      pass: traceable.length >= 6 && linked.length >= 5 && urlsOk && honestQuotes && c.model.traceable === c.evidences.filter(function(e){ return /^https?:\/\//.test(e.url || ''); }).length,
      traceable:traceable.length, total:c.evidences.length, linkedJudgements:linked.length, urlsOk:urlsOk, honestQuotes:honestQuotes
    };
  });

  /* A4 真实案例没有编造财务、贷款余额和综合评分 */
  /* A4 公开案例：技术分只能来自规则；无财务数据时不得虚构财务或授信结论 */
  T('A4_public_case_no_fabricated_finance', function(){
    const c = companyById('acme');
    state.companyId = c.id;
    const report = publicPreviewHtml(c) + publicMdDoc(c) + publicDocDoc(c) + publicCsvDoc(c);
    const fabricatedScore = /模型参考分\s*\d+\s*分/.test(report);
    const fabricatedMoney = /(营业收入|净利润|贷款余额|授信额度)\s*[:：]?\s*[\d,，.]+\s*(万元|亿元|元)/.test(report);
    const scoreLine = report.indexOf('技术价值评价') >= 0 && report.indexOf('证据充分度') >= 0;
    const ruleTraced = report.indexOf(RESEARCH_SCORE_RULE.version) >= 0;
    const gateExplained = report.indexOf('不是技术得分及格线') >= 0 || report.indexOf('不是技术分及格线') >= 0 || report.indexOf('门槛只约束证据是否足够出分') >= 0;
    return {
      pass: c.score === null && c.grade === '—' && c.rawScore === null && c.range === null
        && !fabricatedScore && !fabricatedMoney && scoreLine && ruleTraced && gateExplained,
      score:c.score, grade:c.grade, rawScore:c.rawScore, range:c.range,
      fabricatedScore:fabricatedScore, fabricatedMoney:fabricatedMoney,
      scoreLine:scoreLine, ruleTraced:ruleTraced, gateExplained:gateExplained
    };
  });

  /* A6 AI 输出保留来源片段；未匹配片段不得通过校验 */
  T('A6_ai_snippet_verification', function(){
    const text = '中科艾科米（北京）科技有限公司中标低温超高真空扫描隧道显微镜系统，中标价格 5296600.00 元。';
    const data = {
      technologies:[{name:'低温 SPM', snippet:'低温超高真空扫描隧道显微镜系统'}],
      patents:[{number:'', title:'', snippet:'这一句在原文中不存在'}],
      products:[], researchResults:[], quantities:[], facts:[{statement:'中标', support:'strong', snippet:'中标价格 5296600.00 元'}]
    };
    const v = aiVerifySnippets(data, text);
    return {
      pass: v.total === 3 && v.verified === 2
        && data.technologies[0]._snippetVerified === true
        && data.patents[0]._snippetVerified === false
        && data.facts[0]._snippetVerified === true,
      verify:v
    };
  });

  /* A7 人工修改证据标记后，关联判断状态同步变化 */
  T('A7_evidence_mark_updates_judgement', function(){
    const c = companyById('acme');
    const id = 'CL-REAL-01';
    const j = (c.judgements || []).filter(function(x){ return x.id === id; })[0];
    const keys = j.evidenceIds.map(function(eid){ return c.id + ':' + eid; });
    const saved = {};
    keys.forEach(function(k){ saved[k] = state.evals[k] ? JSON.parse(JSON.stringify(state.evals[k])) : null; });
    keys.forEach(function(k){ state.evals[k] = {mark:'采信', by:'自动测试员', at:'2026-11-21', note:''}; });
    computeCompanyModel(c, null, reviewState(c));
    const confirmed = c.judgementRows.filter(function(x){ return x.id === id; })[0];
    state.evals[keys[0]] = {mark:'存疑', by:'自动测试员', at:'2026-11-21', note:'片段需回原文核对'};
    computeCompanyModel(c, null, reviewState(c));
    const review = c.judgementRows.filter(function(x){ return x.id === id; })[0];
    /* 恢复 */
    keys.forEach(function(k){ if(saved[k]) state.evals[k] = saved[k]; else delete state.evals[k]; });
    computeCompanyModel(c, null, reviewState(c));
    return {
      pass: confirmed.status === 'confirmed' && confirmed.statusText === '已采信'
        && review.status === 'review' && review.statusText === '需复核',
      confirmed:confirmed.statusText, review:review.statusText
    };
  });

  /* A8 导出报告区分模拟数据、公开证据与 AI 分析内容 */
  T('A8_export_distinguishes_sources', function(){
    const pub = companyById('acme');
    state.companyId = pub.id;
    const before = pub.evidences.length;
    const aiEv = ev({
      id:'ai-test-a8', grade:'C', dim:'技术', source:'中国政府采购网·中标公告',
      url:'https://www.ccgp.gov.cn/example.htm', date:'2026-07-15', retrievedAt:'2026-11-21 10:00',
      title:'南京大学低温 SPM 系统中标', quote:'中标单位：中科艾科米（北京）科技有限公司',
      quoteNote:'测试用 AI 片段', fields:[], supports:[], caveat:'AI 抽取，需人工核对',
      impact:'待核实', invalid:['页面下线'], conflict:false, trace:'direct', origin:'ai'
    });
    pub.evidences.push(aiEv);
    computeCompanyModel(pub, null, reviewState(pub));
    const pubReport = publicPreviewHtml(pub);
    const pubMd = publicMdDoc(pub);
    const pubCsv = publicCsvDoc(pub);
    const hasAiLabel = pubReport.indexOf('AI 解析记录') >= 0 && pubReport.indexOf('AI 抽取结果') >= 0 && pubCsv.indexOf('是否AI抽取') >= 0;
    /* 移除测试证据 */
    pub.evidences = pub.evidences.filter(function(e){ return e.id !== 'ai-test-a8'; });
    computeCompanyModel(pub, null, reviewState(pub));
    state.companyId = 'lixin';
    const simMd = mdDoc();
    return {
      pass: hasAiLabel && pubMd.indexOf('公开资料') >= 0 && pubReport.indexOf('公开资料') >= 0
        && simMd.indexOf('模拟演示') >= 0 && simMd.indexOf('公开资料模式') < 0 && before === pub.evidences.length,
      hasAiLabel:hasAiLabel, publicLabel:pubReport.indexOf('公开资料') >= 0, simulatedLabel:simMd.indexOf('模拟演示') >= 0
    };
  });

  /* A5 未预置的新文本：调用失败时必须明确失败，且不展示预置结果。
     真实模型调用记录见 reports/ai_live_call.md；本机无密钥时按失败路径验收。 */
  await (async function(){
    try {
      state.user = { name:'自动测试员', role:'风险审查员' };
      state.companyId = 'acme';
      setView('ai');
      const a = aiStore();
      const saved = JSON.parse(JSON.stringify({ai:state.ai, runs:state.aiRuns}));
      const oldFetch = window.fetch;
      document.getElementById('ai-source-name').value = '测试来源·未预置文本';
      document.getElementById('ai-url').value = 'https://example.com/brand-new-notice';
      document.getElementById('ai-date').value = '2026-11-20';
      document.getElementById('ai-text').value = '这是一段从未预置过解析结果的公开资料测试文本。它只用于验证：当服务端没有配置模型或模型调用失败时，页面必须明确显示失败，而不能展示任何预先写好的分析结论。文本长度需要超过八十个字符，以便通过前端的最短长度校验。';
      window.fetch = function(url){
        /* 服务发现要求当前版本健康信息；解析接口本身返回 503，验证显式失败路径 */
        if(String(url).indexOf('/api/health') >= 0){
          return Promise.resolve({
            ok:true, status:200,
            json:function(){ return Promise.resolve({ok:true, service:'prooftrace-ai-proxy', version:'4.3', configured:true, model:'qwen-plus', agent:{version:'1.3'}}); }
          });
        }
        return Promise.resolve({
          ok:false, status:503,
          text:function(){ return Promise.resolve(JSON.stringify({ok:false,error:{message:'服务端未配置模型（测试桩）'}})); }
        });
      };
      aiRun();
      await new Promise(function(r){ setTimeout(r, 250); });
      const st = aiStore();
      const html = aiHtml();
      const pass = st.status === 'error' && /解析失败/.test(html) && /服务端未配置模型/.test(html)
        && !/解析结果（人工复核）/.test(html) && (!st.result);
      window.fetch = oldFetch;
      state.ai = saved.ai;
      state.aiRuns = saved.runs;
      aiPersist();
      out.cases.A5_ai_failure_explicit = { pass:pass, status:st.status, error:st.error, hasPresetResult:!!st.result };
    } catch(e){
      out.cases.A5_ai_failure_explicit = { pass:false, err:String(e && e.stack || e) };
    }
  })();

  /* ===== P0/P1 新增回归 ===== */

  /* P0-1/P0-2/P0-4 金额单位、比较词、陈述核对在页面上的呈现 */
  T('P01_amount_unit_operator_statement_review', function(){
    const saved = {ai:state.ai, companyId:state.companyId};
    state.companyId = 'acme';
    state.ai = Object.assign({}, aiStore(), {
      status:'ok',
      result:{
        companyId:'acme', companyName:'中科艾科米（北京）科技有限公司', inputTextType:'user_paraphrase',
        model:'test', createdAt:'2026-11-21', elapsedMs:1,
        source:{name:'测试公告', url:'https://example.com/a', date:'2026-11-21'},
        verify:{total:3, verified:3},
        data:{
          organization:{name:'中科艾科米（北京）科技有限公司', type:'企业'},
          subjectMatch:{candidate:'中科艾科米（北京）科技有限公司', matched:true, basis:'测试', snippet:'中科艾科米', targetRole:'supplier'},
          events:[{type:'award', date:'2026-11-02', counterparty:'某研究所', amountRaw:'459.5万元', amountValue:459.5, amountUnit:'万元', currency:'CNY', subjectRole:'supplier', snippet:'中标金额为459.5万元'}],
          quantities:[{label:'温度', operator:'<', value:3, unit:'K', snippet:'温度低于3 K'}],
          facts:[{statement:'某研究所发布中标公告', support:'medium', snippet:'中国政府采购网刊载中标结果', _snippetVerified:true,
            _statementCheck:aiCheckFactStatement('某研究所发布中标公告','中国政府采购网刊载中标结果')}],
          entities:[], technologies:[], patents:[], products:[], researchResults:[], pendingVerification:[], warnings:[]
        }
      }
    });
    const html = aiResultHtml();
    const pass = html.indexOf('459.5万元') >= 0 && html.indexOf('459.5 CNY') < 0
      && html.indexOf('&lt; 3 K') >= 0 && html.indexOf('待人工核对') >= 0
      && html.indexOf('主体动作或角色未在片段中出现') >= 0
      && html.indexOf('人工改写或摘要（非原文）') >= 0;
    state.ai = saved.ai; state.companyId = saved.companyId;
    return {pass:pass, hasRaw:html.indexOf('459.5万元') >= 0, hasCny:html.indexOf('459.5 CNY') >= 0,
      hasOperator:html.indexOf('&lt; 3 K') >= 0, hasReview:html.indexOf('待人工核对') >= 0};
  });

  /* P0-3 跨企业导入必须拒绝，且不得改动当前企业证据 */
  T('P03_cross_company_import_rejected', function(){
    const acme = companyById('acme'), yunshu = companyById('yunshu');
    const saved = {ai:state.ai, runs:state.aiRuns, companyId:state.companyId};
    const yBefore = yunshu.evidences.length, aBefore = acme.evidences.length;
    state.companyId = 'yunshu';
    state.ai = Object.assign({}, aiStore(), {
      status:'ok', url:'https://example.com/acme-only',
      result:{runId:'AI-CROSSTEST', companyId:'acme', companyName:acme.name, inputTextType:'unknown',
        request:{companyId:'acme', companyName:acme.name, sourceName:'acme公告', sourceUrl:'https://example.com/acme-only', publishDate:'2026-11-21', inputTextType:'unknown'},
        data:{facts:[{statement:'跨企业测试事实', snippet:'跨企业测试片段', _snippetVerified:true, _statementCheck:{flags:[],labels:[]}}]}}
    });
    state.aiRuns = [];
    const host = document.createElement('div');
    host.id = 'pt-test-import-host';
    host.innerHTML = '<input type="checkbox" data-ai-pick="0" checked>';
    document.body.appendChild(host);
    aiImport();
    const yAfter = yunshu.evidences.length, aAfter = acme.evidences.length;
    host.remove();
    state.ai = saved.ai; state.aiRuns = saved.runs; state.companyId = saved.companyId;
    return {pass:yAfter === yBefore && aAfter === aBefore, yunshu:[yBefore,yAfter], acme:[aBefore,aAfter]};
  });

  /* P1-1 11 条证据对应 10 个来源；同网址不同片段不重复计来源 */
  T('P11_source_count_dedup', function(){
    const acme = companyById('acme');
    const real = companySourceStats(acme);
    const synthetic = companySourceStats({evidences:[
      {url:'https://example.com/a'},
      {url:'https://example.com/a#frag'},
      {url:'https://example.com/b?utm_source=x'}
    ]});
    return {pass:real.facts === 11 && real.sources === 10 && synthetic.facts === 3 && synthetic.sources === 2,
      real:real, synthetic:synthetic};
  });

  /* P0-5 导入使用请求快照，不随当前表单变化；文本类型与来源网址如实标注 */
  T('P05_import_uses_request_snapshot', function(){
    const c = companyById('acme');
    const saved = {ai:state.ai, runs:state.aiRuns, companyId:state.companyId, ev:JSON.parse(JSON.stringify(c.evidences)), archives:state.archives};
    const url = 'https://example.com/pt-test-snapshot-20261121';
    state.companyId = 'acme';
    state.archives = state.archives || {};
    state.ai = Object.assign({}, aiStore(), {
      status:'ok', url:'https://example.com/CHANGED-AFTER-RUN',
      result:{runId:'AI-SNAPTEST', companyId:'acme', companyName:c.name, inputTextType:'user_paraphrase',
        request:{companyId:'acme', companyName:c.name, sourceName:'快照来源', sourceUrl:url, publishDate:'2026-11-21', inputTextType:'user_paraphrase'},
        model:'test', createdAt:'2026-11-21',
        data:{facts:[{statement:'快照绑定测试事实', snippet:'快照绑定测试片段', _snippetVerified:true, _statementCheck:{flags:[],labels:[]}}]}}
    });
    state.aiRuns = [{id:'AI-SNAPTEST', companyId:'acme', status:'ok', evidence:[], imported:false}];
    const host = document.createElement('div');
    host.id = 'pt-test-snapshot-host';
    host.innerHTML = '<input type="checkbox" data-ai-pick="0" checked>';
    document.body.appendChild(host);
    aiImport();
    const e = c.evidences.filter(function(x){ return x.quote === '快照绑定测试片段'; })[0];
    host.remove();
    const pass = !!e && e.url === url && e.inputTextType === 'user_paraphrase'
      && e.snippetType === 'user_paraphrase'
      && /未从来源网址抓取/.test(e.quoteNote || '')
      && e.sourceDocumentId === aiSourceDocumentId(url);
    /* 恢复 */
    c.evidences = saved.ev.map(function(x){ return ev(x); });
    computeCompanyModel(c, null, reviewState(c));
    state.ai = saved.ai; state.aiRuns = saved.runs; state.companyId = saved.companyId; state.archives = saved.archives;
    return {pass:pass, url:e && e.url, snippetType:e && e.snippetType, inputTextType:e && e.inputTextType};
  });

  /* P4-1 金额一致性：数值冲突、非人民币不折算，在页面上明确标注 */
  T('P4_amount_consistency_ui', function(){
    const saved = {ai:state.ai, companyId:state.companyId};
    state.companyId = 'acme';
    state.ai = Object.assign({}, aiStore(), {
      status:'ok',
      result:{
        companyId:'acme', companyName:'中科艾科米（北京）科技有限公司', inputTextType:'source_verbatim',
        model:'test', createdAt:'2026-11-21', elapsedMs:1,
        source:{name:'测试公告', url:'https://example.com/amount', date:'2026-11-21'},
        verify:{total:2, verified:2},
        data:{organization:{}, subjectMatch:{}, entities:[], technologies:[], patents:[], products:[], researchResults:[],
          quantities:[{label:'温度', operator:'', value:3, unit:'K', snippet:'温度为3 K',
            _operatorCheck:{flags:['operator_missing'], labels:['未提供比较词，按精确值处理，需人工确认']}}],
          facts:[], pendingVerification:[], warnings:[],
          events:[
            {type:'award', date:'2026-11-02', amountRaw:'100万美元', amountValue:100, amountUnit:'万美元', currency:'USD', subjectRole:'supplier', snippet:'合同金额为100万美元',
              _amountCheck:{flags:['amount_currency_mismatch','amount_currency_not_cny'], labels:['金额原文币种与结构化币种不一致','非人民币金额，不折算为人民币'], currency:'USD', currencyKnown:true, computedCny:null}},
            {type:'award', date:'2026-11-03', amountRaw:'459.5万元', amountValue:495.5, amountUnit:'万元', currency:'CNY', amountCny:4595000, subjectRole:'supplier', snippet:'中标金额为459.5万元',
              _amountCheck:{flags:['amount_raw_value_mismatch','amount_cny_recomputed'], labels:['金额原文数值与结构化数值不一致','模型人民币换算与程序计算不一致，已按程序重算'], currency:'CNY', currencyKnown:true, computedCny:4595000}}
          ]}
      }
    });
    const html = aiResultHtml();
    const pass = html.indexOf('金额待人工核对') >= 0
      && html.indexOf('非人民币金额，不折算') >= 0
      && html.indexOf('折算人民币 4595000 元（程序计算）') >= 0
      && html.indexOf('金额原文数值与结构化数值不一致') >= 0
      && html.indexOf('比较词待核对') >= 0
      && !/100万美元[\s\S]{0,120}折算人民币/.test(html);
    state.ai = saved.ai; state.companyId = saved.companyId;
    return {pass:pass, hasUsdLabel:html.indexOf('非人民币金额，不折算') >= 0,
      hasMismatch:html.indexOf('金额原文数值与结构化数值不一致') >= 0,
      hasOperatorLabel:html.indexOf('比较词待核对') >= 0};
  });

  /* P4-2 技术价值分析草稿：六段结构、证据编号、待复核标签；证据状态变化后标记需要更新 */
  T('P4_analysis_draft_and_stale', function(){
    const c = companyById('acme');
    const saved = {analysis:JSON.parse(JSON.stringify(state.aiAnalysis || {})), evals:JSON.parse(JSON.stringify(state.evals || {}))};
    state.evals = state.evals || {};
    state.evals['acme:EV-001'] = {mark:'采信', by:'自动测试员', at:'2026-11-21'};
    const sig = analysisSignature(c);
    state.aiAnalysis = state.aiAnalysis || {};
    state.aiAnalysis.acme = {
      status:'ok', model:'qwen-plus', createdAt:'2026-11-21 16:00', elapsedMs:1234,
      signature:sig, stats:{inputEvidence:c.evidences.length, citedEvidence:2, items:2, droppedItems:0, invalidEvidenceIds:[]},
      draft:{
        sections:[
          {key:'technicalCapability', title:'技术能力与技术路线', items:[
            {claim:'企业具备公开可查的薄膜沉积工艺积累', evidenceIds:['EV-001'], evidenceStatus:'confirmed', confidence:'medium', note:'', reviewRequired:true}
          ]},
          {key:'technologyAssets', title:'技术资产与权属', items:[]},
          {key:'rdAdvancement', title:'研发及技术先进性线索', items:[
            {claim:'公开资料提及企业参与某项研发项目', evidenceIds:['EV-002'], evidenceStatus:'pending', confidence:'low', note:'仅作调查线索，不得作为已确认事实。', reviewRequired:true}
          ]},
          {key:'commercialization', title:'成果转化与商业化线索', items:[]},
          {key:'whyWatch', title:'值得进一步关注的原因', items:[]},
          {key:'gapsAndNextSteps', title:'证据不足与下一步尽调问题', items:[]}
        ],
        nextSteps:[{question:'补充核心专利清单及权属变更记录', evidenceIds:['EV-002'], reviewRequired:true}],
        warnings:[],
        stats:{inputEvidence:c.evidences.length, citedEvidence:2, items:2, droppedItems:0, invalidEvidenceIds:[]}
      }
    };
    const html = analysisDraftHtml(c);
    const baseOk = ['技术能力与技术路线','技术资产与权属','研发及技术先进性线索','成果转化与商业化线索','值得进一步关注的原因','证据不足与下一步尽调问题']
      .every(function(t){ return html.indexOf(t) >= 0; })
      && html.indexOf('EV-001') >= 0 && html.indexOf('依据：已采信证据') >= 0
      && html.indexOf('依据待核实 · 仅作线索') >= 0
      && html.indexOf('仅作调查线索') >= 0
      && html.indexOf('AI 草稿 · 待人工复核') >= 0
      && html.indexOf('本草稿需要更新') < 0;
    state.evals['acme:EV-001'] = {mark:'存疑', by:'自动测试员', at:'2026-11-21'};
    const staleHtml = analysisDraftHtml(c);
    const staleOk = staleHtml.indexOf('本草稿需要更新') >= 0;
    if(saved.analysis && Object.keys(saved.analysis).length) state.aiAnalysis = saved.analysis; else delete state.aiAnalysis;
    state.evals = saved.evals;
    return {pass:baseOk && staleOk, sections:baseOk, stale:staleOk};
  });

  /* P4-3 分析生成失败：必须显示失败，不使用预置草稿 */
  await (async function(){
    try {
      state.user = { name:'自动测试员', role:'风险审查员' };
      state.companyId = 'acme';
      setView('profile');
      const savedAnalysis = JSON.parse(JSON.stringify(state.aiAnalysis || {}));
      const oldFetch = window.fetch;
      window.fetch = function(){
        return Promise.resolve({
          ok:false, status:503,
          text:function(){ return Promise.resolve(JSON.stringify({ok:false,error:{message:'服务端未配置模型（测试桩）'}})); }
        });
      };
      aiAnalyze();
      await new Promise(function(r){ setTimeout(r, 250); });
      const rec = analysisRecord(companyById('acme'));
      const html = analysisDraftHtml(companyById('acme'));
      const pass = rec && rec.status === 'error' && /服务端未配置模型/.test(html)
        && html.indexOf('技术能力与技术路线') < 0;
      window.fetch = oldFetch;
      state.aiAnalysis = savedAnalysis;
      analysisPersist();
      out.cases.P4_analysis_failure_explicit = { pass:pass, status:rec && rec.status, error:rec && rec.error };
    } catch(e){
      out.cases.P4_analysis_failure_explicit = { pass:false, err:String(e && e.stack || e) };
    }
  })();

  /* P4.1-1 错误分类：Failed to fetch、鉴权、限流、超时、结构异常、未知错误 */
  T('P41_error_mapping', function(){
    const cases = [
      [aiExplainError({message:'Failed to fetch'}), '本地服务未启动或无法访问'],
      [aiExplainError({code:'upstream_auth', status:401, message:'401 invalid api key'}), 'API 鉴权失败'],
      [aiExplainError({code:'upstream_rate_limit', status:429, message:'429 rate limit'}), '触发模型限流'],
      [aiExplainError({message:'模型调用超时（90000ms）'}), '模型调用超时'],
      [aiExplainError({code:'invalid_response', message:'JSON parse error'}), '模型返回结构异常'],
      [aiExplainError({message:'some strange socket failure'}), '未知网络错误']
    ];
    const ok = cases.every(function(x){ return x[0].title === x[1] && x[0].detail && x[0].raw; });
    const rawKept = aiExplainError({message:'Failed to fetch'}).raw === 'Failed to fetch';
    return { pass:ok && rawKept, titles:cases.map(function(x){ return x[0].title; }), rawKept:rawKept };
  });

  /* P4.1-2 五种连接状态文案与测试连接入口 */
  T('P41_conn_status_labels', function(){
    const saved = {ai:state.ai, companyId:state.companyId};
    state.companyId = 'acme';
    state.ai = Object.assign({}, aiStore(), {status:'idle', result:null, runAt:'', connStatus:'unknown', connAt:'', connNote:'', connModel:''});
    const unknown = aiConnPill();
    state.ai.connStatus = 'offline';
    const offline = aiConnPill();
    state.ai.connStatus = 'unconfigured';
    const unconfigured = aiConnPill();
    state.ai.connStatus = 'ready';
    const ready = aiConnPill();
    const readyHtml = aiConnHtml(false);
    state.ai.connStatus = 'ready'; state.ai.status = 'ok'; state.ai.result = {data:{}}; state.ai.runAt = '2026-11-21 16:00:00';
    const success = aiConnPill();
    state.ai.status = 'error'; state.ai.error = '模型调用失败';
    const error = aiConnPill();
    const pass = unknown.indexOf('尚未检查') >= 0 && offline.indexOf('本地服务未启动') >= 0
      && unconfigured.indexOf('服务已启动，模型未配置') >= 0
      && ready.indexOf('模型已配置，尚未实际调用') >= 0
      && success.indexOf('模型最近一次调用成功') >= 0
      && error.indexOf('模型调用失败') >= 0
      && readyHtml.indexOf('data-action="ai-test-conn"') >= 0;
    state.ai = saved.ai; state.companyId = saved.companyId;
    return {pass:pass, states:{unknown:unknown, offline:offline, unconfigured:unconfigured, ready:ready, success:success, error:error}};
  });

  /* P4.1-3 测试连接实际调用 /api/health 的三种结果 */
  await (async function(){
    const saved = {ai:state.ai, companyId:state.companyId};
    const oldFetch = window.fetch;
    const body = function(obj){ return Promise.resolve({ok:true, status:200,
      json:function(){ return Promise.resolve(obj); },
      text:function(){ return Promise.resolve(JSON.stringify(obj)); }}); };
    try {
      state.companyId = 'acme';
      state.ai = Object.assign({}, aiStore(), {connStatus:'unknown', connAt:'', connNote:'', connModel:'', status:'idle', result:null, runAt:''});
      window.fetch = function(){ return body({ok:true, service:'prooftrace-ai-proxy', version:'4.3', agent:{version:'1.3'}, configured:true, model:'qwen-plus', note:'已配置'}); };
      aiTestConnection();
      await new Promise(function(r){ setTimeout(r, 80); });
      const ready = aiStore().connStatus;
      window.fetch = function(){ return body({ok:true, service:'prooftrace-ai-proxy', version:'4.3', agent:{version:'1.3'}, configured:false, model:null, note:'缺少 AI_API_KEY'}); };
      aiTestConnection();
      await new Promise(function(r){ setTimeout(r, 80); });
      const unconfigured = aiStore().connStatus;
      window.fetch = function(){ return Promise.reject(new TypeError('Failed to fetch')); };
      aiTestConnection();
      await new Promise(function(r){ setTimeout(r, 80); });
      const offline = aiStore().connStatus;
      const note = aiStore().connNote;
      out.cases.P41_conn_health_states = { pass:ready === 'ready' && unconfigured === 'unconfigured' && offline === 'offline' && /无法连接|未找到当前版本服务/.test(note),
        ready:ready, unconfigured:unconfigured, offline:offline, note:note };
    } catch(e){
      out.cases.P41_conn_health_states = { pass:false, err:String(e && e.stack || e) };
    } finally {
      window.fetch = oldFetch;
      state.ai = saved.ai; state.companyId = saved.companyId;
    }
  })();

  /* P4.1-4 草稿导出：六段结构、证据编号、待复核状态，且不输出评分/授信结论 */
  T('P41_analysis_export_md', function(){
    const c = companyById('acme');
    const rec = {
      status:'ok', model:'qwen-plus', createdAt:'2026-11-21 16:00', elapsedMs:1200,
      stats:{inputEvidence:c.evidences.length, citedEvidence:2, items:2, droppedItems:0, invalidEvidenceIds:['ZZZ-999']},
      draft:{
        sections:[
          {title:'技术能力与技术路线', items:[{claim:'企业具备公开可查的工艺积累', evidenceIds:['EV-001','EV-002'], evidenceStatus:'confirmed', evidenceStatusText:'已采信', confidence:'medium', note:''}]},
          {title:'技术资产与权属', items:[]},
          {title:'研发及技术先进性线索', items:[{claim:'公开资料提及研发项目', evidenceIds:['EV-002'], evidenceStatus:'pending', evidenceStatusText:'待核实', confidence:'low', note:'仅作调查线索，不得作为已确认事实。'}]},
          {title:'成果转化与商业化线索', items:[]},
          {title:'值得进一步关注的原因', items:[]},
          {title:'证据不足与下一步尽调问题', items:[]}
        ],
        nextSteps:[{question:'补充核心专利清单', evidenceIds:['EV-002']}],
        warnings:[],
        stats:{inputEvidence:c.evidences.length, citedEvidence:2, items:2, droppedItems:0, invalidEvidenceIds:['ZZZ-999']}
      }
    };
    const md = analysisExportMd(c, rec);
    const six = ['技术能力与技术路线','技术资产与权属','研发及技术先进性线索','成果转化与商业化线索','值得进一步关注的原因','证据不足与下一步尽调问题'];
    const pass = six.every(function(t){ return md.indexOf('## ' + t) >= 0; })
      && md.indexOf('EV-001') >= 0 && md.indexOf('EV-002') >= 0
      && md.indexOf('待人工复核') >= 0 && md.indexOf('仅作调查线索') >= 0
      && md.indexOf('ZZZ-999') >= 0
      && md.indexOf('综合评分：') < 0 && md.indexOf('综合评分:') < 0
      && md.indexOf('授信额度：') < 0 && md.indexOf('授信额度:') < 0
      && md.indexOf('内容由AI大模型生成') >= 0;
    return {pass:pass, length:md.length, hasSix:six.every(function(t){ return md.indexOf('## ' + t) >= 0; })};
  });

  /* P4.1-5 页面入口：AI 页与分析面板都有测试连接，草稿有导出入口 */
  T('P41_entry_points', function(){
    const saved = {companyId:state.companyId, analysis:JSON.parse(JSON.stringify(state.aiAnalysis || {}))};
    state.companyId = 'acme';
    const aiPage = aiHtml();
    const c = companyById('acme');
    state.aiAnalysis = state.aiAnalysis || {};
    state.aiAnalysis.acme = {status:'ok', model:'test', createdAt:'2026-11-21', elapsedMs:1, signature:analysisSignature(c),
      stats:{inputEvidence:c.evidences.length, citedEvidence:1, items:1, droppedItems:0, invalidEvidenceIds:[]},
      draft:{sections:[{title:'技术能力与技术路线', items:[{claim:'测试判断', evidenceIds:['EV-001'], evidenceStatus:'pending', evidenceStatusText:'待核实', confidence:'low'}]}], nextSteps:[], warnings:[], stats:{}}};
    const profilePage = analysisDraftHtml(c);
    state.companyId = saved.companyId;
    if(Object.keys(saved.analysis).length) state.aiAnalysis = saved.analysis; else delete state.aiAnalysis;
    const pass = aiPage.indexOf('data-action="ai-test-conn"') >= 0
      && profilePage.indexOf('data-action="ai-test-conn"') >= 0
      && profilePage.indexOf('data-action="ai-analysis-export"') >= 0;
    return {pass:pass, aiTest:aiPage.indexOf('ai-test-conn') >= 0, profileTest:profilePage.indexOf('ai-test-conn') >= 0, exportBtn:profilePage.indexOf('ai-analysis-export') >= 0};
  });

  /* ===== 第二轮：真实企业研究内核 ===== */
  function p2Company(name){
    return createResearchCompany({name:name, industry:'精密仪器', segment:'测试细分', city:'北京市', region:'北京', summary:'自动化验收用测试卷宗，仅用于验证程序行为。'});
  }
  function p2Cleanup(c){
    if(!c) return;
    const i = COMPANIES.findIndex(function(x){ return x.id === c.id; });
    if(i >= 0) COMPANIES.splice(i, 1);
    if(state.researchCompanies) delete state.researchCompanies[c.id];
    writeStore(STORE_RESEARCH, state.researchCompanies || {});
    if(state.aiClaims) delete state.aiClaims[c.id];
    writeStore(STORE_AICLAIMS, state.aiClaims || {});
    if(state.aiAnalysis) delete state.aiAnalysis[c.id];
    analysisPersist();
    if(state.devStage) delete state.devStage[c.id];
    writeStore(STORE_DEVSTAGE, state.devStage || {});
    if(state.archives) delete state.archives[c.id];
    if(state.stages) delete state.stages[c.id];
    if(state.reviews) delete state.reviews[c.id];
    ['evals','decisions'].forEach(function(k){
      if(state[k]) Object.keys(state[k]).forEach(function(key){ if(key.indexOf(c.id + ':') === 0) delete state[k][key]; });
    });
    if(state.companyId === c.id) state.companyId = 'acme';
  }
  function p2ImportHost(picks, metrics){
    const host = document.createElement('div');
    host.id = 'pt-p2-import-host';
    host.innerHTML = picks.map(function(i){
      return '<input type="checkbox" data-ai-pick="' + i + '" checked>';
    }).join('') + picks.map(function(i, idx){
      return '<select data-ai-metric="' + i + '"><option value="' + metrics[idx] + '" selected>' + metrics[idx] + '</option></select>';
    }).join('');
    document.body.appendChild(host);
    return host;
  }
  function p2AiResult(c, facts, picks, metrics, runId){
    state.aiRuns = (state.aiRuns || []).filter(function(r){ return r.id !== runId; });
    state.aiRuns.push({id:runId, companyId:c.id, status:'ok', createdAt:'2026-11-21 09:00'});
    state.ai = Object.assign({}, aiStore(), {
      status:'ok', url:'https://example.com/p2-source',
      result:{
        runId:runId, companyId:c.id, companyName:c.name, model:'acceptance-test',
        inputTextType:'source_verbatim',
        request:{companyId:c.id, companyName:c.name, sourceName:'验收测试公告', sourceUrl:'https://example.com/p2-source',
          publishDate:'2026-11-20', inputTextType:'source_verbatim'},
        data:{facts:facts}
      }
    });
    return p2ImportHost(picks || facts.map(function(_, i){ return i; }), metrics || facts.map(function(){ return 'other'; }));
  }

  /* P2-1 新建真实企业：字段缺失保持 null，与合成样本隔离，不给分也不产生负面判断 */
  T('P2_01_real_company_create_isolation', function(){
    const c = p2Company('验收测试甲科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    const r = {
      dataSource:c.dataSource, custom:!!c.custom, code:c.code, staff:c.staff, owner:c.owner,
      score:c.score, grade:c.grade, publicModel:!!(c.model && c.model.public),
      isResearch:isResearchCase(c), isSimulated:isSimulatedCase(c),
      verdict:c.verdict, tone:c.tone
    };
    r.report = publicPreviewHtml(c) + publicMdDoc(c) + publicProfileHtml(c);
    const pass = c.dataSource === 'real' && c.custom === true && c.code === null && c.staff === null && c.owner === null
      && c.score === null && c.grade === '—' && c.model.public === true
      && isResearchCase(c) === true && isSimulatedCase(c) === false
      && r.verdict.indexOf('暂不输出技术评分') >= 0 && c.judgementRows.length === 0
      && c.techEvaluation.known === 0 && c.techEvaluation.total === 5
      && c.model.formalScore === null && c.model.acceptedScore === null
      && r.report.indexOf('技术价值评价') >= 0 && r.report.indexOf('模拟演示') < 0
      && r.report.indexOf(RESEARCH_SCORE_RULE.version) >= 0
      && !/负面|高风险|拒绝准入|虚假宣传/.test(r.verdict);
    p2Cleanup(c);
    return {pass:pass, detail:r};
  });

  /* P2-2 AI 事实导入：按指标分类，保留真实证据 ID，生成候选判断而非直接采信 */
  T('P2_02_ai_import_metric_and_candidate', function(){
    const c = p2Company('验收测试乙科技有限公司');
    const saved = {companyId:state.companyId, ai:state.ai, runs:state.aiRuns};
    state.companyId = c.id;
    const facts = [
      {statement:'该公司获得发明专利授权 3 项。', support:'strong', snippet:'发明专利授权 3 项', _snippetVerified:true, _statementCheck:{flags:[],labels:[]}},
      {statement:'其中标金额为 120 万元。', support:'medium', snippet:'中标金额为 120 万元', _snippetVerified:true, _statementCheck:{flags:[],labels:[]}}
    ];
    const host = p2AiResult(c, facts, [0, 1], ['patent', 'adoption'], 'AI-P2-CLASSIFY');
    aiImport();
    host.remove();
    const byId = {};
    c.evidences.forEach(function(e){ byId[e.id] = e; });
    const evs = c.evidences.filter(function(e){ return e.id.indexOf('ai-p2-classify') === 0; });
    const claims = (c.judgements || []).filter(function(j){ return j.origin === 'ai-fact'; });
    const importedPass = evs.length === 2 && claims.length === 2
      && evs[0].metric === 'patent' && evs[0].dim === '技术资产'
      && evs[1].metric === 'adoption' && evs[1].dim === '客户采用'
      && evs[0].supports.length === 1 && evs[0].supports[0] === claims[0].id
      && claims.every(function(j){ return j.candidate === true && j.reviewRequired === true && j.evidenceIds.length > 0; })
      && !(evs[0].dim === evs[1].dim)
      && evs[0].facts.length >= 1 && evs[1].facts.length >= 1;
    const beforeFormal = publicJudgementPanel(c);
    claimAdopt(claims[0].id);
    const afterFormal = publicJudgementPanel(c);
    const afterCandidate = candidateClaimsHtml(c);
    const adoptPass = claims[0].candidate === false && claims[0].adoptedFromAI === true && claims[0].reviewRequired === true
      && beforeFormal.indexOf(claims[0].title) < 0 && afterFormal.indexOf(claims[0].title) >= 0
      && afterCandidate.indexOf(claims[0].title) < 0;
    const pass = importedPass && adoptPass;
    state.companyId = saved.companyId; state.ai = saved.ai; state.aiRuns = saved.runs;
    p2Cleanup(c);
    return {pass:pass, importedPass:importedPass, adoptPass:adoptPass, evCount:evs.length, metrics:evs.map(function(e){ return e.metric + '/' + e.dim; }),
      claimCount:claims.length, supports:evs.map(function(e){ return e.supports; })};
  });

  /* P2-3 专利申请 vs 专利授权：识别为统计口径差异，不作实质冲突或虚假宣传结论 */
  T('P2_03_scope_conflict_is_timing_not_substantive', function(){
    const c = p2Company('验收测试丙科技有限公司');
    const facts = [
      {predicate:'专利申请', value:'5', unit:'项', time:'2025-06-01', metric:'patent', sourceDocumentId:'doc-a', evidenceId:'EV-A'},
      {predicate:'专利授权', value:'2', unit:'项', time:'2026-10-01', metric:'patent', sourceDocumentId:'doc-b', evidenceId:'EV-B'}
    ];
    const scope = aiScopeConflictFor(facts);
    const cid = aiEnsureScopeConflict(c, scope);
    const conflict = c.conflicts.filter(function(x){ return x.id === cid; })[0];
    const claim = {id:'P2-SCOPE', verification:{relation:'timing', canAssertNegative:false, independentSources:1}};
    const pass = !!scope && scope.type === 'scope' && !!conflict
      && conflict.nature === 'timing' && /不据此判定企业虚假宣传/.test(conflict.reason)
      && mayConcludeNegative(c, claim) === false;
    p2Cleanup(c);
    return {pass:pass, scope:scope && scope.type, nature:conflict && conflict.nature, reason:conflict && conflict.reason};
  });

  /* P2-4 同源转载/同一网址不同参数只计一个独立来源 */
  T('P2_04_same_source_not_independent', function(){
    const c = p2Company('验收测试丁科技有限公司');
    const e1 = ev({id:'p2d-1', grade:'C', dim:'客户采用', metric:'adoption', source:'测试公告', url:'https://example.com/notice?id=1&utm_source=a',
      independenceGroup:'reprint_2026_notice_1', date:'2026-01-10', title:'中标公告一', summary:'中标 1', quote:'中标 1', facts:[]});
    const e2 = ev({id:'p2d-2', grade:'C', dim:'客户采用', metric:'adoption', source:'转载', url:'https://example.com/notice?id=1&utm_source=b',
      independenceGroup:'reprint_2026_notice_1', date:'2026-01-11', title:'转载同一公告', summary:'中标 1', quote:'中标 1', facts:[]});
    const e3 = ev({id:'p2d-3', grade:'D', dim:'客户采用', metric:'adoption', source:'另一站点转载', url:'https://news.example.org/reprint/notice-1',
      independenceGroup:'reprint_2026_notice_1', date:'2026-01-12', title:'跨站转载', summary:'中标 1', quote:'中标 1', facts:[]});
    c.evidences.push(e1, e2, e3);
    c.judgements.push({id:'P2-DEDUP', title:'客户已采用', statement:'客户已采用该产品', support:'strong', supportLabel:'强',
      evidenceIds:['p2d-1', 'p2d-2', 'p2d-3'], metric:'adoption', dimension:'客户采用', limit:'测试'});
    normalizeEvidenceEngine(c);
    const j = c.judgements.filter(function(x){ return x.id === 'P2-DEDUP'; })[0];
    const pass = c.verification.documents === 2 && j.verification.independentSources === 1 && j.verification.evidenceCount === 3;
    p2Cleanup(c);
    return {pass:pass, docs:c.verification.documents, independent:j.verification.independentSources, evidence:j.verification.evidenceCount};
  });

  /* P2-5 没有证据的判断保持“证据不足”，不得自动产生负面事实或评分 */
  T('P2_05_missing_evidence_is_not_negative', function(){
    const c = p2Company('验收测试戊科技有限公司');
    c.judgements.push({id:'P2-NOEV', title:'客户采用情况', statement:'该企业没有客户采用', support:'strong', supportLabel:'强',
      evidenceIds:[], metric:'adoption', dimension:'客户采用', limit:'测试'});
    computeCompanyModel(c, null, reviewState(c));
    const j = c.judgements.filter(function(x){ return x.id === 'P2-NOEV'; })[0];
    const evalDim = c.techEvaluation.dimensions.filter(function(d){ return d.key === 'adoption'; })[0];
    const pass = j.verification.relation === 'insufficient' && j.verification.canAssertNegative === false
      && mayConcludeNegative(c, j) === false && evalDim.status === 'unknown'
      && c.score === null && c.techEvaluation.known === 0
      && !/负面|虚假宣传|拒绝准入/.test(c.verdict);
    p2Cleanup(c);
    return {pass:pass, relation:j.verification.relation, canAssertNegative:j.verification.canAssertNegative,
      dim:evalDim.status, score:c.score};
  });

  /* P2-6 两个时点快照：历史快照不引用未来证据，增量由程序计算 */
  T('P2_06_snapshots_do_not_leak_future', function(){
    const c = p2Company('验收测试己科技有限公司');
    [['p2f-1','2024-06-01','patent','技术资产'],
     ['p2f-2','2025-06-01','product','产品化'],
     ['p2f-3','2026-11-01','adoption','客户采用']].forEach(function(x){
      c.evidences.push(ev({id:x[0], grade:'C', dim:x[3], metric:x[2], source:'测试', url:'https://example.com/' + x[0],
        date:x[1], title:x[0], summary:'测试事实', quote:'测试', facts:[{predicate:x[2], value:'1', unit:'项', time:x[1], evidenceId:x[0], sourceDocumentId:'src-' + x[0], metric:x[2]}]}));
    });
    computeCompanyModel(c, null, reviewState(c));
    const a = researchSnapshot(c, '2024-12-31');
    const b = researchSnapshot(c, SNAPSHOT_ASOF[1]);
    const d = snapshotDiff(a, b);
    const pass = a.evidenceCount === 1 && a.evidenceIds[0] === 'p2f-1'
      && a.evidenceIds.indexOf('p2f-2') < 0 && a.evidenceIds.indexOf('p2f-3') < 0
      && b.evidenceCount === 3 && d.addedCount === 2 && d.addedFacts === 2
      && a.metrics[0].status === 'observed' && a.metrics[3].status === 'unknown'
      && publicPreviewHtml(c).indexOf('2024-12-31') >= 0;
    p2Cleanup(c);
    return {pass:pass, early:a.evidenceCount, late:b.evidenceCount, added:d.addedCount, addedFacts:d.addedFacts};
  });

  /* P2-7 发展阶段与工作流独立；证据不足时保持未知；人工选择可持久化 */
  T('P2_07_dev_stage_independent_of_workflow', function(){
    const c = p2Company('验收测试庚科技有限公司');
    c.evidences.push(ev({id:'p2g-1', grade:'C', dim:'技术资产', metric:'patent', source:'测试', url:'https://example.com/p2g-1',
      date:'2025-01-01', title:'专利', summary:'发明专利 1 项', quote:'发明专利 1 项', facts:[]}));
    computeCompanyModel(c, null, reviewState(c));
    const sug = devStageSuggestion(c);
    state.companyId = c.id;
    setDevStage('sprout');
    state.stages[c.id] = 'review';
    computeCompanyModel(c, null, reviewState(c));
    const html = devStagePanel(c);
    const pass = sug.key === 'seed' && state.devStage[c.id] === 'sprout' && devStageKey(c) === 'sprout'
      && stageOf(c) === 'review' && html.indexOf('育苗期') >= 0 && html.indexOf('产品化与首批客户') >= 0
      && html.indexOf('首台套') >= 0;
    p2Cleanup(c);
    return {pass:pass, suggestion:sug.key, selected:devStageKey(c), workflow:stageOf(c)};
  });

  /* P2-8 报告与归档快照包含核验、技术评价、阶段、AI 草稿、证据 ID 与复核状态 */
  T('P2_08_report_and_archive_include_new_modules', function(){
    const c = p2Company('验收测试辛科技有限公司');
    c.evidences.push(ev({id:'p2h-1', grade:'C', dim:'客户采用', metric:'adoption', source:'中标公告',
      url:'https://example.com/p2h-1', date:'2026-02-01', title:'中标公告', summary:'中标 120 万元', quote:'中标 120 万元',
      facts:[{predicate:'中标金额', value:'120', unit:'万元', time:'2026-02-01', evidenceId:'p2h-1', sourceDocumentId:'src-p2h-1', metric:'adoption'}]}));
    c.judgements.push({id:'P2-REPORT', title:'客户已采用', statement:'客户已采用该产品', support:'medium', supportLabel:'中',
      evidenceIds:['p2h-1'], metric:'adoption', dimension:'客户采用', limit:'测试', candidate:true, origin:'ai-fact', reviewRequired:true});
    state.companyId = c.id;
    setDevStage('grow');
    state.aiAnalysis[c.id] = {status:'ok', model:'acceptance-test', createdAt:'2026-11-21 08:00', elapsedMs:1,
      signature:analysisSignature(c), stats:{inputEvidence:1, citedEvidence:1, items:1, droppedItems:0, invalidEvidenceIds:[]},
      draft:{sections:[{title:'客户与产品化', items:[{claim:'该企业已有客户采用证据，但交付规模待核', evidenceIds:['p2h-1'], evidenceStatus:'pending', evidenceStatusText:'待核实', confidence:'low'}]}],
        nextSteps:[{question:'请补充合同或验收材料？', evidenceIds:['p2h-1']}], warnings:[], stats:{}}};
    computeCompanyModel(c, null, reviewState(c));
    const md = publicMdDoc(c);
    const prev = publicPreviewHtml(c) + publicProfileHtml(c);
    state.evals[c.id + ':p2h-1'] = {mark:'存疑', by:'自动测试员', at:'2026-11-21', note:'测试'};
    computeCompanyModel(c, null, reviewState(c));
    const staleMd = publicMdDoc(c);
    const snap = snapshotOf(c, {version:'acceptance-v1'});
    const checks = {
      mdSections:['4.1','4.2','4.3','4.4'].every(function(x){ return md.indexOf(x) >= 0; }),
      mdEvidence:md.indexOf('p2h-1') >= 0, mdReview:md.indexOf('待人工复核') >= 0,
      previewCandidate:prev.indexOf('AI 候选') >= 0, previewGuide:prev.indexOf('主动检索指引') >= 0,
      staleMd:staleMd.indexOf('证据状态已变化，草稿需要更新') >= 0,
      claimEvidence:!!snap.claims[0] && snap.claims[0].evidenceIds.indexOf('p2h-1') >= 0,
      claimReview:!!snap.claims[0] && snap.claims[0].reviewRequired === true,
      verification:!!snap.verification, tech:!!snap.techEvaluation,
      devStage:snap.devStage.key === 'grow', snapshots:snap.snapshots.length === 2,
      stale:!!(snap.aiAnalysis && snap.aiAnalysis.stale === true)
    };
    const pass = Object.keys(checks).every(function(k){ return checks[k]; });
    p2Cleanup(c);
    return {pass:pass, checks:checks, mdSections:['4.1','4.2','4.3','4.4'].filter(function(x){ return md.indexOf(x) >= 0; }),
      stale:!!(snap.aiAnalysis && snap.aiAnalysis.stale), devStage:snap.devStage.key};
  });

  /* P2-9 AI 分析条目人工纳入：保留证据 ID 与待复核状态，不直接采信 */
  T('P2_09_analysis_adopt_keeps_evidence_and_review', function(){
    const c = p2Company('验收测试壬科技有限公司');
    c.evidences.push(ev({id:'p2i-1', grade:'C', dim:'技术先进性', metric:'advancement', source:'测试',
      url:'https://example.com/p2i-1', date:'2026-03-01', title:'性能指标', summary:'精度 0.1 nm', quote:'精度 0.1 nm', facts:[]}));
    computeCompanyModel(c, null, reviewState(c));
    state.companyId = c.id;
    state.aiAnalysis[c.id] = {status:'ok', model:'acceptance-test', createdAt:'2026-11-21 08:10', elapsedMs:1,
      signature:analysisSignature(c), stats:{inputEvidence:1, citedEvidence:1, items:1, droppedItems:0, invalidEvidenceIds:[]},
      draft:{sections:[{title:'技术先进性', items:[{claim:'该企业公开指标显示较高精度', evidenceIds:['p2i-1'], evidenceStatus:'pending', evidenceStatusText:'待核实', confidence:'low'}]}],
        nextSteps:[], warnings:[], stats:{}}};
    analysisAdopt(0, 0);
    const j = (c.judgements || []).filter(function(x){ return x.origin === 'ai-analysis'; })[0];
    const html = publicJudgementPanel(c);
    const candidateHtml = candidateClaimsHtml(c);
    const pass = !!j && j.evidenceIds.indexOf('p2i-1') >= 0 && j.reviewRequired === true
      && j.candidate === false && j.adoptedFromAI === true
      && html.indexOf('该企业公开指标显示较高精度') >= 0 && html.indexOf('p2i-1') >= 0
      && html.indexOf('待核实') >= 0 && candidateHtml.indexOf('该企业公开指标显示较高精度') < 0;
    p2Cleanup(c);
    return {pass:pass, evidence:j && j.evidenceIds, review:j && j.reviewRequired, candidate:j && j.candidate};
  });

  /* P2-10 新材料实际触发跨文档口径核验：申请 5 项 vs 授权 2 项识别为口径差异 */
  T('P2_10_new_material_triggers_scope_check', function(){
    const c = p2Company('验收测试癸科技有限公司');
    c.evidences.push(ev({id:'p2j-pre', grade:'C', dim:'技术资产', metric:'patent', source:'旧公告',
      url:'https://example.com/doc-a', date:'2025-06-01', title:'专利申请', summary:'专利申请 5 项', quote:'专利申请 5 项',
      sourceDocumentId:'src-doc-a',
      facts:[{predicate:'专利申请', value:'5', unit:'项', time:'2025-06-01', evidenceId:'p2j-pre', sourceDocumentId:'src-doc-a', metric:'patent'}]}));
    const saved = {companyId:state.companyId, ai:state.ai, runs:state.aiRuns};
    state.companyId = c.id;
    const host = p2AiResult(c, [{statement:'该公司专利授权 2 项。', support:'strong', snippet:'专利授权 2 项', _snippetVerified:true, _statementCheck:{flags:[],labels:[]}}],
      [0], ['patent'], 'AI-P2-SCOPE');
    aiImport();
    host.remove();
    const conf = (c.conflicts || []).filter(function(x){ return x.autoDetected === 'scope'; })[0];
    const claim = (c.judgements || []).filter(function(j){ return j.origin === 'ai-fact'; })[0];
    const pass = !!conf && conf.nature === 'timing' && /统计口径|口径/.test(conf.reason)
      && !/虚假宣传$/.test(conf.title) && /不据此判定企业虚假宣传/.test(conf.reason)
      && claim.verification.relation === 'timing' && claim.verification.canAssertNegative === false
      && mayConcludeNegative(c, claim) === false;
    state.companyId = saved.companyId; state.ai = saved.ai; state.aiRuns = saved.runs;
    p2Cleanup(c);
    return {pass:pass, conflict:conf && conf.title, relation:claim && claim.verification.relation};
  });

  /* P2-11 中科艾科米真实资料：按发布日期生成 2024 年末与 2026-11 两个快照 */
  T('P2_11_acme_snapshots_from_real_dates', function(){
    const c = companyById('acme');
    const a = researchSnapshot(c, '2024-12-31');
    const b = researchSnapshot(c, SNAPSHOT_ASOF[1]);
    const future = ['EV-001', 'EV-006', 'EV-007', 'EV-008', 'EV-009', 'EV-011'];
    const pass = a.evidenceCount === 5 && b.evidenceCount === 11
      && a.evidenceIds.indexOf('EV-002') >= 0 && a.evidenceIds.indexOf('EV-003') >= 0
      && a.evidenceIds.indexOf('EV-004') >= 0 && a.evidenceIds.indexOf('EV-005') >= 0
      && a.evidenceIds.indexOf('EV-010') >= 0
      && future.every(function(id){ return a.evidenceIds.indexOf(id) < 0; })
      && b.evidenceIds.length === 11 && b.documentCount <= 11
      && snapshotDiff(a, b).addedCount === 6;
    return {pass:pass, y2024:a.evidenceCount, y2026:b.evidenceCount, docs2024:a.documentCount,
      added:snapshotDiff(a, b).addedCount};
  });

  /* P2-12 通过“新建真实企业”表单建档，再导入一条新材料（验收 A） */
  T('P2_12_create_via_form_and_import_one_material', function(){
    const name = '验收测试子科技有限公司';
    const saved = {companyId:state.companyId, ai:state.ai, runs:state.aiRuns};
    openCreateCompany();
    const dlg = document.getElementById('dialog');
    const formOpen = !!dlg && dlg.hidden === false;
    document.getElementById('rc-name').value = name;
    document.getElementById('rc-industry').value = '精密仪器';
    document.getElementById('rc-region').value = '北京';
    const ok = submitResearchCompany();
    closeDialog();
    const c = COMPANIES.filter(function(x){ return x.name === name; })[0];
    const persisted = JSON.parse(localStorage.getItem(STORE_RESEARCH) || '{}')[c ? c.id : ''] || null;
    let imported = 0, claimCount = 0;
    if(c){
      state.companyId = c.id;
      const host = p2AiResult(c, [{statement:'该企业获得发明专利授权 1 项。', support:'strong', snippet:'发明专利授权 1 项',
        _snippetVerified:true, _statementCheck:{flags:[],labels:[]}}], [0], ['patent'], 'AI-P2-FORM');
      aiImport();
      host.remove();
      imported = c.evidences.length;
      claimCount = (c.judgements || []).filter(function(j){ return j.origin === 'ai-fact'; }).length;
    }
    const pass = formOpen && ok === true && !!c && c.dataSource === 'real' && persisted && persisted.name === name
      && state.companyId === c.id && imported === 1 && claimCount === 1;
    state.companyId = saved.companyId; state.ai = saved.ai; state.aiRuns = saved.runs;
    p2Cleanup(c);
    return {pass:pass, formOpen:formOpen, created:!!c, persisted:!!persisted, imported:imported, claimCount:claimCount};
  });

  /* ===== P7：证据驱动评分、门槛与归因 ===== */
  /* 测试证据必须带真实技术事实，否则按新规则不应定级。 */
  let p7PatentSeq = 0;
  function p7DefaultEvidence(c, metric){
    if(metric === 'patent'){
      p7PatentSeq++;
      return {title:'发明专利授权公告', quote:'发明专利授权公告号 CN118' + String(100000 + p7PatentSeq) + 'B，专利权人：' + c.name + '。'};
    }
    if(metric === 'rd') return {title:'自主研发投入', quote:'公司自主研发，研发人员 30 人，研发费用 500 万元，研发项目 3 项，已形成发明专利。'};
    if(metric === 'advancement') return {title:'技术指标与检测', quote:'产品精度 0.1nm，第三方检测报告合格，优于基线 0.5nm。'};
    if(metric === 'product') return {title:'产品型号与量产', quote:'产品型号 PT-100，已批量生产并交付客户。'};
    if(metric === 'adoption') return {title:'客户采用与收入', quote:'已实现销售收入 800 万元，客户 3 家，完成验收。'};
    return {title:researchMetricName(metric) + '测试证据', quote:'测试原文片段'};
  }
  function p7Evidence(c, id, metric, opts){
    opts = opts || {};
    const url = opts.url || ('https://example.gov.cn/' + id);
    const base = p7DefaultEvidence(c, metric);
    const e = ev({
      id:id, grade:opts.grade || 'A', dim:researchMetricDim(metric), dimLabel:researchMetricDim(metric),
      metric:metric, source:'验收测试公开来源', url:url, date:'2026-01-01', retrievedAt:todayFull(),
      title:opts.title || base.title,
      summary:opts.summary || opts.quote || base.quote, quote:opts.quote || base.quote,
      sourceDocumentId:opts.doc || url, supports:[], facts:opts.facts || [],
      anchorFacts:opts.anchorFacts || [], origin:'manual'
    });
    c.evidences.push(e);
    return e;
  }
  function p7Mark(c, e, mark){
    state.evals[c.id + ':' + e.id] = {mark:mark, note:'验收测试标记', by:'自动测试员', at:today()};
  }
  function p7Recalc(c){ computeCompanyModel(c, null, reviewState(c)); return c.model; }

  T('P7_01_unverified_evidence_does_not_move_formal_score', function(){
    const c = p2Company('P7评分测试甲科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    const e1 = p7Evidence(c, 'p7-e1', 'patent');
    const e2 = p7Evidence(c, 'p7-e2', 'rd');
    const e3 = p7Evidence(c, 'p7-e3', 'advancement');
    [e1,e2,e3].forEach(function(e){ p7Mark(c, e, '采信'); });
    let m = p7Recalc(c);
    const formalBefore = m.formalScore;
    const acceptedBefore = m.acceptedScore;
    const patentBefore = m.metricLevels.patent.acceptedLevel;
    /* 同一授权事实换一个网址转载：候选与正式分都不得变化 */
    const e4 = p7Evidence(c, 'p7-e4', 'patent', {grade:'A', quote:e1.quote, title:'转载：' + e1.title});
    m = p7Recalc(c);
    const sameFactStable = m.acceptedScore === acceptedBefore && m.formalScore === formalBefore
      && m.metricLevels.patent.acceptedLevel === patentBefore
      && m.metricLevels.patent.candidateLevel === patentBefore;
    /* 新增一项未采信的新授权事实：只允许候选等级提高 */
    const e5 = p7Evidence(c, 'p7-e5', 'patent');
    m = p7Recalc(c);
    const patent = m.metricLevels.patent;
    const pass = sameFactStable
      && m.acceptedScore === acceptedBefore && m.formalScore === formalBefore
      && patent.candidateLevel === 3 && patent.acceptedLevel === patentBefore
      && m.candidateScore != null && m.candidateScore > m.acceptedScore
      && patent.evidenceIds.indexOf('p7-e5') < 0;
    p2Cleanup(c);
    return {pass:pass, formalBefore:formalBefore, acceptedBefore:acceptedBefore,
      acceptedAfter:m.acceptedScore, formalAfter:m.formalScore, candidate:m.candidateScore,
      patentAccepted:patent.acceptedLevel, patentCandidate:patent.candidateLevel, sameFactStable:sameFactStable};
  });

  T('P7_02_gate_and_formal_conditions_are_separate', function(){
    const c = p2Company('P7评分测试乙科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    ['patent','rd'].forEach(function(k, i){
      p7Mark(c, p7Evidence(c, 'p7b-e' + (i+1) + 'a', k), '采信');
      p7Mark(c, p7Evidence(c, 'p7b-e' + (i+1) + 'b', k, {doc:'https://example.gov.cn/doc-' + k + '-' + i}), '采信');
    });
    const m = p7Recalc(c);
    const blockerKeys = (m.formalBlockers || []).map(function(b){ return b.key; });
    const pass = m.acceptedScore != null && m.formalScore === null && m.suff >= m.scoreRule.gate
      && blockerKeys.indexOf('metrics') >= 0 && blockerKeys.indexOf('accepted') < 0 && blockerKeys.indexOf('suff') < 0
      && m.formalReady === false && c.score === null && c.grade === '—';
    p2Cleanup(c);
    return {pass:pass, accepted:m.acceptedScore, formal:m.formalScore, suff:m.suff,
      gate:m.scoreRule.gate, blockers:blockerKeys};
  });

  T('P7_03_score_history_records_attribution', function(){
    const c = p2Company('P7评分测试丙科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    p7Mark(c, p7Evidence(c, 'p7c-e1', 'patent'), '采信');
    p7Mark(c, p7Evidence(c, 'p7c-e2', 'rd'), '采信');
    const m0 = p7Recalc(c);
    const baselineScore = m0.acceptedScore;
    const baseline = (c.scoreHistory || []).length;
    const e3 = p7Evidence(c, 'p7c-e3', 'advancement');
    p7Mark(c, e3, '采信');
    c._scoreTrigger = '补充并采信技术先进性证据';
    const m = p7Recalc(c);
    const hist = c.scoreHistory[c.scoreHistory.length - 1] || {};
    const changed = (hist.changes || []).map(function(x){ return x.metric; });
    const pass = baseline === 0 && c.scoreHistory.length === 1
      && changed.indexOf('advancement') >= 0
      && hist.before && hist.before.acceptedScore === baselineScore && hist.after.acceptedScore === m.acceptedScore
      && m.acceptedScore > baselineScore
      && hist.ruleVersion === m.scoreRule.version && hist.trigger === '补充并采信技术先进性证据'
      && hist.actor === '自动测试员';
    p2Cleanup(c);
    return {pass:pass, baseline:baseline, history:c.scoreHistory.length, changed:changed,
      before:hist.before && hist.before.acceptedScore, after:hist.after && hist.after.acceptedScore};
  });

  T('P7_04_table_separates_candidate_score_and_review_status', function(){
    const c = p2Company('P7评分测试丁科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    p7Evidence(c, 'p7d-e1', 'patent');
    p7Evidence(c, 'p7d-e2', 'rd');
    const m = p7Recalc(c);
    const score = scoreCell(c);
    const grade = gradeCell(c);
    const review = reviewCell(c);
    const pass = m.acceptedScore === null && m.candidateScore != null
      && score.indexOf('候选') >= 0 && score.indexOf('未采信') >= 0
      && grade.indexOf('候选') >= 0 && grade.indexOf('待复核') < 0
      && (review.indexOf('待核实') >= 0 || review.indexOf('待纳入') >= 0)
      && queueRows().indexOf('证据充分度') >= 0;
    p2Cleanup(c);
    return {pass:pass, score:score, grade:grade, review:review};
  });

  T('P7_05_report_uses_latest_score_and_rule_version', function(){
    const c = p2Company('P7评分测试戊科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    p7Mark(c, p7Evidence(c, 'p7e-e1', 'patent'), '采信');
    p7Mark(c, p7Evidence(c, 'p7e-e2', 'rd'), '采信');
    const e3 = p7Evidence(c, 'p7e-e3', 'advancement');
    p7Mark(c, e3, '采信');
    c._scoreTrigger = '补充技术先进性证据';
    const m = p7Recalc(c);
    const md = publicMdDoc(c);
    const pass = md.indexOf(m.scoreRule.version) >= 0
      && md.indexOf('技术评分 ' + m.formalScore) >= 0
      && md.indexOf('补充技术先进性证据') >= 0
      && md.indexOf('不是技术得分及格线') >= 0
      && md.indexOf('不输出综合评分') < 0;
    p2Cleanup(c);
    return {pass:pass, formal:m.formalScore, hasRule:md.indexOf(m.scoreRule.version) >= 0,
      hasTrigger:md.indexOf('补充技术先进性证据') >= 0};
  });

  T('P7_06_agent_context_exposes_scores_and_rule_version', function(){
    const c = p2Company('P7评分测试己科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    p7Mark(c, p7Evidence(c, 'p7f-e1', 'patent'), '采信');
    p7Mark(c, p7Evidence(c, 'p7f-e2', 'rd'), '采信');
    p7Mark(c, p7Evidence(c, 'p7f-e3', 'advancement'), '采信');
    p7Recalc(c);
    state.companyId = c.id;
    const ctx = agentContext();
    const co = ctx.companies.filter(function(x){ return x.id === c.id; })[0] || {};
    const mm = co.model || {};
    const gate = ctx.rules && ctx.rules.research ? ctx.rules.research.gate : null;
    const bounds = ctx.rules && ctx.rules.boundaries ? ctx.rules.boundaries.join('|') : '';
    const pass = ctx.companyId === c.id
      && mm.ruleVersion === c.model.ruleVersion
      && mm.acceptedScore === c.model.acceptedScore
      && mm.formalScore === c.model.formalScore
      && mm.candidateScore === c.model.candidateScore
      && mm.metricLevels && mm.metricLevels.length === 5
      && mm.suffBreakdown && mm.suffBreakdown.parts.length === 4
      && Array.isArray(mm.formalBlockers) && mm.scoreHistory.length >= 0
      && gate === RESEARCH_SCORE_RULE.gate
      && bounds.indexOf('不得写入或改写任何分数') >= 0
      && bounds.indexOf('不是技术得分及格线') >= 0;
    state.companyId = 'acme';
    p2Cleanup(c);
    return {pass:pass, companyId:ctx.companyId, rule:mm.ruleVersion, accepted:mm.acceptedScore,
      formal:mm.formalScore, gate:gate, hasBounds:bounds.indexOf('不得写入或改写任何分数') >= 0};
  });

  T('P7_07_expert_rule_preview_and_publish', function(){
    const c = p2Company('P7评分测试庚科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    const e1 = p7Evidence(c, 'p7g-e1', 'patent');
    const e2 = p7Evidence(c, 'p7g-e2', 'patent', {doc:'https://example.gov.cn/p7g-doc2'});
    p7Mark(c, e1, '采信'); p7Mark(c, e2, '采信');
    p7Mark(c, p7Evidence(c, 'p7g-e3', 'rd'), '采信');
    p7Mark(c, p7Evidence(c, 'p7g-e4', 'advancement'), '采信');
    p7Recalc(c);
    const oldV = c.model.ruleVersion;
    const oldScore = c.model.acceptedScore;
    const savedRuleHist = (state.expertRuleHistory || []).slice();
    const savedRule = state.expertRule;
    const acme = COMPANIES.filter(function(x){ return x.id === 'acme'; })[0];
    const acmeHist = acme ? (acme.scoreHistory || []).slice() : [];
    const draft = { weights:{patent:0.5, rd:0.1, advancement:0.1, product:0.15, adoption:0.15},
      metricRules:JSON.parse(JSON.stringify(RESEARCH_SCORE_RULE.metricRules)), gate:0.6, minMetrics:3, minAccepted:3 };
    const prev = rulePreviewRows(draft).filter(function(x){ return x.id === c.id; })[0];
    const histBefore = (c.scoreHistory || []).length;
    publishRule(draft);
    const hist = c.scoreHistory[c.scoreHistory.length - 1] || {};
    const pass = !!prev && prev.newAccepted !== oldScore
      && c.model.ruleVersion !== oldV
      && c.model.acceptedScore === prev.newAccepted
      && c.model.acceptedScore > oldScore
      && c.scoreHistory.length === histBefore + 1
      && String(hist.trigger || '').indexOf('规则变化') === 0
      && (state.expertRuleHistory || []).length === savedRuleHist.length + 1;
    /* 恢复原型规则与测试前历史，避免污染默认数据 */
    state.expertRule = savedRule;
    state.expertRuleHistory = savedRuleHist;
    writeStore(STORE_EXPERTRULE, savedRule);
    writeStore(STORE_EXPERTRULE + '.history', savedRuleHist);
    applyExpertRule();
    COMPANIES.filter(isResearchCase).forEach(function(x){
      x._scoreTrigger = '';
      computeCompanyModel(x, null, reviewState(x));
    });
    if(acme) acme.scoreHistory = acmeHist;
    p2Cleanup(c);
    return {pass:pass, oldVersion:oldV, newVersion:c.model && c.model.ruleVersion,
      oldScore:oldScore, newScore:c.model && c.model.acceptedScore, preview:prev && prev.newAccepted,
      trigger:hist.trigger};
  });

  /* ===== P7.1 技术等级由事实锚点决定、证据数量只影响充分度 ===== */
  T('P71_01_repeat_sources_do_not_raise_level', function(){
    const c = p2Company('P71重复来源测试科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    const e1 = p7Evidence(c, 'p71-a1', 'patent');
    p7Mark(c, e1, '采信');
    let m = p7Recalc(c);
    const before = m.metricLevels.patent.acceptedLevel;
    const beforeReason = m.metricLevels.patent.reason;
    p7Evidence(c, 'p71-a2', 'patent', {quote:e1.quote, title:'转载一'});
    p7Evidence(c, 'p71-a3', 'patent', {quote:e1.quote, title:'转载二'});
    m = p7Recalc(c);
    const after = m.metricLevels.patent.acceptedLevel;
    const pass = before === 2 && after === 2 && m.metricLevels.patent.reason === beforeReason;
    p2Cleanup(c);
    return {pass:pass, before:before, after:after, reason:m.metricLevels.patent.reason};
  });

  T('P71_02_new_grant_fact_can_raise_level', function(){
    const c = p2Company('P71新事实升级测试科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    p7Mark(c, p7Evidence(c, 'p71-b1', 'patent'), '采信');
    let m = p7Recalc(c);
    const before = m.metricLevels.patent.acceptedLevel;
    p7Mark(c, p7Evidence(c, 'p71-b2', 'patent'), '采信');
    m = p7Recalc(c);
    const after = m.metricLevels.patent.acceptedLevel;
    const pass = before === 2 && after === 3;
    p2Cleanup(c);
    return {pass:pass, before:before, after:after, reason:m.metricLevels.patent.reason};
  });

  T('P71_03_application_is_not_grant', function(){
    const c = p2Company('P71申请授权区分测试科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    p7Mark(c, p7Evidence(c, 'p71-c1', 'patent', {title:'发明专利申请受理', quote:'发明专利申请号 CN202510000001.2，已受理。'}), '采信');
    const m = p7Recalc(c);
    const lv = m.metricLevels.patent.acceptedLevel;
    const pass = lv === 1 && m.acceptedScore === null && m.metricLevels.patent.reason.indexOf('申请') >= 0;
    p2Cleanup(c);
    return {pass:pass, level:lv, score:m.acceptedScore, reason:m.metricLevels.patent.reason};
  });

  T('P71_04_award_amount_is_not_revenue', function(){
    const c = p2Company('P71中标收入区分测试科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    p7Mark(c, p7Evidence(c, 'p71-d1', 'adoption', {quote:'中标金额 1200 万元，已签合同，客户 1 家。'}), '采信');
    const m = p7Recalc(c);
    const lv = m.metricLevels.adoption.acceptedLevel;
    const pass = lv === 2 && m.metricLevels.adoption.reason.indexOf('中标') >= 0
      && !/已实现收入|规模化收入/.test(m.metricLevels.adoption.reason);
    p2Cleanup(c);
    return {pass:pass, level:lv, reason:m.metricLevels.adoption.reason};
  });

  T('P71_05_joint_rd_is_not_self_rd', function(){
    const c = p2Company('P71联合研发区分测试科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    p7Mark(c, p7Evidence(c, 'p71-e1', 'rd', {title:'产学研联合研发项目', quote:'与清华大学联合研发，研发人员 30 人，研发费用 500 万元，连续研发 3 年。'}), '采信');
    const m = p7Recalc(c);
    const lv = m.metricLevels.rd.acceptedLevel;
    const pass = lv <= 1 && /联合|委托/.test(m.metricLevels.rd.reason);
    p2Cleanup(c);
    return {pass:pass, level:lv, reason:m.metricLevels.rd.reason};
  });

  T('P71_06_no_benchmark_is_not_industry_leader', function(){
    const c = p2Company('P71无对照先进性测试科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    p7Mark(c, p7Evidence(c, 'p71-f1', 'advancement', {quote:'产品精度 0.1nm，第三方检测报告合格，行业领先。'}), '采信');
    const m = p7Recalc(c);
    const lv = m.metricLevels.advancement.acceptedLevel;
    const pass = lv === 2 && /无同行|基线/.test(m.metricLevels.advancement.reason);
    p2Cleanup(c);
    return {pass:pass, level:lv, reason:m.metricLevels.advancement.reason};
  });

  T('P71_07_revenue_and_acceptance_support_level4', function(){
    const c = p2Company('P71收入转化测试科技有限公司');
    if(!c) return {pass:false, err:'创建失败'};
    p7Mark(c, p7Evidence(c, 'p71-g1', 'adoption', {quote:'已实现销售收入 800 万元，客户 3 家，完成验收，复购。'}), '采信');
    const m = p7Recalc(c);
    const lv = m.metricLevels.adoption.acceptedLevel;
    const pass = lv === 4 && /收入/.test(m.metricLevels.adoption.reason);
    p2Cleanup(c);
    return {pass:pass, level:lv, reason:m.metricLevels.adoption.reason};
  });

  /* 恢复测试前状态，避免影响用户打开页面时的默认数据 */
  state.stages = {};
  state.authors = {};
  state.reviews = {};
  state.decisions = {};
  state.evals = {};
  state.archives = {};
  state.reviewFlags = {};
  state.aiAnalysis = {};
  analysisPersist();
  state.companyId = 'yunshu';
  COMPANIES.forEach(function(c){ computeCompanyModel(c, null, reviewState(c)); });
  setView('overview');

  out.passAll = Object.keys(out.cases).every(function(k){ return out.cases[k] && out.cases[k].pass; });
  return out;
})()
