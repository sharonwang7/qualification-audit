#!/usr/bin/env node
/**
 * audit-tool.cjs — 资质审核「机械工具」（做法一：agent 驱动）
 *
 * 分工：agent(大模型) 负责三阶段【判断】；本工具只做机械活和确定性硬规则，绝不做语义判断。
 *
 * 子命令：
 *   list [limit]                           → 待办列表(最近在前，默认上限 50)。返回含 fetched/has_more(待审实际可能更多)。
 *   case <instance_code> [force]           → 单条数据包【精简】：表单 + 附件摘要/预览 + 确定性红线 + case_file。
 *                                            默认【跳过已审】：已有AI评论且无冲突 → should_skip=true 早退，不下载/不OCR(免重复白跑)。
 *                                            force 或 QUAL_FORCE_RECHECK=1 → 强制重审。附件全文写盘到 case_file。
 *   read-attachment <code> <idx> [maxChars]→ 按需、有界地读某条附件全文(默认上限 4000 字)。
 *   comment <instance_code> <textfile>     → 写评论(编码/查重/限流由工具处理)。
 *
 * 环境变量：FEISHU_APP_ID, QUAL_DEFINITION_CODE, FEISHU_USER_OPEN_ID, QUAL_ATTACH_DIR, QUAL_PYTHON_BIN, QUAL_OCR_CLI, QUAL_CARD_SCRIPT
 * 注：判断用哪个大模型由 OpenClaw 决定，本工具不涉及模型调用。
 */
process.noDeprecation = true;  // 抑制 shell:true 的 DEP0190 告警，避免污染输出被 agent 误解析

const fs = require('fs');
const path = require('path');

// 加载技能包根目录下的 .env（系统环境变量优先，不覆盖已有值）
(function loadDotEnv() {
  const envFile = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
})();
const { execFileSync, execSync, spawn } = require('child_process');

const { parseForm, downloadAttachments, downloadCommentAttachments, readAttachmentContent, findCloudDocLinks } = require('../lib/data-prep.js');
const { runDeterministicChecks, loadEntities } = require('../lib/deterministic-checker.js');
const { checkNamedPersonRank } = require('../lib/named-person-rank.js');
const { checkPhoneRoster, normPhone: normRosterPhone } = require('../lib/phone-roster-check.js');
const { checkTrademarkAuth, normRegNo: normTmRegNo } = require('../lib/trademark-auth-check.js');
const { isInScope, MY_AUDIT_QUALS } = require('../lib/scope-filter.js');
const { hasAIComment, writeComment, extractCommentAttachments } = require('../lib/comment-manager.js');
const { withLock, atomicWriteFileSync } = require('../lib/file-lock.js');
// L1 飞书接入连接器（P0 收拢）：本文件所有 lark-cli 传输统一委托到此模块
const connector = require('../lib/connector-feishu.js');

// ── 棘轮版本检查（v2.2.2）──
// 每次命令执行前记录 git 版本、最新 tag 和脏状态，方便生产审计和回滚
function checkSkillVersion() {
  try {
    const tag = execSync('git describe --tags --abbrev=0', { cwd: __dirname, encoding: 'utf8', timeout: 3000 }).trim();
    const latest = execSync('git tag --sort=-creatordate', { cwd: __dirname, encoding: 'utf8', timeout: 3000 }).split('\n')[0].trim();
    const dirty = execSync('git status --porcelain', { cwd: __dirname, encoding: 'utf8', timeout: 3000 }).trim();
    const hash = execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8', timeout: 3000 }).trim();
    const status = dirty ? '\u26a0\ufe0f DIRTY' : (tag !== latest ? `\u26a0\ufe0f BEHIND(latest=${latest})` : 'clean');
    return { tag, hash, latest, dirty: !!dirty, status };
  } catch (e) {
    return { tag: 'unknown', hash: 'unknown', status: 'no-git' };
  }
}

// ── Profile 隔离层（C1, 2026-07-02）：一个开关锁定整组环境，杜绝"改了群忘了改状态"的半吊子隔离 ──
// prod = 大公子桥真实生产（值取自 .env）；test = OpenClaw 测试（硬编码 _test 路径 + 测试群 + 禁 approve）。
// 安全默认 test（fail-safe）：忘设 QUAL_PROFILE 不会误伤生产；生产入口必须显式 QUAL_PROFILE=prod。
// 显式 env（approve 硬锁只认它，绝不认 sentinel 继承 → 保 fail-safe「忘设不误伤生产」）。
const QUAL_PROFILE_ENV = (process.env.QUAL_PROFILE || '').toLowerCase();
// 活动 profile sentinel（cmdList 在 list 时写、固定非 profile 路径 scratch/active_profile）：
//   子代理由 sessions_spawn 起、不继承父进程 env → 无显式 env 时读 sentinel 继承父 profile。
//   2026-07-24 prod 空跑修：否则子代理默认 test → write-result/markOutcome 误落 test 台账、父在 prod 收不到 → 空卡。
function _readActiveProfileSentinel() {
  try { const s = fs.readFileSync(path.join(__dirname, '..', 'scratch', 'active_profile'), 'utf8').trim().toLowerCase(); if (s === 'prod' || s === 'test') return s; } catch (e) {}
  return '';
}
// 路由用 profile（台账/群/身份）：显式 env > sentinel 继承 > 默认 test（fail-safe）。
const QUAL_PROFILE = QUAL_PROFILE_ENV || _readActiveProfileSentinel() || 'test';
const PROFILES = {
  prod: {
    chatId:   process.env.LARK_AUDIT_CHAT_ID   || 'oc_231fbee0b63f15721bc550e75897b818',
    chatB:    process.env.QUAL_CARD_B_CHAT     || 'oc_b3d2d2ec90d16d1f594a73dc56583af2',  // Card B（商标+授权）群
    identity: process.env.FEISHU_USER_OPEN_ID  || 'ou_102cae80079463e6c8281777fec96f47',
    auditDir: process.env.QUAL_AUDIT_DIR       || 'D:\\agent-hub\\audit_reports',
    pending:  process.env.QUAL_PENDING_ACTIONS || 'D:\\agent-hub\\pending_actions.json',
    allowApprove: true,
    // 发卡身份（feishu account key）。空=沿用 gen_card 默认（config.json claude_bot=大公子），生产维持现状零改动。
    cardBotAccount: process.env.QUAL_CARD_BOT_ACCOUNT || 'zizhi',  // 2026-07-24 王爷定：zizhi 独跑生产 → prod 卡也由 zizhi 发（原默认空=大公子）
    // 额外生产群（2026-07-23 王爷请求把旧群 oc_b3f3cf 也纳入）：卡在主群 chatId 之外，同时发到这些群（逗号分隔可多）。
    //   每群卡独立 key=batchDate+chatId 追踪/原地更新；FAIR 从任一群回都按 #N 处理，与群无关。
    extraChats: (process.env.QUAL_EXTRA_PROD_CHATS || 'oc_b3f3cfa72f5bddbbb3c50009f95e10e0').split(',').map(s => s.trim()).filter(Boolean),
  },
  test: {
    chatId:   'oc_e8198717e2b926d97fb9007171aef2af',
    chatB:    process.env.QUAL_CARD_B_CHAT     || 'oc_e8198717e2b926d97fb9007171aef2af',  // 测试：B 也发测试群
    identity: 'ou_dc58e9efc5ed5cf4c73d48249d7f8e70',
    auditDir: 'D:\\agent-hub\\_test\\audit_reports',
    pending:  'D:\\agent-hub\\_test\\pending_actions.test.json',
    allowApprove: false,
    // 测试环境卡由【资质审核助手自己(zizhi)】发，不再借大公子身份（2026-07-09 修 #3 身份错配）。
    cardBotAccount: process.env.QUAL_CARD_BOT_ACCOUNT || 'zizhi',
  },
};
const CFG = { ...(PROFILES[QUAL_PROFILE] || PROFILES.test) };  // 克隆，避免下方 approve 覆盖污染 PROFILES 模板
// 🔴 approve 硬锁：只有【显式 env=prod】才放开 approve/reject/note；profile 来自 sentinel 继承（子代理场景）时
//   强制 allowApprove=false → 忘设/继承来的 prod 仍拦真实审批，fail-safe 完全不被 sentinel 削弱。
if (QUAL_PROFILE_ENV !== 'prod') CFG.allowApprove = false;

// ── 卡片分类 + 拆卡开关 + 委托授权（2026-07-06）──
// 资质 → 卡片类别：含 法人/董事/股东 → 'A'（法人+其他）；否则含 商标/授权书类 → 'B'（商标+授权）；其它(在范围)→ 'A'。
// 行政类本就 in_scope=false、不落盘不上卡，无需在此处理。王爷定界：只要含法人/董事就归 A。
function categorize(sealType) {
  const s = String(sealType || '');
  if (/法定代表人|法人|董事|股东/.test(s)) return 'A';
  if (/商标注册证|商标授权书|品牌授权书|授权书/.test(s)) return 'B';
  return 'A';
}
const CAT_LABEL = { A: '法人+其他', B: '商标+授权' };
// 拆卡总开关：默认关（保持单卡现状，零改动上线）；ready 后置 QUAL_SPLIT_CARDS=1 启用双卡。
const SPLIT_CARDS = process.env.QUAL_SPLIT_CARDS === '1';
// 委托白名单：open_id → 允许处理的类别（'A'|'B'|'all'）。operator(CFG.identity=王爷) 恒 all（不入表）。
// 从 env QUAL_DELEGATES 读 JSON（如 {"ou_xxx":"B"}）；解析失败置空 → 无委托，仅 operator 全权。
let QUAL_DELEGATES = {};
try { if (process.env.QUAL_DELEGATES) QUAL_DELEGATES = JSON.parse(process.env.QUAL_DELEGATES); }
catch (e) { console.error('[qual-audit] QUAL_DELEGATES 解析失败，忽略：' + e.message); }
// 启动自检：当前 profile 打到 stderr（不污染 stdout 的 JSON 输出），便于确认没跑错环境。
const _ver = checkSkillVersion();
console.error(`[qual-audit] PROFILE=${QUAL_PROFILE} ${_ver.tag} @ ${_ver.hash} [${_ver.status}] chat=${CFG.chatId} auditDir=${CFG.auditDir} allowApprove=${CFG.allowApprove}`);

const APP_ID = process.env.FEISHU_APP_ID || 'cli_9cb844403dbb9108';
const DEFINITION_CODE = process.env.QUAL_DEFINITION_CODE || '0E0BBB7F-A4C8-471F-8051-3E4E88A83856';
// 写/查评论用的 user_id：必须是【当前调用 --as bot 所用 app 的用户】，否则 99992361 cross app。
//   大公子桥(cli_aaa274)：王伊瑄=ou_102cae；OpenClaw/zizhi(独立 app)：王伊瑄=ou_dc58e9（飞书 open_id 按 app 隔离，同一人不同 app 不同 id）。
// 2026-07-25（王爷要求·各环境默认用自己身份）：prod 下不再靠固定 .env 值（两环境 .env 同步、都写死 ou_102cae → zizhi 跑必 cross app），
//   改为运行时取【当前 lark-cli 登录用户 openId】(auth status)——天然是"本 app 命名空间的 open_id"：大公子自动 ou_102cae、zizhi 自动 ou_dc58e9。
//   优先级：显式 QUAL_APPROVAL_OPEN_ID 覆盖 > prod 取 auth-status > 回退 CFG.identity（含 .env FEISHU_USER_OPEN_ID / 硬编码）。
//   test 不调 lark-cli，直接用硬编码 CFG.identity（隔离）。
const USER_OPEN_ID = (() => {
  if (process.env.QUAL_APPROVAL_OPEN_ID) return process.env.QUAL_APPROVAL_OPEN_ID;
  if (QUAL_PROFILE === 'prod') {
    try {
      const j = require('../lib/connector-feishu.js').runLark(['auth', 'status', '--json'], { cwd: process.cwd(), stripCtrl: false });
      const oid = j && j.identities && j.identities.user && j.identities.user.openId;
      if (oid) { console.error(`[qual-audit] 审批身份(auth-status)=${oid}`); return oid; }
    } catch (e) { console.error('[qual-audit] auth-status 取审批身份失败，回退 CFG.identity(' + CFG.identity + ')：' + e.message); }
  }
  return CFG.identity;
})();
const ATTACH_DIR = process.env.QUAL_ATTACH_DIR || 'D:\\fando-ocr-cache';
const CWD = process.cwd();
const PREVIEW_CHARS = 240;
const READ_DEFAULT_MAX = 4000;

// approve/reject/note 成功后 fire-and-forget 同步 bitable（兼容 大公子 和 OpenClaw）
const SYNC_SCRIPT = process.env.QUAL_SYNC_SCRIPT || 'D:\\agent-hub\\scripts\\sync-audit-bitable.cjs';
function spawnAutoSync() {
  if (!fs.existsSync(SYNC_SCRIPT)) return;
  const child = spawn('node', [SYNC_SCRIPT, '--days=7'], {
    detached: true, stdio: 'ignore', env: process.env, shell: true, windowsHide: true
  });
  child.unref();
}

// lark-cli 调用：传输已收拢到 connector-feishu.js（L1）。保留同名薄委托，调用点不变。
function lark(cmd, params) {
  return connector.cliShortcut(cmd, params, { cwd: CWD });
}

function getInstance(code) {
  return lark('approval instances get', { instance_code: code });
}

// ── open_id → 姓名 反查（工具层兜底，不依赖模型智能）──
// 申请人常在表单没填「申请人」栏；强模型会自己拿发起人 open_id 反查真名、弱模型不会 → 下沉进代码，两者都稳。
// 缺 contact:user.basic_profile:readonly scope 或查失败 → fail-open 返回 ''（不阻断审核）。进程内缓存，避免重复查。
const _userNameCache = {};
function resolveUserName(openId) {
  if (!openId || !/^ou_/.test(openId)) return '';
  if (Object.prototype.hasOwnProperty.call(_userNameCache, openId)) return _userNameCache[openId];
  let name = '';
  try {
    const url = `https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id&department_id_type=open_department_id`;
    const data = larkApi('GET', url, {}, 'user');
    name = (data && data.user && data.user.name) || '';
  } catch (e) { name = ''; }
  _userNameCache[openId] = name;
  return name;
}

// ── 节点识别：审核 bot 只处理「审批/审核」节点；下游「是否领取」等节点不是它的活。──
// 审核节点名正则可配（QUAL_AUDIT_NODE_RE，默认 审批|审核）。
const AUDIT_NODE_RE = new RegExp(process.env.QUAL_AUDIT_NODE_RE || '审批|审核');
function pendingNodeInfo(instData) {
  const tasks = (instData && instData.tasks) || [];
  const pending = tasks.filter(t => t && t.status === 'PENDING');
  const pendingNodes = [...new Set(pending.map(t => t.node_name).filter(Boolean))];
  // collectOnly：有 pending 任务、但没有一个在审核节点 → 当前只剩领取等下游节点，非审核 bot 的活。
  // fail-safe：读不到 tasks / 无 pending → collectOnly=false（保守不跳，宁多审不漏审）。
  const collectOnly = pending.length > 0 && !pendingNodes.some(n => AUDIT_NODE_RE.test(n));
  return { pendingNodes, collectOnly };
}

// ── 原始 API 调用（用于评论接口等 shortcut 未覆盖的端点）── 传输已收拢到 connector（L1），保留同名薄委托
function larkApi(method, url, params, identity) {
  return connector.api(method, url, params, identity, { cwd: CWD });
}

// ── #1 实名人职级校验：分页拉【各中心负责人】表全部记录（供 checkNamedPersonRank，fail-open）──
function fetchRankRecords(cfg) {
  let items = [], pageToken = null, more = false, guard = 0;
  do {
    const params = pageToken ? { page_size: 500, page_token: pageToken } : { page_size: 500 };
    const resp = larkApi('GET', `/open-apis/bitable/v1/apps/${cfg.app_token}/tables/${cfg.table_id}/records`, params, 'user');
    const d = (resp && resp.data) || {};
    items = items.concat(d.items || []);
    pageToken = d.page_token; more = !!d.has_more;
  } while (more && ++guard < 20);
  return items;
}

// ── #2 实名手机号名录校验：分页拉【11.26手机卡确认】【AI使用】视图记录，返回规范化手机号集合（供 checkPhoneRoster，fail-open）──
function fetchPhoneRoster(cfg) {
  const phones = [];
  let pageToken = null, more = false, guard = 0;
  do {
    const params = { page_size: 500, view_id: cfg.view_id };
    if (pageToken) params.page_token = pageToken;
    const resp = larkApi('GET', `/open-apis/bitable/v1/apps/${cfg.app_token}/tables/${cfg.table_id}/records`, params, 'user');
    const d = (resp && resp.data) || {};
    for (const it of (d.items || [])) {
      let cell = (it.fields || {})[cfg.phone_field];
      // 文本字段可能是字符串，或 [{text}] 富文本数组
      if (Array.isArray(cell)) cell = cell.map(x => (x && x.text) || x).join('');
      const p = normRosterPhone(cell);
      if (p) phones.push(p);
    }
    pageToken = d.page_token; more = !!d.has_more;
  } while (more && ++guard < 30);
  return phones;
}

// ── #3 内部商标授权书校验：从 trademark-registry-full.json 建「注册号→归属entity」反查索引 + 我司主体清单 ──
// 读一次、缓存。regIndex 键=归一化注册号(纯数字)，值={owner, name, brand}。全程 fail-open：任何异常返回空。
let _tmRegCache = null;
function buildTrademarkRegIndex() {
  if (_tmRegCache) return _tmRegCache;
  const empty = { regIndex: new Map(), ourEntities: [], creditMap: {} };
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'references', 'trademark-registry-full.json'), 'utf8'));
    const ents = (reg && reg.entities) || {};
    const regIndex = new Map();
    const registryOwners = [];
    for (const owner of Object.keys(ents)) {
      const tms = ents[owner] && ents[owner].trademarks;
      if (!Array.isArray(tms)) continue;   // 排除 "商标注册申请"/"海外商标" 等非主体键
      registryOwners.push(owner);
      for (const t of tms) {
        const rn = normTmRegNo(t && t.reg_no);
        if (rn && !regIndex.has(rn)) regIndex.set(rn, { owner, name: (t && t.name) || '', brand: (t && t.brand) || '' });
      }
    }
    // 我司主体清单 + 信用代码表：以 entities.json 为权威源（含 uscc/别名），并入 registry 里出现的注册主体名兜底。
    const ourEntities = [];
    const creditMap = {};
    const seen = new Set();
    try {
      const ej = loadEntities();
      for (const ie of (ej.internal_entities || [])) {
        if (!ie || !ie.name) continue;
        ourEntities.push({ name: ie.name, uscc: ie.uscc, aliases: ie.alias || [] });
        seen.add(ie.name);
        if (ie.uscc) creditMap[require('../lib/trademark-auth-check.js').normName(ie.name)] = ie.uscc;
      }
      for (const oe of (ej.overseas_entities || [])) {
        if (!oe || !oe.name) continue;
        ourEntities.push({ name: oe.name, tax_id: oe.tax_id, reg_no: oe.reg_no, aliases: oe.alias || [] });
        seen.add(oe.name);
      }
    } catch (e) { /* fail-open：entities.json 读失败仍用 registry 主体兜底 */ }
    for (const o of registryOwners) if (!seen.has(o)) ourEntities.push({ name: o, aliases: [] });
    _tmRegCache = { regIndex, ourEntities, creditMap };
    return _tmRegCache;
  } catch (e) {
    return empty;   // fail-open
  }
}

