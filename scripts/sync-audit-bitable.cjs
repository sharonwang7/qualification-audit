#!/usr/bin/env node
// sync-audit-bitable.cjs -- sync AI audit results to the existing 资质申请 bitable table
// Target: E3yNbkywtaDW6esN0NhcDY7Wnwd / tbl7eiLTHsErBTCK
// Match key: SourceID (fldENvNlvI) — base64 decoded → {userId}:{instanceCode}:{hash}:1
// Writes: 审核结果 (fldEVySNG9), 审核备注 (flduvXWjbc)
// Usage: node sync-audit-bitable.cjs [--days=N]  (default 30)

'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

// 加载技能包 .env（独立运行时兜底；作为子进程时继承父进程已有变量）
(function loadEnv() {
  const envFile = process.env.QUAL_ENV_FILE || path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_]+)\s*=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
})();

// 数据目录——优先读 QUAL_* 环境变量（doctor/setup 已配），否则自动从 SKILL_ROOT 推断
const SKILL_ROOT   = path.resolve(__dirname, '..');
const AUDIT_DIR  = process.env.QUAL_AUDIT_DIR  || path.join(SKILL_ROOT, '..', '..', 'audit_reports');
const PA_PATH    = process.env.QUAL_PENDING_ACTIONS || path.join(path.dirname(AUDIT_DIR), 'pending_actions.json');

const BASE_TOKEN = 'E3yNbkywtaDW6esN0NhcDY7Wnwd';
const TABLE_ID   = 'tbl7eiLTHsErBTCK';
const FLD_SOURCE = 'fldENvNlvI';   // SourceID (base64)
const FLD_RESULT    = 'fldEVySNG9';   // 审核结果 (select)
const FLD_NOTE      = 'flduvXWjbc';   // 审核备注 (text)
const FLD_ADVICE    = 'fldSwYZ2JS';   // AI首次建议 (select)
const FLD_REWORK    = 'fldQdMPZXF';   // 是否返工 (select 是/否)
const FLD_FIRSTPASS = 'fldTvF0xBe';   // 是否首过 (select 是/否)

// 归一化 verdict → 5 选项之一（容忍 emoji/空格）
function normVerdict(v) {
  v = String(v || '');
  if (v.includes('转人工')) return '转人工';
  if (v.includes('退回'))   return '退回';
  if (v.includes('需追问')) return '需追问';
  if (v.includes('需补充')) return '需补充';
  if (v.includes('通过'))   return '通过';
  return null;
}
// 从 revisions.jsonl 载入：最早原判(AI首判) + 返工集合
// 🔴 2026-07-14 修（首过率口径修正，王爷定义：AI 全程未被人推翻 = 首过）：
//   revisions.jsonl 混了两类"结论改变"事件，必须区分——
//     ① 用户 R 异议改判（reason 非空）：AI 判断被人推翻 → 真返工，压首过。
//     ② 申请人补料后复审（reason 空，走 APPLICANT_REPLIED 复审路径，不传 revisionReason）：
//        输入变了、AI 用同一套标准对新证据给出新结论，AI 并未被推翻 → 【不算返工、不压首过】。
//   信号来源：appendRevisionLog 的 reason = _revisionReason，仅 R 流程会传 → reason 空 ⟺ 非 R（补料复审）。
//   故：reworkedSet（返工/首过判定）只收 reason 非空的件；firstVerdictMap（AI 首次建议列）仍取所有修订的最早原判。
const _revLog = path.join(AUDIT_DIR, 'revisions.jsonl');
const firstVerdictMap = new Map();  // ic → 最早 from.verdict（跨所有修订，含补料复审——供"AI 首次建议"列）
const reworkedSet = new Set();      // ic → 出现过【用户 R 异议】(reason 非空)的件——供"是否返工/是否首过"判定；补料复审不计入
if (fs.existsSync(_revLog)) {
  const recs = fs.readFileSync(_revLog, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  for (const r of recs) {
    if (!firstVerdictMap.has(r.instanceCode)) firstVerdictMap.set(r.instanceCode, r.from && r.from.verdict);
    if (r.reason && String(r.reason).trim()) reworkedSet.add(r.instanceCode); // 仅 R 异议算返工，补料复审(reason空)不算
  }
}
// AI 首次建议：有过修订(含补料复审)的取 revisions 最早原判；否则取当前 verdict
function getFirstAdvice(ic, c) {
  const raw = firstVerdictMap.has(ic) ? firstVerdictMap.get(ic) : (c && c.verdict);
  return normVerdict(raw);
}
// 方向归并（首过判定用）
function dirOf(v) {
  v = String(v || '');
  if (v.includes('退回')) return '退回';
  if (v.includes('通过')) return '通过';
  if (v.includes('需补充') || v.includes('需追问') || v.includes('询问')) return '补充';
  return null;
}

const daysArg = parseInt((process.argv.find(a => a.startsWith('--days=')) || '--days=30').split('=')[1], 10);
const DRY = process.argv.includes('--dry-run'); // 只读对比，不写任何格子（2026-08-04 王爷要）
const curVals = new Map(); // ic → {result,advice,rework,firstpass} 现表值（仅 dry-run 时填）
const MAX_SCAN = 500; // max bitable records to scan (sorted newest-first)
const TMP_DIR  = path.join(os.tmpdir(), 'sync-audit-bitable');
fs.mkdirSync(TMP_DIR, { recursive: true });

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }

