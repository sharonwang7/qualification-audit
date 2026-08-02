/**
 * deterministic-checker.js — 确定性检查层
 * 职责：在 LLM 推理之前执行硬性规则检查（R01-R10）
 * 特点：100%代码逻辑，不依赖 LLM，结果稳定可重复
 *
 * 执行顺序：LLM分析之前 → 发现CRITICAL直接标记 → 再交LLM处理语义层
 */
const fs = require('fs');
const path = require('path');

// 加载知识库
const ENTITIES_PATH = path.join(__dirname, '..', 'common', 'entities.json');
const RULES_PATH = path.join(__dirname, '..', 'common', 'deterministic-rules.json');

let _entities = null;
let _rules = null;

function loadEntities() {
  if (_entities) return _entities;
  try {
    const raw = fs.readFileSync(ENTITIES_PATH, 'utf8');
    _entities = JSON.parse(raw);
    return _entities;
  } catch (e) {
    console.error('[DeterministicChecker] 加载 entities.json 失败:', e.message);
    return { internal_entities: [], brand_to_entity: {}, trademark_registry: {}, risk_levels: {} };
  }
}

function loadRules() {
  if (_rules) return _rules;
  try {
    // 规则以 JSON 存储，原生 JSON.parse 加载（支持嵌套 detection / required_fields）。
    // 弃用旧的手写 YAML 解析器（无法解析嵌套，导致 R11/risk_routing/豁免读不到）。
    const raw = fs.readFileSync(RULES_PATH, 'utf8');
    _rules = JSON.parse(raw);
    if (!Array.isArray(_rules.rules)) _rules.rules = [];
    return _rules;
  } catch (e) {
    console.error('[DeterministicChecker] 加载 deterministic-rules.json 失败:', e.message);
    // 🔴 fail-visible，不再 fail-silent（2026-07-17 王爷定）
    // 旧行为：返回 { rules: [] } → 规则循环 0 次 → issues=[]/passed=true，与「跑了、没红线」的输出【完全一致】
    //   → 红线全灭却伪装成「全部通过」，且报错只在 stderr、子代理看不到。
    // 实证：2026-07-17 09:17 本文件被写坏(未转义引号) → 14:39 修复，期间 11 条红线静默失效，
    //   14:37 跑的 n=52~55 四件全部 passed:true 判通过，事后无任何落库痕迹。
    // 现返回哨兵 → runDeterministicChecks 透传 engine_failed → case 输出 deterministic.engine_failed=true
    //   → 子代理按 child-judge 附件/引擎铁律判转人工；write-result 工具层【硬拒】verdict=通过（不靠子代理自觉）。
    return { rules: [], engine_failed: true, engine_error: String((e && e.message) || e).slice(0, 300) };
  }
}

// ===== 检查函数 =====

/**
 * 执行确定性检查
 * @param {Object} formMap - 解析后的表单字段
 * @param {Array} attachDocs - 附件文档对象数组
 * @param {Array} qualTypes - 申请的资质类型数组
 * @returns {Object} { issues: [], passed: boolean, criticalCount: number }
 */
// ── 合同期限解析（2026-08-02 王爷定·Plan B）：从「合同明细」自由文本抽日期区间，注入 case 给 LLM 当【确定性参考信号】。──
//   刻意【不改判定】：判过期/授权书是否越界仍交 LLM（自由文本+OCR 不确定，代码不独断退回，防误杀）。仅提供解析好的区间省 LLM 找。
function normalizeDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}
function parseContractDates(text) {
  const s = String(text || '');
  const D = '\\d{4}[-/.年]\\s*\\d{1,2}[-/.月]\\s*\\d{1,2}日?';
  const m = s.match(new RegExp(`(${D})\\s*[-~至到]+\\s*(${D})`));
  if (m) {
    const start = normalizeDate(m[1]), end = normalizeDate(m[2]);
    if (start && end) return { startDate: start, endDate: end };
  }
  return { startDate: null, endDate: null };
}

