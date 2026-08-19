#!/usr/bin/env node
// 单测：FAIR 解析 + 漏解析告警（detectUnparsedFair）
// 起因：2026-08-18 #113 事故——手动 write-result 绕过 fair，"通过：F#113" 被漏执行。
// 跑法：node scripts/test-fair-parse.cjs
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const TOOL = path.join(__dirname, 'audit-tool.cjs');

function run(text) {
  const out = execFileSync('node', [TOOL, 'test-fair', text], { encoding: 'utf8' });
  return JSON.parse(out);
}

// 每个用例：{ 说明, 文本, 期望 tokens 的 [字母#编号] 列表, 期望 unparsed 是否非空 }
const CASES = [
  { desc: '事故原文：通过+无编号R追问 → F#113 解析、R# 告警',
    text: '通过：F#113  R# 为什么中信证券要求机构客户变更手机号？申请研究服务白名单是什么意思？均没有说明',
    tokens: ['F#113'], unparsedNonEmpty: true },
  { desc: '别名无字母：通过#113 → 0 token + 告警',
    text: '通过#113',
    tokens: [], unparsedNonEmpty: true },
  { desc: '正常多 token：F#65 A#66 → 全解析、无告警',
    text: 'F#65  A#66 原因：客户主体不合格',
    tokens: ['F#65', 'A#66'], unparsedNonEmpty: false },
  { desc: '规则名不误报：R05 无#/编号 → 0 token + 无告警',
    text: '我觉得 R05 规则应该放宽一点，R14 也是',
    tokens: [], unparsedNonEmpty: false },
  { desc: '正常写法不误报：通过：F#113 → 1 token、无告警',
    text: '通过：F#113，同意放行',
    tokens: ['F#113'], unparsedNonEmpty: false },
  { desc: '"通过率81%"不误报（reB 要求带#）',
    text: '这批通过率 81% 很高，通过 90 单',
    tokens: [], unparsedNonEmpty: false },
  { desc: '字母#空（F#后无数字）→ 告警',
    text: 'F# 这个先放一放',
    tokens: [], unparsedNonEmpty: true },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const r = run(c.text);
  const gotTokens = (r.tokens || []).map(t => `${t.letter}#${t.n}`);
  const tokOk = JSON.stringify(gotTokens) === JSON.stringify(c.tokens);
  const unpOk = (r.unparsed && r.unparsed.length > 0) === c.unparsedNonEmpty;
  if (tokOk && unpOk) { pass++; console.log(`  ✓ ${c.desc}`); }
  else {
    fail++;
    console.log(`  ✗ ${c.desc}`);
    if (!tokOk) console.log(`      tokens 期望 ${JSON.stringify(c.tokens)} 实得 ${JSON.stringify(gotTokens)}`);
    if (!unpOk) console.log(`      unparsed 期望非空=${c.unparsedNonEmpty} 实得 ${JSON.stringify(r.unparsed)}`);
  }
}
console.log(`\n==> test-fair-parse: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
