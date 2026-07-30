// T4_structure_check/test.js — 结构一致性测试（monorepo v3.0+）
// 定位：测黄金测试自家的盲区——目录、路径引用、交叉引用、变量对齐、SKILL.md 内容

const fs = require('fs');
const path = require('path');

// 包内位置：golden_tests/tests/T4_structure_check/ → 上 3 级即 skill 根
// （迁进包内前此处爬 4 级 + skills/qualification-audit，假设 golden_tests 在 workspace 下；
//   随包分发后 golden_tests 是 skill 根的直接子目录，统一为上 3 级。）
const SKILL_ROOT = path.resolve(__dirname, '..', '..', '..');

// 递归读目录下所有匹配文件
function glob(dir, pattern, exclude) {
  const re = new RegExp(pattern);
  const excludeRe = exclude ? new RegExp(exclude) : null;
  const out = [];
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') walk(p);
      else if (e.isFile() && re.test(e.name) && !(excludeRe && excludeRe.test(p))) out.push(p);
    }
  }
  walk(dir);
  return out;
}

async function run(ctx) {
  const { assert } = ctx;

  // ─── A: 目录结构 ───
  assert('A1: references/ 不应存在', () => {
    if (fs.existsSync(path.join(SKILL_ROOT, 'references')))
      throw new Error('references/ 目录仍然存在');
  });
  assert('A2: common/ 必须存在', () => {
    if (!fs.existsSync(path.join(SKILL_ROOT, 'common')))
      throw new Error('common/ 目录缺失');
  });
  assert('A3: faren/scenes/legal_rep.json 必须存在', () => {
    if (!fs.existsSync(path.join(SKILL_ROOT, 'faren', 'scenes', 'legal_rep.json')))
      throw new Error('legal_rep.json 缺失');
  });
  assert('A4: feifaren/scenes/trademark.json 必须存在', () => {
    if (!fs.existsSync(path.join(SKILL_ROOT, 'feifaren', 'scenes', 'trademark.json')))
      throw new Error('trademark.json 缺失');
  });

  const scenes = ['bank','common','cooperation','litigation','new_project','out_of_scope','platform','index'];
  for (const s of scenes) {
    assert(`A5: common/scenes/${s}.json`, () => {
      if (!fs.existsSync(path.join(SKILL_ROOT, 'common', 'scenes', s + '.json')))
        throw new Error(`common/scenes/${s}.json 缺失`);
    });
  }

  // ─── B: 路径引用残留 ───
  const jsFiles = glob(SKILL_ROOT, '\\.(cjs|js|mjs)$', 'node_modules|\\.bak\\.|golden_tests');
  for (const f of jsFiles) {
    const content = fs.readFileSync(f, 'utf8');
    const rel = path.relative(SKILL_ROOT, f);
    assert(`B1: ${rel} 不含 references/`, () => {
      if (content.includes('references/')) throw new Error(`${rel} 含 references/ 残留`);
    });
  }

  const libScripts = glob(path.join(SKILL_ROOT, 'lib'), '\\.(cjs|js)$');
  const scriptsFiles = glob(path.join(SKILL_ROOT, 'scripts'), '\\.(cjs|js)$', 'backfill-rules-snapshot|golden_tests');
  for (const f of libScripts.concat(scriptsFiles)) {
    const content = fs.readFileSync(f, 'utf8');
    const rel = path.relative(SKILL_ROOT, f);
    assert(`B2: ${rel} 不含 D:\\ 硬编码`, () => {
      // 允许 D:\\ 出现在注释和字符串 "down" 等，只检测 `'D:\\` 或 `"D:\\` 的路径硬编码
      if (/['"]D:\\[a-z]/i.test(content)) throw new Error(`${rel} 含 D:\\ 硬编码路径`);
    });
  }

  // ─── C: 交叉引用 ───
  const skillMd = fs.readFileSync(path.join(SKILL_ROOT, 'SKILL.md'), 'utf8');
  const linkRe = /\[[^\]]+\]\(([^)]+\.(?:md|mmd|json))\)/g;
  let m;
  while ((m = linkRe.exec(skillMd)) !== null) {
    const p = path.join(SKILL_ROOT, m[1].replace(/^\.\//, ''));
    assert(`C1: SKILL.md 引用 ${m[1]} 存在`, () => {
      if (!fs.existsSync(p)) throw new Error(`SKILL.md 引用文件不存在: ${m[1]}`);
    });
  }

  // index.json scene_files 路径存在性
  const idxPath = path.join(SKILL_ROOT, 'common', 'scenes', 'index.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  for (const [key, sf] of Object.entries(idx.scene_files || {})) {
    const fp = path.join(SKILL_ROOT, sf.file);
    assert(`C2: index.json → ${key} → ${sf.file} 存在`, () => {
      if (!fs.existsSync(fp)) throw new Error(`scene_files.${key}.file 指向不存在的: ${sf.file}`);
    });
  }

  // ─── D: 变量对齐 ───
  let envContent = '';
  try { envContent = fs.readFileSync(path.join(SKILL_ROOT, '.env.example'), 'utf8'); } catch (e) {}
  const envVars = [...envContent.matchAll(/^(\w+)\s*=/gm)].map(m => m[1]);

  const allCode = [...libScripts, ...scriptsFiles].map(f => fs.readFileSync(f, 'utf8')).join('\n');
  for (const v of envVars) {
    assert(`D1: .env.example 变量 ${v} 在代码中使用`, () => {
      if (!allCode.includes(`process.env.${v}`)) throw new Error(`${v} 在 .env.example 定义但代码未引用`);
    });
  }

  // ─── E: SKILL.md 内容 ───
  const skillLines = skillMd.split('\n');
  assert('E1: SKILL.md 版本 v3.0', () => {
    if (!skillMd.includes('# 资质智能审核助手 v3.0')) throw new Error('版本号不是 v3.0');
  });
  assert('E2: SKILL.md 含角色路由', () => {
    if (!skillMd.includes('QUAL_AUDIT_ROLE')) throw new Error('缺少 QUAL_AUDIT_ROLE 角色路由说明');
  });
  assert('E3: SKILL.md 含 spawn 岗位说明', () => {
    if (!skillMd.includes('你的岗位')) throw new Error('spawn 模板缺少"你的岗位"角色说明');
  });
  assert('E4: SKILL.md 行数 ≤ 160', () => {
    if (skillLines.length > 160) throw new Error(`SKILL.md 行数=${skillLines.length}，应 ≤160`);
  });
}

module.exports = { run };