function runDeterministicChecks(formMap, attachDocs, qualTypes) {
  const _rulesPack = loadRules();
  const rules = _rulesPack.rules;
  const entities = loadEntities();
  const issues = [];

  // 🔴 引擎失效 → 立刻作为一条 CRITICAL 摆到台面上（2026-07-17 王爷定）。
  // 关键：绝不让「规则没加载」和「规则跑了、没红线」产出相同的 issues=[]/passed=true。
  if (_rulesPack.engine_failed) {
    issues.push({
      ruleId: 'ENGINE-FAIL',
      severity: 'CRITICAL',
      action: 'HUMAN',
      message: `🔴 确定性规则引擎加载失败（deterministic-rules.json 解析错误：${_rulesPack.engine_error}）——本次【全部红线均未执行】，"没有红线告警"≠"没有风险"。禁止判通过，一律转人工，并立即报修规则文件。`,
      detail: { engine_error: _rulesPack.engine_error }
    });
  }

  for (const rule of rules) {
    const result = checkRule(rule, formMap, attachDocs, qualTypes, entities);
    if (result) {
      issues.push(result);
    }
  }

  // ===== OCR 可读性闸（堵静默漏报的命根子）=====
  // 任何附件 status≠ok(认不清/认空/失败)或页级 low_conf → 证据不可信。
  // 红线规则(R02/R05/R07…)是对文字搜关键词:读不出字 → 搜不到 → 会"静默通过"。
  // 这里强制升级:证据不可读 = 无法排除红线风险 = 必须人工,绝不自动放行。
  // 注:旧 golden 快照无 status 字段 → 视为可读(向后兼容,不触发本闸)。
  // 只有真·读不出(status=empty/failed)才硬升级；low_conf 仅 advisory(噪声碎片会误判,不当闸门)。
  const unreadable = (attachDocs || [])
    .map((a, i) => ({ idx: i, source: a.source, status: a.status }))
    // 2026-07-25（王爷定·对齐修复）：needs_vision=扫描件/图片，由子代理 image()/pdf() 视觉读，【非"不可读"】——
    //   与 case.js 的 ocr_gate 闸口径对齐（那边早已排除 needs_vision）。此前漏排 → needs_vision 误升 needs_human=true，
    //   子代理视觉读成功也被 Q4 硬闸挡"通过"（邓淑贤事故）。只放开"视觉已读"；真·读不出(empty/failed)仍计不可读、仍 needs_human。
    .filter(a => a.status && a.status !== 'ok' && a.status !== 'needs_vision');
  if (unreadable.length > 0) {
    // F6 修复：口径与 SKILL 对齐——部分附件读不出 = 需补充(SUPPLEMENT)而非"必须转人工(CRITICAL)"。
    // 仍设 needs_human=true 作为 fast-track 自动通过的一票否决（见下方返回值），但不再硬置 passed=false。
    issues.push({
      ruleId: 'OCR-GATE',
      severity: 'MAJOR',
      action: 'SUPPLEMENT',
      message: `附件证据读不出（${unreadable.map(u => `${u.source}:${u.status}`).join('、')}），无法排除红线风险，禁止自动通过；须在评论中标注每个读取失败的附件（文件名+原因+"需人工核查原件"），基于其余可读附件完成分析，结论给⚠️需补充；全部附件失败时才给🔴转人工。`,
      detail: { unreadable }
    });
  }

  // 内部授权排除检查
  const skipResult = checkInternalAuthExemption(formMap, qualTypes, entities);

  const criticalCount = issues.filter(i => i.severity === 'CRITICAL').length;

  // Plan B：解析合同明细日期区间 + expired 标记，注入 case（信息型，不改判定；判过期/授权书越界仍由 LLM 定）
  const _cd = parseContractDates(formMap['合同明细']);
  let contract_date_range = null;
  if (_cd.startDate || _cd.endDate) {
    const _endMs = _cd.endDate ? Date.parse(_cd.endDate) : NaN;
    contract_date_range = {
      start: _cd.startDate || null,
      end: _cd.endDate || null,
      expired: isNaN(_endMs) ? null : (_endMs < Date.now())
    };
  }

  return {
    issues,
    passed: criticalCount === 0,
    criticalCount,
    contract_date_range,   // Plan B：null=合同明细无可解析日期区间；否则 {start,end,expired}

    // 引擎失效 → needs_human=true，一票否决 fast-track 自动通过
    needs_human: unreadable.length > 0 || !!_rulesPack.engine_failed,
    unreadable_attachments: unreadable,
    shouldSkip: skipResult.shouldSkip,
    skipReason: skipResult.reason,
    autoApprove: skipResult.autoApprove || null,
    // 🔴 供 case 输出 / write-result 硬拒 / 落库留痕（2026-07-17 王爷定）
    engine_failed: !!_rulesPack.engine_failed,
    engine_error: _rulesPack.engine_error || ''
  };
}

