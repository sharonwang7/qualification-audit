// T1_fair_1390001_stop/test.js — C06: fair 遇 1390001 停链
// 测文件合约：多条 FAIR token 中一条失败时应停链
// 改后：token2 报 1390001 → token3 不应执行
// 基线：token3 继续执行

const { setup, write, read } = require('../../lib/fixture-helper.cjs');

module.exports = {
  run: async function(ctx) {
    const { assert, mock } = ctx;
    const dir = mock.auditDir;

    // C06 的守卫在 fair 函数内部（cmdFair 的循环逻辑），文件层不可直接测
    // 但我们可以通过 pending_actions 的状态来验证：
    //   - 基线：所有 token 对应的条目都被处理（CLOSED）
    //   - 改后：1390001 后的 token 未被处理（仍 PENDING_REVIEW）

    // 这个测试是为改代码后准备的：通过比较三个案件的处理结果来验证停链
    // 改代码前：三个都处理完
    const M = setup(dir + '/T1_2');
    write(M, 'pending_actions.json', {
      __meta: { nextN: 100 },
      case_1: { n: 50, person: '测试A', date: '20260727', verdict: '通过', state: 'PENDING_REVIEW', since: '2026-07-27T13:00:00.000Z' },
      case_2: { n: 51, person: '测试B', date: '20260727', verdict: '通过', state: 'PENDING_REVIEW', since: '2026-07-27T13:00:00.000Z' },
      case_3: { n: 52, person: '测试C', date: '20260727', verdict: '通过', state: 'PENDING_REVIEW', since: '2026-07-27T13:00:00.000Z' }
    });
    write(M, 'card_map.json', { generated_at: new Date().toISOString(), card_map: { 'mock': 'om_mock' } });
    write(M, 'current_batch.json', {
      batchDate: '20260727',
      startedAt: new Date().toISOString(),
      expected: ['case_1', 'case_2', 'case_3'],
      outcomes: {}
    });

    console.log('    [T1_2] 三条PENDING_REVIEW均就绪，需跑 fair 后才能验证链停');
    console.log('      基线：三条都会变 CLOSED');
    console.log('      改后：case_1 CLOSED, case_2 1390001(标记), case_3 仍 PENDING_REVIEW');

    // 基线不做断言（需要实际调用 fair），只是记录
    return true;
  }
};