// ── 检查审批实例 iCommentTime 之后是否有新的非 AI 评论（申请人已回复）──
function hasNewUserComment(instanceCode, afterIsoTime) {
  try {
    const url = `/open-apis/approval/v4/instances/${instanceCode}/comments`;
    const data = larkApi('GET', url, { user_id: USER_OPEN_ID, user_id_type: 'open_id' }, 'bot');
    const allComments = (data && data.data && data.data.comments) || (data && data.comments) || [];
    const comments = allComments.filter(c => !c.is_delete);
    const afterMs = afterIsoTime ? new Date(afterIsoTime).getTime() : 0;
    const extractText = c => {
      try { return JSON.parse(c.content || '{}').text || ''; } catch (e) { return (c.content || '').toString(); }
    };
    // F29/F13：优先按作者身份判"新用户回复"——作者 ≠ 审核身份(USER_OPEN_ID)；
    // 不再单靠文本不含"AI审核/深度审视"（申请人可复制这两个串绕过→回复被吞→案件卡死）。
    // 仅当评论无作者字段时，退回文本启发式兜底。
    // 展开顶层评论 + 嵌套回复（replies）：申请人常以"回复 AI 评论"形式补答，只看顶层会漏 → 案件卡死
    const flat = [];
    for (const c of comments) {
      flat.push(c);
      const reps = (c.replies || c.reply_list || c.comment_reply_list || []).filter(r => !r.is_delete);
      for (const r of reps) flat.push(r);
    }
    return flat.some(c => {
      // create_time 飞书返回毫秒(13位)；历史 *1000 是把毫秒当秒的 bug → 时间闸恒失效。按位数归一。
      const rawT = Number(c.create_time || c.created_time || c.created_at || 0);
      const ts = rawT > 1e12 ? rawT : rawT * 1000;
      if (ts <= afterMs) return false;
      // 作者字段是 commentator（历史误用 user_id/open_id 恒空 → 只能靠文本兜底，脆弱）
      const author = c.commentator || c.user_id || c.open_id || c.commenter_id || (c.user && (c.user.user_id || c.user.open_id)) || '';
      if (author) return author !== USER_OPEN_ID;
      const text = extractText(c);
      return !text.includes('AI审核') && !text.includes('深度审视');
    });
  } catch (e) {
    console.error(`[hasNewUserComment] 查评论失败(${instanceCode})，本轮不翻转状态，下次 list 轮询重试: ${e.message}`);
    return false; // 失败则安全默认：不翻转状态（下轮重试）
  }
}

// ── comments：拉取审批实例评论（申请人回复 / AI审核评论），手动复审前核对，杜绝"查错接口=假空=漏回复" ──
// 用与 hasNewUserComment 相同的权威接口 /approval/v4/instances/{code}/comments（非 instances get 的 comment_list，后者不返评论）
function cmdComments(instanceCode) {
  if (!instanceCode) throw new Error('comments 需要 <instance_code>');
  const url = `/open-apis/approval/v4/instances/${instanceCode}/comments`;
  const data = larkApi('GET', url, { user_id: USER_OPEN_ID, user_id_type: 'open_id' }, 'bot');
  const all = (data && data.data && data.data.comments) || (data && data.comments) || [];
  // 作者字段是 commentator（飞书审批评论），历史误用 user_id/open_id → 一直取空 → 误退文本兜底。
  const authorOf = x => x.commentator || x.user_id || x.open_id || x.commenter_id || (x.user && (x.user.user_id || x.user.open_id)) || '';
  const textOf = x => { try { return JSON.parse(x.content || '{}').text || ''; } catch (e) { return (x.content || '').toString(); } };
  const toRow = (x, replyTo) => {
    const text = textOf(x);
    const author = authorOf(x);
    const isAI = author ? (author === USER_OPEN_ID) : (text.includes('AI审核') || text.includes('深度审视'));
    return {
      id: x.id || x.comment_id || '',
      reply_to: replyTo || null,
      author,
      is_self: !!author && author === USER_OPEN_ID,
      is_ai: isAI,
      is_delete: !!x.is_delete,
      create_time: x.create_time || x.created_time || x.created_at || '',
      text
    };
  };
  // 展开顶层评论 + 其嵌套回复（replies）——历史原因等常以"回复"形式挂在 AI 评论下，漏读会误判卡死
  const rows = [];
  for (const c of all) {
    rows.push(toRow(c, null));
    const reps = c.replies || c.reply_list || c.comment_reply_list || [];
    for (const r of reps) rows.push(toRow(r, c.id || c.comment_id || ''));
  }
  rows.sort((a, b) => Number(a.create_time || 0) - Number(b.create_time || 0));
  const applicantReplies = rows.filter(r => !r.is_ai && !r.is_delete);
  return { ok: true, instance_code: instanceCode, total: rows.length, top_level: all.length, applicant_reply_count: applicantReplies.length, comments: rows };
}

function buildApplink(code) {
  return `https://applink.feishu.cn/client/mini_program/open?appId=${APP_ID}&mode=appCenter&path_pc=pc/pages/in-process/index?instanceId=${code}&source=bitable&path=pages/detail/index?instanceId=${code}&source=bitable`;
}

function caseFilePath(code) {
  return path.join(ATTACH_DIR, code.substring(0, 8), 'case.json');
}

// ── BOM-safe JSON reader（PowerShell 写文件会带 UTF-8 BOM，Node 不自动剥）──
function readJsonFile(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
}

// ── 审核报告 JSON 路径（QUAL_AUDIT_DIR/YYYYMMDD.json）──
const AUDIT_DIR = CFG.auditDir;  // C2（2026-07-02）：审核报告目录随 profile（prod=生产 / test=_test）
const CURRENT_BATCH_PATH = path.join(AUDIT_DIR, 'current_batch.json');
// ⑥ 跨午夜批次对齐：list 写入 current_batch.json，write-result/gen-card 读它确定报告文件，消除 LLM 链依赖
function readBatchDate() {
  try {
    if (fs.existsSync(CURRENT_BATCH_PATH)) {
      const b = JSON.parse(fs.readFileSync(CURRENT_BATCH_PATH, 'utf8'));
      // 48h 内的批次才沿用，防止用到上上次的老文件
      if (b && b.batchDate && b.startedAt && (Date.now() - new Date(b.startedAt).getTime()) < 48 * 3600000) {
        return b.batchDate;
      }
    }
  } catch (e) {}
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}
function auditReportPath() {
  return path.join(AUDIT_DIR, `${readBatchDate()}.json`);
}
function auditDateStr() {
  return readBatchDate();
}

// ── 本轮完成度状态机（2026-07-09，#1/#2）──────────────────────────────────
// current_batch.json 复用为"本轮批次账本"：expected=本轮 spawn 的 instance_code 集；
// outcomes[code]={status,at}，status ∈ done|skip|failed|timeout（均视为 settled）。
// await-batch 轮询它直到全 settled 或超时；gen-card 据它硬闸防空卡/半卡。
const SETTLED = new Set(['done', 'skip', 'failed', 'timeout']);
function isSettled(o) { return !!(o && SETTLED.has(o.status)); }
function readBatch() {
  try { if (fs.existsSync(CURRENT_BATCH_PATH)) return JSON.parse(fs.readFileSync(CURRENT_BATCH_PATH, 'utf8')) || {}; } catch (e) {}
  return {};
}
// 登记某 instance_code 的本轮结果。持 CURRENT_BATCH_PATH 锁防并发子代理互覆盖。
// 无 expected 集（旧批次/手动跑/R修订）→ 不记（fail-safe：这些场景不参与硬闸）。
function markOutcome(code, status) {
  try {
    withLock(CURRENT_BATCH_PATH, () => {
      const b = readBatch();
      if (!Array.isArray(b.expected) || b.expected.length === 0) return;
      b.outcomes = b.outcomes || {};
      b.outcomes[code] = { status, at: new Date().toISOString() };
      atomicWriteFileSync(CURRENT_BATCH_PATH, JSON.stringify(b));
    });
  } catch (e) { /* 记账失败不阻断主流程 */ }
}
// 计算本批未 settled 的 expected 子集（barrier / await 共用）
function batchPending(b) {
  b = b || readBatch();
  if (!Array.isArray(b.expected) || b.expected.length === 0) return null; // null=无期望集，不设闸
  const outc = b.outcomes || {};
  return b.expected.filter(c => !isSettled(outc[c]));
}
function readAuditReport() {
  const p = auditReportPath();
  if (!fs.existsSync(p)) return { path: p, cases: [] };
  return { path: p, cases: readJsonFile(p) };
}
function requireCase(instanceCode) {
  // 先查今天，再往前找最近 30 天（跨天 R修订场景）
  for (let daysBack = 0; daysBack <= 30; daysBack++) {
    const d = new Date(Date.now() - daysBack * 86400000);
    const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const p = path.join(AUDIT_DIR, `${ymd}.json`);
    if (!fs.existsSync(p)) continue;
    try {
      const cases = readJsonFile(p);
      const c = cases.find(x => x.instanceCode === instanceCode);
      if (c) return { reportPath: p, cases, c };
    } catch (e) {}
  }
  throw new Error(`最近 30 天审核报告里找不到 ${instanceCode}，请先 write-result`);
}

// ── pending_actions.json — 运行状态索引（FAIR 状态机）──
const PENDING_ACTIONS_PATH = CFG.pending;  // C2（2026-07-02）：FAIR 状态机随 profile（prod=生产 / test=_test）
// F7 修复：pending_actions 丢失/损坏时，nextN 取最近 30 天 audit_reports 里的 max(n)+1，
// 绝不重置为 1，杜绝同一 #N 跨天对应多个实例 → F#N 误批到错误实例。
function computeNextNFromReports() {
  let maxN = 0;
  for (let d = 0; d <= 30; d++) {
    const dd = new Date(Date.now() - d * 86400000);
    const ymd = `${dd.getFullYear()}${String(dd.getMonth()+1).padStart(2,'0')}${String(dd.getDate()).padStart(2,'0')}`;
    const p = path.join(AUDIT_DIR, `${ymd}.json`);
    if (!fs.existsSync(p)) continue;
    try {
      const cases = readJsonFile(p);
      for (const c of cases) { if (typeof c.n === 'number' && c.n > maxN) maxN = c.n; }
    } catch (e) {}
  }
  return maxN + 1;
}
function readPendingActions() {
  if (!fs.existsSync(PENDING_ACTIONS_PATH)) return { __meta: { nextN: computeNextNFromReports() } };
  try {
    const pa = readJsonFile(PENDING_ACTIONS_PATH);
    if (!pa.__meta || typeof pa.__meta.nextN !== 'number') {
      pa.__meta = { nextN: Math.max(computeNextNFromReports(), (pa.__meta && pa.__meta.nextN) || 1) };
    }
    return pa;
  } catch (e) { return { __meta: { nextN: computeNextNFromReports() } }; }
}
// 原子写 pending_actions（调用方负责持锁；本函数不取锁，避免与外层 withLock 自死锁）
function writePendingActions(data) {
  atomicWriteFileSync(PENDING_ACTIONS_PATH, JSON.stringify(data, null, 2));
}
function setPAState(instanceCode, updates) {
  withLock(PENDING_ACTIONS_PATH, () => {
    const pa = readPendingActions();         // 持锁后重读最新，杜绝丢写
    if (pa[instanceCode]) {
      Object.assign(pa[instanceCode], updates);
      writePendingActions(pa);
    }
  });
}

// ── 从 instance_code 查 task_id（遍历待办列表匹配）──
function findTask(instanceCode) {
  const res = lark('approval tasks query', { topic: '1', page_size: '100', definition_code: DEFINITION_CODE });
  const tasks = (res && res.data && res.data.tasks) || [];
  return tasks.find(t => t.instance_code === instanceCode) || null;
}

// ── 执行审批操作（approve/reject）── 传输已收拢到 connector（L1），保留同名薄委托
function larkApprovalAction(action, data) {
  return connector.approvalAction(action, data, { cwd: CWD });
}

// ── 构造审批评论文本（面向申请人：精简，只留「结论 + 待办 +（退回）理由」）──
// 2026-07-05 重构（王爷需求）：fullAnalysis 三阶段推理只进卡片+报告给【审批人】看，不再塞进申请人评论。
//   申请人评论 = 结论 + applicantAction（他要补/改什么）+（退回时）审批人意见。
// 🔴 必须保留「AI审核」这个串：comment-manager.hasAIComment 靠「AI审核/深度审视」查重，去掉会导致
//   重复评论 / 冲突检测失效（历史顽疾根因）。故每条评论头部固定带【AI审核】。
function buildCommentText(c, extraReason) {
  const action = (c.applicantAction || c.suggestion || '').toString().trim();  // 兜底 suggestion，防旧数据/漏填
  let text;
  if (c.verdict === '通过') {
    // 通过=夸完整性（王爷定）：申请人无需"改什么"，给正向确认即可。
    text = `✅【AI审核】已通过\n\n材料完整、证据链齐全，事由清晰，予以放行。`;
  } else if (c.verdict === '需补充') {
    text = `⚠️【AI审核】需补充材料，暂未通过`;
    if (action) text += `\n\n请补充 / 修改：\n${action}`;
    text += `\n\n补齐后请直接在本审批下回复。`;
  } else if (c.verdict === '退回') {
    text = `❌【AI审核】已退回，需修正后重新提交`;
    if (action) text += `\n\n需修正：\n${action}`;
    if (extraReason) text += `\n\n退回原因：${extraReason}`;
  } else {
    // 转人工 / 兜底：内部流转，通常不发申请人；给最小信息。
    text = `🔴【AI审核】该申请需人工进一步核查。`;
    if (action) text += `\n\n${action}`;
    if (extraReason) text += `\n\n审批人意见：${extraReason}`;
  }
  // C7：可选触发来源归因——设 QUAL_TRIGGER_SOURCE 即在评论末尾留痕，便于审计谁触发了本次审核。
  const trigger = process.env.QUAL_TRIGGER_SOURCE;
  if (trigger) text += `\n\n（审核触发来源：${trigger}）`;
  return text;
}

function summaryVal(summaries, key) {
  const s = (summaries || []).find(x => x.key === key);
  return s ? s.value : '';
}

// 去掉表单里的模板说明字段（指引文案，非数据），减少内联体积。完整表单仍写进 case_file。
function cleanForm(form) {
  const out = {};
  for (const k of Object.keys(form || {})) {
    if (/^说明/.test(k) || /^-/.test(k) || !k.trim()) continue;
    out[k] = form[k];
  }
  return out;
}

// OCR 已解耦到独立包 ocr-paddle(CLI 正门),不再有常驻 VL 服务,故无需 ensure-vl。
// 引擎"开机"仅 ~8s,由 data-prep 在 case 时按需一次性调用,失败自动标 status:failed → 审核侧升级人工。

// ── list：翻页拉全部待办(最近在前)，按 pending_actions 状态过滤建工作清单。──
// 设计(2026-06-30 重构)：
//   1) 工具层翻页拉【全量】待办(仅索引，不进 agent 上下文，便宜) — 杜绝"100/50 名之外静默漏审"；
//   2) 状态过滤：PENDING_REVIEW(待用户 FAIR)/CLOSED(已处理) 跳过；new/AWAITING_APPLICANT/APPLICANT_REPLIED 入工作清单；
//   3) 排序：在途优先(申请人已回复 > 等待回复) > 新件；同档 task_id 倒序(最新在前，对齐"审最近的")；
//   4) 截断 N(默认 12 = 每轮派出的子代理数/节流)；未返回的留在工作清单——无 pa 条目=下轮 list 自动重现，【不丢】；
//   5) 返回 remaining 计数 → agent 在卡片报"剩余 M 条下轮继续"。
// 完整性靠"全量翻页 + 无条目即重现"，不需要单独 watermark/BACKLOG 态；不爆靠 N。
// 日期窗过滤：对 task_id 倒序的 tasks，从新到旧用轻量 instances get 读 start_time(ms)，
// 收集 start_time >= cutoff 的；连续 STREAK_STOP 条越界即停（倒序保证 + 容忍轻微错位）。
// fail-open：读不到时间的保留，绝不误删。SCAN_CAP 防异常全扫。
function applyDateWindow(tasks, sinceDays) {
  const cutoffMs = Date.now() - sinceDays * 86400000;
  const STREAK_STOP = 5;
  const SCAN_CAP = 300;
  const kept = [];
  let streak = 0, scanned = 0, droppedCollect = 0;
  for (const t of tasks) {
    if (scanned >= SCAN_CAP) break;
    scanned++;
    let startMs = null, inst = null;
    try {
      inst = getInstance(t.instance_code);
      const st = inst && inst.data && inst.data.start_time;
      if (st) startMs = Number(st);
    } catch (e) { inst = null; startMs = null; }
    if (startMs === null) { kept.push(t); streak = 0; continue; } // 读不到时间 → 保守保留(不判节点)
    if (startMs >= cutoffMs) {
      // 在窗口内：再看节点，领取-only 丢弃（但不打断 streak，它是近期件）→ case gate 仍会兜底
      const ni = pendingNodeInfo(inst.data);
      if (ni.collectOnly) { droppedCollect++; streak = 0; continue; }
      kept.push(t); streak = 0;
    } else { streak++; if (streak >= STREAK_STOP) break; }
  }
  return { tasks: kept, scanned, droppedCollect };
}