function checkRule(rule, formMap, attachDocs, qualTypes, entities) {
  // 检查是否适用于当前资质类型
  const appliesTo = rule.applies_to || [];
  if (!appliesTo.includes('ALL')) {
    const hasMatch = qualTypes.some(qt => appliesTo.some(at => qt && qt.includes(at)));
    if (!hasMatch) return null;
  }

  // 根据规则ID执行具体检查
  switch (rule.id) {
    case 'R01': return checkR01(rule, formMap);
    case 'R02': return checkR02(rule, formMap, attachDocs);
    case 'R03': return checkR03(rule, formMap, attachDocs);
    case 'R04': return checkR04(rule);
    case 'R05': return checkR05(rule, formMap, attachDocs);
    case 'R06': return checkR06(rule, formMap);
    case 'R07': return checkR07(rule, attachDocs);
    case 'R08': return checkR08(rule, formMap);
    case 'R12': return checkR12(rule, formMap, entities);
    case 'R10': return checkR10(rule);
    case 'R11': return checkR11(rule, formMap);
    default: return null;
  }
}

// R01: 商标注册证必须填写注册号
function checkR01(rule, formMap) {
  const fields = ['提供商标注册号', '提供注册号', '注册号', '商标注册号'];
  const hasRegNo = fields.some(f => formMap[f] && String(formMap[f]).trim() !== '');

  if (!hasRegNo) {
    return {
      ruleId: 'R01',
      severity: rule.severity,
      action: rule.action,
      message: rule.message,
      ref: rule.ref
    };
  }
  return null;
}

// R02: 品牌/商标授权书须有业务关系证明（双章合同/替代证据）
// F23 修复：去掉"合同明细字段非空即放行"（同事随手填一行字不能证明双章合同）；
//          附件关键词命中只降为 CONFIRM 提醒，绝不当"已具备双章合同"放行，是否成立交 agent 判。
function checkR02(rule, formMap, attachDocs) {
  const attachText = (attachDocs || []).map(a => a.content || '').join('\n');
  const hasContract = /(合同|协议)/.test(attachText);
  const hasSeal = /(盖章|签字|签章|双方|双章)/.test(attachText);
  if (hasContract && hasSeal) {
    return {
      ruleId: 'R02', severity: 'MINOR', action: 'CONFIRM', ref: rule.ref,
      message: '【R02】附件疑似含双章合同（命中"合同/协议"+"盖章/签字"字样）。关键词命中≠真双章——请由 agent 结合 seal_count 与合同正文（甲乙双方/盖章签字处）确认是否双方有效盖章，再据此判定业务关系证明成立与否。'
    };
  }
  return { ruleId: 'R02', severity: rule.severity, action: rule.action, message: rule.message, ref: rule.ref };
}

