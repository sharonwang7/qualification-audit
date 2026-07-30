// golden_tests/lib/fixture-helper.cjs
// 封装 mock 环境搭建工具，供各测试复用
const fs = require('fs');
const path = require('path');

function setup(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  return dir;
}

function write(dir, file, data) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2), 'utf8');
}

function read(dir, file) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// 创建 mock 用 current_batch.json
function mockCurrentBatch(dir, batchDate, expected) {
  write(dir, 'current_batch.json', {
    batchDate,
    startedAt: new Date().toISOString(),
    expected: expected || [],
    outcomes: {}
  });
}

// 创建 mock 用 pending_actions.json
function mockPendingActions(dir, entries) {
  write(dir, 'pending_actions.json', {
    __meta: { nextN: 100 },
    ...entries
  });
}

// 创建 mock 用 card_map.json
function mockCardMap(dir, hasMap) {
  if (hasMap) {
    write(dir, 'card_map.json', {
      generated_at: new Date().toISOString(),
      card_map: { '20260727_oc_mock': 'om_mock' }
    });
  }
}

// 创建 mock 用 case.json（让 write-result 校验通过）
function mockCaseFile(dir, instanceCode, dest) {
  const caseDir = path.join(dir, '..', 'fando-ocr-cache', instanceCode);
  if (!fs.existsSync(caseDir)) fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'case.json'), JSON.stringify({
    instance_code: instanceCode,
    in_scope: true,
    should_skip: false,
    form: { '资质流向方全称（公司/自然人/平台）': [dest || 'mock流向方'] },
    ocr_gate: { all_ok: true, unreadable: [], low_conf_advisory: [] },
    deterministic: { issues: [], passed: true, criticalCount: 0, needs_human: false, unreadable_attachments: [], shouldSkip: false, skipReason: '', autoApprove: null, engine_failed: false, engine_error: '' },
    createTime: Math.floor(Date.now() / 1000)
  }, null, 2), 'utf8');
  return caseDir;
}

module.exports = { setup, write, read, mockCurrentBatch, mockPendingActions, mockCardMap, mockCaseFile };
