#!/usr/bin/env node
/**
 * batch-t2-eval.cjs — 批量生成 T2 评估 prompt
 * 读取所有 golden case 的 input.json，生成子代理审核用的 prompt
 */
const fs = require('fs');
const path = require('path');

const GOLDEN_DIR = path.join(__dirname, '..', '.dev', 'golden_set');
const dirs = fs.readdirSync(GOLDEN_DIR)
  .filter(d => fs.statSync(path.join(GOLDEN_DIR, d)).isDirectory())
  .sort();

const cases = [];
for (const d of dirs) {
  const inputPath = path.join(GOLDEN_DIR, d, 'input.json');
  const expPath = path.join(GOLDEN_DIR, d, 'expected.json');
  if (!fs.existsSync(inputPath) || !fs.existsSync(expPath)) continue;
  
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const exp = JSON.parse(fs.readFileSync(expPath, 'utf8'));
  const expDet = exp.expected || exp;
  
  cases.push({
    id: d,
    input,
    conclusion_key: expDet.conclusion_key || '?',
    scene: expDet.scene || '?',
    known_ai_miss: exp.known_ai_miss === true
  });
}

// 生成每个 case 的精简输入（只保留审核需要的信息）
function formatCaseForEval(c) {
  const form = c.input.form || {};
  const atts = c.input.attachments || [];
  const comments = c.input.comments || [];
  
  const attTexts = atts.map((a, i) => {
    const content = (a.content || a.summary || '').slice(0, 500); // content 优先，回退 summary（golden 附件多为 summary）
    return `[附件${i+1}: ${a.source || 'unknown'} (${a.type}, ${a.size_kb || '?'}KB)]\n${content}`;
  }).join('\n\n');

  // 评论区（含嵌套 replies）：申请人常在 AI 补充要求的回复里补关键证据；漏读 replies 会误判需补充，必须喂入。
  const commentTexts = comments.map((cm) => {
    const who = cm.author_role || '?';
    const rt = cm.reply_to ? `（回复：${cm.reply_to}）` : '';
    const del = cm.is_delete ? '［已撤回］' : '';
    return `- ${who}${rt}${del}：${cm.text || ''}`;
  }).join('\n');

  return `### ${c.id}
申请人: ${form['申请人'] || '?'}
审批编号: ${form['审批编号'] || '?'}
申请资质: ${(() => { const qs = form['申请资质'] || form['拟用资质'] || []; return Array.isArray(qs) ? qs.join('、') : qs; })()}
流向方: ${form['资质流向方全称（公司/自然人/平台）'] || form['相对方全称（公司/自然人全称）'] || '?'}
事由: ${form['申请事由'] || '?'}
使用平台: ${form['使用平台'] || '?'}
公司主体: ${form['公司主体'] || '?'}
是否合作: ${form['是否跟对方存在合作关系'] || '(空)'}
是否涉及账号: ${form['是否涉及相关账号'] || '(空)'}
${attTexts ? '\n附件内容:\n' + attTexts : ''}${commentTexts ? '\n\n评论区（含嵌套回复，申请人补充说明可能在此）：\n' + commentTexts : ''}
`;
}

const prompt = `你是资质审核 agent，按以下三阶段框架审核每个 case，给出结论。

## 三阶段审核框架
1. **证据链核实**：证据是否充分？被证明≠被说明。合作/授权类走证据链层级表。
2. **逻辑穿透**（四维度）：
   - 看流向：资质交给谁？
   - 看用途：用来干什么？
   - 业务必要性：Q1触发条件（是否有业务背景/对方要求）+ Q2强制必要性（材料是否不可替代）
   - 主体必要性：是否必须这个主体？
3. **风险控制**：替代控制 / 限制控制（红线：转授权、授权不明、期限不受控→驳回）/ 技术控制

## 结论选项
- pass：通过，证据充分+逻辑穿透+无红线
- request_info：需补充，证据不足或业务必要性未说明
- reject：驳回，触碰红线
- manual_review：边界case，需人工

## 内部主体豁免
慕可生物/凡岛网络/欣芝妍 之间的内部授权 → 豁免，无需审批 → pass

## 输出格式
严格输出 JSON 数组，每个元素：
{"case_id": "GSxxx", "conclusion": "pass|request_info|reject|manual_review", "reason": "一句话理由"}

不要输出分析过程，只输出 JSON。

---

${cases.map(formatCaseForEval).join('\n---\n\n')}
`;

// 写到 scratch
const outPath = path.join(__dirname, '..', '..', '..', '..', '..', 'AppData', 'Roaming', 'FanDo', 'openclaw', 'workspace-agent-2', 'scratch', 't2-eval-prompt.txt');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, prompt, 'utf8');
console.log(`Prompt 已写入: ${outPath}`);
console.log(`共 ${cases.length} 个 case`);
console.log(`Prompt 大小: ${(prompt.length / 1024).toFixed(1)} KB`);

// 同时输出 case 列表
console.log('\nCase 列表:');
for (const c of cases) {
  console.log(`  ${c.id}: ${c.conclusion_key} (${c.scene})${c.known_ai_miss ? ' ⚠WATCH' : ''}`);
}