// R03: 授权期限/范围须明确
// F24 修复：不再用单字"从/至/起/止"判定（几乎任何文本都命中而误放行）；
//          要求真实日期模式，或明确的"授权期限/有效期/授权范围"等词。
function checkR03(rule, formMap, attachDocs) {
  const DATE_RE = /\d{4}\s*[-/年.]\s*\d{1,2}/;
  const SCOPE_RE = /(授权期限|有效期限|有效期|授权范围|使用范围|授权地区|授权渠道|授权区域)/;
  const contractDetail = String(formMap['合同明细'] || '');
  if (DATE_RE.test(contractDetail) || SCOPE_RE.test(contractDetail)) return null;
  const attachText = (attachDocs || []).map(a => a.content || '').join('\n');
  if (DATE_RE.test(attachText) || SCOPE_RE.test(attachText)) return null;
  return {
    ruleId: 'R03',
    severity: rule.severity,
    action: rule.action,
    message: rule.message
  };
}

// R04: 品牌授权书须使用对应品牌模板（CONFIRM 提醒型：命中品牌授权书即标注，需人工确认模板匹配度）
function checkR04(rule) {
  return {
    ruleId: 'R04',
    severity: rule.severity,
    action: rule.action,
    message: rule.message,
    ref: rule.ref
  };
}

// R08: 使用平台须具体（使用平台字段为空 且 事由未提到具体平台名 → 建议补充）
function checkR08(rule, formMap) {
  const platform = formMap['使用平台'];
  if (platform && String(platform).trim() !== '') return null;

  const reason = String(formMap['申请事由'] || '');
  const kws = (rule.detection && rule.detection.reason_keywords) || [];
  if (kws.some(k => reason.includes(k))) return null;

  return {
    ruleId: 'R08',
    severity: rule.severity,
    action: rule.action,
    message: rule.message
  };
}

// R10: 领取份数限制（CONFIRM 提醒型：命中商标注册证即标注"一式一份，不允许多取"）
function checkR10(rule) {
  return {
    ruleId: 'R10',
    severity: rule.severity,
    action: rule.action,
    message: rule.message,
    ref: rule.ref
  };
}

// R05: 法人资质须有平台截图或双章合同
function checkR05(rule, formMap, attachDocs) {
  if (!attachDocs || attachDocs.length === 0) {
    return {
      ruleId: 'R05',
      severity: rule.severity,
      action: rule.action,
      message: rule.message,
      ref: rule.ref
    };
  }

  const attachText = attachDocs.map(a => a.content || '').join('\n');
  const hasEvidence = /(截图|后台|平台|logo|合同|协议|盖章|签字)/i.test(attachText);

  if (!hasEvidence) {
    return {
      ruleId: 'R05',
      severity: rule.severity,
      action: rule.action,
      message: rule.message,
      ref: rule.ref
    };
  }

  return null;
}

// R06: 申请事由非空检查（语义充分性由 R11 必读字段完整性 + analyzer 语义化追问负责）
function checkR06(rule, formMap) {
  const reason = formMap['申请事由'];
  if (isEmptyValue(reason)) {
    return {
      ruleId: 'R06',
      severity: rule.severity,
      action: rule.action,
      message: rule.message,
      ref: rule.ref
    };
  }
  return null;
}

// ===== 通用空值判定（R11 共用） =====
function isEmptyValue(v) {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) {
    if (v.length === 0) return true;
    // 全部空对象 [{}] 也算空
    if (v.every(x => !x || (typeof x === 'object' && Object.keys(x).length === 0))) return true;
  }
  return false;
}

// R11: 申请必读字段完整性（4 个必有字段缺一即拦截）
function checkR11(rule, formMap) {
  const required = rule.detection?.required_fields || [];
  const missing = [];
  for (const f of required) {
    const candidates = [f.name, ...(f.aliases || [])];
    const hit = candidates.some(name => !isEmptyValue(formMap[name]));
    if (!hit) missing.push(f.name);
  }
  if (missing.length > 0) {
    return {
      ruleId: 'R11',
      severity: rule.severity,
      action: rule.action,
      message: rule.message.replace('{missing_fields}', missing.join('、')),
      ref: rule.ref,
      detail: { missing }
    };
  }
  return null;
}

