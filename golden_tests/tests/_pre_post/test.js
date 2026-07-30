// golden_tests/tests/_pre_post/test.js — 守卫合约的改前/改后对比测试
// 改前跑 → 所有 '改后GET断' 的断言应失败（守卫不存在）
// 改后跑 → 所有 '改后GET断' 的断言应通过（守卫生效）

const { checkCardGeneratedGuard, check1390001Stop, checkSourceGuard, checkFairGuard } = require('../../lib/guard-contract.cjs');

module.exports = {
  run: async function(ctx) {
    const { assert } = ctx;

    // ═══════════ C05 + C07: card_was_generated + source 守卫 ═══════════

    // 场景 A: PENDING_REVIEW + 无 card_map + source=agent → 改后：拒绝
    {
      const pa = { test001: { n: 1, person: '测试', date: '20260727', verdict: '通过', state: 'PENDING_REVIEW' }};
      const result = checkFairGuard(pa, null, 'agent');
      // 基线通过（无守卫），改后应拒绝
      // 所以改前这个断言应该 FAIL，改后 PASS
      assert('[C05C07:A] PENDING_REVIEW + 无card_map + source=agent → 拒绝',
        () => {
          if (result.pass !== false) throw new Error('改后期望：拒绝');
          if (!result.reason.includes('拒绝')) throw new Error('应有拒绝原因');
          console.log('      拒绝: ' + result.reason.slice(0,60));
        }
      );
    }

    // 场景 B: PENDING_REVIEW + 有 card_map + source=message → 改前改后都通过
    {
      const pa = { test002: { n: 2, person: '测试', date: '20260727', verdict: '通过', state: 'PENDING_REVIEW' }};
      const cm = { generated_at: new Date().toISOString(), card_map: { k: 'v' }};
      const result = checkFairGuard(pa, cm, 'message');
      assert('[C05C07:B] PENDING_REVIEW + 有card_map + source=message → 通过',
        () => {
          if (result.pass !== true) throw new Error('期望通过: ' + result.reason);
          console.log('      通过: ' + result.reason);
        }
      );
    }

    // 场景 C: PENDING_REVIEW + 有 card_map + source=agent → 改后拒绝（source守卫）
    {
      const pa = { test003: { n: 3, person: '测试', date: '20260727', verdict: '通过', state: 'PENDING_REVIEW' }};
      const cm = { generated_at: new Date().toISOString(), card_map: { k: 'v' }};
      const result = checkFairGuard(pa, cm, 'agent');
      assert('[C05C07:C] 有card_map但source=agent → 拒绝',
        () => {
          if (result.pass !== false) throw new Error('改后期望：source守卫拒绝');
          console.log('      拒绝: ' + (result.reason || '').slice(0,60));
        }
      );
    }

    // 场景 D: CLOSED + 无 card_map + source=agent → 通过（无需守卫）
    {
      const pa = { test004: { n: 4, person: '测试', date: '20260727', verdict: '通过', state: 'CLOSED' }};
      const result = checkFairGuard(pa, null, 'agent');
      assert('[C05C07:D] CLOSED + 无card_map + source=agent → 通过',
        () => {
          if (result.pass !== true) throw new Error('CLOSED案件应放行: ' + result.reason);
          console.log('      通过（无需守卫）');
        }
      );
    }

    // ═══════════ C06: 1390001 链停 ═══════════

    // 场景 E: 全部成功 → 不停链
    {
      const results = [
        { code: 0, message: 'ok' },
        { code: 0, message: 'ok' },
        { code: 0, message: 'ok' },
      ];
      const result = check1390001Stop(results);
      assert('[C06:E] 全部成功 → 不停链',
        () => {
          if (result.pass !== true) throw new Error('应全部放行');
          console.log('      全部放行');
        }
      );
    }

    // 场景 F: 中间一条 1390001 → 后续应跳过
    {
      const results = [
        { code: 0, message: 'ok' },
        { code: 1390001, message: 'Current approval process has ended.' },
        { code: 0, message: 'should not run', _skippedByChainStop: true },
        { code: 0, message: 'should not run', _skippedByChainStop: true },
      ];
      const result = check1390001Stop(results);
      assert('[C06:F] 1390001在中 → 停链后2条跳过',
        () => {
          if (result.pass !== true) throw new Error('应停链并标记跳过: ' + (result.reason || ''));
          console.log('      停链: ' + (result.reason || ''));
        }
      );
    }

    // 场景 G: 第一条 1390001 → 全部跳
    {
      const results = [
        { code: 1390001, message: 'ended' },
        { _skippedByChainStop: true },
        { _skippedByChainStop: true },
      ];
      const result = check1390001Stop(results);
      assert('[C06:G] 第一条1390001 → 全部跳',
        () => {
          if (result.pass !== true) throw new Error('应全部跳过');
          console.log('      全部跳过: ' + (result.reason || ''));
        }
      );
    }

    return true;
  }
};
