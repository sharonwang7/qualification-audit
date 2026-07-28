/**
 * trademark-auth-check.js — 【内部·商标授权书】确定性校验（代码化清单 #3，2026-07-09）
 *
 * 场景：资质类型 = 商标授权书（内部）——我司一个主体把某注册商标授权给另一我司主体/内部使用。
 *       ⚠️ 不是「品牌授权书」(对外，走 C01-C04)。判定「内部」= 甲乙方都是我司主体。
 *
 * 王爷定的三点核查：
 *  1) 甲乙方主体：甲方(授权方=公司主体) / 乙方(被授权方=资质流向方) 是否都是我司主体。
 *  2) 社会信用代码正确：主体 ↔ 其统一社会信用代码一致。有权威表(creditMap: name→uscc)则暴露供核对，
 *     无则降级💧提醒人工核（绝不硬编造）。
 *  3) 授权商标归属甲方（核心，治「把凡岛商标当慕可的」）：授权书里的商标注册号，其实际注册主体必须 = 甲方。
 *     - 命中 entity ≠ 甲方 → 硬告警(MAJOR/SUPPLEMENT)；
 *     - 命中且 = 甲方 → 通过；
 *     - 注册号不在库 → 💧提醒人工核（fail-open，别因库不全误判不符）。
 *
 * 本模块【纯逻辑，不自带网络/不读盘】：调用方注入
 *   - regIndex : Map/对象  归一化注册号(纯数字串) → { owner:'实际注册主体名', name, brand }
 *   - ourEntities : Array<{name, uscc?, aliases?:string[]}>  我司主体清单（境内+境外）
 *   - creditMap : (可选) Object  归一化主体名 → 统一社会信用代码/标识（权威源；无则降级💧）
 *
 * 全程 fail-open：任何取不到/结构异常/无库 → 只提醒或返回 []，绝不阻断审核。
 * 说明：表单能拿到的只是结构化字段；甲乙方/注册号若只在授权书图片正文里(needs_vision)，
 *       代码侧拿不到 → 降级💧提醒人工核，不臆断不符。
 */

// 归一化主体名：去空格、全角转半角、小写。
function normName(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase();
}
// 去公司类型后缀，便于「整体相等」比较（不做任意子串，杜绝子串冒充）。
function stripCorpSuffix(s) {
  return normName(s).replace(/(股份)?有限(责任)?公司$|分公司$|公司$|商行$|经营部$|经营中心$|工作室$|厂$/g, '');
}
// 提取 18 位统一社会信用代码（最强身份信号）。
function extractUSCC(s) {
  const m = String(s || '').match(/[0-9A-HJ-NP-RTUWXY]{18}/i);
  return m ? m[0].toUpperCase() : null;
}
// 归一化注册号：只留数字。
function normRegNo(s) {
  return String(s == null ? '' : s).replace(/\D/g, '');
}

// 把一个「主体串」解析到我司主体清单里的一条（USCC 精确 / 名称整体相等 / 去后缀整体相等 / 别名整体相等）。
// 命中返回该 entity 对象，否则 null。
function resolveOurEntity(raw, ourEntities) {
  const nm = normName(raw);
  if (!nm) return null;
  const stripped = stripCorpSuffix(raw);
  const uscc = extractUSCC(raw);
  for (const ie of (ourEntities || [])) {
    if (!ie || !ie.name) continue;
    if (uscc && ie.uscc && uscc === String(ie.uscc).toUpperCase()) return ie;
    if (nm === normName(ie.name)) return ie;
    if (stripped && stripped === stripCorpSuffix(ie.name)) return ie;
    const aliasHit = (ie.aliases || ie.alias || []).some(a => {
      const an = normName(a);
      return an && (nm === an || (stripped && stripped === an));
    });
    if (aliasHit) return ie;
  }
  return null;
}