function cmdList(limit, sinceDays) {
  // ⑥ 写批次日期文件（code-level 传递，不走 LLM prompt 链）
  const _bd = (() => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; })();
  // 2026-07-09（#1/#2）：起始即重置本轮账本（expected=[]、outcomes={}），清掉上轮残留防陈旧 block；
  // expected 在下方选定 worklist 后回填。此刻 expected 为空 → gen-card 硬闸 fail-safe 不拦（list 未跑完时不误伤）。
  try { fs.writeFileSync(CURRENT_BATCH_PATH, JSON.stringify({ batchDate: _bd, startedAt: new Date().toISOString(), roundStartedAt: new Date().toISOString(), expected: [], outcomes: {} })); } catch (e) {}
  // 2026-07-24：写「活动 profile」sentinel 到固定非 profile 路径 scratch/active_profile，供本轮 spawn 的子代理继承。
  //   根因（prod 空跑实证）：子代理由 sessions_spawn 起、不继承父进程 env → QUAL_PROFILE 丢失默认 test → write-result/markOutcome
  //   误落 test 台账，parent 在 prod 读不到 → 判 timeout → 空卡。修：spawn 模板每条命令前缀 $env:QUAL_PROFILE=(读此文件)。
  //   ⚠️ 只影响子代理的台账/群路由；approve 硬锁仍只认【显式 env prod】(line 54/1470)、不读此 sentinel → fail-safe 不受影响。
  try { const _sp = path.join(__dirname, '..', 'scratch', 'active_profile'); fs.mkdirSync(path.dirname(_sp), { recursive: true }); fs.writeFileSync(_sp, QUAL_PROFILE); } catch (e) {}

  // 1. 翻页拉全部待办（工具内，纯索引）
  let tasks = [];
  let pageToken = null;
  let pages = 0;
  do {
    const params = { topic: '1', page_size: '100', definition_code: DEFINITION_CODE };
    if (pageToken) params.page_token = pageToken;
    const res = lark('approval tasks query', params);
    const batch = (res && res.data && res.data.tasks) || [];
    tasks.push(...batch);
    pageToken = (res && res.data && res.data.has_more) ? (res.data.page_token || null) : null;
    pages++;
  } while (pageToken && pages < 20); // 安全上限 20 页(2000 条)，防异常死循环
  tasks.sort((a, b) => String(b.task_id).localeCompare(String(a.task_id)));
  const totalPending = tasks.length;

  const pa = readPendingActions();
  // 清理 30 天前的 CLOSED 条目（持锁重读再删，避免覆盖并发写入的新条目）
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const staleClosed = Object.entries(pa)
    .filter(([code, entry]) => code !== '__meta' && entry.state === 'CLOSED' && entry.processedAt && entry.processedAt < cutoff)
    .map(([code]) => code);
  let cleanedCount = 0;
  if (staleClosed.length > 0) {
    withLock(PENDING_ACTIONS_PATH, () => {
      const fresh = readPendingActions();
      for (const code of staleClosed) {
        if (fresh[code] && fresh[code].state === 'CLOSED') { delete fresh[code]; cleanedCount++; }
      }
      if (cleanedCount > 0) writePendingActions(fresh);
    });
    for (const code of staleClosed) delete pa[code]; // 同步内存供后续过滤
  }

  // ── 对账自愈（2026-06-30）：飞书是真相源，pending_actions 只是缓存，缓存会漂移。──
  // 凡缓存里仍标"未结案"(PENDING_REVIEW/AWAITING_APPLICANT/APPLICANT_REPLIED)、却已不在【当前全量待办集】里的
  //   → 说明它已被 approve/reject（离开待办）→ 自动置 CLOSED，纠正"FAIR 执行时漏记账"导致的状态漂移。
  // 保护：仅当本轮成功拉到 >0 条待办时才对账（拉取失败会 throw 中止，0 条则跳过，防查询抖动误关一片）。
  let reconciledClosed = 0;
  if (totalPending > 0) {
    const liveCodes = new Set(tasks.map(t => t.instance_code));
    const openStates = new Set(['PENDING_REVIEW', 'AWAITING_APPLICANT', 'APPLICANT_REPLIED']);
    const drifted = Object.entries(pa)
      .filter(([code, v]) => code !== '__meta' && openStates.has(v.state) && !liveCodes.has(code))
      .map(([code]) => code);
    if (drifted.length > 0) {
      withLock(PENDING_ACTIONS_PATH, () => {
        const fresh = readPendingActions();
        for (const code of drifted) {
          if (fresh[code] && openStates.has(fresh[code].state)) {
            fresh[code].state = 'CLOSED';
            fresh[code].reconciledAt = new Date().toISOString();
            fresh[code].reconciledNote = '飞书已离开待办，list 对账自动置 CLOSED（疑似 FAIR 执行时漏记账）';
            reconciledClosed++;
          }
        }
        if (reconciledClosed > 0) writePendingActions(fresh);
      });
      for (const code of drifted) { if (pa[code]) pa[code].state = 'CLOSED'; } // 同步内存供后续过滤
    }

    // ── 对账洞修复（2026-07-06）：仍在待办集、但审批节点已过、只剩「是否领取」等下游节点(collectOnly) 的开放件 → 也置 CLOSED。──
    //   根因：审批被他处通过后进入领取阶段，实例仍 live 故不被上面「离开待办」分支捕获，却已非审核 bot 的活 → 反复进卡（#8/#12/#16/#11 活证据）。
    //   仅对【仍 live 且 open】的少量 pa 条目补一次 getInstance 判节点；读不到/异常一律不关（fail-open，宁多审不误关）。
    // R2 定界（2026-07-06 用户裁定）：对全部开放态（含 AWAITING_APPLICANT/APPLICANT_REPLIED）都自动关。
    //   依据：审批节点被其他审核人通过后，审批责任即从我方转移给通过者；对方通过就由对方负责，与我方无关，
    //   故此件对我方已 moot，静默关闭无问题（无需为"申请人可能还在补料"保留）。
    const liveOpen = Object.entries(pa)
      .filter(([code, v]) => code !== '__meta' && openStates.has(v.state) && liveCodes.has(code))
      .map(([code]) => code);
    const collectDrifted = [];
    for (const code of liveOpen) {
      try {
        const inst = getInstance(code);
        if (pendingNodeInfo(inst.data).collectOnly) collectDrifted.push(code);
      } catch (_) { /* fail-open：读不到节点就不关 */ }
    }
    if (collectDrifted.length > 0) {
      withLock(PENDING_ACTIONS_PATH, () => {
        const fresh = readPendingActions();
        for (const code of collectDrifted) {
          if (fresh[code] && openStates.has(fresh[code].state)) {
            fresh[code].state = 'CLOSED';
            fresh[code].reconciledAt = new Date().toISOString();
            fresh[code].reconciledNote = '审批节点已过、仅剩领取等下游节点，list 对账自动置 CLOSED（非审核 bot 的活）';
            reconciledClosed++;
          }
        }
        writePendingActions(fresh);
      });
      for (const code of collectDrifted) { if (pa[code]) pa[code].state = 'CLOSED'; } // 同步内存供后续过滤
    }
  }

  // 统计 PENDING_REVIEW（未确认的旧案例）
  const pendingReview = Object.entries(pa).filter(([k, v]) => k !== '__meta' && v.state === 'PENDING_REVIEW');

  // 1b. 日期窗过滤（sinceDays>0 才启用；--all/--since 0 关闭）。
  //     🔴 对账自愈用【全量 tasks】（上面已跑完），此处只把"进入工作清单的候选集"收窄到窗口内——
  //     绝不能在对账前 window，否则窗口外的会被误判成"已离开待办"而错关。
  let windowScanned = 0, windowCollectDropped = 0;
  let candidateTasks = tasks;
  if (sinceDays && sinceDays > 0) {
    const w = applyDateWindow(tasks, sinceDays);
    candidateTasks = w.tasks;
    windowScanned = w.scanned;
    windowCollectDropped = w.droppedCollect;
  }

  // 2a. ① FLIP：对 pa 里【全部】AWAITING 件检查申请人回复（解耦 worklist 成员资格）。
  // 必须在 BUILD_WL 之前跑，确保刚翻转的件能以 APPLICANT_REPLIED 身份进入本轮 worklist。
  // 网络判定在锁外，仅翻转写入放锁内，避免长时间持锁。
  const flips = [];
  for (const [code, entry] of Object.entries(pa)) {
    if (code === '__meta' || entry.state !== 'AWAITING_APPLICANT' || !entry.iCommentTime) continue;
    if (hasNewUserComment(code, entry.iCommentTime)) {
      entry.state = 'APPLICANT_REPLIED'; // 同步内存，让 BUILD_WL 立即看到
      flips.push(code);
    }
  }
  if (flips.length > 0) {
    withLock(PENDING_ACTIONS_PATH, () => {
      const fresh = readPendingActions();
      for (const code of flips) { if (fresh[code]) fresh[code].state = 'APPLICANT_REPLIED'; }
      writePendingActions(fresh);
    });
  }

  // 2b. BUILD_WL：AWAITING_APPLICANT 本轮跳过（等申请人回复中；flip 已在上方处理）
  const worklist = [];
  for (const t of candidateTasks) {
    const entry = pa[t.instance_code];
    if (!entry) {
      worklist.push({ ...t, pa_state: 'new' });
    } else if (entry.state === 'PENDING_REVIEW') {
      // 已审核待批复 → gen-card 直读 JSON，不需要重新 spawn 子代理
    } else if (entry.state === 'CLOSED') {
      // 已处理 → 跳过
    } else if (entry.state === 'AWAITING_APPLICANT') {
      // 等待申请人回复，flip 未触发 → 本轮跳过
    } else {
      // APPLICANT_REPLIED（含本轮刚翻转的）→ 进入工作清单
      worklist.push({ ...t, pa_state: entry.state, pa_n: entry.n });
    }
  }
  const awaitingCount = Object.values(pa).filter(v => v.state === 'AWAITING_APPLICANT').length;

  // 4. 排序：在途优先(申请人已回复 0 > 等待回复 1) > 新件 2；同档 task_id 倒序(最新在前)
  const rank = s => (s === 'APPLICANT_REPLIED' ? 0 : s === 'AWAITING_APPLICANT' ? 1 : 2);
  worklist.sort((a, b) => {
    const r = rank(a.pa_state) - rank(b.pa_state);
    return r !== 0 ? r : String(b.task_id).localeCompare(String(a.task_id));
  });

  // 5. 截断 N（默认 12 = 每轮派出的子代理数/节流）；剩余的下轮 list 自动重现（无 pa 条目），不丢
  const lim = limit || 12;
  const selected = worklist.slice(0, lim);
  const remaining = worklist.length - selected.length;

  // 2026-07-09（#1/#2）：回填本轮 expected = 待 spawn 的 instance_code 集，重置 outcomes。
  // 供 await-batch 等齐、gen-card 硬闸防空卡。仅记录本轮真正会 spawn 子代理的件（PENDING_REVIEW 直读JSON不 spawn，不入 expected）。
  try {
    const b = readBatch();
    b.expected = selected.map(t => t.instance_code);
    b.outcomes = {};
    b.expectedAt = new Date().toISOString();
    atomicWriteFileSync(CURRENT_BATCH_PATH, JSON.stringify(b));
  } catch (e) {}

  return {
    total_pending: totalPending,
    pages_fetched: pages,
    fetched: totalPending,            // 兼容旧字段
    worklist_total: worklist.length,
    returned: selected.length,
    remaining,
    since_days: (sinceDays && sinceDays > 0) ? sinceDays : null,
    window_scanned: windowScanned,
    window_collect_dropped: windowCollectDropped,
    has_more: remaining > 0,          // 工作清单仍有剩余 → 下轮继续
    pending_review_count: pendingReview.length,
    pending_review_cases: pendingReview.map(([code, v]) => ({ instance_code: code, n: v.n, person: v.person, state: 'PENDING_REVIEW', since: v.since })),
    awaiting_count: awaitingCount,    // AWAITING_APPLICANT 件数（等待申请人回复，本轮跳过）
    flipped_count: flips.length,      // 本轮从 AWAITING → APPLICANT_REPLIED 的翻转数
    batch_date: _bd,
    cleaned_closed: cleanedCount,
    reconciled_closed: reconciledClosed,
    note: `${(sinceDays && sinceDays > 0) ? `日期窗 ${sinceDays} 天(扫${windowScanned}条时间, 跳${windowCollectDropped}条领取节点)；` : '全量(无日期窗)；'}待办共 ${totalPending} 条(翻 ${pages} 页)；工作清单 ${worklist.length} 条，本轮返回 ${selected.length} 条${remaining > 0 ? `，剩余 ${remaining} 条下轮自动继续` : ''}；AWAITING 等待申请人回复 ${awaitingCount} 条${flips.length > 0 ? `（本轮翻转 ${flips.length} 条）` : ''}；PENDING_REVIEW(待你 F/A/I/R 确认)跳过 ${pendingReview.length} 条${pendingReview.length > 0 ? `：#${pendingReview.map(([, v]) => v.n).join(' #')}` : ''}${reconciledClosed > 0 ? `；对账自愈：${reconciledClosed} 条已离开飞书待办，自动置 CLOSED` : ''}。`,
    tasks: selected.map(t => ({
      instance_code: t.instance_code,
      task_id: t.task_id,
      pa_state: t.pa_state || 'new',
      pa_n: t.pa_n || null,
      applicant: summaryVal(t.summaries, '申请人'),
      quals: summaryVal(t.summaries, '申请资质'),
      reason: summaryVal(t.summaries, '申请事由').slice(0, 60)
    })),

    // P1-2（2026-07-24）：list 自动返回 safety_net cron spec —— 父 agent 不用算时间/不用跑 safety-net-spec 命令，
    //   拿到 list 返回后直接调一条 cron action=add（用 safety_net.cron_add 原样传入）。
    //   openclaw CLI 从 node 子进程调不通（交互式/启动慢），所以不 fire-and-forget；改为内嵌 spec 减少父 agent 步骤。
    //   父 agent 责任：list → cron add(safety_net.cron_add) → spawn 子代理 → sessions_yield。
  //   不去重（cron 按 job-id 唯一、name 非键）：每轮 list 各挂一个一次性 safety-net cron、deleteAfterRun 自清、
  //   gen-card 幂等→重复触发无害。这是刻意每轮刷新兜底——deleteAfterRun 会把上一轮消耗掉，必须每轮补一个才覆盖最新一轮新 spawn 的子代理。
    safety_net: (function() {
      try { return cmdSafetyNetSpec(remaining); } catch (e) { return { ok: false, error: e.message }; }
    })()
  };
}

// ── case：单条数据包【精简】。附件全文写盘，stdout 只回摘要+预览+case_file。──
// ── 云文档抓取（2026-07-09）：附件类字段以【文本链接】提交的云文档(docx/wiki)→ 抓 rawContent 当附件正文 ──
// 让「上传文件」与「文本贴云文档链接」两种提交形式都能审。fail-open：抓不到留 status=failed 占位(计入证据缺失闸)，不阻断。
function extractDocToken(url) {
  const m = String(url).match(/\/(docx|docs|wiki|sheets)\/([A-Za-z0-9]+)/);
  return m ? { kind: m[1], token: m[2] } : null;
}
function fetchDocxRawContent(documentId) {
  const resp = larkApi('GET', `/open-apis/docx/v1/documents/${documentId}/raw_content`, { lang: 0 }, 'bot');
  return ((resp && resp.data) || {}).content || '';
}
function fetchCloudDocs(form) {
  let links = [];
  try { links = findCloudDocLinks(form) || []; } catch (e) { return []; }
  const out = [];
  for (let i = 0; i < links.length; i++) {
    const { field, url } = links[i];
    const src = `clouddoc_${i + 1}(${field})`;
    try {
      const tok = extractDocToken(url);
      if (!tok) throw new Error('无法解析云文档 token');
      let content = '', docId = tok.token;
      if (tok.kind === 'wiki') {
        const nresp = larkApi('GET', '/open-apis/wiki/v2/spaces/get_node', { token: tok.token }, 'bot');
        const node = (nresp && nresp.data && nresp.data.node) || {};
        if (node.obj_type && node.obj_type !== 'docx') throw new Error(`wiki 节点类型=${node.obj_type}，暂不支持抓正文，请改上传文件`);
        docId = node.obj_token || tok.token;
        content = fetchDocxRawContent(docId);
      } else if (tok.kind === 'docx') {
        content = fetchDocxRawContent(docId);
      } else {
        throw new Error(`云文档类型 ${tok.kind} 暂不支持抓正文，请改上传文件`);
      }
      if (!content || !content.trim()) throw new Error('抓到空内容（可能无读权限或文档为空）');
      out.push({ source: src, type: 'clouddoc', status: 'ok', content: content.slice(0, 20000), size: Buffer.byteLength(content, 'utf8') });
    } catch (e) {
      console.error(`[case] 云文档抓取失败(${url}): ${e.message}`);
      out.push({ source: src, type: 'clouddoc', status: 'failed', size: 0, content: `[云文档抓取失败：${(e.message || '').slice(0, 120)}｜链接：${String(url).slice(0, 80)}｜需人工打开核对或改为上传文件]`, error: { kind: 'clouddoc', message: (e.message || '').slice(0, 200) } });
    }
  }
  return out;
}

