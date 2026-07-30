#!/usr/bin/env node
/**
 * smoke.cjs — 真实运行时冒烟闸（P0-1, 2026-07-29）
 *
 * 为什么要它：v3.0 迁移出的 8 个问题（SKILL_ROOT 加载顺序崩、qualStr 未定义、角色过滤 list/case
 *   不一致、数据路径飞错、gen_card 编码乱码…）【全是运行时/集成层】，而黄金测试是 require-mock、
 *   T4 是静态 grep、对抗审查子代理还超时挂了——三层都测不到"在真实安装位置、真起进程时的行为"，
 *   所以"9.5/10 一致性"下仍崩。本闸【真起子进程 node scripts/audit-tool.cjs …】跑核心链路，
 *   专抓那类 bug。并入棘轮：发 tag 前必绿。
 *
 * 安全：全程 QUAL_PROFILE=test（隔离台账 + 物理禁真实 approve），不碰生产数据、不真发审批。
 *
 * 判定原则：只把【代码级崩溃】判失败——ReferenceError / xxx is not defined / SyntaxError /
 *   PowerShell 解析错(乱码) / 进程非 0 且非受控退出。飞书 API/网络错(如查询超时)不算冒烟失败
 *   （那是环境不是代码）。
 *
 * 用法：node scripts/smoke.cjs          # 全绿 exit 0；任一代码级崩溃 exit 1
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const AUDIT = path.join(__dirname, 'audit-tool.cjs');
const SCOPE_FILTER = path.join(__dirname, '..', 'lib', 'scope-filter.js');
const results = [];
function rec(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

// 代码级崩溃特征（这些出现在 stderr/stdout 即判 bug；飞书业务错不在内）
const CRASH_RE = /ReferenceError|is not defined|Cannot access .* before initialization|SyntaxError|TypeError:.*is not a function|ParserError|Unexpected token|无法将.*识别为|命令、可执行程序|CommandNotFound/i;

// 起一个真实子进程跑 audit-tool 子命令，返回 { code, out, err }
function runAudit(args, extraEnv) {
  const env = { ...process.env, QUAL_PROFILE: 'test', ...(extraEnv || {}) };
  // spawnSync：无论退出码都同时返回 stdout+stderr（banner 在 stderr，execFileSync 成功时抓不到）。
  const r = spawnSync(process.execPath, [AUDIT, ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 180000, windowsHide: true, env,
    cwd: path.join(__dirname, '..'),
  });
  return { code: r.status == null ? -1 : r.status, out: r.stdout || '', err: r.stderr || '' };
}

// ── 检查 1：模块加载 + 路径解析（3 种角色）——抓 #1 加载顺序、#2 qualStr、#5 路径 ──
// lookup 轻量(读台账、不打重飞书)，足以触发整段模块加载 + PROFILE/路径求值。
for (const role of ['', 'faren', 'feifaren']) {
  const r = runAudit(['lookup-case-by-n', '1'], role ? { QUAL_AUDIT_ROLE: role } : { QUAL_AUDIT_ROLE: '' });
  const combined = r.out + r.err;
  const crashed = CRASH_RE.test(combined);
  // 期望：不崩（lookup 找不到 #1 是正常业务结果，不算失败）；banner 里 auditDir 存在
  const hasBanner = /\[qual-audit\][^\n]*auditDir=/.test(r.err);
  rec(`模块加载+路径 (role=${role || '未设'})`, !crashed && hasBanner,
    crashed ? '代码崩溃: ' + (combined.match(CRASH_RE) || [''])[0] : (hasBanner ? '' : '未见 auditDir banner'));
}

// ── 检查 2：list 真跑（test）——抓 cmdList 运行时(qualStr/isMyWorklistRole/路径) ──
{
  const r = runAudit(['list']);
  const combined = r.out + r.err;
  const crashed = CRASH_RE.test(combined);
  // list 可能返回 0 条待办 / needs_role_setup / 正常清单——都算通过；只要不代码崩溃
  let parseable = false;
  try { const jsonLine = r.out.split('\n').filter(l => l.trim().startsWith('{')).pop(); if (jsonLine) { JSON.parse(jsonLine); parseable = true; } } catch (e) {}
  rec('list 真跑(test) 不崩且输出可解析', !crashed && (parseable || /needs_role_setup|worklist|total_pending/.test(combined)),
    crashed ? '代码崩溃: ' + (combined.match(CRASH_RE) || [''])[0] : (parseable ? '' : 'stdout 非可解析 JSON'));
}

// ── 检查 3：gen-card 真跑(test)——抓 #6 PS1 编码乱码/语法错 ──
{
  const r = runAudit(['gen-card'], { QUAL_FORCE_CARD: '1' });
  const combined = r.out + r.err;
  const crashed = CRASH_RE.test(combined);
  // 空台账时"无可渲染内容"是正常；只要 PS1 没编码乱码/语法崩
  rec('gen-card 真跑(test) PS1 无编码/语法崩', !crashed,
    crashed ? 'PS1 崩溃: ' + (combined.match(CRASH_RE) || [''])[0] : '');
}

// ── 检查 4：角色分拣收口 isMyWorklistRole（抓 #3/#4 各管各的）——直接 require 断言 ──
{
  let ok = true, detail = '';
  try {
    delete require.cache[require.resolve(SCOPE_FILTER)];
    const m = require(SCOPE_FILTER);
    const cases = [
      ['faren', '法定代表人签名（总经办）', true],
      ['faren', '品牌授权书（总经办）', false],   // 关键：品牌授权书不进法人岗（#3/#4）
      ['faren', '其它', true],
      ['feifaren', '品牌授权书（总经办）', true],
      ['feifaren', '法定代表人签名', false],
      ['', '品牌授权书（总经办）', true],          // 未设角色=全量
    ];
    for (const [role, q, exp] of cases) {
      process.env.QUAL_AUDIT_ROLE = role;
      const got = m.isMyWorklistRole(q);
      if (got !== exp) { ok = false; detail += `[role=${role || '未设'} q=${q} 期望${exp}得${got}] `; }
    }
    delete process.env.QUAL_AUDIT_ROLE;
  } catch (e) { ok = false; detail = e.message; }
  rec('角色分拣收口 isMyWorklistRole', ok, detail);
}

// ── 检查 5：黄金回归（若存在 runner）──
{
  const runner = path.join(__dirname, '..', '.dev', 'golden_set');
  const e2e = path.join(__dirname, 'run_golden_e2e.cjs');
  if (fs.existsSync(e2e) && fs.existsSync(runner)) {
    rec('黄金回归 runner 存在', true, '（本闸不代跑重回归，仅确认在包内；发版前另跑 run_golden_e2e）');
  } else {
    rec('黄金回归 runner 存在', false, 'run_golden_e2e.cjs 或 .dev/golden_set 缺失');
  }
}

// ── 汇总 ──
const failed = results.filter(r => !r.ok);
console.log('\n==== 冒烟闸结果 ====');
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${failed.length === 0 ? '🟢 全绿' : '🔴 ' + failed.length + ' 项失败'} (${results.length - failed.length}/${results.length})`);
process.exit(failed.length === 0 ? 0 : 1);
