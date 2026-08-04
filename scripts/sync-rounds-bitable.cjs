#!/usr/bin/env node
// sync-rounds-bitable.cjs -- sync AI 吞吐轮次埋点 (rounds.jsonl) → 「AI吞吐·轮次」bitable 表
// Target base : E3yNbkywtaDW6esN0NhcDY7Wnwd
// Target table: tblvwZQgR7weABB1  (AI吞吐·轮次)
//
// 数据源  : audit_reports/rounds.jsonl，每行
//           {ts, round, date, startedAt, cardSentAt, size, resend}
//           - date       如 "20260708"
//           - startedAt / cardSentAt 是 ISO 字符串
//           - resend=true 是重发/刷卡行 → 排除，只取首发行（resend!=true）
// 幂等 key : (日期 + 轮次)。已存在则 update，不存在才 create → 重跑不产生重复行。
// 写入字段 : 5 个根字段；公式列「AI吞吐秒每单」由 bitable 自算，不写。
//           datetime 字段写毫秒时间戳（ISO→ms）。
//
// Usage: node sync-rounds-bitable.cjs

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

const SKILL_ROOT   = path.resolve(__dirname, '..');
const AUDIT_DIR  = process.env.QUAL_AUDIT_DIR  || path.join(SKILL_ROOT, '..', '..', 'audit_reports');
const ROUNDS_JSONL = path.join(AUDIT_DIR, 'rounds.jsonl');

const BASE_TOKEN = 'E3yNbkywtaDW6esN0NhcDY7Wnwd';
const TABLE_ID   = 'tblvwZQgR7weABB1';   // AI吞吐·轮次
// 根字段 id（仿 sync-audit-bitable.cjs 的 FLD_* 风格，固化在顶部常量）
const FLD_DATE     = 'fldhos454Q';   // 日期 (text)     如 "2026-07-08"
const FLD_ROUND    = 'fldewBAKvE';   // 轮次 (number)
const FLD_STARTED  = 'fldGosJdmH';   // 轮次开始 (datetime, ms)
const FLD_CARDSENT = 'fldTtNopSu';   // 卡片发出 (datetime, ms)
const FLD_SIZE     = 'fldw50oFmL';   // 本轮单数 (number)
// 公式列 fldDyj0x0X「AI吞吐秒每单」= IF(单数=0,0,(卡片发出-轮次开始)/1000/单数) —— bitable 自算，脚本不写。

const TMP_DIR = path.join(os.tmpdir(), 'sync-rounds-bitable');
fs.mkdirSync(TMP_DIR, { recursive: true });

function larkBase(extraArgs) {
  const args = ['base', ...extraArgs, '--as', 'user'];
  const out  = execFileSync('lark-cli', args, {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    cwd: TMP_DIR, shell: true, timeout: 60000,
  });
  return JSON.parse(out);
}

// "20260708" → "2026-07-08"
function fmtDate(ymd) {
  const s = String(ymd || '');
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}
// ISO string → 毫秒时间戳（number）；无效/空 → null
function isoToMs(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

// ── Step 1: 读 rounds.jsonl，只取 resend!=true 首发行，按 (date,round) 去重 ──
if (!fs.existsSync(ROUNDS_JSONL)) {
  console.log(`Nothing to sync: ${ROUNDS_JSONL} not found.`);
  process.exit(0);
}
const rows = fs.readFileSync(ROUNDS_JSONL, 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  .filter(r => r.resend !== true);     // 只认首发行

// 同一 (date,round) 若有多条首发（历史遗留/多次 re-gen）取【最早 cardSentAt】——首次发卡才是真轮次吞吐。
// ISO 字符串按字典序比较即时间序。
const byKey = new Map(); // "date|round" → row
for (const r of rows) {
  const key = `${r.date}|${r.round}`;
  const prev = byKey.get(key);
  if (!prev || String(r.cardSentAt) < String(prev.cardSentAt)) byKey.set(key, r);
}
console.log(`==> ${byKey.size} 首发轮次待同步 (rounds.jsonl 共 ${rows.length} 首发行)`);
if (byKey.size === 0) { console.log('Nothing to sync.'); process.exit(0); }

// ── Step 2: 拉现有表记录，建 (日期+轮次) → record_id 映射（幂等判定）──
const existing = new Map(); // "日期|轮次" → record_id
{
  let offset = 0;
  while (true) {
    // 投影列表返回 parallel arrays：data.data=[[col0,col1],...]、data.record_id_list=[...]
    // （与 sync-audit-bitable.cjs 一致）。--field-id 顺序即列序：col0=日期、col1=轮次。
    const resp = larkBase([
      '+record-list',
      '--base-token', BASE_TOKEN,
      '--table-id',   TABLE_ID,
      '--field-id',   FLD_DATE,
      '--field-id',   FLD_ROUND,
      '--offset',     String(offset),
      '--limit',      '200',
      '--format',     'json',
    ]);
    const rowsResp  = (resp.data && resp.data.data)           || [];
    const recordIds = (resp.data && resp.data.record_id_list) || [];
    for (let i = 0; i < rowsResp.length; i++) {
      const row = rowsResp[i] || [];
      // text 读回可能是 string 或 [{text}] 数组；number 读回是数字
      let dv = row[0];
      if (Array.isArray(dv)) dv = dv.map(x => (x && x.text != null ? x.text : x)).join('');
      const dateStr = String(dv == null ? '' : dv).trim();
      const roundNum = row[1];
      const key = `${dateStr}|${Number(roundNum)}`;
      if (dateStr) existing.set(key, recordIds[i]);
    }
    if (!(resp.data && resp.data.has_more)) break;
    offset += rowsResp.length;
    if (rowsResp.length === 0) break;
  }
}
console.log(`==> 表内已有 ${existing.size} 行`);

// ── Step 3: 幂等 upsert ──
let created = 0, updated = 0, failed = 0;
for (const [, r] of byKey) {
  const dateStr = fmtDate(r.date);
  const roundNum = Number(r.round);
  const fields = {};
  fields[FLD_DATE]  = dateStr;
  fields[FLD_ROUND] = roundNum;
  const sMs = isoToMs(r.startedAt);
  const cMs = isoToMs(r.cardSentAt);
  if (sMs != null) fields[FLD_STARTED]  = sMs;
  if (cMs != null) fields[FLD_CARDSENT] = cMs;
  fields[FLD_SIZE] = Number(r.size) || 0;

  const key = `${dateStr}|${roundNum}`;
  const recId = existing.get(key);

  const tmpFn = `upd_${dateStr}_${roundNum}.json`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  fs.writeFileSync(path.join(TMP_DIR, tmpFn), JSON.stringify(fields), 'utf8');

  const upsertArgs = [
    '+record-upsert',
    '--base-token', BASE_TOKEN,
    '--table-id',   TABLE_ID,
    '--json',       `@./${tmpFn}`,
  ];
  if (recId) { upsertArgs.push('--record-id', recId); }

  try {
    const resp = larkBase(upsertArgs);
    if (resp.ok) {
      if (recId) { updated++; console.log(`  ~ ${key} 更新`); }
      else       { created++; console.log(`  + ${key} 新建`); }
    } else { failed++; console.warn(`  ✗ ${key}: ${JSON.stringify(resp)}`); }
  } catch (e) { failed++; console.warn(`  ERR ${key}: ${e.message}`); }
}

console.log(`\n==> done: created=${created} updated=${updated} failed=${failed}`);