// 传输可移植性修复（2026-08-07 王爷定，别人同步不了的真凶）：原来只裸调 `lark-cli` 二进制——异机上二进制不在 PATH、
//   或只用 lark-cli 的 JS 包(QUAL_LARKCLI_JS)时就失败(审核走 connector 用 JS 兜底正常、sync 独独挂)。改为【镜像 connector 的传输】：
//   优先 `node <run.js>`(QUAL_LARKCLI_JS 或默认路径存在时)，找不到 JS 入口才兜底退回 `lark-cli` 二进制；并处理 saved_path(大结果落文件)。
const LARK_CLI_JS = process.env.QUAL_LARKCLI_JS ||
  'C:\\Users\\FD\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\scripts\\run.js';
const LARK_DIRECT = (() => { try { return fs.existsSync(LARK_CLI_JS); } catch (e) { return false; } })();
function larkBase(extraArgs) {
  const args = ['base', ...extraArgs, '--as', 'user'];
  const out = LARK_DIRECT
    ? execFileSync(process.execPath, [LARK_CLI_JS, ...args.flatMap(a => String(a).split(' ')).filter(s => s.length)], {
        encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, cwd: TMP_DIR, timeout: 60000, windowsHide: true
      })
    : execFileSync('lark-cli', args, {
        encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, cwd: TMP_DIR, shell: true, timeout: 60000, windowsHide: true
      });
  const meta = JSON.parse((out.trim()) || '{}');
  if (meta.saved_path && fs.existsSync(meta.saved_path)) {
    const d = JSON.parse(fs.readFileSync(meta.saved_path, 'utf8').replace(/^﻿/, ''));
    try { fs.unlinkSync(meta.saved_path); } catch (e) {}
    return d;
  }
  return meta;
}

// ── Step 1: collect audit cases from recent N days ──
const allCases = new Map(); // instanceCode → case object
for (let d = 0; d <= daysArg; d++) {
  const dt  = new Date(Date.now() - d * 86400000);
  const ymd = `${dt.getFullYear()}${String(dt.getMonth()+1).padStart(2,'0')}${String(dt.getDate()).padStart(2,'0')}`;
  const fp  = path.join(AUDIT_DIR, `${ymd}.json`);
  if (!fs.existsSync(fp)) continue;
  try {
    for (const c of readJson(fp)) {
      if (c.instanceCode && !allCases.has(c.instanceCode)) allCases.set(c.instanceCode, c);
    }
  } catch (e) { console.warn(`  WARN ${fp}: ${e.message}`); }
}
console.log(`==> Collected ${allCases.size} audit cases (last ${daysArg}d)`);
if (allCases.size === 0) { console.log('Nothing to sync.'); process.exit(0); }

