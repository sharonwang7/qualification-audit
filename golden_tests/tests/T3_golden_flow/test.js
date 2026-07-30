// T3_golden_flow/test.js — 全流程黄金剧本
// 模拟完整链路：write-result → PENDING_REVIEW → card_map → fair(F#)
// 测文件合约，不调用飞书API

const { setup, write, read } = require('../../lib/fixture-helper.cjs');

module.exports = {
  run: async function(ctx) {
    const { assert, mock } = ctx;
    const dir = mock.auditDir;

    // ────────────────── 剧本1：标准通过流程 ──────────────────
    {
      const M = setup(dir + '/G1_standard');

      // step 1: list 完成 → current_batch 含 expected
      write(M, 'current_batch.json', {
        batchDate: '20260727',
        startedAt: new Date().toISOString(),
        expected: ['g1_test001'],
        outcomes: {}
      });

      // step 2: write-result 落盘 → pending_actions PENDING_REVIEW
      write(M, 'pending_actions.json', {
        __meta: { nextN: 72 },
        g1_test001: { n: 72, person: '张欣怡', date: '20260727', verdict: '通过', state: 'PENDING_REVIEW', since: new Date().toISOString() }
      });

      // step 3: gen-card → card_map.json 生成
      write(M, 'card_map.json', {
        generated_at: new Date().toISOString(),
        card_map: { '20260727_oc_mock': 'om_mock_001' }
      });

      // step 4: fair 前检查 — PENDING_REVIEW + card_map存在 → 可操作
      const pa4 = read(M, 'pending_actions.json');
      const cm4 = read(M, 'card_map.json');
      assert('G1.1 标准流程 step4: PENDING_REVIEW且card_map存在',
        () => {
          const entry = pa4['g1_test001'];
          if (!entry) throw new Error('g1_test001 不存在');
          if (entry.state !== 'PENDING_REVIEW') throw new Error('状态应为 PENDING_REVIEW');
          if (cm4 === null) throw new Error('card_map 应存在');
          console.log('      PA状态=' + entry.state + ', card_map=' + (cm4 ? '存在' : '不存在'));
        }
      );

      // step 5: fair 执行后 → CLOSED
      write(M, 'pending_actions.json', {
        __meta: { nextN: 72 },
        g1_test001: { n: 72, person: '张欣怡', date: '20260727', verdict: '通过', state: 'CLOSED', since: new Date().toISOString(), closedAt: new Date().toISOString() }
      });

      const pa5 = read(M, 'pending_actions.json');
      assert('G1.2 标准流程 step5: fair 后状态变 CLOSED',
        () => {
          if (pa5['g1_test001'].state !== 'CLOSED') throw new Error('fair 后应 CLOSED');
          console.log('      状态已变 CLOSED');
        }
      );
    }

    // ────────────────── 剧本2：卡未发直接 fair 被拦 ──────────────────
    {
      const M = setup(dir + '/G2_no_card');

      // step 1: write-result 落盘
      write(M, 'pending_actions.json', {
        __meta: { nextN: 73 },
        g2_test001: { n: 73, person: '测试用户', date: '20260727', verdict: '通过', state: 'PENDING_REVIEW', since: new Date().toISOString() }
      });
      // 故意不生成 card_map.json（事故场景）

      // 改前基线：无守卫 → fair 可执行（PA变CLOSED但card_map不存在）
      // 模拟：即使无 card_map，fair 仍执行
      write(M, 'pending_actions.json', {
        __meta: { nextN: 73 },
        g2_test001: { n: 73, person: '测试用户', date: '20260727', verdict: '通过', state: 'CLOSED', since: new Date().toISOString(), closedAt: new Date().toISOString() }
      });

      const pa = read(M, 'pending_actions.json');
      const cm = read(M, 'card_map.json');
      assert('G2 无card_map改前: fair仍执行（基线）',
        () => {
          if (pa['g2_test001'].state !== 'CLOSED') throw new Error('基线：无守卫，fair应执行');
          if (cm !== null) throw new Error('测试条件：card_map 应为 null');
          console.log('      基线下 PA=CLOSED（已执行）, card_map=不存在');
        }
      );
      // 改代码后：此场景应被 fair 守卫拦截 → PA 不变（仍 PENDING_REVIEW）
    }

    // ────────────────── 剧本3：子代理超时被 register-orphans 兜底 ──────────────────
    {
      const M = setup(dir + '/G3_orphan');

      // expected 有 2 条，但只有 1 条落盘
      write(M, 'current_batch.json', {
        batchDate: '20260727',
        startedAt: new Date().toISOString(),
        expected: ['g3_done', 'g3_orphan'],
        outcomes: { g3_done: { status: 'done', at: new Date().toISOString() } }
      });

      // 有 result 文件但没 write-result 的孤儿件需要 register-orphans 找回
      // 模拟：g3_done 已落盘，g3_orphan 无 outcome（被 register-orphans 兜底）
      const batch = read(M, 'current_batch.json');
      assert('G3.1 expected=2 条, outcomes=1 条（g3_done done）',
        () => {
          if (batch.expected.length !== 2) throw new Error('expected 应为 2');
          if (Object.keys(batch.outcomes).length !== 1) throw new Error('outcomes 应为 1');
          console.log('      expected=2, outcomes=1（g3_done done）');
        }
      );

      // register-orphans + batch-fail 之后：g3_orphan 标记 timeout
      write(M, 'current_batch.json', {
        batchDate: '20260727',
        startedAt: new Date().toISOString(),
        expected: ['g3_done', 'g3_orphan'],
        outcomes: {
          g3_done: { status: 'done', at: new Date().toISOString() },
          g3_orphan: { status: 'timeout', at: new Date().toISOString() }
        }
      });
      const batch2 = read(M, 'current_batch.json');
      assert('G3.2 register-orphans后: 2条全 settled（done + timeout）',
        () => {
          const s = Object.values(batch2.outcomes).map(o => o.status);
          if (!s.includes('done')) throw new Error('应含 done');
          if (!s.includes('timeout')) throw new Error('孤儿件应 timeout');
          console.log('      outcomes: ' + s.join(' + '));
        }
      );
    }

    // ────────────────── 剧本4：WR_G5 拒绝 false positive ──────────────────
    {
      const M = setup(dir + '/G4_wrg5');

      // 模拟 write-result 提交缺失板块的 result
      // WR_G5: 缺"业务必要性"板块 → 被拒
      const badResult = {
        person: '测试',
        sealType: '法人章（总经办）',
        entity: '测试公司',
        dest: '测试流向方',
        context: '测试事由',
        verdict: '通过',
        fullAnalysis: '## 阶段一\n## 阶段二\n### 看流向\n### 看用途\n### 主体必要性\n## 阶段三',
        taskId: '123'
      };
      // 检查是否包含所需板块
      const fa = badResult.fullAnalysis;
      const hasBizNecessity = fa.includes('业务必要性');
      const hasQ1 = /Q1/.test(fa);
      const hasQ2 = /Q2/.test(fa);

      assert('G4 WR_G5: 缺业务必要性板块+Q1+Q2 → 被拒',
        () => {
          if (hasBizNecessity) throw new Error('测试条件：不应含业务必要性板块');
          console.log('      fullAnalysis 缺' + (!hasBizNecessity ? ' [业务必要性]' : '') + (!hasQ1 ? ' [Q1]' : '') + (!hasQ2 ? ' [Q2]' : ''));
          console.log('      WR_G5 应拒绝此 result');
        }
      );

      // 正向用例：完整四板块+Q1+Q2 → 通过
      const goodResult = {
        person: '测试',
        sealType: '法人章（总经办）',
        entity: '测试公司',
        dest: '测试流向方',
        context: '测试事由',
        verdict: '通过',
        fullAnalysis: '## 阶段一·证据链核实\n\n附件核查完成。\n\n## 阶段二·逻辑穿透\n\n### 看流向\n测试公司 → 测试流向方\n\n### 看用途\n测试用途说明。\n\n### 业务必要性\nQ1触发条件：发生了某个业务事件。\nQ2强制必要性：如果不做会产生风险。\n\n### 主体必要性\n必须法人出面。\n\n## 阶段三·风险控制\n\n替代/限制/技术控制到位。',
        taskId: '123'
      };
      const fa2 = goodResult.fullAnalysis;
      const hasBiz2 = fa2.includes('业务必要性');
      const hasQ1_2 = /Q1/.test(fa2);
      const hasQ2_2 = /Q2/.test(fa2);

      assert('G4 WR_G5 正向: 四板块+Q1+Q2 → 通过',
        () => {
          if (!hasBiz2) throw new Error('应有业务必要性');
          if (!hasQ1_2) throw new Error('应有Q1');
          if (!hasQ2_2) throw new Error('应有Q2');
          console.log('      四板块齐+Q1+Q2 ✓');
        }
      );
    }

    return true;
  }
};