// 从 form 取甲方(授权方=公司主体)。可能是数组。
function extractGrantor(form) {
  const cand = ['公司主体', '公司主体1', '申请主体全称', '申请公司', '公司全称', '授权方', '甲方'];
  for (const k of cand) {
    let v = form && form[k];
    if (Array.isArray(v)) v = v.filter(Boolean).join(' ');
    v = String(v == null ? '' : v).trim();
    if (v && !/其它|其他/.test(v)) return v;
  }
  return '';
}
// 从 form 取乙方(被授权方=资质流向方)。
function extractGrantee(form) {
  const cand = ['资质流向方全称（公司/自然人/平台）', '资质流向方', '相对方全称（公司/自然人全称）', '相对方全称', '被授权方', '乙方'];
  for (const k of cand) {
    let v = form && form[k];
    if (Array.isArray(v)) v = v.filter(Boolean).join(' ');
    v = String(v == null ? '' : v).trim();
    if (v) return v;
  }
  return '';
}
// 从 form 取授权商标注册号（可能多个：逗号/分号/顿号/空格分隔）。
function extractRegNos(form) {
  const cand = ['提供商标注册号', '提供注册号', '商标注册号', '注册号'];
  const out = [];
  for (const k of cand) {
    let v = form && form[k];
    if (v == null) continue;
    const arr = Array.isArray(v) ? v : [v];
    for (const item of arr) {
      String(item).split(/[,，;；、\s/]+/).forEach(p => {
        const n = normRegNo(p);
        if (n && n.length >= 4 && out.indexOf(n) === -1) out.push(n);
      });
    }
  }
  return out;
}

// regIndex 反查：接受 Map 或普通对象；键=归一化注册号。
function lookupReg(regIndex, regNo) {
  if (!regIndex) return null;
  if (typeof regIndex.get === 'function') return regIndex.get(regNo) || null;
  return regIndex[regNo] || null;
}

/**
 * @param {Object} form         解析后的表单
 * @param {Map|Object} regIndex 注册号(归一化) → { owner, name?, brand? } 反查索引
 * @param {Array} ourEntities   我司主体清单 [{name, uscc?, aliases?}]
 * @param {Object} [creditMap]  可选：归一化主体名 → 信用代码/标识（权威源）
 * @returns {Array} issue[]（可能多条；无问题→[]）。全程 fail-open。
 */