// ── Step 2: read pending_actions for FAIR state ──
const pa = fs.existsSync(PA_PATH) ? readJson(PA_PATH) : {};

function getResultOption(ic) {
  const entry = pa[ic];
  if (entry) {
    if (entry.state === 'CLOSED') {
      if (entry.processedAction === 'approve') return '✅通过';
      if (entry.processedAction === 'reject')  return '❌退回';
    }
    if (entry.state === 'AWAITING_APPLICANT') return '⏸询问中';
  }
  const c = allCases.get(ic);
  if (c && c.processedAction === 'approved') return '✅通过';
  if (c && c.processedAction === 'rejected') return '❌退回';
  // AI verdict = 需补充 with no final action → 询问中 (note sent or pending)
  if (c && !c.processedAction && (c.verdict === '需补充' || c.verdict === '需追问')) return '⏸询问中';
  return null;
}

// ── Step 3: scan bitable records (newest-first) to build instanceCode→record_id map ──
console.log('==> Scanning bitable (newest-first) for matching records...');

// write sort config
const sortPath = path.join(TMP_DIR, 'sort.json');
// sort by 发起时间 desc; field name may vary — use the field id fldkUIRhdW
fs.writeFileSync(sortPath, JSON.stringify([{ field: 'fldkUIRhdW', desc: true }]), 'utf8');

const icToRecordId = new Map();
let offset = 0;
let scannedTotal = 0;
const remaining = new Set(allCases.keys());

while (offset < MAX_SCAN && remaining.size > 0) {
  const batchSize = Math.min(200, MAX_SCAN - offset);
  const _fieldIds = DRY
    ? ['--field-id', FLD_SOURCE, '--field-id', FLD_RESULT, '--field-id', FLD_ADVICE, '--field-id', FLD_REWORK, '--field-id', FLD_FIRSTPASS]
    : ['--field-id', FLD_SOURCE];
  const resp = larkBase([
    '+record-list',
    '--base-token', BASE_TOKEN,
    '--table-id',   TABLE_ID,
    ..._fieldIds,
    '--sort-json',  '@./sort.json',
    '--offset',     String(offset),
    '--limit',      String(batchSize),
    '--format',     'json',
  ]);

  // response format: parallel arrays
  const rows      = resp.data.data        || [];
  const recordIds = resp.data.record_id_list || [];
  // FLD_SOURCE is the only requested field → column index 0
  for (let i = 0; i < rows.length; i++) {
    scannedTotal++;
    const sid = rows[i][0];
    if (!sid) continue;
    try {
      const decoded = Buffer.from(sid, 'base64').toString('utf8');
      const ic = decoded.split(':')[1];
      if (ic && remaining.has(ic)) {
        icToRecordId.set(ic, recordIds[i]);
        if (DRY) curVals.set(ic, { result: rows[i][1], advice: rows[i][2], rework: rows[i][3], firstpass: rows[i][4] });
        remaining.delete(ic);
      }
    } catch (e) {}
  }

  if (!resp.data.has_more) break;
  offset += rows.length;
}
console.log(`  Scanned ${scannedTotal} records, matched ${icToRecordId.size}/${allCases.size} audit cases`);
if (remaining.size > 0) {
  console.log(`  Not found in bitable (${remaining.size}): ${[...remaining].slice(0,3).join(', ')}${remaining.size > 3 ? '...' : ''}`);
}

