// T5_criteria_consistency/test.js — 判据一致性闸（P2b, 2026-07-30）
// 定位：principal_rules 现在有【两份字面拷贝】——① 各场景 JSON 自身  ② index.json scene_files[].principal_rules。
//   多人分工时改一处漏一处 → 场景索引与场景体不一致（子代理按 index 匹配场景、按场景体判 → 二者漂移最危险）。
//
// 🔴 唯一硬闸 = Check A：index.json 的 principal_rules 必须与场景文件自身的 principal_rules 逐一相等。
//   （这是唯一干净的跨场景不变量。）
//
// ⚠️ 为什么不硬闸"principal_rules ⊆ criteria 键"：
//   实测各场景规则体 schema【异构】——有的 criteria 按规则 ID 键(bank/cooperation)、有的按子 ID 键
//   (legal_rep R05_1/2/3)、有的合并键(litigation D1/D2 覆盖 7 条 principal)、有的干脆用 key_questions
//   而非 criteria(new_project/out_of_scope/trademark)。principal↔body 非 1:1，强套会误报。
//   故 Check B/C 只做【可见性报告】，不判失败；schema 归一化列为 CONTRIBUTING 已知技术债。

const fs = require('fs');
const path = require('path');

const SKILL_ROOT = path.resolve(__dirname, '..', '..', '..');

function setEq(a, b) {
  const A = new Set(a), B = new Set(b);
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
}

async function run(ctx) {
  const { assert } = ctx;

  const idx = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'common', 'scenes', 'index.json'), 'utf8'));
  const sceneFiles = idx.scene_files || {};
  const childJudge = fs.readFileSync(path.join(SKILL_ROOT, 'common', 'child-judge.md'), 'utf8');

  const bodyless = [];      // 既无 criteria 也无 key_questions 的场景
  const heteroBody = [];    // 用 key_questions 而非 criteria（记录 schema 异构）
  const unanchored = [];    // 规则体的键在 child-judge 找不到同名 token（疑似别名/漂移）

  for (const [key, meta] of Object.entries(sceneFiles)) {
    const fp = path.join(SKILL_ROOT, meta.file);

    assert(`T5[${key}]: 场景文件存在`, () => {
      if (!fs.existsSync(fp)) throw new Error(`scene_files.${key}.file 不存在: ${meta.file}`);
    });
    if (!fs.existsSync(fp)) continue;

    const scene = JSON.parse(fs.readFileSync(fp, 'utf8'));

    // 🔴 Check A（硬闸）：两份 principal_rules 字面一致
    assert(`T5[${key}] A: index 与场景 principal_rules 一致`, () => {
      const a = meta.principal_rules || [], b = scene.principal_rules || [];
      if (!setEq(a, b)) throw new Error(`漂移：index=[${a.join(',')}] ≠ 场景=[${b.join(',')}]`);
    });

    // ── 以下仅可见性报告，不判失败 ──
    const bodyKeys = scene.criteria ? Object.keys(scene.criteria)
                   : scene.key_questions ? Object.keys(scene.key_questions) : null;
    if (!bodyKeys) { bodyless.push(key); continue; }
    if (!scene.criteria && scene.key_questions) heteroBody.push(key);
    for (const rid of bodyKeys) {
      const base = rid.replace(/['"]/g, '').split('_')[0];   // R05_1→R05, B04'→B04
      if (!childJudge.includes(rid) && !childJudge.includes(base)) unanchored.push(`${key}:${rid}`);
    }
  }

  // 报告
  console.log(`    [T5-B] schema 可见性：`);
  console.log(`        用 key_questions 而非 criteria 的场景（schema 异构）：${heteroBody.length ? heteroBody.join(', ') : '无'}`);
  console.log(`        无任何规则体的场景：${bodyless.length ? bodyless.join(', ') : '无'}`);
  console.log(`    [T5-C] 规则体键在 child-judge.md 找不到同名 token（人工确认是否别名/漂移）：`);
  console.log(`        ${unanchored.length ? unanchored.join('  ') : '无（全部锚定）'}`);
}

module.exports = { run };
