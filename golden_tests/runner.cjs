// golden_tests/runner.cjs — qualification-audit 黄金测试驱动器 v2
// 直接 require 目标函数，不走子进程，避免飞书API/env穿透/编码三坑
// 用法: node golden_tests/runner.cjs [filter]

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TESTS_DIR = path.join(ROOT, 'tests');
const TEMP_DIR = path.join(ROOT, '_temp');

const results = [];
let passed = 0, failed = 0;

function assert(label, fn) {
  try {
    fn();
    passed++;
    results.push({ label, status: 'PASS' });
  } catch (e) {
    failed++;
    results.push({ label, status: 'FAIL', error: e.message });
  }
}

// 重置并创建 mock 工作区
function setupMock() {
  if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, 'cache'), { recursive: true });
  return {
    auditDir: TEMP_DIR,
    pendingPath: path.join(TEMP_DIR, 'pending_actions.json'),
    cardMapPath: path.join(TEMP_DIR, 'card_map.json'),
  };
}

function loadTests(filter) {
  return fs.readdirSync(TESTS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(TESTS_DIR, e.name, 'test.js')))
    .map(e => ({ name: e.name, mainJs: path.join(TESTS_DIR, e.name, 'test.js') }))
    .filter(t => !filter || t.name.includes(filter) || t.name.startsWith('T' + filter.replace(/^T/, '')));
}

async function main() {
  const filter = process.argv[2];
  const tests = loadTests(filter);
  if (tests.length === 0) {
    console.log(`⚠️  未找到测试 [${filter || '（无filter）'}]`);
    process.exit(0);
  }

  console.log(`\n═══════════ 黄金测试集 ═══════════`);
  console.log(`运行 ${tests.length} 条测试\n`);

  for (const test of tests) {
    console.log(`  ▶ ${test.name}`);
    const mock = setupMock();
    const mod = require(test.mainJs);
    const ctx = { assert, mock, fs, path, TEMP_DIR };
    try {
      await mod.run(ctx);
      if (mod.after) mod.after(ctx);
    } catch (e) {
      failed++;
      results.push({ label: test.name, status: 'ERROR', error: e.message });
      console.log(`    💥 ${e.message}`);
    }
    console.log('');
  }

  console.log(`═══════════ 结果 ═══════════`);
  console.log(`通过: ${passed}  失败: ${failed}`);
  if (failed > 0) {
    console.log('\n--- 失败 ---');
    for (const r of results) {
      if (r.status !== 'PASS') {
        console.log(`❌ ${r.label}: ${r.error || ''}`);
      }
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