// ── Dry-run：只对比不写（2026-08-04 王爷要，大公子加）──
if (DRY) {
  const norm = (v) => {
    if (v == null) return '';
    if (Array.isArray(v)) v = v.length ? v[0] : '';
    if (v && typeof v === 'object') v = (v.text != null ? v.text : (v.value != null ? v.value : (v.name != null ? v.name : JSON.stringify(v))));
    return String(v).trim();
  };
  const FIELDS = [['result', '审核结果'], ['advice', 'AI首次建议'], ['rework', '是否返工'], ['firstpass', '是否首过']];
  let fill = 0, same = 0, change = 0, norow = 0;
  const changes = [];
  for (const [ic, c] of allCases) {
    if (!icToRecordId.get(ic)) { norow++; continue; }
    const cur = curVals.get(ic) || {};
    const comp = {
      result: getResultOption(ic),
      advice: getFirstAdvice(ic, c),
      rework: reworkedSet.has(ic) ? '是' : '否',
      firstpass: getResultOption(ic) ? (!reworkedSet.has(ic) ? '是' : '否') : null,
    };
    for (const [k, label] of FIELDS) {
      const nv = comp[k] ? norm(comp[k]) : '';
      if (!nv) continue; // sync 不写空值 → 该格不动
      const cv = norm(cur[k]);
      if (!cv) fill++;
      else if (cv === nv) same++;
      else { change++; changes.push({ ic, person: c.person || '?', field: label, from: cv, to: nv }); }
    }
  }
  console.log(`\n===DRYRUN=== matched=${icToRecordId.size} 未匹配到行=${norow}`);
  console.log(`GREEN_fill=${fill} YELLOW_same=${same} RED_change=${change}`);
  console.log('CHANGES_JSON=' + JSON.stringify(changes));
  process.exit(0);
}

// ── Step 4: update matched records ──
let updated = 0, skipped = 0, failed = 0;
for (const [ic, c] of allCases) {
  const recordId = icToRecordId.get(ic);
  if (!recordId) { skipped++; continue; }

  const resultOption = getResultOption(ic);
  const adviceOption = getFirstAdvice(ic, c);
  const reworkFlag   = reworkedSet.has(ic) ? '是' : '否';
  // 是否首过（王爷定义 2026-07-14）：AI 在这条审批中【全程未被人推翻】即首过——
  //   只看有没有 R 异议(reworkedSet)，不看结论方向是否变化。
  //   "需补充→申请人补料→通过"这类：AI 两次都对、判断从未被推翻 → 首过=是（不再因方向从"补充"变"通过"而误判否）。
  //   仅当出现过用户 R 异议改判（AI 判断被推翻）才 firstPass=否。有最终结论(resultOption)才落此列。
  let firstPass = null;
  if (resultOption) {
    firstPass = (!reworkedSet.has(ic)) ? '是' : '否';
  }
  const noteText     = c.fullAnalysis || '';
  if (!resultOption && !adviceOption && !noteText) { skipped++; continue; }

  const fields = {};
  if (resultOption) fields[FLD_RESULT] = resultOption;
  if (adviceOption) fields[FLD_ADVICE] = adviceOption;
  fields[FLD_REWORK] = reworkFlag;
  if (firstPass)    fields[FLD_FIRSTPASS] = firstPass;
  if (noteText)     fields[FLD_NOTE]   = noteText;

  const tmpFn = `upd_${ic.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
  fs.writeFileSync(path.join(TMP_DIR, tmpFn), JSON.stringify(fields), 'utf8');

  try {
    const r = larkBase([
      '+record-upsert',
      '--base-token', BASE_TOKEN,
      '--table-id',   TABLE_ID,
      '--record-id',  recordId,
      '--json',       `@./${tmpFn}`,
    ]);
    if (r.ok) { updated++; console.log(`  ✓ ${ic} (${c.person || '?'}) → ${resultOption || '(note only)'}`); }
    else { console.warn(`  ✗ ${ic}: ${JSON.stringify(r)}`); failed++; }
  } catch (e) { console.warn(`  ERR ${ic}: ${e.message}`); failed++; }
}

console.log(`\n==> done: updated=${updated} skipped=${skipped} failed=${failed}`);
