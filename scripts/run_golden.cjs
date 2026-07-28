#!/usr/bin/env node
/**
 * run_golden.cjs — 黄金回归集 runner（做法一适配）
 *
 * 背景：做法一下「结论」由 agent 大模型判断，没有代码能算结论。所以：
 *   · 本 runner 只【自动精确断言确定性层(T1)】——管辖范围 + 红线规则 + 是否跳过，纯代码、可复现。
 *   · 「结论(conclusion_key)」是大模型产物 → runner 不做代码相等断言，只把人工真值列出来，供你/agent 评估对照。
 *
 * 用法:
 *   node scripts/run_golden.cjs
 *
 * 退出码：T1 有失败 → 1；全过 → 0。（旧格式目录跳过并提示）
 */
const fs = require('fs');
const path = require('path');
const { runDeterministicChecks } = require('../lib/deterministic-checker.js');
const { isInScope } = require('../lib/scope-filter.js');

const GOLDEN_DIR = process.env.QUAL_GOLDEN_DIR
  || path.join(__dirname, '..', '.dev', 'golden_set');

function eqSet(a, b) {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
}

function runCase(dir) {
  const inputP = path.join(dir, 'input.json');
  const expP = path.join(dir, 'expected.json');
  if (!fs.existsSync(inputP) || !fs.existsSync(expP)) {
    return { status: 'skip', reason: '缺 input.json / expected.json（旧格式，待转换）' };
  }
  const rd = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));  // 容 BOM
  const input = rd(inputP);
  const raw = rd(expP);
  const exp = raw.expected || raw;  // 兼容：扁平(字段在顶层) 或 嵌套(expected:{})
  const form = input.form || {};
  const attachments = input.attachments || [];
  const qualRaw = form['申请资质'] || form['拟用资质'];
  const quals = Array.isArray(qualRaw) ? qualRaw : [qualRaw].filter(Boolean);

  const det = runDeterministicChecks(form, attachments, quals);
  const actual = {
    in_scope: isInScope(form),
    should_skip: det.shouldSkip || false,
    rules_fired: det.issues.map(i => i.ruleId).sort(),
    // F1/F2 守护：auto_approve = 是否真会进入 fast-track
    // 前置闸：deterministic.autoApprove.flag && !needs_human && !ocr_gate_failed
    auto_approve: !!(det.autoApprove && det.autoApprove.flag && !det.needs_human)
  };

  const fails = [];
  const expDet = exp.deterministic || {};
  if (typeof exp.in_scope === 'boolean' && actual.in_scope !== exp.in_scope)
    fails.push(`in_scope 期望 ${exp.in_scope} 实际 ${actual.in_scope}`);
  if (typeof exp.should_skip === 'boolean' && actual.should_skip !== exp.should_skip)
    fails.push(`should_skip 期望 ${exp.should_skip} 实际 ${actual.should_skip}`);
  if (typeof expDet.auto_approve === 'boolean' && actual.auto_approve !== expDet.auto_approve)
    fails.push(`auto_approve 期望 ${expDet.auto_approve} 实际 ${actual.auto_approve}（F1：内部主体 fast-track 判定）`);
  if (Array.isArray(expDet.rules_fired) && !eqSet(actual.rules_fired, expDet.rules_fired))
    fails.push(`rules_fired 期望 [${expDet.rules_fired}] 实际 [${actual.rules_fired}]`);
  if (Array.isArray(expDet.rules_not_fired)) {
    const leaked = expDet.rules_not_fired.filter(r => actual.rules_fired.includes(r));
    if (leaked.length) fails.push(`不该触发却触发了: [${leaked}]`);
  }

  return {
    status: fails.length ? 'fail' : 'pass',
    fails,
    actual,
    conclusion_key: exp.conclusion_key || '?',
    scene: exp.scene || '?',
    known_ai_miss: raw.known_ai_miss === true
  };
}

// 🔴 引擎自检（2026-07-17 王爷定）——必须在跑用例【之前】。
// 为什么：规则文件解析失败时，旧行为是静默返回 0 条规则 → 所有用例的 rules_fired 恒空 →
//   期望空的用例反而"过"，回归网整个变哑巴、还给你一个绿灯。2026-07-17 上午即如此：
//   本文件被写坏 5 小时，11 条红线全灭，期间 n=52~55 四件全部判通过，而"跑回归"却报全绿。
// 所以：先证明规则确实加载了，再谈用例过不过。基线数字变更须【有意识】同步此处。
const RULES_PATH = path.join(__dirname, '..', 'references', 'deterministic-rules.json');
const EXPECT_RULES = 11;
function preflight() {
  let n;
  try {
    const r = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8').replace(/^﻿/, ''));
    n = Array.isArray(r.rules) ? r.rules.length : 0;
  } catch (e) {
    console.error(`✗ 引擎自检失败：deterministic-rules.json 解析错误 → ${e.message}`);
    console.error('  此状态下【全部红线静默失效】、issues 恒空，本次回归结果无任何意义。先修文件再跑。');
    process.exit(1);
  }
  if (n !== EXPECT_RULES) {
    console.error(`✗ 引擎自检失败：deterministic-rules.json 期望 ${EXPECT_RULES} 条规则，实际 ${n} 条。`);
    console.error('  若确为有意增删规则，请同步更新 run_golden.cjs 的 EXPECT_RULES 基线。');
    process.exit(1);
  }
  console.log(`✓ 引擎自检：deterministic-rules.json 已加载 ${n} 条规则（基线 ${EXPECT_RULES}）`);
}

function main() {
  preflight();
  if (!fs.existsSync(GOLDEN_DIR)) {
    console.error('找不到 examples/golden_set/');
    process.exit(2);
  }
  const dirs = fs.readdirSync(GOLDEN_DIR)
    .filter(d => fs.statSync(path.join(GOLDEN_DIR, d)).isDirectory())
    .sort();

  let pass = 0, fail = 0, skip = 0;
  const forAgentEval = [];

  console.log('═══ T1 确定性层（自动精确断言）═══');
  for (const d of dirs) {
    const r = runCase(path.join(GOLDEN_DIR, d));
    if (r.status === 'skip') { skip++; console.log(`  ⊘ ${d}  跳过：${r.reason}`); continue; }
    if (r.status === 'pass') {
      pass++;
      console.log(`  ✓ ${d}  scope=${r.actual.in_scope} skip=${r.actual.should_skip} auto=${r.actual.auto_approve} rules=[${r.actual.rules_fired}]`);
    } else {
      fail++;
      console.log(`  ✗ ${d}  ${r.fails.join(' | ')}`);
    }
    if (r.status !== 'skip') {
      forAgentEval.push({ id: d, conclusion_key: r.conclusion_key, scene: r.scene, known_ai_miss: r.known_ai_miss });
    }
  }

  console.log('\n═══ 结论 / 场景（大模型判断 → 需 agent 评估，runner 不自动断言）═══');
  for (const e of forAgentEval) {
    const watch = e.known_ai_miss ? '  ⚠看护(已知AI判错)' : '';
    console.log(`  · ${e.id}  人工真值结论=${e.conclusion_key}  场景=${e.scene}${watch}`);
  }
  console.log('  → 评估方式：让 agent 按 SKILL.md 对这些 input 审一遍，对照上面的「人工真值结论」。');

  console.log(`\n═══ 汇总 ═══`);
  console.log(`  T1: ${pass} 过 / ${fail} 挂 / ${skip} 跳过(旧格式)`);
  process.exit(fail ? 1 : 0);
}

main();
