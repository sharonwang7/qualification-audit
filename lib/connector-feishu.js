/**
 * connector-feishu.js — 飞书接入连接器（L1 · P0 收拢）
 *
 * 唯一职责：把所有与飞书 lark-cli 的传输收进这一处。
 *   本模块之外的代码不应再直接 execFileSync('lark-cli', ...)。
 *
 * 背景（P0 分层重构）：飞书传输原本散在 3 处、各写一份 execFileSync + saved_path 解包：
 *   · scripts/audit-tool.cjs       lark() / larkApi() / larkApprovalAction()
 *   · lib/comment-manager.js       execLarkApi()
 * 收拢后：上述函数保留同名，改为薄委托到本模块，行为（argv + 返回契约）逐一保持不变。
 *
 * 安全：所有 lark-cli 调用统一 execFileSync 数组形式；动态数据（params/body/data）一律走 @file，
 *   命令行只有固定 flag + UUID + @文件名，无 shell 注入面。shell:true 是 Windows 下 .cmd/.ps1 shim 所必需。
 *
 * 传输层四个入口（严格对应旧实现，返回契约不变）：
 *   cliShortcut(cmd, params, {cwd})                    ≡ 旧 lark()            —— shortcut 子命令，--as user，返回 data|meta
 *   api(method, url, params, identity, {cwd})          ≡ 旧 larkApi()        —— 原始 api METHOD URL，默认 --as bot，返回 data|meta
 *   apiWithBody(method, url, params, body, id, {cwd})  ≡ 旧 execLarkApi()    —— 带 body，返回 {success, data} / {success, error}
 *   approvalAction(action, data, {cwd})                ≡ 旧 larkApprovalAction() —— approval tasks approve/reject，--yes --as user
 *
 * 语义层（在传输层之上，供后续把散落调用点迁移过来；行为等价于现有调用点内联逻辑）：
 *   getInstance / getInstanceComments / listBaseRecords / approve / reject
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_TIMEOUT = 30000;
const MAX_BUFFER = 10 * 1024 * 1024;

// 2026-07-24 弹窗根治：lark-cli 是 npm 脚本 shim（.ps1/.cmd）。execFileSync('lark-cli',{shell:true}) 走
//   cmd.exe → lark-cli.cmd（内有 `title %COMSPEC% & node run.js`）→ 起 node 跑真实 JS——那句 title 拉起可见
//   cmd 黑窗，且是【孙进程】，windowsHide 只压得住最外层 cmd、压不住它 → 每次审批弹十几个窗。
//   正解：直接 `node run.js` 跑（绕开整条 shell shim），windowsHide 才真正生效、且行为与 shim 逐字节等价
//   （identity/绑定/参数校验实测一致）。找不到 JS 入口时兜底退回 shim（保证异机可用）。
const LARK_CLI_JS = process.env.QUAL_LARKCLI_JS ||
  'C:\\Users\\FD\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\scripts\\run.js';
const LARK_DIRECT = (() => { try { return fs.existsSync(LARK_CLI_JS); } catch (e) { return false; } })();

// 写一个临时 @file（前缀沿用旧实现，保持崩溃残留清理 glob 兼容：_at_ / _api_p_ / _d_ / _p_ / _b_）
function tmpWrite(cwd, prefix, obj) {
  const f = path.join(cwd, `${prefix}${Date.now()}_${Math.floor(process.hrtime()[1])}.json`);
  fs.writeFileSync(f, JSON.stringify(obj), 'utf8');
  return f;
}
function tryUnlink(f) { try { fs.unlinkSync(f); } catch (e) {} }

// 传输核心：execFileSync → 解析 stdout meta → 若 saved_path 存在则读文件解包（去 BOM，可选去控制字符）→ 返回 data|meta
// 所有旧实现共享这一段；差异仅 stripCtrl（approvalAction 只去 BOM）。
function runLark(argv, { cwd = process.cwd(), stripCtrl = true } = {}) {
  // 2026-07-24 修直调回归：LARK_DIRECT(node run.js, 无 shell)不会像 shell 那样对含空格的 argv 元素再分词，
  //   而 shortcut/approval 命令以 'approval tasks query' 这种多词整串传入 → 直调下被当成单个「未知命令」，
  //   打断 list/getInstance/approve/reject 全链路。（shim 分支靠 shell:true 让 cmd 重新分词，一直正常。）
  //   修：直调前把每个 argv 元素按空格拆开。安全：动态数据(params/body/data)一律走 @file，
  //   命令行只有固定命令词+flag+UUID+@文件名，均无空格 → 拆分无副作用。
  const directArgv = argv.flatMap(a => String(a).split(' ')).filter(s => s.length);
  const out = LARK_DIRECT
    // 直调 node run.js：无 shell、无 shim → 无 cmd 窗；windowsHide 隐藏 node 自身控制台。env 继承 → LARK_CHANNEL 绑定保留。
    ? execFileSync(process.execPath, [LARK_CLI_JS, ...directArgv], {
        encoding: 'utf8', maxBuffer: MAX_BUFFER, cwd, timeout: DEFAULT_TIMEOUT, windowsHide: true
      })
    // 兜底（异机/未装到默认路径）：退回 shim + shell:true + windowsHide（至少压外层窗）。
    : execFileSync('lark-cli', argv, {
        encoding: 'utf8', maxBuffer: MAX_BUFFER, cwd, timeout: DEFAULT_TIMEOUT, shell: true, windowsHide: true
      });
  const meta = JSON.parse((out.trim()) || '{}');
  if (meta.saved_path && fs.existsSync(meta.saved_path)) {
    let raw = fs.readFileSync(meta.saved_path, 'utf8').replace(/^﻿/, '');
    if (stripCtrl) raw = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    const data = JSON.parse(raw);
    tryUnlink(meta.saved_path);
    return data;
  }
  return meta;
}

// ── 传输层入口 ──────────────────────────────────────────────

// ≡ 旧 audit-tool.lark(cmd, params)：shortcut 子命令，固定 --as user，返回 data|meta
function cliShortcut(cmd, params, { cwd = process.cwd() } = {}) {
  const pfile = tmpWrite(cwd, '_at_', params);
  try {
    return runLark([cmd, '--params', '@' + path.basename(pfile), '--as', 'user'], { cwd, stripCtrl: true });
  } finally {
    tryUnlink(pfile);
  }
}

// ≡ 旧 audit-tool.larkApi(method, url, params, identity)：原始 api，默认 --as bot，--format json，返回 data|meta
function api(method, url, params, identity, { cwd = process.cwd() } = {}) {
  const pfile = tmpWrite(cwd, '_api_p_', params || {});
  try {
    return runLark(
      ['api', method, url, '--params', '@' + path.basename(pfile), '--as', identity || 'bot', '--format', 'json'],
      { cwd, stripCtrl: true }
    );
  } finally {
    tryUnlink(pfile);
  }
}

// ── 审批定义列表（v3.2.3）──
// 从本地缓存 common/approval-definitions.json 读，不再调飞书 API。
// 审批流是公司固定的 → 预拉一次缓存进技能包 = 零 API 调用、零 scope 依赖、对所有团队/agent 都稳。
// 新增审批流时跑：node scripts/refresh-approval-defs.cjs → 更新缓存文件 → 提交。
function listApprovalDefinitions(pageSize = 500) {
  try {
    const defs = require('../common/approval-definitions.json');
    const items = defs.map(d => ({ approval_name: d.name, approval_code: d.code, group_name: d.group }));
    const paged = pageSize > 0 ? items.slice(0, pageSize) : items;
    return { data: { items: paged, has_more: false } };
  } catch (e) {
    return { data: { items: [], has_more: false } };
  }
}

// ≡ 旧 comment-manager.execLarkApi(method, url, params, body, identity)：带 body，返回 {success, data} / {success, error}
function apiWithBody(method, url, params, body, identity, { cwd = process.cwd() } = {}) {
  const pfile = tmpWrite(cwd, '_p_', params || {});
  let bfile = null;
  const argv = ['api', method, url, '--params', '@' + path.basename(pfile)];
  if (body !== undefined && body !== null) {
    bfile = tmpWrite(cwd, '_b_', body);
    argv.push('--data', '@' + path.basename(bfile));
  }
  argv.push('--as', identity || 'bot', '--format', 'json');
  try {
    const data = runLark(argv, { cwd, stripCtrl: true });
    return { success: true, data };
  } catch (err) {
    return { success: false, error: { message: err.message, code: err.code } };
  } finally {
    tryUnlink(pfile);
    if (bfile) tryUnlink(bfile);
  }
}

// ≡ 旧 audit-tool.larkApprovalAction(action, data)：approval tasks approve/reject，--yes --as user，只去 BOM（stripCtrl:false）
function approvalAction(action, data, { cwd = process.cwd() } = {}) {
  const dfile = tmpWrite(cwd, '_d_', data);
  try {
    return runLark(
      [`approval tasks ${action}`, '--data', '@' + path.basename(dfile), '--yes', '--as', 'user'],
      { cwd, stripCtrl: false }
    );
  } finally {
    tryUnlink(dfile);
  }
}

// ── 语义层（薄封装，供后续迁移调用点；平台化时这一层将换成"统一审批数据模型"）──

// 审批实例详情（shortcut）
function getInstance(instanceCode, opts) {
  return cliShortcut('approval instances get', { instance_code: instanceCode }, opts);
}

// 审批实例评论（权威接口 /approval/v4/instances/{code}/comments，须带 user_id）
function getInstanceComments(instanceCode, userOpenId, opts) {
  const url = `/open-apis/approval/v4/instances/${instanceCode}/comments`;
  return api('GET', url, { user_id: userOpenId, user_id_type: 'open_id' }, 'bot', opts);
}

// 多维表格记录（bitable records，--as user）
function listBaseRecords(appToken, tableId, params, opts) {
  const url = `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;
  return api('GET', url, params, 'user', opts);
}

// 拉取云文档全文（docs +fetch，--scope full --as user）；返回解包后的 raw（data|meta），只去 BOM
function fetchDoc(docId, { cwd = process.cwd() } = {}) {
  return runLark(
    ['docs', '+fetch', '--doc', docId, '--scope', 'full', '--as', 'user', '--format', 'json'],
    { cwd, stripCtrl: false }
  );
}

function approve(instanceCode, taskId, opts) {
  return approvalAction('approve', { instance_code: instanceCode, task_id: taskId }, opts);
}
function reject(instanceCode, taskId, opts) {
  return approvalAction('reject', { instance_code: instanceCode, task_id: taskId }, opts);
}

module.exports = {
  // 传输层
  cliShortcut,
  api,
  apiWithBody,
  approvalAction,
  runLark,
  // 语义层
  getInstance,
  getInstanceComments,
  listBaseRecords,
  fetchDoc,
  approve,
  reject,
  listApprovalDefinitions,
};