async function cmdCase(code, opt) {
  if (!code) throw new Error('case 需要 instance_code 参数');
  const inst = getInstance(code);
  const createTime = (inst && inst.data && inst.data.start_time) ? Math.floor(Number(inst.data.start_time) / 1000) : null;
  // 发起人（申请人本人）open_id：用于评论区 @ 申请人。真实实例里发起人 id 在 data.user_id（已是 ou_ open_id 格式），
  // 少数返回可能落在 data.open_id，兜底取之。取不到则空字符串（下游 @ 逻辑 fail-open：无 id 就不 @，只发纯评论）。
  const applicantOpenId = (inst && inst.data && (inst.data.user_id || inst.data.open_id)) || '';
  // ── 节点 gate（在下附件之前）：当前只剩「是否领取」等下游节点(审批已完成) → 非审核 bot 的活，直接跳过。──
  const nodeInfo = pendingNodeInfo(inst.data);
  if (nodeInfo.collectOnly) {
    return {
      instance_code: code, applink: buildApplink(code),
      in_scope: false, should_skip: true,
      skip_reason: `当前待办为「${nodeInfo.pendingNodes.join('/')}」节点，非资质审核（审批已完成/下游领取节点），跳过`,
      pending_nodes: nodeInfo.pendingNodes,
      createTime
    };
  }
  const form = parseForm(inst);
  // 申请人姓名兜底：表单「申请人」为空 → 用发起人 open_id 反查真名注入 form，下游(子代理/快速路径/卡片)一处覆盖。
  if (!(form['申请人'] || form['申请人全称']) && applicantOpenId) {
    const _nm = resolveUserName(applicantOpenId);
    if (_nm) form['申请人'] = _nm;
  }
  let inScope = isInScope(form);
  const qField = form['申请资质'] || form['拟用资质'];
  const quals = Array.isArray(qField) ? qField : [qField];

  let attachments = downloadAttachments(form, code);
  const commentFiles = extractCommentAttachments(inst);
  if (commentFiles.length > 0) {
    attachments = attachments.concat(downloadCommentAttachments(code, commentFiles));
  }
  // 云文档链接（文本形式提交的决策文档等）→ 抓 rawContent 当附件正文并入（与上传文件并存都能审）
  const cloudDocs = fetchCloudDocs(form);
  if (cloudDocs.length > 0) attachments = attachments.concat(cloudDocs);
  const attachDocs = readAttachmentContent(attachments);
  // ── 评论正文（申请人回复）纳入 case（2026-07-09 修复 #34「没读评论」）──
  // case 原来只拉评论区【附件文件】(extractCommentAttachments)，不拉评论【正文】——申请人写在评论里的
  // 说明/补充/"双章合同见评论附件"等文字，子代理此前完全看不到 → 漏判。fail-open：查评论失败绝不阻断审核。
  let commentRows = [];
  try {
    const _cm = cmdComments(code);
    commentRows = (_cm && _cm.comments) || [];
  } catch (e) { console.error(`[case] 拉评论正文失败(${code})，fail-open 继续: ${e.message}`); }
  const applicantComments = commentRows.filter(r => !r.is_ai && !r.is_delete && (r.text || '').trim());
  // ③「其他/其它」类：isInScope 只判结构化申请资质字段；模糊类型需在此合并扫（事由 OR 附件），单次 pass。
  if (!inScope) {
    const isOther = quals.some(q => q && (String(q).includes('其它') || String(q).includes('其他')));
    if (isOther) {
      const reason = String(form['申请事由'] || '');
      const attachText = attachDocs.map(a => a.content || '').join('\n');
      if (MY_AUDIT_QUALS.some(sq => reason.includes(sq) || attachText.includes(sq))) inScope = true;
    }
  }
  const deterministic = runDeterministicChecks(form, attachDocs, quals);

  // #1 平台账号「实名人职级」live-query 校验（2026-07-04，全程 fail-open：查表失败/无实名人绝不阻断）
  try {
    const _ents = loadEntities();
    const _rankCfg = _ents && _ents.named_person_rank_check;
    if (_rankCfg) {
      const rankIssue = checkNamedPersonRank(form, () => fetchRankRecords(_rankCfg), _ents);
      if (rankIssue) deterministic.issues.push(rankIssue);
    }
  } catch (e) { /* fail-open */ }

  // #2 实名手机号「是否公司名录号」live-query 校验（2026-07-09，全程 fail-open：查表失败/无号/名录空绝不阻断）
  try {
    const _ents2 = loadEntities();
    const _phoneCfg = _ents2 && _ents2.phone_roster_check;
    if (_phoneCfg) {
      const phoneIssue = checkPhoneRoster(form, () => fetchPhoneRoster(_phoneCfg), _ents2);
      if (phoneIssue) deterministic.issues.push(phoneIssue);
    }
  } catch (e) { /* fail-open */ }

  // #3 内部商标授权书「甲乙方我司主体 + 信用代码 + 授权商标归属甲方」校验（2026-07-09，全程 fail-open）
  // 仅当资质含「商标授权书」时触发（注意：品牌授权书是对外的，不走此规则）。
  try {
    if (quals.some(q => q && String(q).includes('商标授权书'))) {
      const { regIndex, ourEntities, creditMap } = buildTrademarkRegIndex();
      const tmIssues = checkTrademarkAuth(form, regIndex, ourEntities, creditMap);
      for (const iss of (tmIssues || [])) deterministic.issues.push(iss);
    }
  } catch (e) { /* fail-open */ }

  // Fast-track：内部商标授权书 → 预填（通过）。
  // F2 修复：附件读不出(needs_human)时禁止 fast-track，降级走下方三阶段/转人工。
  // F1/F31 修复：内部判定已改精确匹配；预填结果走正常 write-result 进入 PENDING_REVIEW，
  //            纳入 gen-card + INTERRUPT 等用户 F#N，不再"直接 approve"。
  if (deterministic.autoApprove && deterministic.autoApprove.flag && !deterministic.needs_human) {
    const dest = form['资质流向方全称（公司/自然人/平台）'] || form['资质流向方'] || form['相对方全称（公司/自然人全称）'] || form['相对方全称'] || '';
    const applicant = form['申请人'] || form['申请人全称'] || '';
    const fastTrackResult = {
      person: applicant,
      sealType: quals.filter(Boolean).join('、'),
      entity: form['申请主体全称'] || form['申请公司'] || form['公司全称'] || '',
      dest,
      context: `内部商标授权（${dest}）`,
      verdict: '通过',
      suggestion: '内部授权无需总经办审批，建议通过（仍需你 F#N 确认）',
      fullAnalysis: deterministic.autoApprove.reason,
      taskId: (findTask(code) || {}).task_id || '',
      createTime
    };
    const cf = caseFilePath(code);
    fs.mkdirSync(path.dirname(cf), { recursive: true });
    fs.writeFileSync(cf, JSON.stringify({ instance_code: code, applink: buildApplink(code), in_scope: true, fast_track: true, applicant_open_id: applicantOpenId, form, deterministic }), 'utf8');
    const wr = writeResultObj(code, fastTrackResult);  // 分配 n + PENDING_REVIEW
    return {
      instance_code: code,
      applink: buildApplink(code),
      in_scope: true,
      fast_track: { flag: true, verdict: '通过', reason: deterministic.autoApprove.reason, n: wr.n },
      form: cleanForm(form),
      case_file: cf,
      hint: 'fast_track=true → 已预填(通过)并写入今日报告(PENDING_REVIEW)。仍须照常 gen-card 发卡片、等用户 F#N 确认，禁止本轮直接 approve。'
    };
  }

  // 完整数据包(含附件全文)写盘到 ATTACH_DIR(包外)，供 read-attachment 按需读
  const full = {
    instance_code: code, applink: buildApplink(code), in_scope: inScope,
    createTime,
    applicant_open_id: applicantOpenId,
    should_skip: deterministic.shouldSkip || false, skip_reason: deterministic.skipReason || '',
    form, attachments: attachDocs, comments: commentRows, deterministic
  };
  const cf = caseFilePath(code);
  fs.mkdirSync(path.dirname(cf), { recursive: true });
  fs.writeFileSync(cf, JSON.stringify(full), 'utf8');

  // OCR 可读性闸:任何附件 status≠ok 或低置信 → all_ok=false,审核侧禁止自动通过
  const minScore = segs => (Array.isArray(segs) && segs.length) ? Math.min(...segs.map(s => (s.score == null ? 1 : s.score))) : null;
  const unreadable = attachDocs
    .map((a, i) => ({ idx: i, source: a.source, status: a.status || 'ok' }))
    .filter(x => x.status !== 'ok' && x.status !== 'needs_vision'); // needs_vision 非失败：子代理将用 image()/pdf() 读，不计入"不可读"闸
  const low_conf_advisory = attachDocs
    .map((a, i) => ({ idx: i, source: a.source, min_score: minScore(a.segments) }))
    .filter((_, i) => attachDocs[i].low_conf === true);
  const ocr_gate = { all_ok: unreadable.length === 0, unreadable, low_conf_advisory };

  // 🔒 场景强制闸(2026-07)：从表单检测"高易漏"场景 → 在 case 输出挂显眼提示，
  // 防"富信息附件稀释规则执行"（GS013 端到端漏 P03 的根因：材料齐全→误判通过）。
  const _formText = JSON.stringify(form || {});
  const scene_gates = [];
  if (/回退|注销|转移|迁移|找回|解绑|过户|变更主体|账号转让/.test(_formText)) {
    scene_gates.push('⚠️P03[账号操作]：本单疑似账号操作(回退/注销/转移/找回/解绑等)。P02(平台强制材料，截图可证) ≠ P03(操作本身的原因与影响)。必须正面回答"为什么要做这个操作 + 操作后影响/必要性"；事由仅写"做什么操作+要什么材料"而未答"为什么" → 需补充。不得因材料齐全/截图充分就判通过。');
  }

  // R 修订注入（phase2，2026-07-25）：pending 记了用户 R 修订原因 → 挂显眼闸 + 回传 revise_reason，让重审子代理针对这条意见重判。
  let _reviseReason;
  try { const _pe = readPendingActions()[code]; if (_pe && _pe.reviseReason) _reviseReason = _pe.reviseReason; } catch (e) {}
  if (_reviseReason) scene_gates.push('🔴 用户 R 修订（复审）：' + _reviseReason + ' —— 必须【针对用户这条修订意见】重新判断（用户不认可上轮结论或指出自相矛盾），正面回应其质疑，不得照抄上轮分析。');

  // stdout 只回精简摘要：form 内联(文本有界)；附件只回摘要+预览+状态，不回全文(防溢出)
  return {
    instance_code: code,
    applink: full.applink,
    revise_reason: _reviseReason,
    in_scope: inScope,
    should_skip: full.should_skip,
    skip_reason: full.skip_reason,
    form: cleanForm(form),
    attachments_summary: attachDocs.map((a, i) => ({
      idx: i, source: a.source, type: a.type, size_kb: a.size_kb,
      status: a.status || 'ok', low_conf: a.low_conf === true, min_score: minScore(a.segments),
      seal_count: (a.seal_count === undefined ? null : a.seal_count),
      vision_paths: a.vision_paths || undefined, // needs_vision 时给子代理的图片路径(交 image()/pdf() 读)
      truncated_pages: a.truncated_pages || undefined,          // 扫描PDF只渲了前N页 → 结论须保守+提示人工核后页
      image_pages: (a.image_pages && a.image_pages.length) ? a.image_pages : undefined, // 混合PDF里未OCR的图片页(0-based索引)
      chars: (a.content || '').length,
      preview: (a.content || '').slice(0, PREVIEW_CHARS)
    })),
    ocr_gate,
    truncated_attachments: attachDocs.map((a, i) => (a.truncated_pages ? { idx: i, source: a.source } : null)).filter(Boolean),
    // 申请人评论正文（非 AI、非删除）——补料/说明常写在这里，必须纳入判断；空数组=确无申请人回复
    comments_summary: applicantComments.map(r => ({ author: r.author, create_time: r.create_time, text: (r.text || '').slice(0, 500) })),
    deterministic,
    scene_gates,
    createTime,
    case_file: cf,
    hint: `附件全文未内联。要全文：node scripts/audit-tool.cjs read-attachment ${code} <idx> [maxChars]。comments_summary=申请人评论回复（补料/说明常在此，必须纳入判断，非空时逐条读）。放行门：ocr_gate.all_ok=false 或 deterministic.needs_human 时禁止自动通过，转人工。`
  };
}

// ── read-attachment：按需、有界读某条附件全文 ──
function cmdReadAttachment(code, idxStr, maxStr) {
  if (!code || idxStr === undefined) throw new Error('read-attachment 需要 <instance_code> <idx> [maxChars]');
  const cf = caseFilePath(code);
  if (!fs.existsSync(cf)) throw new Error(`未找到 case 数据(${cf})，请先跑：case ${code}`);
  const full = readJsonFile(cf);
  const idx = parseInt(idxStr, 10);
  const a = (full.attachments || [])[idx];
  if (!a) throw new Error(`附件 idx 越界: ${idxStr}（共 ${(full.attachments || []).length} 个）`);
  const max = parseInt(maxStr, 10) || READ_DEFAULT_MAX;
  const content = a.content || '';
  return {
    source: a.source, type: a.type, total_chars: content.length,
    returned_chars: Math.min(max, content.length),
    truncated: content.length > max,
    content: content.slice(0, max)
  };
}

// ── comment：写评论(编码/限流由工具处理) ──
async function cmdComment(code, file) {
  if (!code || !file) throw new Error('comment 需要 <instance_code> <comment_textfile> 两个参数');
  const text = fs.readFileSync(file, 'utf8');
  const r = await writeComment(code, text, USER_OPEN_ID);
  return { ok: r === true, result: r };
}

// ── HTML → 纯文本（共用）──
function htmlToText(html) {
  return html
    .replace(/<h2>(.*?)<\/h2>/g, '\n【$1】\n')
    .replace(/<h3>(.*?)<\/h3>/g, '\n$1\n')
    .replace(/<b>(.*?)<\/b>/g, '$1')
    .replace(/<br\/>/g, '\n')
    .replace(/<li>(.*?)<\/li>/gs, '  • $1\n')
    .replace(/<ul>|<\/ul>|<p>|<\/p>/g, '')
    .replace(/<a href="[^"]*">(.*?)<\/a>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Doc 缓存路径helpers ──
// 文档级缓存：D:\fando-ocr-cache\doc_<docId[:8]>\case_N.txt （首次拉取时提取全部 case）
// 实例级缓存：D:\fando-ocr-cache\<code[:8]>\comment_draft.txt （cache-from-doc 写映射时填）
function docCacheDir(docId) {
  return path.join(ATTACH_DIR, 'doc_' + docId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 8));
}
function docCaseCachePath(docId, n) { return path.join(docCacheDir(docId), `case_${n}.txt`); }
function instanceDraftPath(code) { return path.join(ATTACH_DIR, code.substring(0, 8), 'comment_draft.txt'); }

// ── 从 HTML 文档提取所有 case 段落 ──
function extractAllCaseSections(docText) {
  const cases = {};
  const headerRe = /<h2>(\d+)[.、．\s]/g;
  let m;
  const positions = [];
  while ((m = headerRe.exec(docText)) !== null) positions.push({ n: parseInt(m[1], 10), start: m.index });
  for (let i = 0; i < positions.length; i++) {
    const { n, start } = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start : docText.length;
    const text = htmlToText(docText.slice(start, end));
    if (text && text.length >= 20) cases[n] = text;
  }
  return cases;
}

// ── 拉取文档并缓存全部 case 段落（文档级缓存）──
async function fetchDocAndCacheAll(docId) {
  // 传输已收拢到 connector（L1）：docs +fetch 解包后返回 raw（data|meta）
  const raw = connector.fetchDoc(docId, { cwd: CWD });
  const docText = (raw && raw.data && raw.data.document && raw.data.document.content) || '';
  if (!docText) return {};
  const cdir = docCacheDir(docId);
  fs.mkdirSync(cdir, { recursive: true });
  const cases = extractAllCaseSections(docText);
  for (const [n, text] of Object.entries(cases)) {
    fs.writeFileSync(path.join(cdir, `case_${n}.txt`), text, 'utf8');
  }
  return cases;
}

// ── cache-from-doc：一次拉取文档，缓存全部 case，可选按映射写入各实例的 comment_draft.txt ──
// 用法：node scripts/audit-tool.cjs cache-from-doc <doc_id> [<caseN>:<instance_code> ...]
// 示例：node scripts/audit-tool.cjs cache-from-doc OJDxxx 1:AAAA-... 2:BBBB-...
async function cmdCacheFromDoc(docId, ...mappings) {
  if (!docId) throw new Error('cache-from-doc 需要 <doc_id>');
  const allCases = await fetchDocAndCacheAll(docId);
  const result = {
    doc_id: docId,
    cached_cases: Object.keys(allCases).map(Number).sort((a, b) => a - b),
    cache_dir: docCacheDir(docId),
    instance_writes: []
  };
  for (const mapping of mappings) {
    const sep = mapping.indexOf(':');
    if (sep < 0) continue;
    const n = parseInt(mapping.substring(0, sep), 10);
    const code = mapping.substring(sep + 1);
    const text = allCases[n];
    if (!text) { result.instance_writes.push({ case: n, ok: false, error: 'case not found in doc' }); continue; }
    const draftPath = instanceDraftPath(code);
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    fs.writeFileSync(draftPath, text, 'utf8');
    result.instance_writes.push({ case: n, code: code.substring(0, 8) + '...', ok: true, chars: text.length });
  }
  return result;
}

// ── comment-from-doc：从缓存（或按需拉文档）提取 case 段落写入评论 ──
// 缓存命中顺序：实例级(comment_draft.txt) → 文档级(doc_<id>/case_N.txt) → 拉文档并缓存全部
// 用法：node scripts/audit-tool.cjs comment-from-doc <instance_code> <doc_id> <case_number>
async function cmdCommentFromDoc(code, docId, caseNum) {
  if (!code || !docId || !caseNum) throw new Error('comment-from-doc 需要 <instance_code> <doc_id> <case_number>');
  const n = parseInt(caseNum, 10);

  // 1. 按优先级查缓存
  let text, cacheSource;
  const instPath = instanceDraftPath(code);
  const docPath = docCaseCachePath(docId, n);
  if (fs.existsSync(instPath)) {
    text = fs.readFileSync(instPath, 'utf8');
    cacheSource = 'instance';
  } else if (fs.existsSync(docPath)) {
    text = fs.readFileSync(docPath, 'utf8');
    cacheSource = 'doc';
  } else {
    // 缓存未命中：拉文档并缓存全部 case，此后同文档其他 case 均走 doc 缓存
    const allCases = await fetchDocAndCacheAll(docId);
    text = allCases[n];
    cacheSource = 'fetched';
  }

  if (!text || text.length < 20) return { ok: false, error: `Case ${n} 内容过短（${text ? text.length : 0}字），请检查文档结构或重新跑 cache-from-doc` };

  // 2. 查重 + 写入
  const dedup = await hasAIComment(code, USER_OPEN_ID);
  // F20 fail-closed：查重失败时不写（避免重复评论/冲突），让上层重试，而非误判"没评论过"硬写
  if (dedup.error) return { ok: false, skipped: 'dedup_unknown', hint: '评论查重 API 失败，未写评论以防重复，请稍后重试。' };
  if (dedup.hasUnified) return { ok: false, skipped: 'already_unified', dedup };
  if (dedup.hasComment && !dedup.needsUnified) return { ok: false, skipped: 'already_commented', dedup, hint: '已有今日AI评论，如需覆盖请先手动删除旧评论' };
  const r = await writeComment(code, text, USER_OPEN_ID);
  return { ok: r === true, result: r, chars: text.length, needs_unified: dedup.needsUnified, cache_source: cacheSource };
}

