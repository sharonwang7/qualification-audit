/**
 * scope-filter.js - 管辖范围过滤
 * 职责：判断一条资质申请是否在当前AI的管辖范围内
 */

// P1-4: 总经办管理的资质类型
// P0-S 修复：法人/法定代表人/董事/股东 类用「词根」覆盖全部变体——
//   isInScope 用 `资质值.includes(词根)` 匹配，故 "法定代表人扫脸（总经办）"、"法人验证码"、
//   "法人手机验证码"、"董事长"、"股东" 等都能命中，杜绝变体被判 out-of-scope 静默漏审。
// ⚠️ 若有行政归口的同根资质（如某些 …（行政）项）不应由总经办审，请在确认真实资质枚举后于此排除。
const MY_AUDIT_QUALS = [
  '法定代表人','法人','董事','股东',
  '品牌授权书','商标注册证','商标授权书',
  // 2026-07-05：加通用「授权书」词根，覆盖 销售授权书/经销授权书/代理授权书 等所有授权书类
  //（审核本就管授权书类；陈晶锶「其它/销售授权书续期」曾因不含「品牌/商标授权书」子串被误判越界）。
  '授权书'
  // ⚠️ 2026-07-05 用户定界：印章刻制（发货专用章/公章等）属【行政】，非总经办管辖，勿加「专用章/公章/印章」词根。
  //   总经办管的印章仅「法人章/法定代表人章」——已被上面 法人/法定代表人 词根覆盖（法人章含「法人」）。
];

function isInScope(formMap) {
  // 兼容旧版表单（拟用资质）和新版表单（申请资质）
  const qField = formMap['申请资质'] || formMap['拟用资质'];
  const quals = Array.isArray(qField) ? qField : [qField];
  
  // 检查是否有任何资质在管辖范围内
  for (const qual of quals) {
    if (!qual) continue;
    for (const scopeQual of MY_AUDIT_QUALS) {
      if (qual.includes(scopeQual)) return true;
    }
  }
  
  // "其他/其它"类：scope 判断推迟到 cmdCase 与附件文本合并判（见 audit-tool.cjs）
  return false;
}

// ── 角色过滤（Monorepo v3.0）──
const FAREN_KEYWORDS = ['法定代表人', '法人', '董事', '股东'];
const FEIFAREN_KEYWORDS = ['品牌授权书', '商标注册证', '商标授权书', '授权书'];

function isInMyRole(sealTypeStr) {
  const ROLE = process.env.QUAL_AUDIT_ROLE;
  if (!ROLE) return true;
  const hasFaren = FAREN_KEYWORDS.some(k => sealTypeStr.includes(k));
  const hasFeifaren = FEIFAREN_KEYWORDS.some(k => sealTypeStr.includes(k));
  // faren = 只看法人词根，品牌授权书/商标类不进（各管各的）
  if (ROLE === 'faren') return hasFaren;
  if (ROLE === 'feifaren') return hasFeifaren && !hasFaren;
  return true;
}

// ── 唯一收口（P0-3, 2026-07-29）：一条件"是否属本岗位的工作清单" ──
// cmdList(BUILD_WL) 与 cmdCase 原来各自内联同一段 `isInMyRole(q) || q.includes('其它')`，
//   v3.0 迁移时曾漏了 list 那处（品牌授权书串进法人岗）。此处收成唯一函数，两处都调它，杜绝"加一处漏一处"。
// 语义与原内联逐字等价：本岗位管辖 OR「其它」类（其它留到 case 里判归属，不在此拦）。
function isMyWorklistRole(qualStr) {
  const s = String(qualStr || '');
  return isInMyRole(s) || s.includes('其它');
}

module.exports = { isInScope, isInMyRole, isMyWorklistRole, MY_AUDIT_QUALS, FAREN_KEYWORDS, FEIFAREN_KEYWORDS };
