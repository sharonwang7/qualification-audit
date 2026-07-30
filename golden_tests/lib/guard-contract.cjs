// golden_tests/lib/guard-contract.cjs
// 守卫合约：待改代码后的 FAIR 守卫验证
// 这些函数 = 改代码后 fair 入口应实现的校验逻辑
// 黄金测试直接测这些函数的行为，与 audit-tool.cjs 解耦

// C05/C07: card_was_generated 守卫
// 条件：PENDING_REVIEW 案件存在 + card_map.json 不存在 → 拒绝 fair
function checkCardGeneratedGuard(pendingActions, cardMap) {
  if (!pendingActions || typeof pendingActions !== 'object') {
    return { pass: false, reason: 'pending_actions 不可读' };
  }
  // 是否含有 PENDING_REVIEW 状态的条目
  const hasPendingReview = Object.values(pendingActions)
    .filter(v => v && typeof v === 'object')
    .some(v => v.state === 'PENDING_REVIEW');

  if (!hasPendingReview) {
    return { pass: true, reason: '无 PENDING_REVIEW 案件，无需守卫' };
  }

  // card_map 检查
  if (!cardMap || typeof cardMap.generated_at !== 'string') {
    return {
      pass: false,
      reason: 'fair 拒绝：存在 PENDING_REVIEW 案件但卡片从未生成过（card_map.json 不存在或无效）。请先运行 gen-card 让用户看到审核结果后再执行 F/A/I/R。'
    };
  }

  return { pass: true, reason: 'card_map 存在，守卫放行' };
}

// C06: 1390001 链停守卫
// 条件：多个 fair 操作中有任意一个报 1390001(approval ended) → 后续操作全部跳过
function check1390001Stop(results) {
  if (!Array.isArray(results)) {
    return { pass: false, reason: 'results 应为数组' };
  }
  const stopIdx = results.findIndex(r => r && r.code === 1390001);
  if (stopIdx >= 0) {
    // 找到停止点，后续的应该全部标记为 skipped
    const after = results.slice(stopIdx + 1);
    const allSkipped = after.every(r => r && r._skippedByChainStop);
    return {
      pass: allSkipped,
      reason: allSkipped
        ? `链停在 idx=${stopIdx}，之后 ${after.length} 条已跳过`
        : `链停在 idx=${stopIdx}，但后有 ${after.length} 条未标记跳过`,
      stopIndex: stopIdx,
      skipped: after.length
    };
  }
  return { pass: true, reason: '无 1390001，全部正常' };
}

// C07: source 守卫（从 fair 命令行参数抽离）
// 条件：fair 命令必须来自用户聊天消息（source='message'），
//       自行构造的（source='agent'）拒绝
function checkSourceGuard(source) {
  if (!source || (source !== 'message' && source !== 'directive_token')) {
    return {
      pass: false,
      reason: `fair 拒绝：source=${source || 'undefined'}，FAIR 指令必须来自用户聊天消息，禁止 agent 自行构造并执行 F/A/I/R。`
    };
  }
  return { pass: true, reason: `source=${source} 放行` };
}

// 三元组测试：验证完整守卫链
function checkFairGuard(pendingActions, cardMap, source) {
  // 按顺序过守卫链
  const cardGuard = checkCardGeneratedGuard(pendingActions, cardMap);
  if (!cardGuard.pass) return cardGuard;

  // source 守卫仅在有 PENDING_REVIEW 案件时生效（保护待确认内容）
  // 全部 CLOSED 时无保护目标，允许 agent 来源操作
  if (source && source !== 'message' && source !== 'directive_token') {
    const hasPendingReview = Object.values(pendingActions || {})
      .filter(v => v && typeof v === 'object')
      .some(v => v.state === 'PENDING_REVIEW');
    if (hasPendingReview) {
      return { pass: false, reason: `fair 拒绝：source=${source}，存在 PENDING_REVIEW 案件时 FAIR 指令必须来自用户聊天消息，禁止 agent 自行构造并执行 F/A/I/R。` };
    }
  }

  return { pass: true, reason: '全部守卫通过' };
}

module.exports = { checkCardGeneratedGuard, check1390001Stop, checkSourceGuard, checkFairGuard };