// ── write-result：写/覆盖今日审核报告 + 更新 pending_actions ──
// 用法: node scripts/audit-tool.cjs write-result <instance_code> <result_json_file>
// result_json_file 含: { person, sealType, entity, dest, context, verdict, suggestion, applicantAction, fullAnalysis[, taskId, createTime] }
// applicantAction=面向申请人的待办（需补充/退回必填），是唯一进审批评论给申请人看的自由文本；fullAnalysis 只进卡片/报告给审批人。
// n 由工具从 pending_actions.__meta.nextN 分配（全局单调递增），忽略 agent 传入的 n
function cmdWriteResult(instanceCode, resultFile) {
  if (!instanceCode || !resultFile) throw new Error('write-result 需要 <instance_code> <result_json_file>');
  const result = readJsonFile(resultFile);
  // ── Schema 硬闸（2026-07-03）：子代理 result.json 必须严格对齐 SKILL 步骤5a ──
  // 禁用 applicant（应为 person）、英文枚举（APPROVE→通过）、自创字段（confidence/attachments_read 等）
  // 2026-07-09 修脚本 bug：suggestion 在 SKILL 步骤5a 明写为【可选】(verdict=通过可留空)，此前误列必填 → 子代理漏填被无谓打回、弱模型又没重跑 write-result 而丢件(白雅姿事故)。移出必填。
  const REQUIRED_FIELDS = ['person', 'sealType', 'entity', 'dest', 'context', 'verdict', 'fullAnalysis'];
  const FORBIDDEN_FIELDS = ['applicant', 'confidence', 'attachments_read', 'deterministic_issues_resolved'];
  const VALID_VERDICTS = ['通过', '需补充', '退回', '转人工'];
  // 检查禁用字段
  const foundForbidden = FORBIDDEN_FIELDS.filter(f => result[f] !== undefined);
  if (foundForbidden.length > 0) {
    throw new Error(`write-result 拒绝：result.json 包含禁用字段 [${foundForbidden.join(', ')}]。严格按 SKILL 步骤5a schema：person/sealType/entity/dest/context/verdict/suggestion/fullAnalysis/taskId。`);
  }
  // 检查必填字段
  const missingFields = REQUIRED_FIELDS.filter(f => !result[f] && result[f] !== 0);
  if (missingFields.length > 0) {
    throw new Error(`write-result 拒绝：result.json 缺少必填字段 [${missingFields.join(', ')}]。严格按 SKILL 步骤5a schema。`);
  }
  // verdict 归一化（2026-07-09）：子代理常写 "✅通过"/" 通过 "/"通过。"/英文枚举 → 归一到 4 个中文枚举，避免纯格式问题被硬拒丢件（zizhi Round4 实例：616a 写 "✅通过" 被拒）。
  if (result.verdict != null) {
    let _v = String(result.verdict).trim();
    const _en = { PASS: '通过', PASSED: '通过', APPROVE: '通过', APPROVED: '通过', OK: '通过', SUPPLEMENT: '需补充', 'NEED-SUPPLEMENT': '需补充', REJECT: '退回', REJECTED: '退回', DENY: '退回', FAIL: '退回', HUMAN: '转人工', MANUAL: '转人工', ESCALATE: '转人工' };
    if (_en[_v.toUpperCase()]) _v = _en[_v.toUpperCase()];
    const _hit = VALID_VERDICTS.find(x => _v.includes(x)); // 含某中文枚举即取之（剥离 emoji/标点/空白包裹）
    if (_hit) _v = _hit;
    result.verdict = _v;
  }
  // 检查 verdict 必须是中文枚举
  if (!VALID_VERDICTS.includes(result.verdict)) {
    throw new Error(`write-result 拒绝：verdict 必须是 [${VALID_VERDICTS.join('/')}] 之一，当前为「${result.verdict}」。禁止英文枚举/emoji。`);
  }
  // ── applicantAction 闸（2026-07-05）：面向申请人的"待办"必须独立、干净，不再从 fullAnalysis 长推理里现挖 ──
  // 精简评论后，需补充/退回的评论主体就是 applicantAction；空/过短会让申请人只看到"暂未通过"却不知改啥。
  // 通过=评论固定夸完整、转人工=内部流转，二者无需 applicantAction。
  if (result.verdict === '需补充' || result.verdict === '退回') {
    const _aa = (result.applicantAction || '').toString().trim();
    if (_aa.length < 5) {
      throw new Error(`write-result 拒绝：verdict=${result.verdict} 必须提供 applicantAction（面向申请人的待办：要补/改什么，独立成条、可直接照做），当前「${_aa}」过短。这段会直接进审批评论给申请人看，不能靠 fullAnalysis 现挖。`);
    }
  }
  // ── 硬闸（2026-07-02，防幻觉）：必须先跑过 case（case.json 存在），且提交的流向方须与 case.json 权威值有重合 ──
  // 背景：曾发生「没读 case.json、凭训练先验幻觉编造流向方/附件」→ 整份审核作废、错卡发生产群。
  // 事实必须来自工具落盘的 case.json，不能靠 agent 的记忆/复述。工具做确定性事实校验，agent 只做判断。
  const _cf = caseFilePath(instanceCode);
  if (!fs.existsSync(_cf)) {
    throw new Error(`write-result 拒绝：找不到 ${instanceCode} 的 case.json（${_cf}）。必须先跑 \`case ${instanceCode}\` 生成权威数据并据实审核，不得凭记忆/先验直接 write-result。`);
  }
  let _caseData;
  try { _caseData = readJsonFile(_cf); } catch (e) {
    throw new Error(`write-result 拒绝：case.json 读取失败（${_cf}）：${e.message}。请重跑 case。`);
  }
  const _form = (_caseData && _caseData.form) || {};
  let _destTruth = '';
  for (const k of Object.keys(_form)) { if (k.indexOf('流向') !== -1) _destTruth += ' ' + String(_form[k] || ''); }
  _destTruth = _destTruth.trim();
  if (_destTruth) {
    const _STOP = ['平台', '公司', '店铺', '名称', '链接', '店铺名称', '平台名称'];
    const _tokens = _destTruth
      .split(/[\s，,、：:；;\n\r（）()【】\[\]"'\/|]+/)
      .map(s => s.trim())
      .filter(s => s.length >= 3 && s.indexOf('http') !== 0 && _STOP.indexOf(s) === -1);
    // 只校验 dest（流向方字段）本身，不含 fullAnalysis——否则 agent 只要在分析里提一句对的平台名就能蒙混
    // （本案 dest=杭州卡厘 是错的，却因分析里提了一句"蘑菇街"漏网）。
    const _destClaim = String(result.dest || '');
    if (_tokens.length && !_tokens.some(t => _destClaim.indexOf(t) !== -1)) {
      throw new Error(`write-result 拒绝：你提交的流向方 dest「${result.dest || ''}」与 case.json 权威流向方「${_destTruth}」无任何关键实体重合，疑似未读原件/幻觉。请先 Read ${_cf} 逐字核对流向方（及附件可读性、期限等事实）后重填 result。`);
    }
  }
  // ── WR_G4：fullAnalysis 语义质量闸 —— 拒绝空壳/占位分析（2026-07-04）
  // 背景：吴雨杉事故根因之一——越界件本该 skip，子代理反出 fullAnalysis="三阶段分析" 空壳并落盘。
  // 排除「转人工」（该 verdict 无须完整三阶段）；其余必须有三阶段结构 + 足够长度。
  if (result.verdict !== '转人工') {
    const _fa = result.fullAnalysis || '';
    const _hasStages = ['阶段一', '阶段二', '阶段三'].every(s => _fa.includes(s));
    if (!_hasStages || _fa.length < 100) {
      throw new Error(`write-result 拒绝（WR_G4）：fullAnalysis 须含「阶段一/阶段二/阶段三」三阶段结构且不短于 100 字（当前 ${_fa.length} 字，${_hasStages ? '结构OK' : '缺结构'}）。请完整审核后重新提交。`);
    }
    // ── WR_G5：阶段二·逻辑穿透四板块 + 业务必要性 Q1&Q2 结构闸（2026-07-09）──
    // 背景：2026-07-08 生产段 3/6 件把「业务必要性」揉进「看流向/看用途」且缺 Q2（本该四板块独立、
    //   业务必要性含 Q1 触发条件 + Q2 强制必要性）。WR_G4 只查三阶段标题、查不到板块粒度 → 简化版漏网。
    //   治本：非转人工件必须四板块齐 + 业务必要性 Q1、Q2 双 Q 都在，否则打回子代理重写（不改判断、只补结构）。
    const _boards = ['看流向', '看用途', '业务必要性', '主体必要性'];
    const _missBoards = _boards.filter(b => !_fa.includes(b));
    const _hasQ1 = /Q1/.test(_fa);
    const _hasQ2 = /Q2/.test(_fa);
    if (_missBoards.length > 0 || !_hasQ1 || !_hasQ2) {
      throw new Error(`write-result 拒绝（WR_G5）：阶段二·逻辑穿透必须四板块各自独立成条【看流向 / 看用途 / 业务必要性 / 主体必要性】，且「业务必要性」须单独成板块并同时写明 Q1 触发条件 与 Q2 强制必要性。当前${_missBoards.length ? '缺板块['+_missBoards.join('、')+']' : '四板块齐'}、${_hasQ1 ? 'Q1有' : '缺Q1'}、${_hasQ2 ? 'Q2有' : '缺Q2'}。禁止把业务必要性并入流向/用途或省略 Q2，请补齐结构后重新提交（判断结论不必改，只补分析结构）。`);
    }
  }
    // ── Q4 事实一致性硬闸（2026-07-24）：verdict 与 deterministic/ocr_gate 矛盾即拒 ──
    //   硬牙 1：verdict=通过 × deterministic.needs_human=true → 拒（附件读不出不能通过）
    //   硬牙 2：verdict=通过 × ocr_gate.all_ok=false → 拒（附件不可读不能通过）
    //   诚实边界：硬闸只拦机械性失败（矛盾/漏读），拦不了推理错但自洽的——那道关靠人 F#/A# 兜。
    //   软检查（三阶段标题/needs_vision 正则）已在 WR_G4/G5 覆盖，不在此重复。
    {
      const _caseForGate = _caseData || {};
      const _det = _caseForGate.deterministic || {};
      const _ocr = _caseForGate.ocr_gate || {};
      if (result.verdict === '通过') {
        if (_det.needs_human === true) {
          throw new Error(`write-result 拒绝（Q4-硬牙1）：verdict=通过 但 deterministic.needs_human=true（附件读不出/确定性红线触发），矛盾。verdict 必须改为「需补充」或「转人工」——附件不可读时不得判通过。`);
        }
        if (_ocr.all_ok === false) {
          throw new Error(`write-result 拒绝（Q4-硬牙2）：verdict=通过 但 ocr_gate.all_ok=false（存在不可读附件），矛盾。verdict 必须改为「需补充」或「转人工」——附件不可读时不得判通过。`);
        }
      }
    }
  return writeResultObj(instanceCode, result);
}

// ── 修订历史日志（append-only，2026-07-03）──
// 每次 R 覆盖旧判断前，把〈旧 verdict+analysis / 用户打回理由 / 新 verdict+analysis〉快照落库，
// 供「打回案例库 + 黄金测试集 + 判断逻辑优化」使用。原地覆盖 write-result 不再丢原判。
// 路径随 profile（prod/test 各一份），JSONL 追加，永不覆写。
const REVISIONS_LOG = path.join(AUDIT_DIR, 'revisions.jsonl');
function appendRevisionLog(record) {
  try {
    fs.mkdirSync(path.dirname(REVISIONS_LOG), { recursive: true });
    fs.appendFileSync(REVISIONS_LOG, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) { /* 记录失败不阻断主流程 */ }
}
function cmdRevisions(instanceCode) {
  if (!fs.existsSync(REVISIONS_LOG)) return { ok: true, log: REVISIONS_LOG, total: 0, revisions: [] };
  const lines = fs.readFileSync(REVISIONS_LOG, 'utf8').split('\n').filter(Boolean);
  let recs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (instanceCode) recs = recs.filter(r => r.instanceCode === instanceCode);
  return { ok: true, log: REVISIONS_LOG, total: recs.length, revisions: recs };
}

// ── 修订对比事件卡（方案 B，2026-07-10）──
// R 修订后调此：从 revisions.jsonl 取该件【最新一条】修订，渲染 before/after 对比卡，【永远新发】。
// 与主审核「活卡」完全解耦：不 PATCH、不进 audit_card_ids.json 更新键、不接 FAIR、不参与 safety-net。
// 群随 category（A→CFG.chatId / B 且拆卡→CFG.chatB），发卡身份随 profile（与 gen-card 同一套 env）。
function cmdRevisionCard(instanceCode, round) {
  if (!instanceCode) throw new Error('revision-card 需要 <instance_code>');
  if (!fs.existsSync(REVISIONS_LOG)) return { ok: false, error: `无 revisions.jsonl：${REVISIONS_LOG}` };
  const lines = fs.readFileSync(REVISIONS_LOG, 'utf8').split('\n').filter(Boolean);
  const recs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).filter(r => r.instanceCode === instanceCode);
  if (!recs.length) return { ok: false, no_revision: true, error: `该件无修订历史，无对比可发：${instanceCode}` };
  const rev = recs[recs.length - 1];

  const script = process.env.QUAL_REVISION_CARD_SCRIPT
    || (process.env.QUAL_CARD_SCRIPT ? path.join(path.dirname(process.env.QUAL_CARD_SCRIPT), 'gen_revision_diff_card.ps1') : null);
  if (!script) throw new Error('QUAL_REVISION_CARD_SCRIPT 或 QUAL_CARD_SCRIPT 环境变量未设置（无法定位对比卡脚本）');
  if (!fs.existsSync(script)) throw new Error(`对比卡脚本不存在：${script}`);

  const cat = categorize(rev.sealType);
  const chatId = (cat === 'B' && SPLIT_CARDS) ? CFG.chatB : CFG.chatId;
  // 发卡 env 对齐 gen-card（群/目录/身份随 profile）
  process.env.LARK_AUDIT_CHAT_ID = chatId;
  process.env.QUAL_AUDIT_DIR = CFG.auditDir;
  process.env.QUAL_PENDING_ACTIONS = CFG.pending;
  if (CFG.cardBotAccount) process.env.QUAL_CARD_BOT_ACCOUNT = CFG.cardBotAccount;
  else delete process.env.QUAL_CARD_BOT_ACCOUNT;

  const psArgs = ['-File', script, '-InstanceCode', instanceCode, '-ChatId', chatId];
  const r = round ? parseInt(round, 10) : 1;
  if (r > 1) { psArgs.push('-Round'); psArgs.push(String(r)); }
  const o = execFileSync('powershell', psArgs, {
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, cwd: CWD, timeout: 120000, shell: false, windowsHide: true
  });
  const m = o.match(/"message_id":"([^"]+)"/);
  return {
    ok: true, output: o.trim(), message_id: m ? m[1] : null, category: cat, chat: chatId,
    from_verdict: rev.from && rev.from.verdict, to_verdict: rev.to && rev.to.verdict,
    note: '修订对比事件卡已【新发】一张（不 PATCH、不进更新键、不接 FAIR、不影响活卡幂等）。'
  };
}

// 核心：把结果对象写入今日报告 + 分配全局 n + 入 pending_actions(PENDING_REVIEW)。
// 供 cmdWriteResult(读文件) 与 fast-track(直接传对象) 复用，保证两条路同一状态机入口。
function writeResultObj(instanceCode, result) {
  result.instanceCode = instanceCode;
  // 卡片类别（2026-07-06）：据 sealType 定 A/B，供 gen-card 拆卡 + 委托授权闸使用（权威值落报告）。
  result.category = categorize(result.sealType);
  // 修订理由（R#N 原因）：可选字段，仅用于修订日志，落库前从 result 剥离，避免污染报告/pending_actions
  const _revisionReason = (result.revisionReason != null) ? String(result.revisionReason) : '';
  if (result.revisionReason != null) delete result.revisionReason;
  // 🔴 子代理纪律护栏（2026-07-01，吴雨杉空壳事故根因）：越界/应跳过件【绝不落盘】——本该回 skip、不产出审核结果。
  // 就算子代理无视 in_scope=false 硬 write-result，工具层也拦；读 case_file 的判定为准。fail-open：无 case_file 不拦。
  const _cf = caseFilePath(instanceCode);
  if (fs.existsSync(_cf)) {
    try {
      const _cd = readJsonFile(_cf);
      if (_cd.in_scope === false || _cd.should_skip === true) {
        markOutcome(instanceCode, 'skip'); // 本轮账本登记为 skip → await-batch 不再空等它、gen-card 硬闸放行
        return { ok: false, skipped: true, instanceCode, reason: `越界/应跳过件(in_scope=${_cd.in_scope}, should_skip=${_cd.should_skip}${_cd.skip_reason ? '：' + _cd.skip_reason : ''})，拒绝落盘——本该回 skip，不产出审核结果（其它类无管辖资质归此）` };
      }
    } catch (e) { /* case_file 读失败 → 不拦，继续 */ }
  }
  // 若 agent 未填 createTime / applicant_open_id，从 case_file 补（case 子命令写盘时已记录）
  // applicant_open_id 由工具从 case.json 权威注入，不信任 agent 手填（防幻觉/漏填 → @ 错人）。
  if (!result.createTime || !result.applicant_open_id) {
    const cf = caseFilePath(instanceCode);
    if (fs.existsSync(cf)) {
      try {
        const caseData = readJsonFile(cf);
        if (!result.createTime && caseData.createTime) result.createTime = caseData.createTime;
        // 始终以 case.json 的权威值覆盖，杜绝 agent 手填错 open_id
        if (caseData.applicant_open_id) result.applicant_open_id = caseData.applicant_open_id;
      } catch (e) {}
    }
  }
  // 🔴 确定性红线快照（2026-07-17 王爷定）：从 case_file【权威注入】，与 applicant_open_id 同理——【不信任 agent 手填】。
  // 背景：此前 result schema 无此字段 → 哪条红线响过、有没有被子代理驳回，事后完全不可查
  //   （#50 庞小彤查不出「AI 为何判通过」的根因即此故；2026-07-17 上午 11 条红线静默全灭也无任何落库痕迹）。
  // 注入后可事后审计：rules_overridden=true 即「红线响过、子代理仍判通过」的件，可直接 grep 出来复核。
  {
    const cf = caseFilePath(instanceCode);
    let _snap = null;
    if (fs.existsSync(cf)) {
      try {
        const caseData = readJsonFile(cf);
        const det = caseData.deterministic;
        if (det && Array.isArray(det.issues)) {
          const fired = [...new Set(det.issues.map(i => i && i.ruleId).filter(Boolean))].sort();
          _snap = {
            rules_fired: fired,
            deterministic_passed: !!det.passed,
            engine_failed: !!det.engine_failed,               // 预留：loadRules fail-loud 改造后由 checker 置位；旧数据无此字段 → false
            rules_overridden: fired.length > 0 && result.verdict === '通过'
          };
        }
      } catch (e) { /* 读失败 → 下方置 null，绝不阻断落盘 */ }
    }
    // 🔴 读不到快照 → 一律置 null，【绝不置 []】：「没读到」必须与「跑了但没红线响」可区分。
    //    2026-07-17 教训：deterministic-rules.json 崩掉时 issues=[] 与「全部通过」输出完全一致 → 静默放行 4 件。
    result.rules_fired          = _snap ? _snap.rules_fired : null;
    result.deterministic_passed = _snap ? _snap.deterministic_passed : null;
    result.engine_failed        = _snap ? _snap.engine_failed : null;
    result.rules_overridden     = _snap ? _snap.rules_overridden : null;
  }
  // 🔴 引擎失效硬拒（2026-07-17 王爷定）：红线兜底不可用时【绝不允许落盘「通过」】——不靠子代理自觉。
  // 这是 fail-visible 的最后一道闸：就算子代理无视 child-judge 铁律硬判通过，工具层也拦。
  if (result.engine_failed === true && result.verdict === '通过') {
    return {
      ok: false, instanceCode,
      reason: '🔴 拒绝落盘：确定性规则引擎加载失败（deterministic.engine_failed=true），本次【全部红线均未执行】——'
            + '"没有红线告警"≠"没有风险"，此状态下不得判通过。请把 verdict 改为「转人工」、'
            + '并在 fullAnalysis 里注明「红线引擎失效，未经确定性校验」后重跑 write-result；同时立即报修 deterministic-rules.json。'
    };
  }
  // 临界区：n 分配 + 写 audit_reports + 写 pending_actions，全程持锁 + 原子写（F19/C3）。
  const _wrRes = withLock(PENDING_ACTIONS_PATH, () => {
    const pa = readPendingActions();   // 持锁后重读最新，杜绝并发丢写/同 n
    if (!pa.__meta) pa.__meta = { nextN: 1 };
    // 分配全局单调 n：已在 pending_actions 中的 case（R修订）保留原 n；新 case 取 nextN
    const existingEntry = pa[instanceCode];
    const assignedN = existingEntry ? existingEntry.n : pa.__meta.nextN;
    if (!existingEntry) pa.__meta.nextN = assignedN + 1;
    result.n = assignedN;  // 强制覆盖 agent 提供的 n，保证全局唯一

    // 写 audit_reports（原子）
    const { path: p, cases } = readAuditReport();
    const idx = cases.findIndex(c => c.instanceCode === instanceCode);
    const action = idx >= 0 ? 'updated' : 'appended';
    const _oldSnapshot = idx >= 0 ? cases[idx] : null;
    if (idx >= 0) cases[idx] = result; else cases.push(result);
    atomicWriteFileSync(p, JSON.stringify(cases, null, 2));

    // 修订历史捕获：覆盖了旧判断且 verdict/分析确有变化 → append-only 落库（永不丢原判）
    if (_oldSnapshot && (_oldSnapshot.verdict !== result.verdict || _oldSnapshot.fullAnalysis !== result.fullAnalysis)) {
      appendRevisionLog({
        ts: new Date().toISOString(),
        instanceCode,
        n: assignedN,
        person: result.person,
        sealType: result.sealType,
        reason: _revisionReason,
        from: { verdict: _oldSnapshot.verdict, suggestion: _oldSnapshot.suggestion, fullAnalysis: _oldSnapshot.fullAnalysis },
        to: { verdict: result.verdict, suggestion: result.suggestion, fullAnalysis: result.fullAnalysis }
      });
    }

    // 更新 pending_actions（state=PENDING_REVIEW，原子）
    pa[instanceCode] = {
      n: assignedN,
      person: result.person,
      date: auditDateStr(),
      verdict: result.verdict,
      state: 'PENDING_REVIEW',
      since: new Date().toISOString(),
      ...(result.createTime ? { createTime: result.createTime } : {}),
      ...((_revisionReason || (existingEntry && existingEntry.reviseReason)) ? { reviseReason: _revisionReason || existingEntry.reviseReason } : {})
    };
    writePendingActions(pa);

    return { ok: true, action, n: assignedN, person: result.person, verdict: result.verdict, file: p };
  });
  markOutcome(instanceCode, 'done'); // 本轮账本登记完成（锁外，避免与 PENDING_ACTIONS 锁嵌套）
  return _wrRes;
}

function markProcessed(instanceCode, action) {
  try {
    withLock(PENDING_ACTIONS_PATH, () => {
      const { path: p, cases } = readAuditReport();   // 持锁后重读
      const idx = cases.findIndex(c => c.instanceCode === instanceCode);
      if (idx >= 0) {
        cases[idx].processedAt = new Date().toISOString();
        cases[idx].processedAction = action;
        atomicWriteFileSync(p, JSON.stringify(cases, null, 2));
      }
    });
  } catch (e) { /* 非关键，失败不中断主流程 */ }
}

// F27/F30：approve/reject/note 前置护栏——案必须在 pending_actions 且未 CLOSED；可选 person 硬校验。
// 2026-07-09：test 受控干跑——验 FAIR 执行链编排(lookup→授权闸→状态机→卡刷新)而【不触真飞书 note/approve】。
// 仅当 test(allowApprove=false) 且显式 QUAL_TEST_FAIR=1 才启用；否则 test 仍硬锁。prod 不受影响（走真实动作）。
function isTestDryRun() { return !CFG.allowApprove && process.env.QUAL_TEST_FAIR === '1'; }
// FAIR 字母→动作权威映射（唯一真源；2026-07-21）。agent 只传用户敲的字母，工具据此校验，杜绝 R/A 反接英文先验。
const FAIR_MAP = { F: 'approve', A: 'reject', I: 'note', R: 'revise' };

function assertActionable(instanceCode, expectedPerson, op, fairLetter) {
  // ── FAIR 字母↔动作硬校验（2026-07-21，改法一+二）：防「凭记忆挑动词」把 R(修订) 做成 reject(退回) ──
  // 键接在可核对数据(用户字母 vs 子命令)上、不由 agent 确信度决定；缺字母/字母不符/R误触审批按钮 → 一律 fail-closed。
  const fl = fairLetter != null ? String(fairLetter).trim().toUpperCase() : '';
  if (!fl) throw new Error(`${op} 拒绝：缺 --fair-letter。approve/reject/note 必须带用户原始 FAIR 字母(F/A/I/R)，由工具校验字母↔动作，禁止凭记忆裸调。`);
  if (fl === 'R') throw new Error(`${op} 拒绝：R=修订，不得执行 approve/reject/note。R 的正确路径=重跑三阶段→write-result 覆盖结论→gen-card 出修订卡，等用户再 F/A。`);
  if (!FAIR_MAP[fl]) throw new Error(`${op} 拒绝：--fair-letter「${fl}」不是合法 FAIR 指令(F/A/I/R)。`);
  if (FAIR_MAP[fl] !== op) throw new Error(`${op} 拒绝：用户指令 ${fl}=${FAIR_MAP[fl]}，你却在调 ${op}，字母↔动作不符。请照抄用户字母、别自己改动作。`);
  // C3 approve 硬锁（2026-07-02）：test profile 物理禁止真实审批动作（approve/reject/note 均经此闸）。
  // 不可逆动作只在 prod 放行；测试环境哪怕误调也打不到真飞书审批。
  //   例外：test 干跑(QUAL_TEST_FAIR=1)放行——但下游 cmdApprove/Reject/Note 会跳过真飞书调用，只走编排+记账。
  if (!CFG.allowApprove && !isTestDryRun()) {
    throw new Error(`${op} 拒绝：当前 QUAL_PROFILE=${QUAL_PROFILE}（allowApprove=false），测试环境禁止 approve/reject/note 真实审批。需切到 prod 再执行（验编排可设 QUAL_TEST_FAIR=1 干跑，不触真飞书）。`);
  }
  const pa = readPendingActions();
  const entry = pa[instanceCode];
  if (!entry) {
    throw new Error(`${op} 拒绝：${instanceCode} 不在 pending_actions（未经 case/write-result 进入待确认态，或 pending_actions 丢失）。请重跑 list/case 后再操作，勿盲目 ${op}。`);
  }
  if (entry.state === 'CLOSED') {
    throw new Error(`${op} 拒绝：#${entry.n}（${entry.person}）已处理(CLOSED:${entry.processedAction || ''})，不可重复 ${op}。`);
  }
  const exp = expectedPerson != null ? String(expectedPerson).trim() : '';
  if (exp && entry.person && entry.person !== exp) {
    throw new Error(`${op} 拒绝：person 不一致——你指定的「${exp}」与实例 #${entry.n} 记录的「${entry.person}」不符，疑似 #N 串号。请核对卡片后重试。`);
  }
  return entry;
}

// ── 委托授权闸（2026-07-06）：校验 FAIR 发送人是否有权处理该案类别 ──
// 发送人 open_id 由 env QUAL_ACTOR_OPEN_ID 传入（会话执行 FAIR 前设 = bridge_context.senderId）。
// fail-safe：未传发送人 → 放行（operator 老行为，不破坏 OpenClaw/现有手动流程）。
// operator(CFG.identity=王爷) → 全权；委托人按 QUAL_DELEGATES 限定类别，越权/不在表 → 拒。
function actorOpenId() { return process.env.QUAL_ACTOR_OPEN_ID || ''; }
// 恒为 operator 的 open_id 集：CFG.identity（本 profile 执行身份）+ 王爷真身（QUAL_OPERATOR_OPEN_ID，默认 ou_102cae）。
//   2026-07-09 修 gotcha：test profile 的 CFG.identity=OpenClaw(ou_dc58e9)，若只认它，王爷(ou_102cae)在 test 群回 FAIR 会被授权闸误拒。王爷是人类 operator，应【所有 profile 恒全权】。
const OPERATOR_OPEN_IDS = new Set([CFG.identity, process.env.QUAL_OPERATOR_OPEN_ID || 'ou_102cae80079463e6c8281777fec96f47'].filter(Boolean));
function assertDelegateAllowed(instanceCode, op) {
  const actor = actorOpenId();
  if (!actor) return;                         // 未传发送人 → 老行为放行
  if (OPERATOR_OPEN_IDS.has(actor)) return;   // operator(王爷 恒全权 + 本 profile 执行身份) 全权
  const allowed = QUAL_DELEGATES[actor];
  if (!allowed) throw new Error(`${op} 授权拒绝：发送人 ${actor} 不在委托白名单，无权执行。请王爷处理，或先将其加入 QUAL_DELEGATES。`);
  if (allowed === 'all') return;
  let cat = null;
  try { const { c } = requireCase(instanceCode); cat = c.category || categorize(c.sealType); } catch (e) {}
  if (cat && allowed !== cat) {
    throw new Error(`${op} 授权拒绝：发送人 ${actor} 仅可处理【${CAT_LABEL[allowed] || allowed}】类，本案属【${CAT_LABEL[cat] || cat}】类，越权。`);
  }
}

// ── approve：写 AI 评论 → 执行通过（note 失败则中止，不执行审批）──
// 用法: node scripts/audit-tool.cjs approve <instance_code> [expected_person]
async function cmdApprove(instanceCode, expectedPerson, fairLetter) {
  if (!instanceCode) throw new Error('approve 需要 <instance_code>');
  const _entry = assertActionable(instanceCode, expectedPerson, 'approve', fairLetter);
  assertDelegateAllowed(instanceCode, 'approve');
  if (isTestDryRun()) {
    // test 干跑：走完记账+状态机，跳过真飞书 note+approve。验编排/授权闸/卡刷新用。
    markProcessed(instanceCode, 'approved');
    setPAState(instanceCode, { state: 'CLOSED', processedAt: new Date().toISOString(), processedAction: 'approve', executedBy: actorOpenId() || CFG.identity });
    return { ok: true, dry_run: true, instance_code: instanceCode, n: _entry.n, person: _entry.person, note: 'TEST 干跑：已走完 lookup+授权闸+状态机(→CLOSED)，未触真飞书 note/approve。' };
  }
  const { c } = requireCase(instanceCode);
  const text = buildCommentText(c);
  const r = await writeComment(instanceCode, text, USER_OPEN_ID, { open_id: c.applicant_open_id, name: c.person });
  if (r !== true) throw new Error(`写评论失败（note 铁律）：中止 approve，请手动核查飞书评论状态后再操作。`);
  const taskId = (findTask(instanceCode) || {}).task_id || c.taskId;  // C3：优先重拉新 task_id，不盲信文件里旧的
  if (!taskId) throw new Error(`找不到 task_id for ${instanceCode}，任务可能已处理`);
  const approveRes = larkApprovalAction('approve', { instance_code: instanceCode, task_id: taskId });
  markProcessed(instanceCode, 'approved');
  setPAState(instanceCode, { state: 'CLOSED', processedAt: new Date().toISOString(), processedAction: 'approve', executedBy: actorOpenId() || CFG.identity });
  spawnAutoSync();
  return { ok: true, instance_code: instanceCode, task_id: taskId, approve: approveRes };
}

// ── reject：写 AI 评论 + 退回原因 → 执行拒绝（note 失败则中止；实例终止，申请人须重新提交）──
// 用法: node scripts/audit-tool.cjs reject <instance_code> <reason_file>
async function cmdReject(instanceCode, reasonFile, expectedPerson, fairLetter) {
  if (!instanceCode || !reasonFile) throw new Error('reject 需要 <instance_code> <reason_file>');
  const _entryR = assertActionable(instanceCode, expectedPerson, 'reject', fairLetter);
  assertDelegateAllowed(instanceCode, 'reject');
  if (isTestDryRun()) {
    markProcessed(instanceCode, 'rejected');
    setPAState(instanceCode, { state: 'CLOSED', processedAt: new Date().toISOString(), processedAction: 'reject', executedBy: actorOpenId() || CFG.identity });
    return { ok: true, dry_run: true, instance_code: instanceCode, n: _entryR.n, person: _entryR.person, note: 'TEST 干跑：已走完 lookup+授权闸+状态机(→CLOSED)，未触真飞书 note/reject。' };
  }
  const { c } = requireCase(instanceCode);
  const reason = fs.readFileSync(reasonFile, 'utf8').trim();
  const text = buildCommentText(c, reason);
  const r = await writeComment(instanceCode, text, USER_OPEN_ID, { open_id: c.applicant_open_id, name: c.person });
  if (r !== true) throw new Error(`写评论失败（note 铁律）：中止 reject，请手动核查飞书评论状态后再操作。`);
  const taskId = (findTask(instanceCode) || {}).task_id || c.taskId;  // C3：优先重拉新 task_id
  if (!taskId) throw new Error(`找不到 task_id for ${instanceCode}`);
  const rejectRes = larkApprovalAction('reject', { instance_code: instanceCode, task_id: taskId });
  markProcessed(instanceCode, 'rejected');
  setPAState(instanceCode, { state: 'CLOSED', processedAt: new Date().toISOString(), processedAction: 'reject', executedBy: actorOpenId() || CFG.identity });
  spawnAutoSync();
  return { ok: true, instance_code: instanceCode, task_id: taskId, reject: rejectRes };
}

// ── note：只写 AI 评论，不操作审批按钮（I 指令路径：等申请人补材料）──
// 用法: node scripts/audit-tool.cjs note <instance_code>
// 成功后更新 pending_actions → state=AWAITING_APPLICANT + iCommentTime
async function cmdNote(instanceCode, expectedPerson, fairLetter) {
  if (!instanceCode) throw new Error('note 需要 <instance_code>');
  const _entryN = assertActionable(instanceCode, expectedPerson, 'note', fairLetter);
  assertDelegateAllowed(instanceCode, 'note');
  if (isTestDryRun()) {
    setPAState(instanceCode, { state: 'AWAITING_APPLICANT', iCommentTime: new Date().toISOString(), executedBy: actorOpenId() || CFG.identity });
    return { ok: true, dry_run: true, instance_code: instanceCode, n: _entryN.n, person: _entryN.person, note: 'TEST 干跑：已走完 lookup+授权闸+状态机(→AWAITING_APPLICANT)，未触真飞书 note。' };
  }
  const { c } = requireCase(instanceCode);
  const text = buildCommentText(c);
  const r = await writeComment(instanceCode, text, USER_OPEN_ID, { open_id: c.applicant_open_id, name: c.person });
  if (r === true) {
    setPAState(instanceCode, {
      state: 'AWAITING_APPLICANT',
      iCommentTime: new Date().toISOString(),
      executedBy: actorOpenId() || CFG.identity
    });
    spawnAutoSync();
  }
  return { ok: r === true, instance_code: instanceCode };
}

// ── fair：一条命令批量执行整条 FAIR 回复（2026-07-24 改法一：把"执行"从弱模型手里拿走）──
// 用法: node scripts/audit-tool.cjs fair "<用户整条 FAIR 原文，如 '通过：F#65  修订：R#66，原因：...'>"
//   工具确定性解析所有 F#/A#/I#/R#/S# + 编号 + 原因 → 逐条复用 approve/reject/note/scope-dismiss 原子执行
//   → 刷新卡片 → 返回逐条摘要。字母↔动作在代码里写死（F→approve / A→reject / I→note / S→scope-dismiss / R→修订重审），
//   模型不再挑动词（顺带灭掉"凭记忆挑错动词"风险）。approve 硬锁 / note-先于-approve / 字母硬闸全在各子命令内部保留。
//   模型的活缩成一步：见 FAIR 指令 → 调本命令传原文，别自己逐条解析/别口头解释/别分别调 approve。
function parseFairTokens(text) {
  const s = String(text || '');
  // 必须带 #（对齐卡片指引「F#编号」格式，且避免误吞规则名 R14/R05 等）。允许 # 前后有空格。
  const re = /([FAIRS])\s*#\s*(\d{1,4})/gi;
  const matches = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    matches.push({ letter: m[1].toUpperCase(), n: parseInt(m[2], 10), idx: m.index, endIdx: re.lastIndex });
  }
  const out = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i], next = matches[i + 1];
    // 原因 = 本 token 结尾 → 下一个 token 开始（或结尾）之间，去掉「，原因：」等前缀
    let reason = s.slice(cur.endIdx, next ? next.idx : s.length);
    reason = reason.replace(/^[\s，,。:：、\-—]*/, '').replace(/^原因[:：]?\s*/, '').trim();
    out.push({ letter: cur.letter, n: cur.n, reason });
  }
  return out;
}