// R07: 禁止转授权
function checkR07(rule, attachDocs) {
  if (!attachDocs || attachDocs.length === 0) return null;

  const attachText = attachDocs.map(a => a.content || '').join('\n');
  const forbiddenTerms = ['转授权', '再授权', '可授权他人', 'sub-licens', '再许可'];

  const found = forbiddenTerms.find(term => attachText.includes(term));

  if (found) {
    return {
      ruleId: 'R07',
      severity: rule.severity,
      action: rule.action,
      message: rule.message,
      detail: { foundTerm: found }
    };
  }

  return null;
}

// ── 内部主体精确匹配（F1 修复：禁止裸 includes 子串匹配，防"流向方名称含别名子串"冒充内部）──
// 规范化：去空白 + 全角→半角 + 小写
function _normName(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase();
}
// 去公司类型后缀，便于"整体相等"比较（不做任意子串）
function _stripCorpSuffix(s) {
  return _normName(s).replace(/(股份)?有限(责任)?公司$|分公司$|公司$|商行$|经营部$|经营中心$|工作室$|厂$/g, '');
}
// 提取 18 位统一社会信用代码（最强身份信号）
function _extractUSCC(s) {
  const m = String(s || '').match(/[0-9A-HJ-NP-RTUWXY]{18}/i);
  return m ? m[0].toUpperCase() : null;
}
// 判定流向方是否为我司内部主体：USCC 精确匹配为锚，名称仅"规范化整体相等/去后缀整体相等"命中
function isInternalCounterparty(counterparty, entities) {
  const cp = _normName(counterparty);
  if (!cp) return false;
  const cpStripped = _stripCorpSuffix(counterparty);
  const cpUscc = _extractUSCC(counterparty);
  return (entities.internal_entities || []).some(ie => {
    if (cpUscc && ie.uscc && cpUscc === String(ie.uscc).toUpperCase()) return true;
    if (cp === _normName(ie.name)) return true;
    if (cpStripped && cpStripped === _stripCorpSuffix(ie.name)) return true;
    return (ie.alias || []).some(a => {
      const an = _normName(a);
      return an && (cp === an || (cpStripped && cpStripped === an));
    });
  });
}

function _counterpartyOf(formMap) {
  return formMap['资质流向方全称（公司/自然人/平台）'] || formMap['资质流向方'] || formMap['相对方全称（公司/自然人全称）'] || formMap['相对方全称'] || '';
}

// ── R12 辅助：把「公司主体」解析到已知凡岛主体（境内 USCC / 境外 税号·注册号），返回权威标识 ──
// 用于知识库「主体和信用代码需一致」：暴露权威标识供 AI/审核员核对授权书/证件上的主体+代码。
function resolveCompanyEntity(name, entities) {
  const nm = _normName(name);
  const stripped = _stripCorpSuffix(name);
  const uscc = _extractUSCC(name);
  if (!nm) return null;
  const matchAlias = (aliases) => (aliases || []).some(a => { const an = _normName(a); return an && (nm === an || (stripped && stripped === an)); });
  for (const ie of (entities.internal_entities || [])) {
    if (uscc && ie.uscc && uscc === String(ie.uscc).toUpperCase()) return { name: ie.name, idLabel: '统一社会信用代码', idValue: ie.uscc };
    if (nm === _normName(ie.name) || (stripped && stripped === _stripCorpSuffix(ie.name)) || matchAlias(ie.alias)) {
      return { name: ie.name, idLabel: '统一社会信用代码', idValue: ie.uscc };
    }
  }
  for (const oe of (entities.overseas_entities || [])) {
    const idLabel = oe.tax_id ? '税号' : (oe.reg_no ? '注册号' : '标识');
    const idValue = oe.tax_id || oe.reg_no || '(无)';
    if (nm === _normName(oe.name) || (stripped && stripped === _stripCorpSuffix(oe.name)) || (oe.en_name && _normName(oe.en_name) === nm) || matchAlias(oe.alias)) {
      return { name: oe.name, idLabel, idValue };
    }
  }
  return null;
}

