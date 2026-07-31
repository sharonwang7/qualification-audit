/**
 * refresh-approval-defs.cjs — 从飞书 API 全量拉取审批定义，更新本地缓存
 *
 * 用法: node scripts/refresh-approval-defs.cjs
 *   → 调飞书 API 翻页拉全量审批定义 → 写入 common/approval-definitions.json
 *   → 提交到仓库 = 所有团队共享同一份缓存
 *
 * 审批流变动频率极低（月级），手动跑一次即可。跑完提个 commit。
 * 依赖 lark-cli --as user + approval:definition scope。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LARK_CLI_JS = process.env.QUAL_LARKCLI_JS ||
  'C:\\Users\\FD\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\scripts\\run.js';

function runLark(args, { cwd = process.cwd() } = {}) {
  return execFileSync('node', [LARK_CLI_JS, ...args], {
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    cwd, shell: false, windowsHide: true, timeout: 30000
  }).replace(/^\uFEFF/, '');
}

async function main() {
  let all = [];
  let pageToken = null, pages = 0;

  do {
    pages++;
    const params = { page_size: 100 };
    if (pageToken) params.page_token = pageToken;

    const raw = runLark(['api', 'GET', '/open-apis/approval/v4/approvals', '--params', JSON.stringify(params), '--as', 'user', '--format', 'json']);
    const json = JSON.parse(raw);

    if (!json.ok || json.error) {
      console.error('API error:', JSON.stringify(json.error || json));
      process.exit(1);
    }

    const items = (json.data && json.data.items) || [];
    all.push(...items);
    pageToken = (json.data && json.data.has_more) ? json.data.page_token : null;
    console.error(`Page ${pages}: ${items.length} items, has_more=${!!pageToken}`);
  } while (pageToken && pages < 10);

  const out = all.map(item => ({
    name: item.approval_name || '',
    code: item.approval_code || '',
    group: item.group_name || ''
  }));

  const outPath = path.join(__dirname, '..', 'common', 'approval-definitions.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify({ total: out.length, pages, path: outPath }));
  console.error('Done. Commit this file to the repo.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
