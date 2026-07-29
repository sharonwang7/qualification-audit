#!/usr/bin/env node
/**
 * backfill-rules-snapshot.cjs — 一次性回捞：给历史件补算「确定性红线快照」（2026-07-17 王爷定）
 *
 * 背景：result schema 长期缺 deterministic/rules_fired 字段 → 哪条红线响过、子代理有没有驳回它，
 *   事后完全查不到（#50 庞小彤查不出「AI 为何判通过」的根因即此故）。2026-07-17 已在 write-result
 *   补上工具层权威注入，但【存量件】仍是空白。本脚本从 case 缓存回捞补算。
 *
 * 🔑 为什么读【缓存】而不是重跑 case：
 *   缓存里的 case.json 是【当时子代理决策时实际看到的数据】——这正是审计要还原的现场。
 *   重跑 case 得到的是「今天的规则 + 今天的渲染」下的结果，那是另一个问题（值得单独做，
 *   但不叫回捞）。审计问的是「它当时看到了什么、然后做了什么」，不是「今天会怎样」。
 *
 * ⚠️ 本脚本【不判断对错】，只产出【候选池】。理由：合法覆盖的情形代码识别不了——
 *   L01 诉讼/仲裁明文豁免 R02/R05/R07/R11；I01 内部自用豁免 R05/R08；C04 内部特批替代 R02+R11；
 *   P02 场景判读。这些都要人读。脚本只负责把「值得读的」从 88 件里挑出来。
 *
 * 用法:
 *   node scripts/backfill-rules-snapshot.cjs           # dry-run，只报告，不写盘
 *   node scripts/backfill-rules-snapshot.cjs --write   # 回写 audit_reports/*.json
 */
const fs = require('fs');
const path = require('path');

const SKILL_ROOT = path.resolve(__dirname, '..');

const AUDIT_DIR  = process.env.QUAL_AUDIT_DIR  || path.join(SKILL_ROOT, '..', 'audit_reports');
const ATTACH_DIR = process.env.QUAL_ATTACH_DIR || path.join(SKILL_ROOT, '..', '..', 'fando-ocr-cache');
const WRITE = process.argv.includes('--write');

// 规则分量（取自 common/deterministic-rules.json 的 severity/action，2026-07-17 核对）
// action=SUPPLEMENT → 规则明确要求「需补充」。它响了却判「通过」= 子代理驳回了它 → 值得读。
const SUPPLEMENT_RULES = ['R01', 'R02', 'R03', 'R05', 'R06', 'R07', 'R11'];
// action=CONFIRM（提示人工确认）/ fail-open 提示 / 附件铁律明文可覆盖 → 覆盖属正常设计，不报。
//   R04/R08/R10/R12=CONFIRM；R15=fail-open 提示；OCR-GATE=附件铁律「可读信息够→结论照给+标注失败附件」。
const ADVISORY_RULES = ['R04', 'R08', 'R10', 'R12', 'R15', 'OCR-GATE'];
// L01 诉讼/仲裁：child-judge.md:33 明文【豁免】R02/R05/R07/R11 → 这类覆盖合法，单独分档。
const L01_DEST = /法院|仲裁|公证/;