async function cmdFair(rawText) {
  if (!rawText || !String(rawText).trim()) throw new Error('fair 需要 <原始FAIR文本>，如 fair "通过：F#65  R#66，原因：..."');

  // ── C05+C07: card_was_generated + source 守卫 ──
  // 守卫1：PENDING_REVIEW 案件必须有 card_map 才放行（防止卡没发就操作）
  // 守卫2：agent 自造指令拒绝（改后；基线无此守卫）
  {
    const pa = readPendingActions();
    const cardMapPath = path.join(CWD, 'scratch', 'card_map_latest.json');
    const cardMap = (() => { try { return JSON.parse(fs.readFileSync(cardMapPath, 'utf8')); } catch (e) { return null; } })();
    const hasPendingReview = Object.values(pa).some(v => v && typeof v === 'object' && v.state === 'PENDING_REVIEW');
    if (hasPendingReview && (!cardMap || !cardMap.generated_at)) {
      console.warn('[qual-audit] 守卫拦截：PENDING_REVIEW 案件存在但 card_map 未生成。请先 gen-card 出卡让用户看到结果。');
      return { ok: false, guard: 'card_was_generated', error: '存在 PENDING_REVIEW 案件但卡片从未生成过。请先运行 gen-card 让用户看到审核结果后再执行 F/A/I/R。', hasPendingReview, cardMapExists: !!cardMap };
    }
  }

  const tokens = parseFairTokens(rawText);
  if (!tokens.length) return { ok: false, error: '未解析到任何 FAIR 指令（需 F#/A#/I#/R#/S# + 编号，如 F#65）', raw: String(rawText) };
  const results = [];
  const reviseNeeded = [];  // R# 命中项 → 调用方立即 spawn 子代理重审出修订卡（phase2，勿等下轮 list）
  let anyAction = false;
  let chainStopped = false;
  const STOP_CODES = [1390001];  // C06: 这些错误码会触发链停
  for (const t of tokens) {
    if (chainStopped) {
      results.push({ token: `${t.letter}#${t.n}`, ok: false, _chainStopped: true, error: '链已停（上游 token 触发了不可恢复错误）' });
      continue;
    }
    const tag = `${t.letter}#${t.n}`;
    let lk;
    try { lk = cmdLookupCaseByN(String(t.n)); } catch (e) { results.push({ token: tag, ok: false, error: e.message }); continue; }
    if (!lk.found) { results.push({ token: tag, ok: false, error: lk.hint }); continue; }
    if (lk.already_processed) { results.push({ token: tag, person: lk.person, ok: false, skipped: true, note: lk.hint }); continue; }
    const code = lk.instanceCode;
    try {
      if (t.letter === 'F') {
        const r = await cmdApprove(code, null, 'F');
        results.push({ token: tag, person: lk.person, action: 'approve', ok: !!r.ok, detail: r }); anyAction = true;
      } else if (t.letter === 'A') {
        if (!t.reason) { results.push({ token: tag, person: lk.person, ok: false, error: 'A(退回) 需附退回原因，未从文本解析到' }); continue; }
        const rf = path.join(CWD, `_fair_reason_${Date.now()}_${t.n}.txt`);
        fs.writeFileSync(rf, t.reason, 'utf8');
        try { const r = await cmdReject(code, rf, null, 'A'); results.push({ token: tag, person: lk.person, action: 'reject', ok: !!r.ok, detail: r }); anyAction = true; }
        finally { try { fs.unlinkSync(rf); } catch (e) {} }
      } else if (t.letter === 'I') {
        const r = await cmdNote(code, null, 'I');
        results.push({ token: tag, person: lk.person, action: 'note', ok: !!r.ok, detail: r }); anyAction = true;
      } else if (t.letter === 'S') {
        const r = cmdScopeDismiss(code);
        results.push({ token: tag, person: lk.person, action: 'scope-dismiss', ok: !(r && r.ok === false), detail: r }); anyAction = true;
      } else if (t.letter === 'R') {
        // R=修订（phase2，2026-07-25）：确定性记录用户修订原因（case 会挂成显眼复审闸 + 回传 revise_reason），
        //   并入 revise_needed —— 调用方【立即】对该件 spawn 子代理重审 → gen-card 出修订卡，不等下轮 list（修回退化回归）。
        setPAState(code, { state: 'APPLICANT_REPLIED', reviseReason: t.reason || '', reviseAt: new Date().toISOString() });
        reviseNeeded.push({ n: t.n, instance_code: code, task_id: lk.task_id || null, person: lk.person, reviseReason: t.reason || '' });
        results.push({ token: tag, person: lk.person, action: 'revise-needed', ok: true, reviseReason: t.reason || '', note: '已记录修订原因；请【立即】对该件 spawn 子代理重审出修订卡（见 revise_needed），勿等下轮 list。' });
        anyAction = true;
      } else {
        results.push({ token: tag, ok: false, error: `未知 FAIR 字母 ${t.letter}` });
      }
    } catch (e) {
      results.push({ token: tag, person: lk.person, ok: false, error: e.message });
      // C06: 1390001 链停
      if (e.code === 1390001 || (e.message && (e.message.includes('1390001') || e.message.includes('Current approval process has ended')))) {
        chainStopped = true;
      }
    }
  }
  let cardRefreshed = false;
  if (anyAction) { try { cmdGenCard('1', '', 0); cardRefreshed = true; } catch (e) { console.error('[qual-audit] fair 刷卡失败（非致命，动作已执行）: ' + e.message); } }
  const okCount = results.filter(r => r.ok).length;
  const out = { ok: okCount > 0, fair_summary: `共 ${tokens.length} 条指令，成功 ${okCount} 条`, card_refreshed: cardRefreshed, results };
  if (reviseNeeded.length) {
    out.revise_needed = reviseNeeded;
    out.revise_hint = `有 ${reviseNeeded.length} 件 R 修订：请【立即】对每个 instance_code spawn 一个子代理重审（case 已带 revise_reason 复审闸）→ write-result 覆盖 → gen-card 出修订卡，不要等下轮 list。`;
  }
  return out;
}

// ── lookup-case-by-n：将用户说的 #N 确定性映射到 instanceCode ──
// 用法: node scripts/audit-tool.cjs lookup-case-by-n <n>
// 优先查 pending_actions，未找到则扫描最近 30 天 audit_reports/
function cmdLookupCaseByN(nStr) {
  const n = parseInt(nStr, 10);
  if (!n) throw new Error('lookup-case-by-n 需要数字编号，如 4');
  // 唯一权威来源：pending_actions（活跃状态机）。CLOSED 标 already_processed；
  // 不在 pending_actions 则拒绝凭旧报告猜（F7/F30：旧周期 #N 可能指向错误实例）。
  const pa = readPendingActions();
  const paEntry = Object.entries(pa).find(([k, v]) => k !== '__meta' && v.n === n);
  if (paEntry) {
    const [instanceCode, entry] = paEntry;
    const alreadyProcessed = entry.state === 'CLOSED';
    return {
      found: true,
      already_processed: alreadyProcessed,
      source: 'pending_actions',
      instanceCode, n: entry.n, person: entry.person, verdict: entry.verdict, date: entry.date, state: entry.state,
      ...(alreadyProcessed ? { hint: `#${n}（${entry.person}）已处理(CLOSED:${entry.processedAction || ''})，不可重复 approve/reject。` } : {})
    };
  }
  return { found: false, n, hint: `#${n} 不在当前 pending_actions（可能已超期清理，或 pending_actions 丢失/重建）。请重跑 \`list\` 刷新后再操作，切勿凭旧 audit_reports 的 #${n} 直接 approve/reject——旧周期编号可能指向错误实例。` };
}

