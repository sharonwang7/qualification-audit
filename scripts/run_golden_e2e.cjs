#!/usr/bin/env node
/**
 * run_golden_e2e.cjs — 端到端 golden runner（骨架）
 *
 * 与 run_golden.cjs 的区别：不喂预摘要，而是【读 GS<ID>/attachments/ 里的原始附件文件，
 * 跑真实 readAttachmentContent（PyMuPDF/OCR/视觉管线）】→ 输出可交给 AI 判的 case 包。
 * 这样测的是"判断层 + 提取层"的端到端表现（含 OCR/视觉识别误差）。
 *
 * 用法: node scripts/run_golden_e2e.cjs GS013 [GS002 ...]
 *   - 有 attachments/ 目录 → 走真实读取（端到端）
 *   - 无 attachments/ 目录 → 回退用 input.json 里的预摘要（判断层）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { readAttachmentContent } = require('../lib/data-prep.js');

const GOLDEN = process.env.QUAL_GOLDEN_DIR || path.join(__dirname, '..', '.dev', 'golden_set');
const rd = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

// 从 GS<ID>/attachments/ 构造"指向本地文件"的附件列表（模拟 downloadAttachments 的输出形状）
function buildLocalAttachments(gsDir) {
  const adir = path.join(gsDir, 'attachments');
  if (!fs.existsSync(adir)) return null;
  const files = fs.readdirSync(adir).filter(f => !f.startsWith('.'));
  if (!files.length) return null;
  return files.map(f => {
    const fp = path.join(adir, f);
    return { name: f, path: fp, size: fs.statSync(fp).size };
  });
}

function runE2E(id) {
  const gsDir = path.join(GOLDEN, id);
  const input = rd(path.join(gsDir, 'input.json'));
  const local = buildLocalAttachments(gsDir);
  let mode, attachDocs;
  if (local) {
    mode = 'e2e(真实读取本地附件)';
    attachDocs = readAttachmentContent(local);   // ← 现成读取引擎，0 改动
  } else {
    mode = 'fallback(预摘要，判断层)';
    attachDocs = (input.attachments || []);
  }
  // 镜像生产 case 的场景强制闸（防"富信息附件稀释规则执行"）
  const _formText = JSON.stringify(input.form || {});
  const scene_gates = [];
  if (/回退|注销|转移|迁移|找回|解绑|过户|变更主体|账号转让/.test(_formText)) {
    scene_gates.push('⚠️P03[账号操作]：本单疑似账号操作。P02(平台强制材料，截图可证) ≠ P03(操作原因与影响)。必须正面回答"为什么做该操作+影响"；未答→需补充，不得因材料齐全就判通过。');
  }
  return {
    id, mode, scene_gates,
    form: input.form,
    attachments: attachDocs.map((a, i) => ({
      idx: i,
      source: a.source || a.name || `attach_${i + 1}`,
      type: a.type,
      status: a.status,
      chars: (a.content || '').length,
      vision_paths: a.vision_paths || undefined,
      preview: (a.content || '').slice(0, 120)
    }))
  };
}

const ids = process.argv.slice(2);
if (!ids.length) { console.error('用法: node scripts/run_golden_e2e.cjs GS013 [GS002 ...]'); process.exit(2); }
for (const id of ids) {
  console.log('==== ' + id + ' ====');
  console.log(JSON.stringify(runE2E(id), null, 2));
}
