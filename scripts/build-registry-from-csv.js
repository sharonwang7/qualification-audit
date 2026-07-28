#!/usr/bin/env node
/**
 * build-registry-from-csv.js
 *
 * Rebuild the two CSV-authoritative trademark subjects in
 * references/trademark-registry-full.json from the raw CSV exports
 * under data/trademark-csv/.  Idempotent: safe to re-run.
 *
 * Authoritative CSV sources (王爷 exports, "已注册现用"):
 *   - data/trademark-csv/muke.csv    -> 广州慕可生物科技有限公司
 *       columns: 文本, 申请 注册号, 国际分类, 所属品牌, 商标名称
 *   - data/trademark-csv/fandao.csv  -> 广州凡岛网络科技有限公司
 *       columns: 序号, 申请 注册号, 国际分类, 所属品牌/主体, 商标名称
 *
 * Only these two entities are overwritten. Every other entity plus
 * overseas_trademarks / renewable_trademarks / trademark_applications
 * (an older 2026-06-23 snapshot) is preserved verbatim.
 *
 * Record shape per trademark: { name, reg_no, class, brand }
 *   reg_no : "申请 注册号" with all non-digit chars stripped (第/号/letters/spaces)
 *   class  : "国际分类" with trailing .0 removed
 *   brand  : "所属品牌" or "所属品牌/主体"
 *   name   : "商标名称"
 * Deduped by reg_no within the same subject (first occurrence wins).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SKILL_ROOT = path.resolve(__dirname, '..');
const CSV_DIR = path.join(SKILL_ROOT, 'data', 'trademark-csv');
const JSON_PATH = path.join(SKILL_ROOT, 'references', 'trademark-registry-full.json');

const MUKE_ENTITY = '广州慕可生物科技有限公司';
const FANDAO_ENTITY = '广州凡岛网络科技有限公司';

/** Strip a UTF-8 BOM if present. */
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Minimal CSV line parser. Handles optional double-quote wrapping and
 * escaped "" inside quotes. The exports here are not quote-wrapped, but
 * this keeps the parser correct if a field ever contains a comma.
 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function readCsvRows(file) {
  const raw = stripBom(fs.readFileSync(file, 'utf8'));
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { header: [], rows: [] };
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map(parseCsvLine);
  return { header, rows };
}

/** Locate a column index by matching any of the provided candidate headers. */
function colIndex(header, candidates) {
  for (const cand of candidates) {
    const idx = header.indexOf(cand);
    if (idx !== -1) return idx;
  }
  // fallback: loose contains match
  for (let i = 0; i < header.length; i++) {
    if (candidates.some((c) => header[i].includes(c) || c.includes(header[i]))) return i;
  }
  return -1;
}

function normReg(v) {
  return String(v == null ? '' : v).replace(/[^\d]/g, '');
}

function normClass(v) {
  return String(v == null ? '' : v).trim().replace(/\.0+$/, '');
}

function buildTrademarks(file) {
  const { header, rows } = readCsvRows(file);
  const iReg = colIndex(header, ['申请 注册号', '注册号']);
  const iClass = colIndex(header, ['国际分类']);
  const iBrand = colIndex(header, ['所属品牌/主体', '所属品牌']);
  const iName = colIndex(header, ['商标名称']);
  if (iReg < 0 || iClass < 0 || iBrand < 0 || iName < 0) {
    throw new Error(`Missing expected column in ${path.basename(file)}: header=[${header.join('|')}]`);
  }

  const seen = new Set();
  const out = [];
  let skippedEmpty = 0;
  let skippedDup = 0;
  for (const r of rows) {
    const reg = normReg(r[iReg]);
    if (!reg) { skippedEmpty++; continue; }
    if (seen.has(reg)) { skippedDup++; continue; }
    seen.add(reg);
    out.push({
      name: String(r[iName] == null ? '' : r[iName]).trim(),
      reg_no: reg,
      class: normClass(r[iClass]),
      brand: String(r[iBrand] == null ? '' : r[iBrand]).trim(),
    });
  }
  return { trademarks: out, rowCount: rows.length, skippedEmpty, skippedDup };
}

function main() {
  const registry = JSON.parse(stripBom(fs.readFileSync(JSON_PATH, 'utf8')));

  const muke = buildTrademarks(path.join(CSV_DIR, 'muke.csv'));
  const fandao = buildTrademarks(path.join(CSV_DIR, 'fandao.csv'));

  if (!registry.entities || !registry.entities[MUKE_ENTITY] || !registry.entities[FANDAO_ENTITY]) {
    throw new Error('Expected entities not found in existing registry JSON.');
  }

  registry.entities[MUKE_ENTITY].trademarks = muke.trademarks;
  registry.entities[FANDAO_ENTITY].trademarks = fandao.trademarks;

  registry._meta = registry._meta || {};
  registry._meta.last_updated = '2026-07-09';
  registry._meta.source =
    '慕可/凡岛网络=CSV导出(2026-07-09,已注册现用)，其余主体=旧快照(2026-06-23)未更新';
  registry._meta.tables = registry._meta.tables || [
    'tblmzJEFz98w0zUU (慕可)',
    'tblwlp57lZCiJTFQ (凡岛网络)',
    'tblVCT3lSFLEBqIJ (欣芝妍)',
    'tblG4S7AnyJAUTtk (橙子网络)',
    'tbluHJ5YZYxjx4u4 (凡岛投资)',
    'tblyFnnJVazQx0Uy (海外商标统计)',
    'tblAXcXVEVbkeuWM (可续展商标)',
    'tblfu8xhnlgNurOA (商标注册申请)',
  ];

  fs.writeFileSync(JSON_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf8');

  const line = (label, s) =>
    `${label}: rows=${s.rowCount} kept=${s.trademarks.length} dupSkipped=${s.skippedDup} emptySkipped=${s.skippedEmpty}`;
  console.log(line('muke  ', muke));
  console.log(line('fandao', fandao));
  console.log('written: ' + JSON_PATH);
}

main();