// 发卡前按【提交时间升序=等待最久在前】重排 n：修掉"并行子代理落盘竞态导致 #N 乱序"。
// 保留原有 n 值集合，仅按 createTime 重新分配给各 case → n 变有序、集合不变(零撞号)；同步报告 + pending_actions，保证 #N 与 FAIR 的 lookup 一致。加锁原子写。
function renumberReportByWaitTime(date) {
  try {
    const reportPath = path.join(AUDIT_DIR, (date || auditDateStr()) + '.json');
    if (!fs.existsSync(reportPath)) return;
    withLock(PENDING_ACTIONS_PATH, () => {
      let cases;
      try { cases = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch (e) { return; }
      if (!Array.isArray(cases) || cases.length < 2) return;
      const ctOf = c => { const v = Array.isArray(c.createTime) ? c.createTime[0] : c.createTime; return (v === undefined || v === null) ? Infinity : Number(v); };
      const nVals = cases.map(c => c.n).filter(n => typeof n === 'number').sort((a, b) => a - b);
      cases.sort((a, b) => ctOf(a) - ctOf(b)); // 提交时间升序：老的(等待最久)在前
      const pa = readPendingActions();
      cases.forEach((c, i) => {
        const newN = (nVals[i] !== undefined) ? nVals[i] : (i + 1);
        c.n = newN;
        if (c.instanceCode && pa[c.instanceCode]) pa[c.instanceCode].n = newN;
      });
      atomicWriteFileSync(reportPath, JSON.stringify(cases, null, 2));
      writePendingActions(pa);
    });
  } catch (e) { /* 重排失败不阻断发卡 */ }
}

function cmdGenCard(round, date, remaining) {
  let script = process.env.QUAL_CARD_SCRIPT;
  if (!script) {
    // 自动探测：标准部署下 skill 在 .../skills/qualification-audit/，gen_card_from_json.ps1 在 .../scripts/
    const candidate = path.join(CWD, '..', '..', 'scripts', 'gen_card_from_json.ps1');
    if (fs.existsSync(candidate)) {
      script = candidate;
      console.error(`[qual-audit] QUAL_CARD_SCRIPT 未设，自动探测到 ${candidate}`);
    }
  }
  if (!script) throw new Error('QUAL_CARD_SCRIPT 环境变量未设置，也未在 ../../scripts/gen_card_from_json.ps1 找到脚本。请参考 .env.example 配置此变量。');
  // ── P1-1 原子 settle（2026-07-24）：gen-card 头部自动跑 register-orphans ──
  //   父 agent 唤醒后只调一条 gen-card，模型无法漏跑 / 乱序 / 自判断「还没齐」。
  //   行为：扫本轮 expected 里未 settled 的 code，若 CWD 有 result_<code>.json → 自动 cmdWriteResult 校验+落盘+登记 done。
  //   不主动 batch-fail（避免误伤在跑子代理）：正常路径靠 runtime 推完成事件闭合，异常路径靠 QUAL_ROUND_TIMEOUT 标 timeout 自愈。
  //   写入 current_batch.json 持锁（withLock），与子代理 write-result 互不冲突；失败不阻断主流程（catch 吞）。
  try { cmdRegisterOrphans(); } catch (e) { console.error('[qual-audit] P1-1 register-orphans settle 失败（非致命）: ' + e.message); }

  // 2026-07-09（#2 空卡硬闸 + 生产兜底 a）：本批 spawn 的件未全部 settled(done/skip/failed/timeout) → 拒发，杜绝"没跑完就发空卡/半卡"。
  //   fail-safe：无 expected 集(旧批次/手动跑/纯 PENDING_REVIEW 复审) → batchPending 返 null → 不拦。
  //   总超时自愈：过 roundStartedAt+QUAL_ROUND_TIMEOUT(默认900s=15min，锚子代理 runTimeoutSeconds=600s + 50% 缓冲)仍 pending → 标 timeout 放行，【绝不永久卡死生产】。
  //   耦合不变式：兜底 cron(QUAL_SAFETYNET_MIN,默认16min) ≥ QUAL_ROUND_TIMEOUT → cron 触发时自愈条件已满足、不会"提前跑但不超时"导致永久无卡。
  //   正路：OpenClaw(zizhi) sessions_yield 等推送后重试；大公子 inline 审完/登记每条后 gen-card；QUAL_FORCE_CARD=1 为应急强发逃生阀。
  //
  // 2026-07-24 P1-1 改造：gen-card 头部原子 settle —— 自动跑 register-orphans 找回"写了文件未注册"的孤儿件。
  //   设计原则：事件驱动为主（runtime 推 success/failed/timed out 四态完成事件，subagents.md:95+499），不主动 batch-fail → 0 时间戳依赖、0 误伤在跑子代理。
  //   极端路径（事件全丢）：靠 QUAL_ROUND_TIMEOUT 标 timeout → 兜底 cron 触发 → 卡上列「⚠️未审结·待人工」→ 下轮 list 自动重捞（timeout 不写 pending_actions）。
  //   ⚠️ batch-fail 命令保留（手动调试用），但 gen-card 头部不主动调 → 父 agent 唤醒后只调一条 gen-card，模型没法违背顺序。
  let _timedOut = [];
  {
    const _b0 = readBatch();
    const _pending = batchPending(_b0);
    if (_pending && _pending.length > 0 && process.env.QUAL_FORCE_CARD !== '1') {
      const roundTimeoutSec = (parseInt(process.env.QUAL_ROUND_TIMEOUT, 10) > 0) ? parseInt(process.env.QUAL_ROUND_TIMEOUT, 10) : 900;
      const baseMs = _b0.roundStartedAt ? new Date(_b0.roundStartedAt).getTime() : Date.now();
      if (Date.now() < baseMs + roundTimeoutSec * 1000) {
        return {
          ok: false, ready: false, pending: _pending, pending_count: _pending.length,
          hint: `本批还有 ${_pending.length} 条未完成（未 write-result/未 skip）：${_pending.join(', ')}。OpenClaw：sessions_yield 等推送后重试；大公子 inline：审完/登记(batch-skip/scope-dismiss)这些件再 gen-card。到 ${roundTimeoutSec}s 总超时自动放行。应急 QUAL_FORCE_CARD=1。`
        };
      }
      // 总超时自愈（生产兜底）：过总超时仍 pending → 标 timeout 放行，绝不永久卡死。timed-out 件不上"已审"、下轮 list 自动重captured 重审。
      for (const c of _pending) markOutcome(c, 'timeout');
      _timedOut = _pending.slice();
      console.error(`[qual-audit] gen-card 总超时自愈：${_pending.length} 条标 timeout 放行 [${_pending.join(', ')}]`);
    }
  }
  // 空卡护栏（2026-07-09）：即便 QUAL_FORCE_CARD 强制，若本批【无任何可渲染内容】(0 已审 done + 0 未审结 failed/timeout + 0 待确认 PENDING_REVIEW)→ 拒发，
  //   杜绝真空卡（zizhi 曾在旧流程 QUAL_FORCE_CARD=1 强发 0 条空卡）。全 skip/全未完成的空轮不该产出卡。
  {
    const _gb = readBatch();
    const _oc = (_gb && _gb.outcomes) || {};
    const _hasDone = Object.values(_oc).some(o => o && o.status === 'done');
    const _hasUnaudited = Object.values(_oc).some(o => o && (o.status === 'failed' || o.status === 'timeout'));
    let _hasPR = false;
    try { const _pa = readPendingActions(); _hasPR = Object.keys(_pa).some(k => k !== '__meta' && _pa[k] && _pa[k].state === 'PENDING_REVIEW'); } catch (e) {}
    // 仅当【有 expected 集】(即经由 list 的正规轮)才启用此护栏；无 expected(手动补发/历史复盘)不拦，避免误伤。
    if (Array.isArray(_gb.expected) && _gb.expected.length > 0 && !_hasDone && !_hasUnaudited && !_hasPR) {
      return { ok: false, empty: true, hint: '本批无任何可渲染内容（0 已审 + 0 未审结 + 0 待确认）→ 拒发空卡（即使 QUAL_FORCE_CARD=1 也不发 0 内容卡）。多半是子代理全未完成或全 skip；请核实后再处理，勿强发空卡。' };
    }
  }

  // C4（2026-07-02）：发卡群随 profile。gen_card_from_json.ps1 自己读 LARK_AUDIT_CHAT_ID，
  // spawn 前对齐到 CFG.chatId（prod=生产群 oc_b3f3cf / test=测试群 oc_e819），子进程继承 process.env。
  process.env.LARK_AUDIT_CHAT_ID = CFG.chatId;
  // C5（2026-07-03）：审核报告目录也随 profile。gen_card_from_json.ps1 读 QUAL_AUDIT_DIR，
  // 默认生产目录。test profile 必须显式传 _test 路径。
  process.env.QUAL_AUDIT_DIR = CFG.auditDir;
  process.env.QUAL_PENDING_ACTIONS = CFG.pending;
  // 发卡身份（2026-07-09 修 #3）：非空 → gen_card 用该 feishu account(如 test=zizhi=资质审核助手自己)发/更新卡；
  // 空 → 删除该 env，gen_card 回退默认 claude_bot(大公子)，生产保持现状。
  if (CFG.cardBotAccount) process.env.QUAL_CARD_BOT_ACCOUNT = CFG.cardBotAccount;
  else delete process.env.QUAL_CARD_BOT_ACCOUNT;
  // 移除 renumberReportByWaitTime：write-result 时的全局单调 nextN 已保证 #N 永久稳定，无需按提交时间重排。
  // 发卡时冻结 card_map → FAIR 阶段 lookup-case-by-n 的权威快照（n→{instance_code,person,type}）。
  {
    const paForMap = readPendingActions();
    const cardMap = {};
    for (const [code, entry] of Object.entries(paForMap)) {
      if (code === '__meta') continue;
      if (entry && typeof entry.n === 'number') {
        cardMap[String(entry.n)] = { instance_code: code, person: entry.person || '', type: entry.type || entry.sealType || '' };
      }
    }
    const cardMapPath = path.join(CWD, 'scratch', 'card_map_latest.json');
    fs.mkdirSync(path.dirname(cardMapPath), { recursive: true });
    fs.writeFileSync(cardMapPath, JSON.stringify({ generated_at: new Date().toISOString(), card_map: cardMap }, null, 2));
  }
  
  // Q1a: 支持 update 模式——同一批报告只发一次卡，后续用 patch 更新
  const cardIdsPath = path.join(CWD, 'scratch', 'audit_card_ids.json');
  // Q5（2026-07-24）：cardIds 读写加 withLock，防 safety-net cron 与父 agent 同时 gen-card 的竞态。
  //   竞态场景：进程A读 cardIds={key:msg1} → 进程B读 cardIds={key:msg1} → 进程A写 cardIds={key:msg2} → 进程B写 cardIds={key:msg1}（覆盖A的更新）。
  //   修：每次读/写 cardIds 都在 withLock 内，保证读-改-写原子性。
  //   withLock 已有 O_EXCL 互斥 + 退避重试 + 陈旧锁抢占 + finally 释放（lib/file-lock.js）。
  function readCardIds() {
    return withLock(cardIdsPath, () => {
      try { return JSON.parse(fs.readFileSync(cardIdsPath, 'utf8')); } catch { return {}; }
    });
  }
  let cardIds = readCardIds();  // Q5: withLock 包裹读，防并发竞态
  const r = round ? parseInt(round, 10) : 1;
  // Q5: 原裸读改为 readCardIds()（withLock 包裹，防并发竞态）
  const rem = remaining ? parseInt(remaining, 10) : 0;

  // 单张卡发送。category=null → 渲染全部(现状单卡)；'A'/'B' → ps1 只渲染该类。
  // chatId=目标群；keySuffix 区分 update 追踪键（双卡各自记 message_id）。
  function sendOneCard(category, chatId, keySuffix) {
    process.env.LARK_AUDIT_CHAT_ID = chatId;
    // 2026-07-06：更新键 = batchDate + 目标群 chatId（+ _A/_B）。
    //   ① 绑定 batchDate（current_batch.json，48h 窗）→ 不依赖调用方传的 date 参数（原 key=(date||'') 会因 date 省略/空串/字面 "undefined" 漂移 → 重发）。
    //   ② 拼上 chatId → test(oc_e819) 与 prod(oc_b3f3cf) 不再撞同一个键（audit_card_ids.json 在 scratch/ 是跨 profile 共享的，只按日期会互相覆盖 → 更新到别的群的卡）。
    // 2026-07-09：更新键并入发卡身份——PATCH 只能改自己发的消息，切身份(大公子↔zizhi)时旧 message_id 不可复用，
    // 并入 account 后切身份自然走新建（无 existingMsgId），杜绝跨身份 PATCH 报错；同身份幂等不变。
    const botTag = CFG.cardBotAccount ? ('_' + CFG.cardBotAccount) : '';
    // 2026-07-25（王爷定·方案A"活卡"）：活卡 key 去掉 roundTag，按【当日 batchDate + 群 chatId + 发卡身份 botTag(+suffix)】唯一。
    //   → 所有轮次 + 修订都 PATCH 同一张活卡，活卡永远=台账最新（今日待审看板）；"每轮独立新卡"的旧行为收敛为"当日一张活卡"。
    //   历史版本走【留痕卡(改前vs改后) + revisions.jsonl(全量快照)】双通道，不再靠"每轮新卡"留痕。
    //   注：key 仍稳定（不含 roundTag 也不含调用序号）→ 同轮多次调用仍 PATCH 同一张，绝不复发"一轮多张空卡"（那 bug 的根因是【每次调用】新卡，非缺 roundTag）。
    const key = readBatchDate() + '_' + chatId + botTag + (keySuffix || '');
    // 默认幂等 PATCH（同一轮同一张）；QUAL_CARD_NEW=1 可强制每次新卡（调试用，一般别用）。
    const existingMsgId = (process.env.QUAL_CARD_NEW === '1') ? null : cardIds[key];
    const psArgs = ['-File', script];
    if (r > 1) { psArgs.push('-Round'); psArgs.push(String(r)); }
    if (date) { psArgs.push('-Date'); psArgs.push(date); }
    if (rem > 0) { psArgs.push('-Remaining'); psArgs.push(String(rem)); }
    if (category) { psArgs.push('-Category'); psArgs.push(category); }
    if (existingMsgId) { psArgs.push('-UpdateMessageId'); psArgs.push(existingMsgId); }
    const o = execFileSync('powershell', psArgs, {
      encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, cwd: CWD, timeout: 120000, shell: false, windowsHide: true
    });
    try {
      const respMatch = o.match(/"message_id":"([^"]+)"/);
      if (respMatch && respMatch[1]) {
        // Q5: 整个读-改-写在同一把锁里（照 markOutcome 372行范式），防并发覆盖。
        //   诚实边界：本锁只保证 cardIds map 不丢 key，不保证建卡决策串行（锁跨不了 120s 的 execFileSync 建卡调用，同 key 并发仍可能双建卡）。
        withLock(cardIdsPath, () => {
          let _ids; try { _ids = JSON.parse(fs.readFileSync(cardIdsPath, 'utf8')); } catch { _ids = {}; }
          _ids[key] = respMatch[1];
          atomicWriteFileSync(cardIdsPath, JSON.stringify(_ids, null, 2));
        });
      }
    } catch {}
    return { out: o, updated: !!existingMsgId };
  }


  let out, existingMsgId;
  if (SPLIT_CARDS) {
    // 双卡：A(法人+其他)→chatId(=chatA)、B(商标+授权)→chatB。#N 全局唯一，各卡只显本类。
    const a = sendOneCard('A', CFG.chatId, '_A');
    const b = sendOneCard('B', CFG.chatB, '_B');
    out = `--- Card A (${CAT_LABEL.A}) ---\n${a.out.trim()}\n\n--- Card B (${CAT_LABEL.B}) ---\n${b.out.trim()}`;
    existingMsgId = a.updated || b.updated;
  } else {
    const s = sendOneCard(null, CFG.chatId, '');  // 现状单卡
    out = s.out;
    existingMsgId = s.updated;
  }

  // 额外生产群（2026-07-23 王爷请求把旧群 oc_b3f3cf 也纳入）：把完整卡同时发到 CFG.extraChats 每个群。
  //   跳过主群/B 群；每群 key=batchDate+chatId 独立追踪→原地更新、不重复发；单群失败不影响主发与其它群。
  const _extraChats = (CFG.extraChats || []).filter(ec => ec && ec !== CFG.chatId && ec !== CFG.chatB);
  if (_extraChats.length) {
    const extraLines = [];
    for (const ec of _extraChats) {
      try { const e = sendOneCard(null, ec, ''); extraLines.push(`额外生产群 ${ec.slice(0, 12)}…: ${e.updated ? '已更新同一张' : '已新建'}`); }
      catch (err) { extraLines.push(`额外生产群 ${ec.slice(0, 12)}…: 发送失败(${err.message})`); }
    }
    out += `\n\n--- 额外生产群（${_extraChats.length}）---\n${extraLines.join('\n')}`;
  }

  // 📊 吞吐埋点（fire-and-forget，2026-07）：一轮 gen-card = 一个批次发卡完成。
  // 记〈轮次开始(startedAt from current_batch) → 卡片发出(now) → 本轮单数〉到 rounds.jsonl，
  // 供「AI 吞吐时长 = (卡片发出-轮次开始)/本轮单数」与「人响应时长 = pa.processedAt - 卡片发出」统计。失败不阻断主流程。
  try {
    let startedAt = null;
    let batchExpected = null;
    let batchOutcomes = null;   // 2026-07-15：一并捕获本批结算明细，供健康监控(audit-health-watch.cjs)算超时率/连续失败
    try {
      const _b = JSON.parse(fs.readFileSync(CURRENT_BATCH_PATH, 'utf8'));
      startedAt = _b.startedAt;
      batchExpected = _b.expected;
      batchOutcomes = _b.outcomes;
    } catch {}
    const cardSentAt = new Date().toISOString();
    // 本轮单数 size（2026-07-10 修准）：
    //   优先取 current_batch.json 的 expected 数组长度——list 选定 worklist 后已回填本轮真正 spawn 的
    //   instance_code 集（见 ~L701），是本轮件数的权威来源，不受多次 list / pa.since 边界抖动影响。
    //   仅当 expected 缺失/为空（旧批次、手动跑、纯 PENDING_REVIEW 复审）时才回退旧 pa.since 估法。
    let size = 0;
    if (Array.isArray(batchExpected) && batchExpected.length > 0) {
      size = batchExpected.length;
    } else {
      try {
        const pa = readPendingActions();
        for (const k in pa) { if (k === '__meta') continue; const e = pa[k]; if (e && e.since && startedAt && e.since >= startedAt) size++; }
      } catch {}
    }
    // resend 标记（2026-07-10 修）：不再依赖 existingMsgId——item-3 起默认每次发新卡，existingMsgId 恒 false，
    //   会把每次 re-gen 都当首发、污染吞吐。改为判「本 (date,round) 是否已在 rounds.jsonl 出现过首发行」：
    //   已出现 → 本次是同批 re-gen → resend:true；统计只认每 (date,round) 的第一条首发行。
    let resend = false;
    try {
      const _rp = path.join(AUDIT_DIR, 'rounds.jsonl');
      if (fs.existsSync(_rp)) {
        const _dt = date || auditDateStr();
        for (const _l of fs.readFileSync(_rp, 'utf8').split('\n')) {
          if (!_l) continue;
          try { const _o = JSON.parse(_l); if (_o.date === _dt && _o.round === r && _o.resend !== true) { resend = true; break; } } catch {}
        }
      }
    } catch {}
    // 2026-07-15：本批结算明细（done/skip/failed/timeout 计数），供 audit-health-watch.cjs 算超时率/连续失败。
    //   仅首发行(resend=false)带 settled；旧行/无 outcomes 时缺省 null，watchdog 侧向后兼容。
    let settled = null;
    if (batchOutcomes && typeof batchOutcomes === 'object') {
      settled = { done: 0, skip: 0, failed: 0, timeout: 0 };
      for (const k in batchOutcomes) {
        const st = batchOutcomes[k] && batchOutcomes[k].status;
        if (st && settled[st] != null) settled[st]++;
      }
    }
    fs.appendFileSync(path.join(AUDIT_DIR, 'rounds.jsonl'),
      JSON.stringify({ ts: cardSentAt, round: r, date: date || auditDateStr(), startedAt, cardSentAt, size, resend, settled }) + '\n', 'utf8');
  } catch (e) { /* 埋点失败不阻断发卡 */ }

  // 📤 发卡后自动同步吞吐轮次 → bitable（fire-and-forget，2026-07-13，B）：发一批就更一次，让「AI吞吐·轮次」表准实时。
  //   仅生产触发（CFG.allowApprove=prod；sync 读的是生产 rounds.jsonl，test 无需推）；detached+unref → 不阻塞发卡、失败绝不影响主流程。
  try {
    const _syncScript = 'D:\\agent-hub\\scripts\\sync-rounds-bitable.cjs';
    if (CFG.allowApprove && fs.existsSync(_syncScript)) {
      const _c = require('child_process').spawn(process.execPath, [_syncScript], { detached: true, stdio: 'ignore', cwd: path.dirname(_syncScript), windowsHide: true });
      _c.unref();
    }
  } catch (e) { /* fire-and-forget，绝不影响发卡 */ }

  // 2026-07-06：返回明确的动作语义，杜绝"updated:false 被误读成失败→重发"（那正是"每次2张卡"的人为诱因）。
  const cardAction = existingMsgId ? '已更新同一张卡（原地 PATCH，未新发）' : '已新建一张卡（本批首次）';
  return {
    ok: true, output: out.trim(), updated: !!existingMsgId, card_action: cardAction,
    idempotent_note: '本命令幂等：同一批（键=batchDate+群）重复调用会 PATCH 同一张卡、绝不重复发。updated:false 仅表示"本批首次新建"（正常结果），不是失败，切勿因此重跑。',
    ...(_timedOut.length ? { timed_out: _timedOut, timed_out_note: `⚠️ ${_timedOut.length} 条子代理超时未审结（[${_timedOut.join(', ')}]），未上本卡、已保留台账下轮自动重审。需关注是否反复超时。` } : {})
  };
}

