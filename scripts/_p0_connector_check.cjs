#!/usr/bin/env node
/**
 * _p0_connector_check.cjs — P0 ① 连接器等价性护栏（离线，不打 live 飞书）
 *
 * golden 只测确定性层，测不到飞书传输。此脚本用 monkeypatch 捕获连接器产出的
 * lark-cli argv + @file 内容，逐一断言与旧内联实现等价；并验证 saved_path 解包。
 * 退出码：全过 0；任一不符 1。
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'p0chk_'));
process.chdir(WORK);

// 捕获 execFileSync 调用；返回可控 stdout。
// 注意：连接器在 require 时即解构绑定 execFileSync，故必须在 require 之前打桩，
//   且之后只能通过 STDOUT / THROW 变量控制行为（重新赋值 cp.execFileSync 对已绑定引用无效）。
let CAP = null;
let STDOUT = '{"ok":true}';
let THROW = null;  // {message,code} → 桩抛该异常，用于验证 error 契约
const realExec = cp.execFileSync;
cp.execFileSync = function (file, argv, opts) {
  if (THROW) { const e = new Error(THROW.message); e.code = THROW.code; throw e; }
  // 快照本次调用时各 @file 的内容（此刻临时文件还在，finally 尚未 unlink）
  const files = {};
  for (const a of argv) {
    if (typeof a === 'string' && a.startsWith('@')) {
      const p = path.join(opts.cwd || process.cwd(), a.slice(1));
      try { files[a] = fs.readFileSync(p, 'utf8'); } catch (e) { files[a] = '<missing>'; }
    }
  }
  CAP = { file, argv: argv.slice(), opts, files };
  return STDOUT;
};

const connector = require('../lib/connector-feishu.js');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name} — ${detail}`); }
}

// 把 argv 里的 @临时文件名归一为 @P/@B/@D（按前缀），便于稳定断言
function normArgv(argv) {
  return argv.map(a => {
    if (typeof a !== 'string' || !a.startsWith('@')) return a;
    if (a.includes('_b_')) return '@B';
    if (a.includes('_d_')) return '@D';
    return '@P';           // _at_ / _api_p_ / _p_ 均为 params @file
  });
}
function paramContent(cap) {
  const key = Object.keys(cap.files).find(k => !k.includes('_b_') && !k.includes('_d_'));
  return cap.files[key];
}
function bodyContent(cap) {
  const key = Object.keys(cap.files).find(k => k.includes('_b_') || k.includes('_d_'));
  return cap.files[key];
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('═══ ① 传输层 argv + @file 内容等价 ═══');

// 1) cliShortcut ≡ 旧 lark()
let r = connector.cliShortcut('approval instances get', { instance_code: 'X' }, { cwd: WORK });
check('cliShortcut argv', eq(normArgv(CAP.argv), ['approval instances get', '--params', '@P', '--as', 'user']), JSON.stringify(CAP.argv));
check('cliShortcut params', paramContent(CAP) === '{"instance_code":"X"}', paramContent(CAP));
check('cliShortcut return', eq(r, { ok: true }), JSON.stringify(r));

// 2) api ≡ 旧 larkApi()，identity 缺省 → bot
connector.api('GET', '/open-apis/x', { a: 1 }, undefined, { cwd: WORK });
check('api argv(bot)', eq(normArgv(CAP.argv), ['api', 'GET', '/open-apis/x', '--params', '@P', '--as', 'bot', '--format', 'json']), JSON.stringify(CAP.argv));
check('api params', paramContent(CAP) === '{"a":1}', paramContent(CAP));
// params 为 null → 写 '{}'
connector.api('GET', '/u', null, 'user', { cwd: WORK });
check('api argv(user)', eq(normArgv(CAP.argv), ['api', 'GET', '/u', '--params', '@P', '--as', 'user', '--format', 'json']), JSON.stringify(CAP.argv));
check('api null-params → {}', paramContent(CAP) === '{}', paramContent(CAP));

// 3) apiWithBody ≡ 旧 execLarkApi()，返回 {success,data}
r = connector.apiWithBody('POST', '/c', { p: 1 }, { b: 2 }, 'bot', { cwd: WORK });
check('apiWithBody argv(body)', eq(normArgv(CAP.argv), ['api', 'POST', '/c', '--params', '@P', '--data', '@B', '--as', 'bot', '--format', 'json']), JSON.stringify(CAP.argv));
check('apiWithBody params', paramContent(CAP) === '{"p":1}', paramContent(CAP));
check('apiWithBody body', bodyContent(CAP) === '{"b":2}', bodyContent(CAP));
check('apiWithBody return', eq(r, { success: true, data: { ok: true } }), JSON.stringify(r));
// 无 body → 不加 --data
connector.apiWithBody('GET', '/c', { p: 1 }, null, 'user', { cwd: WORK });
check('apiWithBody argv(no-body)', eq(normArgv(CAP.argv), ['api', 'GET', '/c', '--params', '@P', '--as', 'user', '--format', 'json']), JSON.stringify(CAP.argv));

// apiWithBody 失败 → {success:false,error}（用 THROW 标志触发同一绑定桩抛错）
THROW = { message: 'boom', code: 7 };
r = connector.apiWithBody('GET', '/c', {}, null, 'bot', { cwd: WORK });
check('apiWithBody error contract', eq(r, { success: false, error: { message: 'boom', code: 7 } }), JSON.stringify(r));
THROW = null;

// 4) approvalAction ≡ 旧 larkApprovalAction()
connector.approvalAction('approve', { instance_code: 'X', task_id: 'T' }, { cwd: WORK });
check('approvalAction argv', eq(normArgv(CAP.argv), ['approval tasks approve', '--data', '@D', '--yes', '--as', 'user']), JSON.stringify(CAP.argv));
check('approvalAction data', bodyContent(CAP) === '{"instance_code":"X","task_id":"T"}', bodyContent(CAP));

console.log('═══ ② saved_path 解包（去 BOM + 控制字符）═══');
// 造一个 saved_path 文件含 BOM + 控制字符，断言 runLark 正确解包
const sp = path.join(WORK, 'saved.json');
fs.writeFileSync(sp, '﻿{"v":"ab"}', 'utf8');  // BOM + BEL(0x07)
STDOUT = JSON.stringify({ saved_path: sp });
r = connector.api('GET', '/x', {}, 'bot', { cwd: WORK });
check('saved_path 解包+去控制字符', eq(r, { v: 'ab' }), JSON.stringify(r));
check('saved_path 用后删除', !fs.existsSync(sp), 'saved.json 应被 unlink');

// approvalAction 只去 BOM（不去控制字符）—— 保留旧行为
const sp2 = path.join(WORK, 'saved2.json');
fs.writeFileSync(sp2, '﻿{"v":"x"}', 'utf8');
STDOUT = JSON.stringify({ saved_path: sp2 });
r = connector.approvalAction('reject', { instance_code: 'Y', task_id: 'Z' }, { cwd: WORK });
check('approvalAction saved_path 解包', eq(r, { v: 'x' }), JSON.stringify(r));

// fetchDoc ≡ 旧 fetchDocAndCacheAll 内联：docs +fetch，无 @file
STDOUT = '{"ok":true}';
r = connector.fetchDoc('docXYZ', { cwd: WORK });
check('fetchDoc argv', eq(CAP.argv, ['docs', '+fetch', '--doc', 'docXYZ', '--scope', 'full', '--as', 'user', '--format', 'json']), JSON.stringify(CAP.argv));

console.log('═══ ③ 模块加载 ═══');
try { require('../lib/comment-manager.js'); check('comment-manager 加载', true); }
catch (e) { check('comment-manager 加载', false, e.message); }

// 清理
cp.execFileSync = realExec;
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}

console.log(`\n═══ 汇总 ═══  ${failures === 0 ? '全过 ✅' : failures + ' 项不符 ❌'}`);
process.exit(failures ? 1 : 0);
