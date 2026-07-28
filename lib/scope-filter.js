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

module.exports = { isInScope, MY_AUDIT_QUALS };
