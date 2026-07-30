#!/usr/bin/env node
/**
 * card-live-test.cjs — 卡片「活消息」集成自测（2026-07-30）
 *
 * 补的盲区：smoke/golden 全是离线 mock，【不发真飞书消息】，测不到 gen-card 的 POST-vs-PATCH 行为。
 *   zizhi 实测「R 修订后卡不刷新、停在旧判断」的真因 = existingMsgId 曾硬编码 null → 永远新发、从不更新。
 *   本测【真发卡到测试群 oc_e819】两次，断言第二次是 PATCH 同一张（message_id 不变 + updated=true）。
 *
 * 安全：强制 QUAL_PROFILE=test（发测试群、隔离台账、物理禁真实 approve）。不碰生产。
 * 用法：node scripts/card-live-test.cjs        # 🟢 exit 0 / 🔴 exit 1
 * 注：需要 test profile 的发卡凭证（bound bridge 环境）。无凭证/网络失败 → 判 SKIP 不判 FAIL。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AUDIT = path.join(__dirname, 'audit-tool.cjs');
const TODAY = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD

// test profile 数据目录（与 audit-tool PROFILE 配置一致）
const TEST_DIR = path.join(ROOT, '..', '_test');           // skills/_test（audit-tool prod fallback 同级的 _test）
const auditDir = path.join(TEST_DIR, 'audit_reports');
const CARDIDS = path.join(ROOT, 'scratch', 'audit_card_ids.json'); // gen-card 记 message_id 处（CWD=ROOT）
const TESTCHAT = 'oc_e8198717e2b926d97fb9007171aef2af';    // test profile 发卡群
const CODE = 'CARDLIVETEST01';

// 读/清 本测试键（batchDate=今日 + 测试群）对应的 message_id
function clearTestKeys() {
  try { const j = JSON.parse(fs.readFileSync(CARDIDS, 'utf8')); let ch = false;
    for (const k of Object.keys(j)) if (k.includes(TODAY) && k.includes(TESTCHAT)) { delete j[k]; ch = true; }
    if (ch) fs.writeFileSync(CARDIDS, JSON.stringify(j, null, 2));
  } catch {}
}
function currentCardId() {
  try { const j = JSON.parse(fs.readFileSync(CARDIDS, 'utf8'));
    for (const k of Object.keys(j)) if (k.includes(TODAY) && k.includes(TESTCHAT)) return j[k];
  } catch {}
  return null;
}

function seed() {
  fs.mkdirSync(auditDir, { recursive: true });
  // 1) 报告：1 条完整 case
  const rec = {
    n: 1, person: '测试申请人', sealType: '法定代表人章（测试）', entity: '测试主体',
    dest: '测试流向方', context: '集成自测用例',
    verdict: '通过', applicantAction: '', fullAnalysis: '**阶段一·证据链核实**\n测试。\n**阶段二·逻辑穿透**\n看流向/看用途/业务必要性 Q1 Q2/主体必要性 测试。\n**阶段三·风险控制**\n测试。',
    instanceCode: CODE, category: 'A', createTime: Math.floor(Date.now() / 1000),
    applicant_open_id: '', rules_fired: null
  };
  fs.writeFileSync(path.join(auditDir, TODAY + '.json'), JSON.stringify([rec], null, 2), 'utf8');
  // 2) current_batch：把本 case 标 done
  fs.writeFileSync(path.join(TEST_DIR, 'current_batch.json'), JSON.stringify({
    batchDate: TODAY, startedAt: new Date().toISOString(), expected: [CODE], outcomes: { [CODE]: { status: 'done', at: new Date().toISOString() } }
  }, null, 2), 'utf8');
  // 3) pending_actions：本 case 为 PENDING_REVIEW
  fs.writeFileSync(path.join(TEST_DIR, 'pending_actions.json'), JSON.stringify({
    __meta: { nextN: 2 }, [CODE]: { n: 1, state: 'PENDING_REVIEW', person: '测试申请人', since: new Date().toISOString() }
  }, null, 2), 'utf8');
}

function genCard() {
  const env = { ...process.env, QUAL_PROFILE: 'test', QUAL_AUDIT_DIR: auditDir, QUAL_PENDING_ACTIONS: path.join(TEST_DIR, 'pending_actions.json') };
  const r = spawnSync(process.execPath, [AUDIT, 'gen-card', '1', '', '0'], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 180000, windowsHide: true, cwd: ROOT, env,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const mid = (out.match(/"message_id":"(om_[^"]+)"/) || [])[1] || null;
  const updated = /"updated":\s*true/.test(out) || /card_action":"[^"]*PATCH|已 ?PATCH|原地更新/.test(out);
  return { mid, updated, out };
}

console.log('==== 卡片活消息集成自测 (QUAL_PROFILE=test) ====');
seed();
clearTestKeys();                       // 清掉本批旧 message_id → 让首发走干净 POST（新建）
const a = genCard();
const msg1 = a.mid || currentCardId();  // POST 回传 message_id；兜底从 card_ids 读
if (!msg1) {
  console.log('⚠️  SKIP：首发 gen-card 未产生 message_id（无发卡凭证/网络失败/被空卡闸拦）。非代码失败。');
  console.log(a.out.split('\n').slice(-6).join('\n'));
  process.exit(0);
}
console.log('① 首发（POST）message_id =', msg1, ' updated=', a.updated, '（期望 false=新建）');

const b = genCard();                    // 同批第二次 → 应 PATCH 同一张（PATCH 响应 data:{} 不回传 id，从 card_ids 读）
const msg2 = currentCardId();
console.log('② 二次跑 updated =', b.updated, ' card_ids 里的 message_id =', msg2, '（期望 true=PATCH 且 id 不变）');

const samecard = msg2 && msg2 === msg1;
const patched = b.updated === true;
console.log('\n断言：同一张卡?', samecard ? '✅' : '❌', '  第二次走PATCH?', patched ? '✅' : '❌');
if (samecard && patched) { console.log('🟢 通过：gen-card 同批重跑正确 PATCH 同一张卡（活卡生效，不再新发）'); process.exit(0); }
console.log('🔴 失败：' + (!samecard ? 'message_id 变了=发了新卡' : '第二次没走 PATCH') + ' → existingMsgId 读取/键匹配有问题');
console.log(b.out.split('\n').slice(-6).join('\n'));
process.exit(1);
