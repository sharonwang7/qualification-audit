// T1_fair_no_card_guard/test.js — 与 T1_fair_source_guard 合并
// C05（card_was_generated 守卫）和 C07（source 守卫）是同一份守卫的两个视角
// C05 由 T1_fair_source_guard 的 1.1a 覆盖（PENDING_REVIEW + 无 card_map）
// 本文件仅作占位注册

module.exports = {
  run: async function(ctx) {
    ctx.assert('T1_fair_no_card_guard: 已合并到 T1_fair_source_guard', () => true);
    return true;
  }
};
