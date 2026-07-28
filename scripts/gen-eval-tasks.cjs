#!/usr/bin/env node
/**
 * gen-eval-tasks.cjs — 生成 golden case 评估任务清单
 *
 * 用途：为每个 golden case 生成"agent 应该审核的 input"，包含：
 *   - SKILL.md 三阶段审核框架
 *   - 该 case 的表单/附件/事由
 *   - 人工真值结论（供对比）
 *
 * 输出：markdown + JSON，便于 agent 批评估。
 * 用法：node scripts/gen-eval-tasks.cjs > eval-tasks.md
 */
const fs = require('fs');
const path = require('path');

const GOLDEN_DIR = process.env.QUAL_GOLDEN_DIR
  || path.join(__dirname, '..', '.dev', 'golden_set');

function formatInput(input) {
  const form = input.form || {};
  const attachCount = (input.attachments || []).length;
  return `
**申请编号**：${form['审批编号'] || '?'}
**申请人**：${form['申请人'] || '?'}
**申请资质**：${(() => {
  const qs = form['申请资质'] || form['拟用资质'] || [];
  const qlist = Array.isArray(qs) ? qs : [qs];
  return qlist.join('、') || '?';
})()}
**流向方**：${form['资质流向方全称（公司/自然人/平台）'] || form['相对方全称（公司/自然人全称）'] || '?'}
**事由**：${form['申请事由'] || '?'}
**附件**：${attachCount} 个

${attachCount > 0 ? '**附件摘要**：\n' + (input.attachments || []).slice(0, 3).map((a, i) =>
  `- ${a.source || `attach_${i+1}`}: ${(a.content || '').slice(0, 100).replace(/\n/g, ' ')}...`
).join('\n') : ''}
`;
}

function main() {
  if (!fs.existsSync(GOLDEN_DIR)) {
    console.error('找不到 examples/golden_set/');
    process.exit(1);
  }

  const dirs = fs.readdirSync(GOLDEN_DIR)
    .filter(d => fs.statSync(path.join(GOLDEN_DIR, d)).isDirectory())
    .sort();

  console.log('# 资质审核 Golden 评估任务清单');
  console.log();
  console.log('本清单包含所有 golden case 的评估任务。Agent 应按 SKILL.md 三阶段框架独立审核每个 case，产出结论，然后对比"人工真值结论"。');
  console.log();
  console.log('---');
  console.log();

  const allCases = [];
  for (const d of dirs) {
    const inputPath = path.join(GOLDEN_DIR, d, 'input.json');
    const expPath = path.join(GOLDEN_DIR, d, 'expected.json');

    if (!fs.existsSync(inputPath) || !fs.existsSync(expPath)) continue;

    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const exp = JSON.parse(fs.readFileSync(expPath, 'utf8'));
    const exp_det = exp.expected || exp;

    const caseInfo = {
      id: d,
      conclusion_key: exp_det.conclusion_key || '?',
      scene: exp_det.scene || '?',
      known_ai_miss: exp.known_ai_miss === true,
      summary: input._note || '（无备注）'
    };

    console.log(`## ${d}`);
    console.log();
    console.log(`**备注**：${caseInfo.summary}`);
    console.log();
    console.log('### 输入');
    console.log(formatInput(input));
    console.log();
    console.log('### 人工真值结论');
    console.log(`- **结论**：${caseInfo.conclusion_key}`);
    console.log(`- **场景**：${caseInfo.scene}`);
    if (caseInfo.known_ai_miss) console.log(`- ⚠️ **已知 AI 判错**：本结论曾被 AI 错判`);
    console.log();
    console.log('### Agent 评估');
    console.log('按 SKILL.md 流程审核本 case：');
    console.log('1. **范围判定（步骤 0）**：资质是否在总经办审核范围内？');
    console.log('2. **三阶段分析（步骤 1-3）**：');
    console.log('   - 证据链（步骤 1）：证据是否充分、是否被证明？');
    console.log('   - 四维度（步骤 2）：目的、背景、必要、替代性');
    console.log('   - 红线规则（步骤 3）：是否触发过滤规则？');
    console.log('3. **结论**：基于上述分析，给出 pass / request_info / reject / manual_review');
    console.log();
    console.log('**预期**：你的结论应该与"人工真值结论"一致。若不一致，分析差异原因。');
    console.log();
    console.log('---');
    console.log();

    allCases.push(caseInfo);
  }

  console.log('## 评估汇总');
  console.log();
  console.log('| Case | 人工真值 | 场景 | 备注 |');
  console.log('|------|---------|------|------|');
  for (const c of allCases) {
    const note = c.known_ai_miss ? '⚠️ 已知 AI 误判' : '';
    console.log(`| ${c.id} | ${c.conclusion_key} | ${c.scene} | ${note} |`);
  }
  console.log();
  console.log(`总计：${allCases.length} 个 case`);
}

main();
