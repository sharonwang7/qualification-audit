# CONTRIBUTING — 资质审核 skill 多团队协作规约

> v3.1.1 起（2026-07-29）。目标：**可复用、可分工、不同人跑也稳定高质顺畅**。
> 本文只讲"怎么协作、怎么安全发版"，判断规则本身见 `common/child-judge.md` 和各场景 JSON。

---

## 一、目录所有权（谁改哪、谁 approve）

| 目录/文件 | 归谁改 | 合并要求 |
|-----------|--------|----------|
| `common/`（通用规则/场景/文档/实体库） | 双方共用 | **两个团队都 approve** 才能合并 |
| `scripts/` `lib/` `SKILL.md` `install.md` `.env.example` | 平台/双方 | **双方 approve** |
| `faren/`（法人岗专属场景/规则） | 法人团队 | 法人团队 owner approve |
| `feifaren/`（非法人岗专属场景/规则） | 非法人团队（杜益/余佩琳） | 非法人团队 owner approve |

所有权由 `.github/CODEOWNERS` 强制（配好分支保护后，改到某目录必须对应 owner approve）。

**为什么 `common/` 要双 approve**：它是双方运行时都加载的判断地基，一方误改会同时影响两边。改 `common/` 前在群里同步，PR 双方过目。

---

## 二、角色与数据路径（每个人装完必做）

每人在自己 `.env` 里设两类：

```bash
# 1) 岗位（决定 list 只捞本岗位的待办 + 子代理加载哪些规则）
QUAL_AUDIT_ROLE=faren      # 法人岗：法人/董事/股东类 + cross-type + 其它
QUAL_AUDIT_ROLE=feifaren   # 非法人岗：品牌/商标/授权书类 + 其它
# 不设 = 全量（单人跑/调试用）

# 2) 数据目录（🔴 生产必显式设，否则 P0-2 fail-loud 会停机）
QUAL_AUDIT_DIR=<你的 audit_reports 绝对路径>
QUAL_PENDING_ACTIONS=<你的 pending_actions.json 绝对路径>
```

> **数据路径为什么必须显式设**：不设时代码 fallback 到 `技能包/../`，换机器/换人重装后指向错位置 → 会在错处静默建空库、审核序号从 #1 重开（v3.0 #5 事故）。v3.1.1 起 prod 下"未显式设且 fallback 无历史数据"会直接**报错停机**逼你配。首次运行 `QUAL_AUDIT_ROLE` 未设时，`list` 会返回 `needs_role_setup` 引导设岗位。

---

## 三、发版流程（棘轮：改 → 测 → commit → tag → push）

**任何改动，发 tag 前必须过三道测试闸（全部随包分发在 `scripts/` 和 `golden_tests/`，clone 即可跑，不同人一致）：**

```bash
# 闸 1：真实运行时冒烟（P0-1，2026-07-29）——真起子进程跑核心链路，
#        抓 mock/静态测不到的运行时崩溃（加载顺序/未定义变量/编码/路径/角色分拣）
node scripts/smoke.cjs                     # 必须 🟢 全绿(exit 0)

# 闸 2：结构+守卫+一致性回归（T1-T5，mock/静态，秒级）——
#        T1 fair 守卫链 / T2 gen-card+spawn 模板 / T3 全流程剧本 / T4 目录结构+路径引用 /
#        T5 判据一致性（index↔场景 principal_rules 字面一致，硬闸；schema 异构做可见性报告）
node golden_tests/runner.cjs               # 必须 🟢 全绿(exit 0)

# 闸 3：判断逻辑黄金（GS 例，真判断不回归）
node scripts/run_golden_e2e.cjs <GS...>

# 三闸都绿 → 提交
git add -A && git commit -m "..."
git tag vX.Y.Z
git push origin master --tags     # + push 到 GitHub 远程
```

> **为什么加冒烟闸（闸 1）**：v3.0 迁移时"一致性/对抗/回归审查都做了、评 9.5/10"，但仍出 8 个问题——因为那些审查全是**静态的**（黄金测试是 require-mock、T4 是静态 grep、对抗审查子代理还超时挂了），测不到"在真实安装位置、真起进程时的运行时行为"，而 8 个问题**全是运行时/集成层**。冒烟闸专补这一层。**这是"审查过了还崩"的根治，不可跳。**
>
> **为什么把 golden_tests 迁进包内（闸 2）**：迁移前 T1-T4 只在某个人的 workspace 里，clone 包的人拿不到、跑不了完整闸 → "不同人跑不一致"。2026-07-30 起 `golden_tests/` 随包分发，任何人 clone 后 `node golden_tests/runner.cjs` 都能跑同一套。

