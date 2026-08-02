#!/usr/bin/env node
// 回归测试：parseContractDates（合同明细日期区间解析，2026-08-02 Plan B）
// 用法: node scripts/test-parse-contract-dates.cjs   ——失败退出码非0
const { parseContractDates } = require('../lib/deterministic-checker.js');

const CASES = [
  ['有效期 2026-03-01 至 2026-12-31', '2026-03-01', '2026-12-31'],   // GS017 真实格式
  ['...DateInterval 2026-07-01 至 2027-07-01（覆盖申请时点）', '2026-07-01', '2027-07-01'], // GS019
  ['2025.1.15-2026.1.14', '2025-01-15', '2026-01-14'],
  ['2025/01/15 - 2026/01/14', '2025-01-15', '2026-01-14'],
  ['2025年1月5日至2026年1月4日', '2025-01-05', '2026-01-04'],
  ['合同明细没填', null, null],
  ['', null, null],
  [null, null, null],
];

let fail = 0;
for (const [text, es, ee] of CASES) {
  const r = parseContractDates(text);
  const ok = r.startDate === es && r.endDate === ee;
  if (!ok) { fail++; console.error(`❌ ${JSON.stringify(text)} → got ${r.startDate}/${r.endDate}, want ${es}/${ee}`); }
}
if (fail) { console.error(`\n🔴 parseContractDates 回归失败 ${fail}/${CASES.length}`); process.exit(1); }
console.log(`✅ parseContractDates 回归全过 ${CASES.length}/${CASES.length}`);
