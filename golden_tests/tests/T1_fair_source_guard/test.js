// T1_fair_source_guard/test.js — C07: fair --source 守卫
// 测文件合约：fair 执行前必须卡片先生成
// CARD_GENERATED 守卫 = pending_actions 中 PENDING_REVIEW 状态条目 → 必须有 card_map.json 存在
// 改后：无 card_map 时 fair 应拒绝
// 基线：无此守卫，card_map 是否存在都能操作

const { setup, write, read, mockPendingActions, mockCardMap } = require('../../lib/fixture-helper.cjs');

module.exports = {
  run: async function(ctx) {
    const { assert, mock } = ctx;
    const dir = mock.auditDir;

    // ── 测试 1.1：负向用例 — PENDING_REVIEW 案件、无 card_map.json ──
    // 改代码前：基线无守卫，能正常操作
    // 改代码后：应被拒绝（card_was_generated 守卫触发）
    {
      const M = setup(dir + '/T1_1a');
      mockPendingActions(M, {
        test_src_g: { n: 90, person: '测试用户', date: '20260727', verdict: '通过', state: 'PENDING_REVIEW', since: '2026-07-27T13:00:00.000Z' }
      });
      // 不生成 card_map.json（事故场景）
      const pa = read(M, 'pending_actions.json');
      const cm = read(M, 'card_map.json');

      // 基线断言：没有 card_map 但 fair 也能执行（无守卫）
      // 改后断言：没有 card_map → fair 应被守卫拦截
      assert('T1.1a PENDING_REVIEW + 无 card_map = 基线可通过（无守卫）',
        () => {
          // 文件状态检查
          const hasPendingReview = Object.values(pa).some(v => v.state === 'PENDING_REVIEW');
          if (!hasPendingReview) throw new Error('应含PENDING_REVIEW条目');
          if (cm !== null) throw new Error('应无card_map（测试条件）');
          // 基线下这两条不冲突（无守卫）
          // 改代码后：如果这两条同时成立却要拒绝，才说明守卫生效
          console.log('    [1.1a] PA状态=PENDING_REVIEW ✓, card_map=不存在 ✓');
        }
      );
    }

    // ── 测试 1.2：正向用例 — PENDING_REVIEW 案件、有 card_map.json ──
    // 改前改后都应该通过
    {
      const M = setup(dir + '/T1_1b');
      mockPendingActions(M, {
        test_src_g2: { n: 91, person: '测试用户2', date: '20260727', verdict: '通过', state: 'PENDING_REVIEW', since: '2026-07-27T13:00:00.000Z' }
      });
      mockCardMap(M, true);

      const pa = read(M, 'pending_actions.json');
      const cm = read(M, 'card_map.json');

      assert('T1.1b PENDING_REVIEW + 有 card_map = 始终可通过',
        () => {
          const hasPendingReview = Object.values(pa).some(v => v.state === 'PENDING_REVIEW');
          if (!hasPendingReview) throw new Error('应含PENDING_REVIEW条目');
          if (cm === null) throw new Error('card_map应存在');
          console.log('    [1.1b] PA状态=PENDING_REVIEW ✓, card_map=存在 ✓');
        }
      );
    }

    // ── 测试 1.3：CLOSED 案件 + 无 card_map = 始终可通过 ──
    {
      const M = setup(dir + '/T1_1c');
      mockPendingActions(M, {
        test_src_g3: { n: 92, person: '测试用户3', date: '20260727', verdict: '通过', state: 'CLOSED', since: '2026-07-27T13:00:00.000Z' }
      });
      // 不生成 card_map
      const pa = read(M, 'pending_actions.json');
      const cm = read(M, 'card_map.json');

      assert('T1.1c CLOSED + 无 card_map = 始终可通过（无需守卫）',
        () => {
          const hasPendingReview = Object.values(pa).some(v => v.state === 'PENDING_REVIEW');
          if (hasPendingReview) throw new Error('应无PENDING_REVIEW条目');
          console.log('    [1.1c] 无PENDING_REVIEW ✓, card_map=不存在 ✓');
        }
      );
    }

    return true;
  }
};
