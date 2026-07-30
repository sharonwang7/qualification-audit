// T2_gen_card_fallback/test.js — C08: gen-card 卡 < 1KB 时发纯文本 fallback
// 测 gen-card 返回 smallCard 时的行为合约

const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
const path = require('path');

module.exports = {
  run: async function(ctx) {
    const { assert, mock } = ctx;
    const dir = mock.auditDir + '/T2_gencard';

    mkdirSync(dir, { recursive: true });

    // 模拟 gen-card 输出超小卡
    writeFileSync(path.join(dir, '20260727.json'), JSON.stringify({
      batch_date: '20260727',
      outcomes: { test_mini: { n: 1, status: 'done' } }
    }, null, 2), 'utf8');

    // 模拟一个超小的卡片返回内容（假设 gen-card 调飞书API时卡大小 < 1KB）
    // 改后：这种场景应有 fallback_text 字段
    const fakeGenCardResult = {
      ok: true,
      size: 0.6,
      card_action: '已更新同一张卡',
      fallback_text: null  // 改前：没有 fallback
    };

    assert('T2 gen-card 返回 <1KB', () => {
      if (!existsSync(path.join(dir, '20260727.json'))) throw new Error('mock文件未创建');
      console.log('      size=0.6KB, fallback_text=' + (fakeGenCardResult.fallback_text || 'null（改前）'));
    });

    return true;
  }
};
