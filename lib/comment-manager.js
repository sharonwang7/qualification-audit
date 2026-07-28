/**
 * comment-manager.js — 飞书审批评论管理
 * 职责：
 *   1. hasAIComment() — 检测审批实例上是否已有 AI 评论及是否存在冲突（>=2 条需写统一版）
 *   2. writeComment() — 写入 AI 评论，处理限流返回
 *   3. extractCommentAttachments() — 从审批详情中提取评论区附件元数据
 *
 * 安全：所有 lark-cli 调用统一用 execFileSync 数组形式（杜绝 shell 注入）
 */
const fs = require('fs');
const path = require('path');
// 飞书传输已收拢到 L1 连接器（P0）。本模块保留 execLarkApi 同名薄委托，语义函数不变。
const connector = require('./connector-feishu.js');

const CWD = process.cwd();

/**
 * 内部：执行 lark-cli 命令，参数走 @file 形式，body 走 @file 形式
 * 传输逻辑已迁至 connector-feishu.js；此处仅委托，返回契约不变。
 * @returns { success: boolean, data: object, error: object|null }
 */
function execLarkApi(method, url, params, body, identity) {
  return connector.apiWithBody(method, url, params, body, identity, { cwd: CWD });
}

/**
 * 检测审批实例上是否已有 AI 评论
 * @param {string} instanceCode - 审批实例 code
 * @param {string} userOpenId - 当前用户 open_id（查询该接口必填）
 * @returns {Promise<{hasComment:boolean, count:number, needsUnified:boolean, hasUnified:boolean}>}
 *
 * 判定规则：
 *   - hasComment：含 "AI审核" 或 "深度审视" 标识的评论数 >= 1
 *   - hasUnified：任一 AI 评论含 "统一版"
 *   - needsUnified：AI 评论数 >= 2（需要写统一版收敛冲突）
 *   - 失败 / 异常 → 返回安全默认 {hasComment:false, count:0, needsUnified:false, hasUnified:false}
 */
async function hasAIComment(instanceCode, userOpenId) {
  // F20 fail-closed：查重 API 失败时带 error:true 返回，调用方据此"不写、报警重试"，而非误判"没评论过"导致重复评论。
  const safeDefault = { hasComment: false, count: 0, needsUnified: false, hasUnified: false, error: true };
  try {
    const url = `/open-apis/approval/v4/instances/${instanceCode}/comments`;
    // 飞书该接口必须带 user_id(+user_id_type) 查询参数，否则 99992402 field validation failed。
    // 缺这个会让 hasAIComment 静默失败 → 查重失效 → 重复评论/结论冲突(历史顽疾根因)。
    // 审批评论接口只收 tenant/bot token(user token 报 'user access token not support'),用 --as bot。
    // user_id 必须是【本 app(默认 lark-cli 根=大公子桥 cli_aaa274a26fba9cca)自己的用户】,否则 99992361 cross app。
    const result = execLarkApi('GET', url, { user_id: userOpenId, user_id_type: 'open_id' });
    if (!result.success) {
      console.error(`[hasAIComment] API 调用失败 ${instanceCode}: ${result.error && result.error.message}`);
      return safeDefault;
    }

    const allComments = (result.data && result.data.data && result.data.data.comments)
      || (result.data && result.data.comments) || [];
    // 过滤软删评论（is_delete=1），避免已删评论干扰查重
    const comments = allComments.filter(c => !c.is_delete);
    // content 字段是 JSON 字符串形如 {"text":"...","files":null}，需解析后检测文本
    const extractText = c => {
      try { return JSON.parse(c.content || '{}').text || ''; } catch (e) { return (c.content || '').toString(); }
    };
    const aiComments = comments.filter(c => {
      const text = extractText(c);
      return text.includes('AI审核') || text.includes('深度审视');
    });

    const count = aiComments.length;
    const hasUnified = aiComments.some(c => extractText(c).includes('统一版'));

    // needsUnified：仅当 2+ 条 AI 评论且没有一条是"今日"写的时才触发统一版。
    // 如果最新的 AI 评论是今天写的，它就是当前最新分析，不算冲突——不需要再写统一版。
    // created_time 是秒级时间戳（飞书 approval comment API 字段）。
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayStartMs = todayStart.getTime();
    const hasRecentComment = aiComments.some(c => {
      const ts = c.create_time || c.created_time || c.created_at || 0;
      return Number(ts) * 1000 >= todayStartMs;
    });
    // 有今日评论 → 最新分析已存在，视为"无冲突"（不再触发统一版写入）
    const needsUnified = count >= 2 && !hasRecentComment;

    return { hasComment: count >= 1, count, needsUnified, hasUnified, hasRecentComment, error: false };
  } catch (e) {
    console.error(`[hasAIComment] 异常 ${instanceCode}: ${e.message}`);
    return safeDefault;
  }
}