function checkTrademarkAuth(form, regIndex, ourEntities, creditMap) {
  const issues = [];
  try {
    const grantorRaw = extractGrantor(form);
    const granteeRaw = extractGrantee(form);
    const grantorEnt = resolveOurEntity(grantorRaw, ourEntities);
    const granteeEnt = resolveOurEntity(granteeRaw, ourEntities);

    // ── 1) 甲乙方主体：是否都是我司主体 ──
    // 只有「甲乙方都是我司主体」才算内部商标授权书；否则可能是对外授权(走别的规则)，此处不硬判，只在缺失时💧提醒。
    if (!grantorEnt || !granteeEnt) {
      const miss = [];
      if (grantorRaw && !grantorEnt) miss.push(`授权方(甲方)「${grantorRaw}」`);
      if (granteeRaw && !granteeEnt) miss.push(`被授权方(乙方)「${granteeRaw}」`);
      if (!grantorRaw) miss.push('授权方(甲方)未填/未识别');
      if (!granteeRaw) miss.push('被授权方(乙方)未填/未识别');
      issues.push({
        ruleId: 'R15', severity: 'MINOR', action: 'SUPPLEMENT', ref: '内部商标授权书-甲乙方主体',
        message: `【R15💧】内部商标授权书：${miss.join('、')}未匹配到我司主体清单，请人工确认甲乙方是否均为我司主体（若含对方主体则非内部授权，另按对外授权核）。`,
        detail: { grantor: grantorRaw, grantee: granteeRaw, grantor_matched: !!grantorEnt, grantee_matched: !!granteeEnt }
      });
    }

    // ── 2) 社会信用代码：有权威表则暴露供核；无则降级💧 ──
    const creditLines = [];
    let creditSourceMissing = false;
    for (const [role, ent, raw] of [['甲方', grantorEnt, grantorRaw], ['乙方', granteeEnt, granteeRaw]]) {
      if (!ent) continue;
      let code = ent.uscc || ent.tax_id || ent.reg_no || null;
      if (!code && creditMap) code = creditMap[normName(ent.name)] || null;
      if (code) creditLines.push(`${role}「${ent.name}」→ ${code}`);
      else creditSourceMissing = true;
    }
    if (creditLines.length > 0) {
      issues.push({
        ruleId: 'R15', severity: 'MINOR', action: 'CONFIRM', ref: '内部商标授权书-信用代码',
        message: `【R15】请核对授权书上主体名称与信用代码一致：${creditLines.join('；')}。`,
        detail: { credit: creditLines }
      });
    }
    if (creditSourceMissing || (!grantorEnt && grantorRaw) || (!granteeEnt && granteeRaw)) {
      issues.push({
        ruleId: 'R15', severity: 'MINOR', action: 'SUPPLEMENT', ref: '内部商标授权书-信用代码',
        message: '【R15💧】部分甲乙方主体缺权威信用代码，请人工核甲乙方统一社会信用代码是否正确（无结构化权威源，勿臆断）。',
        detail: { credit_source_incomplete: true }
      });
    }

    // ── 3) 授权商标归属甲方（核心）──
    const regNos = extractRegNos(form);
    if (regNos.length === 0) {
      // 注册号常只在授权书图片正文里（needs_vision）→ 表单拿不到，降级💧提醒。
      issues.push({
        ruleId: 'R15', severity: 'MINOR', action: 'SUPPLEMENT', ref: '内部商标授权书-商标归属',
        message: '【R15💧】未在表单识别到授权商标注册号，请人工核对：授权书内的商标注册号是否实际注册在授权方(甲方)名下（勿把 A 主体的商标当 B 主体授权）。',
        detail: { reg_nos: [] }
      });
    } else {
      const grantorNameNorm = grantorEnt ? normName(grantorEnt.name) : null;
      const grantorStripped = grantorEnt ? stripCorpSuffix(grantorEnt.name) : null;
      for (const rn of regNos) {
        const hit = lookupReg(regIndex, rn);
        if (!hit || !hit.owner) {
          // 注册号不在库 → fail-open 💧提醒（别因库不全误判不符）。
          issues.push({
            ruleId: 'R15', severity: 'MINOR', action: 'SUPPLEMENT', ref: '内部商标授权书-商标归属',
            message: `【R15💧】授权商标注册号 ${rn} 不在本地商标库，无法自动核归属，请人工确认其实际注册在授权方(甲方)名下。`,
            detail: { reg_no: rn, in_registry: false }
          });
          continue;
        }
        const ownerNorm = normName(hit.owner);
        const ownerStripped = stripCorpSuffix(hit.owner);
        const matchesGrantor = grantorEnt &&
          (ownerNorm === grantorNameNorm || (ownerStripped && ownerStripped === grantorStripped));
        if (grantorEnt && !matchesGrantor) {
          // 核心硬告警：商标实际注册主体 ≠ 甲方。
          issues.push({
            ruleId: 'R15', severity: 'MAJOR', action: 'SUPPLEMENT', ref: '内部商标授权书-商标归属',
            message: `【R15】授权商标 ${rn} 实际注册在【${hit.owner}】名下，与授权书授权方(甲方)【${grantorEnt.name}】不符，请核实归属（勿把 A 主体的商标当 B 主体授权）。`,
            detail: { reg_no: rn, actual_owner: hit.owner, grantor: grantorEnt.name, mismatch: true }
          });
        } else if (!grantorEnt) {
          // 甲方没识别出我司主体 → 只暴露实际归属供人工核，不硬告警。
          issues.push({
            ruleId: 'R15', severity: 'MINOR', action: 'SUPPLEMENT', ref: '内部商标授权书-商标归属',
            message: `【R15💧】授权商标 ${rn} 实际注册在【${hit.owner}】名下；授权方(甲方)未识别到我司主体，请人工核对甲方与商标归属是否一致。`,
            detail: { reg_no: rn, actual_owner: hit.owner, grantor_matched: false }
          });
        }
        // matchesGrantor === true → 通过，不产生 issue。
      }
    }
  } catch (e) {
    return []; // fail-open：任何异常绝不阻断审核。
  }
  return issues;
}

module.exports = {
  checkTrademarkAuth,
  resolveOurEntity,
  extractGrantor,
  extractGrantee,
  extractRegNos,
  normName,
  normRegNo,
};