// ③ 越界踢出：用户确认扫到的「其他」类实际越界 → 内部关闭，不写飞书评论
// 用法：scope-dismiss <instance_code>  或  scope-dismiss <#N>  或  scope-dismiss <N>
function cmdScopeDismiss(codeOrN) {
  if (!codeOrN) throw new Error('scope-dismiss 需要 <instance_code> 或 <N>');
  const res = withLock(PENDING_ACTIONS_PATH, () => {
    const pa = readPendingActions();
    let code = codeOrN;
    if (/^#?\d+$/.test(codeOrN)) {
      const n = parseInt(codeOrN.replace('#', ''), 10);
      const found = Object.entries(pa).find(([k, v]) => k !== '__meta' && v.n === n);
      if (!found) throw new Error(`未找到 #${n} 的案件，请用 instance_code 重试`);
      code = found[0];
    }
    if (!pa[code]) {
      // 2026-07-06：越界 fresh 件补关——in_scope=false 的件从不落台账，故 scope-dismiss 原会「查无此条」→ 反复重现于 worklist。
      //   传完整 instance_code（UUID 形态）且台账无此条时，建一个最小 CLOSED 条目（纯内部、不碰飞书、不通知申请人）。
      //   #N 形态仍要求台账已有（上面已处理），此处只接 UUID，避免误建。
      if (!/^[0-9A-Fa-f-]{36}$/.test(code)) throw new Error(`未找到 instance_code=${code}`);
      pa[code] = { n: null, person: '（越界·未落台账）', state: 'NEW' };
    }
    const prev = pa[code].state;
    pa[code].state = 'CLOSED';
    pa[code].dismissedAt = new Date().toISOString();
    pa[code].dismissNote = '用户确认越界，内部关闭（未通知申请人）';
    writePendingActions(pa);
    return { ok: true, instance_code: code, n: pa[code].n, person: pa[code].person, prev_state: prev, new_state: 'CLOSED', note: '已内部关闭，下轮 list 自动跳过，飞书无评论写入' };
  });
  // 2026-07-09（生产兜底 a）：越界踢出 = 结案的一种 → 登记本轮状态机为 skip，让 gen-card 屏障放行（否则该 expected 永久 pending 挡卡）。
  markOutcome(res.instance_code, 'skip');
  return res;
}

// ── await-batch（2026-07-09，#1）：父 agent spawn 完子代理后调此，阻塞轮询磁盘账本直到本批全部 settled 或超时。──
//   治 #1「断了/要再戳一次」：父在同一轮 hold 住等齐再 gen-card，无需第二次触发。
//   对 sessions_spawn 同步/异步均成立——不依赖父收到子代理回话，只看子代理各自写盘的 outcomes。
//   二公子建议：一个子代理 hang 住不拖垮整批 → 超时把未完成件标 timeout 放行，下轮 list 自动重新捞回。
//   用法: await-batch [timeoutSec]   默认 660s（略大于子代理 runTimeoutSeconds=600，留收尾余量）。
function cmdAwaitBatch(timeoutArg) {
  const b0 = readBatch();
  if (!Array.isArray(b0.expected) || b0.expected.length === 0) {
    return { ok: true, ready: true, expected: 0, note: '本轮无 expected 集（旧批次/手动跑/纯复审），无需等待，可直接 gen-card。' };
  }
  const total = b0.expected.length;
  const timeoutSec = (parseInt(timeoutArg, 10) > 0) ? parseInt(timeoutArg, 10) : 660;
  // 以 roundStartedAt 为基准计总等待上界（防父晚调 await 导致超时窗被拉长）；缺失则以本次调用起算。
  const baseMs = b0.roundStartedAt ? new Date(b0.roundStartedAt).getTime() : Date.now();
  const deadline = baseMs + timeoutSec * 1000;
  const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} };
  for (;;) {
    const b = readBatch();
    const pending = batchPending(b) || [];
    const done = total - pending.length;
    if (pending.length === 0) {
      const oc = b.outcomes || {};
      const tally = { done: 0, skip: 0, failed: 0, timeout: 0 };
      for (const c of b.expected) { const s = oc[c] && oc[c].status; if (tally[s] !== undefined) tally[s]++; }
      return { ok: true, ready: true, expected: total, settled: total, tally, note: `本批 ${total} 条全部 settled，可 gen-card。` };
    }
    if (Date.now() >= deadline) {
      for (const c of pending) markOutcome(c, 'timeout'); // 放行：未完成件标 timeout，下轮 list 重新捞回（不丢）
      return {
        ok: true, ready: true, expected: total, settled: done, timed_out: pending, timed_out_count: pending.length,
        note: `等待达上限 ${timeoutSec}s，${pending.length} 条未完成已标 timeout 放行（下轮 list 自动重新捞回，不丢）。可 gen-card（超时件不上本卡）。`
      };
    }
    sleep(4000);
  }
}

// ── batch-skip（2026-07-09，#1/#2）：子代理判定 in_scope=false/should_skip 时调此登记 skip，让 await-batch 不空等、gen-card 硬闸放行。──
//   用法: batch-skip <instance_code>
function cmdBatchSkip(code) {
  if (!code) throw new Error('batch-skip 需要 <instance_code>');
  markOutcome(code, 'skip');
  const b = readBatch();
  const inExpected = Array.isArray(b.expected) && b.expected.includes(code);
  return { ok: true, instance_code: code, marked: 'skip', in_expected: inExpected, note: inExpected ? '已登记本轮 skip。' : '本轮 expected 无此 code（旧批/手动），仅记录不影响硬闸。' };
}

// ── batch-fail（2026-07-09，P1 收网纪律 C）：父 agent 被完成事件唤醒后，若发现某子代理【完成却没落盘】(畸形工具调用/中止/异常，无 write-result)，──
//   调此把它登记为 failed → 账本据此靠【事件】闭合（每个子代理无论成败都产生完成事件，末个事件到达即全 settled → gen-card 出卡），不必空等到 30min。
//   failed 件与 timeout 同类：不写结论、不上"已审"区、卡上列入「未审结·待人工」、下轮 list 自动重captured。
//   用法: batch-fail <instance_code>
function cmdBatchFail(code) {
  if (!code) throw new Error('batch-fail 需要 <instance_code>');
  markOutcome(code, 'failed');
  const b = readBatch();
  const inExpected = Array.isArray(b.expected) && b.expected.includes(code);
  return { ok: true, instance_code: code, marked: 'failed', in_expected: inExpected, note: inExpected ? '已登记本轮 failed（子代理完成却没落盘）→ 账本可靠事件闭合，卡上会列未审结。' : '本轮 expected 无此 code（旧批/手动），仅记录不影响硬闸。' };
}

// ── register-orphans（2026-07-09，治"写了文件没跑 write-result"）：父收网时自动找回【写了 result_<code>.json 却没注册】的孤儿件。──
//   根因：子代理易把 `write 文件` 当成 `exec write-result 命令`（两步分离），或校验打回后漏重跑 → 文件在但没落盘。
//   做法：扫本轮 expected 里未 settled 的 code，若 CWD 有 result_<code>.json → 自动 cmdWriteResult 校验+落盘+登记 done。把"编排"从模型手里收回脚本(第一性原理：能确定化的步骤别留给弱模型)。
//   父应在 batch-fail 之前跑本命令：先把写了文件的找回，剩下真没产出的才 batch-fail。
function cmdRegisterOrphans() {
  const b = readBatch();
  if (!Array.isArray(b.expected) || !b.expected.length) return { ok: true, registered: [], note: '无 expected 集，跳过。' };
  const outc = b.outcomes || {};
  const isSet = c => { const o = outc[c]; return o && SETTLED.has(o.status); };
  const registered = [], skipped_invalid = [], not_found = [];
  for (const code of b.expected) {
    if (isSet(code)) continue;
    // 只认唯一名 result_<code>.json（严禁 fallback 到共享 result.json——会把遗留文件误注册到错的 code，跨件污染）
    const f = path.join(CWD, `result_${code}.json`);
    if (!fs.existsSync(f)) { not_found.push(code); continue; }
    try { const r = cmdWriteResult(code, f); registered.push({ code, n: r.n, person: r.person, verdict: r.verdict }); }
    catch (e) { skipped_invalid.push({ code, error: e.message }); }
  }
  return { ok: true, registered, registered_count: registered.length, skipped_invalid, not_found, note: `自动找回写了文件却没注册的孤儿件：registered=${registered.length}。剩余 not_found 的才是真没产出，交给 batch-fail。` };
}

// ── safety-net-spec（2026-07-09，P1 时间兜底 B）：输出【算好的】一次性兜底 cron JSON，供父 agent 交给 cron action=add。──
//   父在 spawn 完、sessions_yield 前跑一次，把返回的 cron_add 原样喂给调度工具。时间/转义由工具算，避免弱模型算错 +31min。
//   到点(roundStartedAt+31min)兜调一次 gen-card：已正常收网→幂等 PATCH 无害；卡住→触发 30min 自愈出「未审结」卡。
//   用法: safety-net-spec [remaining]
function cmdSafetyNetSpec(remaining) {
  const b = readBatch();
  const base = b.roundStartedAt ? new Date(b.roundStartedAt).getTime() : Date.now();
  // 兜底时间（2026-07-09 从 31min 缩到 16min）：仅"完成事件丢失致父永不被唤醒"的极端兜底；正常靠事件收网即出卡，不等它。
  // 略大于 gen-card 自愈线(QUAL_ROUND_TIMEOUT 默认 900s=15min，锚子代理硬超时 600s + 缓冲)。可用 QUAL_SAFETYNET_MIN 覆盖。
  const netMin = (parseInt(process.env.QUAL_SAFETYNET_MIN, 10) > 0) ? parseInt(process.env.QUAL_SAFETYNET_MIN, 10) : 16;
  const at = new Date(base + netMin * 60 * 1000).toISOString();
  const rem = remaining ? (parseInt(remaining, 10) || 0) : 0;
  const batchDate = b.batchDate || readBatchDate();
  // message 用 bash 风格 &&（与 zizhi exec 一致）。QUAL_PROFILE 兜底 gen-card 需与本轮一致：test 为默认可省；prod 须显式。
  const profPrefix = (QUAL_PROFILE === 'prod') ? "$env:QUAL_PROFILE='prod'; " : '';
  const msg = `${profPrefix}cd ${CWD}; node scripts/audit-tool.cjs gen-card 1 "" ${rem}`;
  return {
    ok: true,
    cron_add: {
      name: `qual-safety-net-${batchDate}-${QUAL_PROFILE}`,
      schedule: { kind: 'at', at },
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn', message: msg, timeoutSeconds: 120 },
      deleteAfterRun: true
    },
    note: `把 cron_add 原样交给你的 cron action=add（一次性、${at} 触发）。这是"完成事件丢失致父永不被唤醒"的极端兜底：到点已正常收网→gen-card 幂等 PATCH 无害；真卡住→触发 30min 自愈、出「未审结·待人工」卡。正常收网不靠它，靠 batch-fail 的事件闭合。`
  };
}

(async () => {
  const args = process.argv.slice(2);
  // 先抽出 --fair-letter <X>（可在任意位置），剥离后再做位置参数解析，避免污染 a1..a3。
  let fairLetter = '';
  { const fi = args.indexOf('--fair-letter'); if (fi >= 0) { fairLetter = args[fi + 1] || ''; args.splice(fi, 2); } }
  const [sub, a1, a2, a3] = args;
  let result;
  if (sub === 'list') {
    const rest = args.slice(1);
    const all = rest.includes('--all');
    let since = all ? 0 : (process.env.QUAL_SINCE_DAYS ? (parseInt(process.env.QUAL_SINCE_DAYS, 10) || 0) : 7);
    const si = rest.indexOf('--since');
    if (si >= 0 && rest[si + 1] !== undefined) since = parseInt(rest[si + 1], 10) || 0;
    const limTok = rest.find(x => /^\d+$/.test(x));
    result = cmdList(limTok ? parseInt(limTok, 10) : 12, since);
  }
  else if (sub === 'case') result = await cmdCase(a1, a2);
  else if (sub === 'read-attachment') result = cmdReadAttachment(a1, a2, a3);
  else if (sub === 'comment') result = await cmdComment(a1, a2);
  else if (sub === 'cache-from-doc') result = await cmdCacheFromDoc(a1, ...args.slice(3));
  else if (sub === 'comment-from-doc') result = await cmdCommentFromDoc(a1, a2, a3);
  else if (sub === 'write-result') result = cmdWriteResult(a1, a2);
  else if (sub === 'approve') result = await cmdApprove(a1, a2, fairLetter);
  else if (sub === 'reject') result = await cmdReject(a1, a2, a3, fairLetter);
  else if (sub === 'note') result = await cmdNote(a1, a2, fairLetter);
  else if (sub === 'fair') result = await cmdFair(a1);
  else if (sub === 'gen-card') result = cmdGenCard(a1, a2, a3);
  else if (sub === 'await-batch') result = cmdAwaitBatch(a1);
  else if (sub === 'batch-skip') result = cmdBatchSkip(a1);
  else if (sub === 'batch-fail') result = cmdBatchFail(a1);
  else if (sub === 'safety-net-spec') result = cmdSafetyNetSpec(a1);
  else if (sub === 'register-orphans') result = cmdRegisterOrphans();
  else if (sub === 'scope-dismiss') result = cmdScopeDismiss(a1);
  else if (sub === 'lookup-case-by-n') result = cmdLookupCaseByN(a1);
  else if (sub === 'revisions') result = cmdRevisions(a1);
  else if (sub === 'revision-card') result = cmdRevisionCard(a1, a2);
  else if (sub === 'comments') result = cmdComments(a1);
  else {
    console.error([
      '用法:',
      '  node scripts/audit-tool.cjs list [limit] [--since <天>|--all]   # 默认日期窗 QUAL_SINCE_DAYS 或 7 天；--all=全量(清库存)',
      '  node scripts/audit-tool.cjs case <instance_code> [force]',
      '  node scripts/audit-tool.cjs read-attachment <instance_code> <idx> [maxChars]',
      '  node scripts/audit-tool.cjs comment <instance_code> <comment_textfile>',
      '  node scripts/audit-tool.cjs cache-from-doc <doc_id> [<caseN>:<instance_code> ...]',
      '  node scripts/audit-tool.cjs comment-from-doc <instance_code> <doc_id> <case_number>',
      '  node scripts/audit-tool.cjs write-result <instance_code> <result_json_file>',
      '  node scripts/audit-tool.cjs approve <instance_code> [expected_person] --fair-letter F   # 必带用户原始字母；person 做串号硬校验',
      '  node scripts/audit-tool.cjs reject <instance_code> <reason_file> [expected_person] --fair-letter A',
      '  node scripts/audit-tool.cjs note <instance_code> [expected_person] --fair-letter I   # R=修订不走这三个动作，改 write-result 重判',
      '  node scripts/audit-tool.cjs fair "<用户整条FAIR原文>"   # 【首选】一条命令批量执行 F#/A#/I#/R#/S#：解析+逐条approve/reject/note/scope-dismiss+刷卡；需 QUAL_PROFILE=prod + QUAL_ACTOR_OPEN_ID',
      '  node scripts/audit-tool.cjs gen-card [round] [date_YYYYMMDD] [remaining]   # 需设 QUAL_CARD_SCRIPT；本批未全 settled 会拒发(防空卡)，先 await-batch；应急 QUAL_FORCE_CARD=1',
      '  node scripts/audit-tool.cjs await-batch [timeoutSec]   # 父 spawn 完调此，阻塞等本批子代理全部 settled 或超时(默认660s，超时标记放行)，再 gen-card',
      '  node scripts/audit-tool.cjs batch-skip <instance_code>  # 子代理判 in_scope=false/should_skip 时登记 skip，让收网不空等',
      '  node scripts/audit-tool.cjs batch-fail <instance_code>  # 父唤醒后发现子代理完成却没落盘(失败/中止)→登记 failed，账本靠事件闭合、卡上列未审结',
      '  node scripts/audit-tool.cjs safety-net-spec [remaining]  # 输出算好的一次性兜底 cron JSON(round+16min→gen-card)，父交给 cron action=add',
      '  node scripts/audit-tool.cjs register-orphans  # 父收网时自动找回"写了 result_<code>.json 却漏跑 write-result"的孤儿件(batch-fail 之前跑)',
      '  node scripts/audit-tool.cjs lookup-case-by-n <n>              # 将 #N 映射到 instanceCode',
      '  node scripts/audit-tool.cjs revisions [instance_code]        # 查修订历史(打回案例库)；不带参=全量',
      '  node scripts/audit-tool.cjs revision-card <instance_code>    # 发一张【修订对比事件卡】(改前vs改后)；永远新发、不接FAIR、不影响活卡幂等；R修订链路 gen-card 后调',
      '  node scripts/audit-tool.cjs comments <instance_code>         # 拉审批评论(申请人回复/AI评论)，复审前核对，防漏回复',
    ].join('\n'));
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
})().catch(e => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