**回滚**：每个稳定版打了 `vX.Y.Z-rollback` tag，`git checkout <tag>` 即回退。

---

## 四、common/ 改动的同步

- `checkSkillVersion()` 每次运行会检测远程新 tag，日志显示 `[⚠️ REMOTE(vX.Y.Z)]`，但**不自动 pull**。
- 看到远程有新版 → 手动 `git pull origin master`，再本地 `node scripts/smoke.cjs` 确认绿。
- 改了 `common/` 并合并后，**在群里 @ 另一团队周知**（他们下次 pull 才生效）。

---

## 五、GitHub 侧待办（需人工，非代码）

当前仓库在个人账号 `sharonwang7`、CODEOWNERS 的非法人团队是 `@TODO` 占位——**"双方 approve 改 common/"的分工闸尚未真正生效**。上线前需人工完成：

1. 杜益、余佩琳注册 GitHub 账号；
2. 把 `.github/CODEOWNERS` 里 `@TODO-duyi @TODO-yupeilin` 替换为真实 handle；
3. 仓库迁到 org（或把团队成员加为 collaborator）；
4. 配 `master` 分支保护：require PR + require CODEOWNERS review（这样"改 common 需双 approve"才真正强制，否则 CODEOWNERS 只是摆设）。

---

## 六、已知限制

- **子代理超时（复杂 cross-type 件）**：含多种资质 + 多附件的件，子代理规则加载多、分析链长，可能超 10 分钟被 kill、父代理无返回。
  - **数据不丢**：子代理超时前若 `write-result` 已落盘，该件在 `pending_actions` 已是 `PENDING_REVIEW`，**下一次 `list` 会当"已审待批"直接渲染、不重跑**。
  - **治本待办（先测量后定）**：统计超时件的资质数/附件数/规则加载量 → 对症选：① 复杂件更长 timeout；② faren 也走 `scoped_rules` 只读相关场景（去掉"全量加载"这个主因）；③ 子代理先落 result 再 return 的快照机制。这属 OpenClaw 编排侧，需 runtime 数据支撑，勿盲改。

- **场景 JSON 规则体 schema 异构（可分工技术债，2026-07-30 T5 发现）**：各场景规则体写法不统一——① `criteria` 按规则 ID 键（bank/cooperation）；② `criteria` 按子 ID / 合并键（legal_rep `R05_1/2/3`、litigation `D1/D2` 覆盖 7 条 principal_rules）；③ 无 `criteria`、改用 `key_questions`（new_project/out_of_scope/trademark）。后果：新人无法依赖统一 schema，机械一致性校验只能钉死 `principal_rules`（T5 Check A），规则体只能做可见性报告。
  - **ID 别名**：`B04'`(child-judge) = `B05`(bank.json)、`D1..D6`(child-judge 确定性表) = `D01..D06`(index/litigation)、`S01/S02`(out_of_scope 场景内自定义) 在 child-judge 无同名 token。**内容一致、仅 ID 写法不同**，T5-C 会列出供人工确认，非丢失。
  - **治本待办**：定义统一场景 schema（规则体字段名、键=规则 ID、子规则命名规范）→ 逐场景归一化 → 归一后可把 T5 Check B（principal_rules ⊆ 规则体键）升为硬闸。归一化会改判据文本，**必须每步过闸 3 黄金回归**，勿盲改。

- **`lib/connector-feishu.js` 有机器相关硬编码路径**：node-direct 走 `run.js` 时 `LARK_CLI_JS` 写死本机 `C:\Users\FD\...\@larksuite\cli\scripts\run.js`，换机器/换用户名会指错（有 shim 回退兜底，不致崩）。T4 B2 只查 `D:\` 硬编码、查不到这个 `C:\`。治本=从 `require.resolve` 或 `where lark-cli` 推导，属跨机复用（可复用分层）范畴。
