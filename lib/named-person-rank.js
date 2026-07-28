/**
 * named-person-rank.js — 平台账号「实名人职级」校验（代码化清单 #1，2026-07-04）
 *
 * 规则（知识库·通用规则 + 账号信息录入）：涉及平台账号绑定（是否涉及相关账号≠无）时，
 * 实名人的公司职级必须为「总监」或「高级经理」，否则需补充/修改。
 *
 * 数据源：飞书多维表格【各中心负责人（HR经理维护）】，实时查（不下载本地、永远最新）。
 * 表坐标 + 合格层级映射固化在 entities.json.named_person_rank_check（层级源表权限锁死，
 * 故用样例人解码：optFtgJqxL=总监 / opthXzAtVZ=高级经理，已实测校验通过）。
 *
 * 本模块是【纯逻辑】：不自带网络。调用方（audit-tool.cjs，有 larkApi）注入 fetchRecords。
 * 已测（2026-07-04）：李松梅→合格·总监、顾心怡→合格·高级经理、张馨文/陈志歌→不合格。
 */

// 提取实名人 open_id 列表：①扫顶层字段名含「实名人」的值；②钻进嵌套组件组（如「账号信息录入」是 widget 数组）扫 name 含「实名人」的子组件。
// 2026-07-08 修复：#34 米博有赞入驻的实名人嵌在「账号信息录入」组件组里、非顶层字段 → 原只扫顶层 → R13 静默漏审。
function extractNamedPersonIds(form) {
  const ids = [];
  const isOu = x => typeof x === 'string' && x.indexOf('ou_') === 0;  // 只认 open_id，滤掉 widget 自身 id 等假阳性
  const pushFrom = (item) => {
    if (!item) return;
    if (typeof item === 'string') { if (isOu(item)) ids.push(item); return; }
    if (typeof item === 'object') {
      if (Array.isArray(item.open_ids)) item.open_ids.forEach(x => isOu(x) && ids.push(x));
      const id = item.open_id || (item.user && (item.user.open_id || item.user.id)) || item.id;
      if (isOu(id)) ids.push(id);
    }
  };
  for (const k of Object.keys(form || {})) {
    const v = form[k];
    // ① 顶层字段名含「实名人」
    if (k.indexOf('实名人') !== -1) (Array.isArray(v) ? v : [v]).forEach(pushFrom);
    // ② 嵌套组件组：值可能是 [[...widgets...]] 双层包裹（如「账号信息录入」），flat 后扫 name 含「实名人」的子组件
    if (Array.isArray(v)) {
      for (const w of v.flat(Infinity)) {
        if (w && typeof w === 'object' && typeof w.name === 'string' && w.name.indexOf('实名人') !== -1) {
          pushFrom(w);
          if (w.value) (Array.isArray(w.value) ? w.value : [w.value]).forEach(pushFrom);
        }
      }
    }
  }
  return [...new Set(ids)];
}

// 是否触发校验：是否涉及相关账号 ≠ 无/空
function involvesAccount(form) {
  const v = String((form && (form['是否涉及相关账号'] || form['是否涉及账号'])) || '').trim();
  return v && v !== '无';
}

/**
 * @param {Object} form 解析后的表单
 * @param {Function} fetchRecords 无参 async/sync 函数，返回【各中心负责人】表全部 records（[{fields:{...}}]）
 * @param {Object} entities entities.json（读 named_person_rank_check 配置）
 * @returns {Object|null} 不合格→issue；合格/不适用/无法判定→null（fail-open，绝不因本校验阻断主流程）
 */
function checkNamedPersonRank(form, fetchRecords, entities) {
  try {
    const cfg = entities && entities.named_person_rank_check;
    if (!cfg) return null;
    if (!involvesAccount(form)) return null;
    const ids = extractNamedPersonIds(form);
    if (!ids.length) return null; // 没解析到实名人 open_id → 交给 AI/文字层，不在此硬判
    const records = fetchRecords() || [];
    const qids = Object.keys(cfg.qualified_level_ids || {});
    const classify = (openId) => {
      for (const r of records) {
        const p = ((r.fields || {})[cfg.person_field] || [])[0];
        const pid = p && (p.id || p.open_id);
        if (!pid || pid !== openId) continue;
        if ((r.fields[cfg.status_field]) !== cfg.require_status) continue;
        const active = ((r.fields[cfg.active_field]) || []).map(x => x.text || x).join(',');
        if (active.indexOf(cfg.require_active_contains) === -1) continue;
        const levels = (r.fields[cfg.level_field]) || [];
        const hit = levels.filter(l => qids.includes(l));
        if (hit.length) return hit.map(id => cfg.qualified_level_ids[id]).join('/');
      }
      return null;
    };
    const unqualified = ids.filter(id => !classify(id));
    if (unqualified.length === 0) return null; // 全部合格
    return {
      ruleId: 'R13', severity: 'MAJOR', action: 'SUPPLEMENT', ref: '通用规则-账号绑定',
      message: `【R13】平台账号绑定的实名人须为总监或高级经理。有 ${unqualified.length} 名实名人未在【各中心负责人】表中匹配到"在职·使用中·总监/高级经理"，请核对并改由符合职级的负责人实名（避免普通员工/离职人员绑定导致账号异常）。`,
      detail: { unqualified }
    };
  } catch (e) {
    return null; // fail-open：查表失败/结构异常绝不阻断审核
  }
}

module.exports = { checkNamedPersonRank, extractNamedPersonIds, involvesAccount };