/**
 * 写入 AI 评论到审批实例
 * @param {string} instanceCode - 审批实例 code
 * @param {string} content - 评论内容（已格式化）
 * @param {string} userOpenId - 评论归属人 open_id
 * @returns {Promise<true|false|'rate_limit'>}
 *   - true：写入成功（code 0 或 99991663 重复评论视为成功）
 *   - false：写入失败
 *   - 'rate_limit'：限流，调用方应等待后重试
 */
async function writeComment(instanceCode, content, userOpenId, atUser) {
  try {
    const url = `/open-apis/approval/v4/instances/${instanceCode}/comments`;
    // user_id/user_id_type 必须在 query params（body 里会报 99992402 field validation failed）
    // content 必须是 stringified JSON 形如 {"text":"...","files":null}（plain text 报 60001 content invalid）
    const params = { user_id: userOpenId, user_id_type: 'open_id' };
    // ── @ 申请人（2026-07-05）：atUser={open_id,name} 有效时，在文本最前面插入 "@姓名 " 字面量，
    //    并在 body.at_info_list 声明 mention（offset=0 指向文本起点）。飞书据 at_info_list 把该处渲染成真 @ 并推送通知。
    //    fail-open：atUser 缺失/无 open_id → 退回纯文本评论，绝不因 @ 失败而漏评论。
    let finalText = content;
    let atInfoList = null;
    if (atUser && atUser.open_id) {
      const atName = (atUser.name || '申请人').toString();
      finalText = `@${atName} \n\n${content}`;
      atInfoList = [{ user_id: atUser.open_id, name: atName, offset: '0' }];
    }
    const body = { content: JSON.stringify({ text: finalText, files: null }) };
    if (atInfoList) body.at_info_list = atInfoList;
    const result = execLarkApi('POST', url, params, body);
    if (!result.success) {
      const errMsg = (result.error && result.error.message || '').toLowerCase();
      if (errMsg.includes('429') || errMsg.includes('rate limit') || errMsg.includes('too many')) {
        return 'rate_limit';
      }
      return false;
    }

    // lark-cli 有两种返回格式：
    // 1. saved_path 模式（--output json）：data = 原始 Feishu 响应 {code, msg, data}
    // 2. 内联模式（--format json，无 --output json）：data = {ok, identity, data}
    const code = result.data && result.data.code;
    // 内联格式：ok=true 且无 code 字段 → 成功
    if (result.data && result.data.ok === true && code === undefined) {
      return true;
    }
    if (code === 0 || code === 99991663) {
      return true;
    }
    if (code === 99991400) {
      return 'rate_limit';
    }
    console.error(`[writeComment] 业务错误 code=${code}, msg=${(result.data && result.data.msg) || ''}`);
    return false;
  } catch (e) {
    console.error(`[writeComment] 异常 ${instanceCode}: ${e.message}`);
    return false;
  }
}

/**
 * 从审批详情数据中提取评论区附件元数据
 * @param {object} instanceData - 审批详情（getInstance 返回的对象）
 * @returns {Array<{name:string, url:string, source:string}>}
 *   容错：comments/files 字段缺失或类型不对则返回空数组
 */
function extractCommentAttachments(instanceData) {
  // ⑦ 已知 bot open_id，过滤掉 AI 自身回复的附件
  const BOT_IDS = new Set([
    process.env.FEISHU_USER_OPEN_ID,
    'ou_dc58e9efc5ed5cf4c73d48249d7f8e70' // OpenClaw 审核助手
  ].filter(Boolean));

  function extractFiles(obj, srcPrefix) {
    const files = (obj && (obj.files || obj.attachments)) || [];
    if (!Array.isArray(files)) return [];
    const res = [];
    for (let j = 0; j < files.length; j++) {
      const f = files[j];
      const url = f && (f.url || f.file_url || f.download_url);
      if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
        res.push({ name: (f && f.name) || `${srcPrefix}_${j + 1}`, url, source: `${srcPrefix}.files[${j}]` });
      }
    }
    return res;
  }

  try {
    const comments = (instanceData && instanceData.data && instanceData.data.comments)
      || (instanceData && instanceData.comments) || [];
    if (!Array.isArray(comments)) return [];

    const out = [];
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      if (!c) continue;
      // 顶层评论附件（过滤 bot 自己发的）
      if (!BOT_IDS.has(c.user_id)) {
        out.push(...extractFiles(c, `comment[${i}]`));
      }
      // ⑦ 嵌套回复附件（申请人常以"回复 AI 评论"形式补材料，原实现漏拉）
      const replies = (c.reply_list && c.reply_list.replies) || c.replies || c.comment_reply_list || [];
      for (let r = 0; r < replies.length; r++) {
        const reply = replies[r];
        if (reply && !reply.is_delete && !BOT_IDS.has(reply.user_id)) {
          out.push(...extractFiles(reply, `comment[${i}].reply[${r}]`));
        }
      }
    }
    return out;
  } catch (e) {
    console.error(`[extractCommentAttachments] 异常: ${e.message}`);
    return [];
  }
}

module.exports = {
  hasAIComment,
  writeComment,
  extractCommentAttachments
};