function readJsonFile(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
function caseFilePath(code) { return path.join(ATTACH_DIR, String(code).substring(0, 8), 'case.json'); }
function pad(s, n) { s = String(s == null ? '' : s); let w = 0; for (const ch of s) w += /[一-龥＀-￯]/.test(ch) ? 2 : 1; return s + ' '.repeat(Math.max(0, n - w)); }

function main() {
  if (!fs.existsSync(AUDIT_DIR)) { console.error(`找不到 ${AUDIT_DIR}`); process.exit(2); }
  const files = fs.readdirSync(AUDIT_DIR).filter(f => /^\d{8}\.json$/.test(f)).sort();

  const tier1 = [], tier2 = [], normal = [], noSnap = [], engineFailed = [];
  let total = 0, filled = 0;

  for (const f of files) {
    const p = path.join(AUDIT_DIR, f);
    let cases;
    try { cases = readJsonFile(p); } catch (e) { console.error(`  ⚠ ${f} 读取失败，跳过: ${e.message}`); continue; }
    if (!Array.isArray(cases)) continue;
    let dirty = false;

    for (const c of cases) {
      total++;
      const cf = c.instanceCode ? caseFilePath(c.instanceCode) : null;
      let snap = null;

      if (cf && fs.existsSync(cf)) {
        try {
          const det = readJsonFile(cf).deterministic;
          if (det && Array.isArray(det.issues)) {
            const fired = [...new Set(det.issues.map(i => i && i.ruleId).filter(Boolean))].sort();
            snap = {
              rules_fired: fired,
              deterministic_passed: !!det.passed,
              engine_failed: !!det.engine_failed,
              // 只把「SUPPLEMENT 类规则被驳回」算作 overridden；CONFIRM/advisory/OCR-GATE 覆盖属正常设计。
              rules_overridden: fired.some(r => SUPPLEMENT_RULES.includes(r)) && c.verdict === '通过'
            };
          }
        } catch (e) { /* 缓存损坏 → 当作无快照 */ }
      }

      // 🔴 无快照一律 null，绝不置 []：「没读到」必须与「跑了但没红线响」可区分。
      const next = snap || { rules_fired: null, deterministic_passed: null, engine_failed: null, rules_overridden: null };
      if (JSON.stringify([c.rules_fired, c.deterministic_passed, c.engine_failed, c.rules_overridden]) !==
          JSON.stringify([next.rules_fired, next.deterministic_passed, next.engine_failed, next.rules_overridden])) {
        Object.assign(c, next); dirty = true; if (snap) filled++;
      }

      if (!snap) { noSnap.push({ f, c }); continue; }
      if (next.engine_failed) engineFailed.push({ f, c });

      const hard = next.rules_fired.filter(r => SUPPLEMENT_RULES.includes(r));
      const row = { date: f.replace('.json', ''), n: c.n, person: c.person, dest: c.dest,
                    sealType: c.sealType, hard, all: next.rules_fired, code: c.instanceCode };
      if (!next.rules_overridden) normal.push(row);
      else if (L01_DEST.test(String(c.dest || ''))) tier2.push(row);
      else tier1.push(row);
    }
    if (dirty && WRITE) fs.writeFileSync(p, JSON.stringify(cases, null, 2), 'utf8');
  }

  const bar = '─'.repeat(96);
  console.log(`\n${bar}\n历史件·确定性红线快照回捞   ${WRITE ? '【已回写 audit_reports】' : '【dry-run · 未写盘】'}\n${bar}`);
  console.log(`扫描 ${files.length} 个报告 / ${total} 件；补出快照 ${filled} 件；无缓存 ${noSnap.length} 件`);
  console.log(`判据：只算 action=SUPPLEMENT 类规则[${SUPPLEMENT_RULES.join(',')}]被驳回；`);
  console.log(`      CONFIRM/提示类[${ADVISORY_RULES.join(',')}]被覆盖属正常设计，不计入。\n`);

  const show = (rows) => rows.forEach(r =>
    console.log(`   ${r.date} n=${pad(r.n, 3)} ${pad(r.person, 12)} 被驳回[${pad(r.hard.join(','), 14)}] → ${pad(r.dest, 34)} ${r.sealType}`));

  console.log(`🔴 【第一档】SUPPLEMENT 类红线被驳回、判通过、且非诉讼/仲裁 —— ${tier1.length} 件`);
  console.log(`   （这是候选池，不是错误清单：I01 内部自用、C04 内部特批、P02 平台场景等合法豁免仍需人读）`);
  tier1.length ? show(tier1) : console.log('   （无）');

  console.log(`\n🟡 【第二档】同上，但流向含法院/仲裁/公证 —— ${tier2.length} 件（L01 明文豁免 R02/R05/R07/R11，大概率合法）`);
  tier2.length ? show(tier2) : console.log('   （无）');

  console.log(`\n⚪ 【不计入】仅 CONFIRM/提示类或 OCR-GATE 响过 —— ${normal.length} 件（设计上可覆盖，不报）`);

  // 📊 每条 SUPPLEMENT 规则的「驳回率」——一条几乎总被驳回的规则，要么定得太严、要么已被子代理当空气。
  //    这是规则健康度指标：100% 驳回率 = 这条规则事实上不存在。
  const stat = {};
  for (const r of [...tier1, ...tier2, ...normal]) {
    for (const id of r.all.filter(x => SUPPLEMENT_RULES.includes(x))) {
      stat[id] = stat[id] || { fired: 0, overridden: 0 };
      stat[id].fired++;
      if (r.hard.length && [...tier1, ...tier2].includes(r)) stat[id].overridden++;
    }
  }
  console.log(`\n📊 SUPPLEMENT 类规则健康度（响了几次 / 被驳回几次 / 驳回率）`);
  console.log(`   驳回率越高 → 这条规则要么定得太严、要么已被子代理当空气（事实上不存在）`);
  for (const id of SUPPLEMENT_RULES) {
    const s = stat[id];
    if (!s) { console.log(`   ${pad(id, 5)} 从未触发`); continue; }
    const rate = Math.round(s.overridden / s.fired * 100);
    const flag = rate >= 90 ? '  ← 🔴 几乎总被驳回，形同虚设' : rate >= 60 ? '  ← ⚠️ 驳回率偏高' : '';
    console.log(`   ${pad(id, 5)} 响 ${pad(s.fired, 3)} 次 / 驳回 ${pad(s.overridden, 3)} 次 / ${pad(rate + '%', 5)}${flag}`);
  }
  console.log(`\n⚠️  engine_failed 落盘 —— ${engineFailed.length} 件`);
  console.log(`   （engine_failed 字段 2026-07-17 才引入。此前引擎崩溃期的件，缓存里同样表现为 issues=[]，`);
  console.log(`     与「跑了、没红线」无法回溯区分——这正是当初 fail-silent 的代价，已不可挽回。）`);
  console.log(`\n❔ 无 case 缓存、无法回捞 —— ${noSnap.length} 件`);

  console.log(`\n${bar}`);
  if (!WRITE) console.log('dry-run 结束。确认无误后加 --write 回写 audit_reports。');
  console.log('');
}

main();
