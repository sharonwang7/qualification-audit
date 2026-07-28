/**
 * phone-roster-check.js — 实名手机号「是否公司名录号」确定性校验（代码化清单 #2，2026-07-09）
 *
 * 规则：涉及平台账号（是否涉及相关账号 ≠ 无）时，账号手机号必须是公司手机号名录里的号，
 * 防「账号绑个人号 / 员工离职后失控」。
 *
 * 数据源：飞书多维表格【11.26手机卡确认】【AI使用】视图，实时查（不下载本地、永远最新）。
 * 表坐标固化在 entities.json.phone_roster_check。手机号字段=手机卡号码（fldedUjL4h，纯11位串、无空格无+86）。
 *
 * 本模块是【纯逻辑】：不自带网络。调用方（audit-tool.cjs，有 larkApi）注入 fetchRoster（返回名录手机号集合）。
 * 全程 fail-open：取不到号/查表失败/结构异常，只提醒或返回 null，绝不阻断审核。
 *
 * 触发条件（2026-07-23 王爷改）：与 R13 统一，用「是否涉及相关账号 ≠ 无」判定，弃用已下线的「是否需要实名」字段。
 */

// 复用 R13 的触发判定（单一事实源）：是否涉及相关账号 ≠ 无/空。
const { involvesAccount } = require('./named-person-rank.js');

// 规范化手机号：只留数字，去 +86/86 前缀、去空格/连字符。返回 11 位号或空串。
function normPhone(raw) {
  let s = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (s.length === 13 && s.indexOf('86') === 0) s = s.slice(2); // 86 + 11位
  else if (s.length === 14 && s.indexOf('086') === 0) s = s.slice(3);
  return s;
}

// 从 form 提取账号手机号。手机号嵌在「账号信息录入」组件组里（widget name=手机号），
// 也兜底扫顶层含「实名手机号/手机号」的字段。触发判定不在此（由 involvesAccount 负责）。
function extractPhoneContext(form) {
  let phone = '';
  const walkWidgets = (arr) => {
    for (const w of arr.flat(Infinity)) {
      if (!w || typeof w !== 'object' || typeof w.name !== 'string') continue;
      const nm = w.name;
      // widget 名精确是「手机号」或含「实名手机号」；排除「换手机号」等无关项由取到即用
      if ((nm === '手机号' || nm.indexOf('实名手机号') !== -1 || nm === '手机号码') && !phone) {
        const p = normPhone((w.value && w.value.text) || w.value || '');
        if (p) phone = p;
      }
    }
  };
  for (const k of Object.keys(form || {})) {
    const v = form[k];
    // 顶层「实名手机号 / 手机号」字段
    if (!phone && (k.indexOf('实名手机号') !== -1 || k === '手机号' || k === '手机号码')) {
      const p = normPhone(Array.isArray(v) ? v[0] : v);
      if (p) phone = p;
    }
    // 嵌套组件组（如「账号信息录入」）
    if (Array.isArray(v)) walkWidgets(v);
  }
  return { phone };
}

/**
 * @param {Object} form 解析后的表单
 * @param {Function} fetchRoster 无参 async/sync，返回公司名录手机号「规范化后」的 Set/数组（[normPhone(...)]）
 * @param {Object} entities entities.json（读 phone_roster_check 配置，仅作开关；无则跳过）
 * @returns {Object|null} 需提醒→issue；命中名录/不适用→null（fail-open）
 */
function checkPhoneRoster(form, fetchRoster, entities) {
  try {
    const cfg = entities && entities.phone_roster_check;
    if (!cfg) return null;
    // 触发闸（2026-07-23 王爷改）：只有「是否涉及相关账号 ≠ 无」才查企业手机号；弃用旧「是否需要实名」字段。
    if (!involvesAccount(form)) return null;
    const { phone } = extractPhoneContext(form);
    // 涉及账号却取不到手机号 → 弱提醒（涉及账号本应登记企业手机号）
    if (!phone) {
      return {
        ruleId: 'R14', severity: 'MINOR', action: 'SUPPLEMENT', ref: '账号-公司手机号名录',
        message: '【R14💧】本件涉及相关账号，但未识别到企业手机号，请确认账号手机号为公司名录手机号（防绑个人号/员工离职失控）。'
      };
    }
    const rosterArr = fetchRoster() || [];
    const roster = new Set([].concat(rosterArr).map(normPhone).filter(Boolean));
    if (roster.size === 0) return null; // 名录空/查表失败 → fail-open，不臆断"不在名录"
    if (roster.has(phone)) return null; // 命中名录 → 通过，不阻断
    const masked = phone.length >= 7 ? phone.slice(0, 3) + '****' + phone.slice(-4) : phone;
    return {
      ruleId: 'R14', severity: 'MAJOR', action: 'SUPPLEMENT', ref: '账号-公司手机号名录',
      message: `【R14】账号手机号 ${masked} 不在公司手机号名录【AI使用】，需确认为公司号（防账号绑个人号/员工离职失控）。`,
      detail: { phone_masked: masked }
    };
  } catch (e) {
    return null; // fail-open：查表失败/结构异常绝不阻断审核
  }
}

module.exports = { checkPhoneRoster, extractPhoneContext, normPhone };
