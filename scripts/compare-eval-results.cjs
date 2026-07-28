#!/usr/bin/env node
/**
 * compare-eval-results.cjs — 对比 agent 评估结论 vs 人工真值
 *
 * 输入：agent 评估结果 JSON（格式见下）
 * 输出：对比表、一致率、差异分析
 *
 * Agent 结论格式：
 * {
 *   "evaluations": [
 *     { "case_id": "GS001", "agent_conclusion": "pass", "matches": true/false, "notes": "..." },
 *     ...
 *   ]
 * }
 */
const fs = require('fs');
const path = require('path');

const GOLDEN_DIR = process.env.QUAL_GOLDEN_DIR
  || path.join(__dirname, '..', '.dev', 'golden_set');

// 读 golden 真值
function loadGroundTruth() {
  const truth = {};
  const dirs = fs.readdirSync(GOLDEN_DIR)
    .filter(d => fs.statSync(path.join(GOLDEN_DIR, d)).isDirectory());
  for (const d of dirs) {
    const expPath = path.join(GOLDEN_DIR, d, 'expected.json');
    if (fs.existsSync(expPath)) {
      const exp = JSON.parse(fs.readFileSync(expPath, 'utf8'));
      const exp_det = exp.expected || exp;
      truth[d] = exp_det.conclusion_key || '?';
    }
  }
  return truth;
}

// 对比
function compareResults(agentResults, groundTruth) {
  const matches = [];
  const mismatches = [];

  for (const eval of agentResults) {
    const caseId = eval.case_id;
    const humanConclusion = groundTruth[caseId] || '?';
    const agentConclusion = eval.agent_conclusion || '?';
    const match = humanConclusion === agentConclusion;

    const record = {
      case_id: caseId,
      human: humanConclusion,
      agent: agentConclusion,
      match,
      notes: eval.notes || ''
    };

    if (match) {
      matches.push(record);
    } else {
      mismatches.push(record);
    }
  }

  return { matches, mismatches };
}

function main() {
  // 读 agent 结果（从 stdin 或文件参数）
  let agentData;
  if (process.argv[2]) {
    agentData = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  } else {
    const input = fs.readFileSync(0, 'utf8');
    agentData = JSON.parse(input);
  }

  const truth = loadGroundTruth();
  const { matches, mismatches } = compareResults(agentData.evaluations || [], truth);

  console.log('# Agent 评估结果对比');
  console.log();
  console.log(`**评估覆盖**：${matches.length + mismatches.length} 个 case`);
  console.log(`**一致率**：${matches.length} / ${matches.length + mismatches.length} = ${((matches.length / (matches.length + mismatches.length) * 100).toFixed(1))}%`);
  console.log();

  if (matches.length > 0) {
    console.log('## ✓ 一致结论');
    console.log();
    console.log('| Case | 人工 | Agent | 备注 |');
    console.log('|------|------|-------|------|');
    for (const m of matches) {
      console.log(`| ${m.case_id} | ${m.human} | ${m.agent} | ${m.notes} |`);
    }
    console.log();
  }

  if (mismatches.length > 0) {
    console.log('## ✗ 不一致结论（需分析）');
    console.log();
    console.log('| Case | 人工 | Agent | 差异分析 |');
    console.log('|------|------|-------|----------|');
    for (const mm of mismatches) {
      console.log(`| ${mm.case_id} | ${mm.human} | ${mm.agent} | ${mm.notes} |`);
    }
    console.log();
  }

  console.log('---');
  console.log();
  console.log('**结论**：');
  if (mismatches.length === 0) {
    console.log(`✅ 100% 一致 —— Agent 三阶段评估与人工真值完全一致。`);
  } else {
    console.log(`⚠️ ${((mismatches.length / (matches.length + mismatches.length) * 100).toFixed(1))}% 不一致 —— 需要分析差异原因（见上表）。`);
  }
}

main();