// R12: 公司主体识别 + 权威主体/信用代码暴露（知识库「主体和信用代码需一致」）
// 识别成功→暴露权威标识供核对；未识别（且非"其它"）→提醒核对是否填错/是否新主体。CONFIRM 级，不阻断。
function checkR12(rule, formMap, entities) {
  let subj = formMap['公司主体'] || formMap['公司主体1'] || '';
  if (Array.isArray(subj)) subj = subj.join(' ');
  subj = String(subj || '').trim();
  if (!subj) return null;                       // 空：不在此规则管
  if (/其它|其他/.test(subj)) return null;      // "其它"是合法取值，不校验
  const ent = resolveCompanyEntity(subj, entities);
  if (ent) {
    return {
      ruleId: 'R12', severity: 'MINOR', action: 'CONFIRM', ref: rule.ref,
      message: `【R12】公司主体「${ent.name}」权威标识：${ent.idLabel} ${ent.idValue}。请核对授权书/证件上的主体名称与信用代码/注册号与此一致（知识库：主体和信用代码需一致）。`,
      detail: { entity: ent.name, idLabel: ent.idLabel, idValue: ent.idValue, matched: true }
    };
  }
  // 未匹配 = 不是我们的主体（USCC/注册号识别只针对我司主体），无权威 ID 可暴露 → 静默跳过，不提示"填错"
  return null;
}

// 内部授权排除检查（仅 USCC/规范化整体相等才算内部，杜绝子串冒充走 fast-track）
function checkInternalAuthExemption(formMap, qualTypes, entities) {
  const isInternalAuth = qualTypes.some(qt => qt && qt.includes('商标授权书'));
  if (!isInternalAuth) return { shouldSkip: false, reason: '' };

  if (isInternalCounterparty(_counterpartyOf(formMap), entities)) {
    return {
      shouldSkip: false,
      autoApprove: { flag: true, reason: '内部授权（我司主体之间）无需总经办深度审核，建议直接通过' }
    };
  }

  return { shouldSkip: false, reason: '' };
}

// ===== 辅助函数 =====

/**
 * 获取资质类型对应的风险等级
 */
function getRiskLevel(qualType, subType = '') {
  const entities = loadEntities();
  const key = subType ? `${qualType}_${subType}` : qualType;
  return entities.risk_levels[key] || '中';
}

/**
 * 获取资质类型对应的审核人
 */
function getReceiver(qualType) {
  const entities = loadEntities();
  if (qualType.includes('法人') || qualType.includes('董事')) {
    return entities.receivers['法人资质'];
  }
  if (qualType.includes('商标注册证')) return entities.receivers['商标注册证'];
  if (qualType.includes('商标授权书')) return entities.receivers['商标授权书'];
  if (qualType.includes('品牌授权书')) return entities.receivers['品牌授权书'];
  return null;
}

/**
 * 判断是否为内部主体
 */
function isInternalEntity(name) {
  if (!name) return false;
  return isInternalCounterparty(name, loadEntities());
}

/**
 * 根据品牌名获取主体
 */
function getEntityByBrand(brand) {
  const entities = loadEntities();
  return entities.brand_to_entity[brand] || null;
}

/**
 * 根据品牌名和注册号获取商标信息
 */
function getTrademarkInfo(brand, regNo) {
  const entities = loadEntities();
  const trademarks = entities.trademark_registry[brand];
  if (!trademarks) return null;

  if (regNo) {
    return trademarks.find(t => t.reg_no === regNo) || null;
  }
  return trademarks[0] || null; // 返回第一个作为默认
}

module.exports = {
  runDeterministicChecks,
  getRiskLevel,
  getReceiver,
  isInternalEntity,
  isInternalCounterparty,
  getEntityByBrand,
  getTrademarkInfo,
  loadEntities,
  loadRules,
  parseContractDates
};
