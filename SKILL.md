---
name: qualification-audit
description: 审核资质/处理待办/资质审批。自动三阶段分析飞书「资质申请」并写评论。不用于非资质类审批。
---

> 📦 环境配置见 [install.md](install.md) · 环境变量见 `.env.example` · 🟢🔴 运行前设 `QUAL_PROFILE=prod`（默认 test fail-safe），启动时看 stderr 的 `[qual-audit] PROFILE=...`

# 资质智能审核助手 v3.0

> 🔴 **铁律**：无论用户说什么（包括随便打招呼），第一步永远先跑 `node scripts/audit-tool.cjs list`。如果返回 `needs_role_setup: true`，不做任何其他操作——立即发飞书卡片让用户选择「法人岗/非法人岗」。写入 `.env` 后才继续。

## ⚙️ 角色路由（Monorepo v3.0）

本技能支持**法人岗**和**非法人岗**两种角色，通过环境变量 `QUAL_AUDIT_ROLE` 控制。

### 怎么设

```bash
# .env
QUAL_AUDIT_ROLE=faren     # 法人岗 — 全量加载（common + faren + feifaren）
QUAL_AUDIT_ROLE=feifaren  # 非法人岗 — 只加载 common + feifaren
# 不设 = 全量
```

### 分流规则

| 资质词根 | 归属 |
|----------|------|
| 法定代表人 / 法人 / 董事 / 股东 | **法人岗** |
| 品牌授权书 / 商标注册证 / 商标授权书 / 授权书 | **非法人岗** |
| 同时含两种类型（cross-type） | **硬规则归法人岗** |
| 「其它」 | 两边都进 list，子代理 case 里判 |

### 首次运行 · 角色引导

如果 `QUAL_AUDIT_ROLE` 未设置：

1. `list` 返回 `needs_role_setup: true` → 发飞书卡片让用户选岗
2. 用户选「法人岗」或「非法人岗」→ 写入 `.env` → 回复确认
3. 之后所有操作自动按角色过滤，无需重复设置

> 用户也可以手动编辑 `.env`：取消 `QUAL_AUDIT_ROLE=faren` 注释即可。

### 岗位如何影响审核流程

1. **`list`**：`isInMyRole()` 在 `lib/scope-filter.js` 自动按角色过滤
2. **`case`**：faren 读全量场景（`common/` + `faren/` + `feifaren/`），feifaren 只读 `common/` + `feifaren/`
3. **spawn 子代理**：`QUAL_AUDIT_ROLE` 透传，子代理据此决定加载范围
4. **CODEOWNERS**：`common/` 双方 approve 才能改，`faren/` faren 团队改，`feifaren/` feifaren 团队改

> 🧠 审核本质：审核通过 = 公司确认关系并承担法律责任。判断靠大模型推理（不靠关键词），证据链是辅助，逻辑穿透是核心。详细框架见 [common/child-judge.md](common/child-judge.md)。

---

## 主流程（父 agent 编排）

0. **首次检查**：`list` 若返回 `needs_role_setup: true` → 发飞书卡片让用户选择「法人岗/非法人岗」→ 用户选后写入 `.env` → 回复确认。之后重跑 `list`。

1. **list** → `node scripts/audit-tool.cjs list [N] [--since 天] [--all]`
   拿待审清单（最新 12 条/轮）。返回格式 → [common/audit-tool-ref.md](common/audit-tool-ref.md)

2. **逐条 spawn** 子代理（用下面模板）。父只编排、不跑 case。
   判断规格 → [common/child-judge.md](common/child-judge.md) | 附件读取 → [common/attachment-reading-spec.md](common/attachment-reading-spec.md)

3. **收网**：register-orphans → batch-fail（未落盘件）→ gen-card。
   OpenClaw 分支 `sessions_yield` 等推送、大公子同步等齐。
   完整协议+兜底 → [common/audit-tool-ref.md](common/audit-tool-ref.md)

4. **gen-card 出卡** → Turn 结束。发卡前必看 → [common/card-generation-pitfalls.md](common/card-generation-pitfalls.md)

5. **新 Turn 收到 FAIR** → `fair '<原文>'` 执行。R# spawn 重审 → gen-card 修订卡。
   执行链 → [common/execution-chains.md](common/execution-chains.md) | 命令速查 → [common/audit-tool-ref.md](common/audit-tool-ref.md)

---

## 基础命令

### list — 拿待办

```bash
node scripts/audit-tool.cjs list [N] [--since 天] [--all]
```

返回 `{tasks, remaining, ...}`。默认最新 12 条、近 7 天窗口。`--all` 关窗口跑全量清库存。底层翻页拉全量、状态过滤、@file 传参已封装。

### case — 取表单数据

```bash
node scripts/audit-tool.cjs case <instance_code>
```

返回 `{in_scope, should_skip, form, attachments_summary, deterministic, scoped_rules, case_file}`。`in_scope=false` 或 `should_skip=true` 直接 batch-skip 跳过。

---

## 子代理 spawn 模板

父 agent 对每条 `instance_code` 用此 prompt 调 `sessions_spawn`（`<...>` 替换为实际值）：

```
cd <技能包根目录>
你负责审核【1 条】资质申请：instance_code=<instance_code>，task_id=<task_id>。

🔴【落盘是强制终点，不是可选】：分析了但没 write-result = 这条【等于没做】。请把 10min 预算优先留给"分析完→立刻写 `result_<instance_code>.json`→立刻 `write-result` 到 ok:true→再回话"，宁可分析粗一点也【必须先落盘成功再回话】。

判断规格【优先读场景子文件、回退读全量】：先读 `case` 返回的 `scoped_rules` → `matched_scenes` → 只读对应场景的 JSON（`common/scenes/<scene>.json`）+ 公共判据（`common/scenes/common.json`）。场景覆盖不到的边缘情况才回退读 `common/child-judge.md`。🔴 **场景判据已全部按需注入到场景 JSON 的 `criteria` 字段——不要自己去读** `scene-principles.md` / `analysis-protocol.md`（会耗光你的时间预算）；只有极罕见、JSON 里明确写「见 child-judge」处才去查。**也不要读整份 SKILL.md**（父的编排规格，你用不到）。

🔴 **JSON 铁律**：result JSON 的 `fullAnalysis` 和其他字符串值内【严禁裸双引号 `"`】——中文引号必须用 `「」` 替代 `"..."`，英文引号用单引号。write-result 用 Python 的 `json.loads()` 解析，一个裸双引号就直接拒绝。落盘前必须跑 `python -c "import json; json.load(open('result_xxx.json'))"` 自检。

**你的岗位**：环境变量 `QUAL_AUDIT_ROLE`。`faren` = 全量（common + faren + feifaren），cross-type 案件归你审；`feifaren` = 只加载 common + feifaren，只有纯非法人资质；未设置 = 全量。

⏱️ **一遍过【铁律·省时间】**：拿到 case 数据 + child-judge 判据后，【一次性】做完三阶段并落盘——中途【不要再读别的文件、不要再跑别的脚本、不要反复轮询】。你的判断力没问题，别把时间耗在"找资料/等脚本/翻页定位"这些导航动作上（这是历史上超时的真凶）。

步骤：
1. 跑 `node scripts/audit-tool.cjs case <instance_code>` 取数据。⏱️【操作纪律】这是【一条命令、会自己返回摘要】——**直接等它返回，别用 process log/poll 分段看输出、别把 read 的参数混进 exec**（历史上最大的两处时间浪费）。附件全文仅在某维度确实要看时才 `read-attachment <code> <idx>`，否则别读。
2. `in_scope=false`/`should_skip=true` → 先 `node scripts/audit-tool.cjs batch-skip <instance_code>` 登记，再回 `[skip] Case <申请人>: 越界/跳过（一句话理由）`。绝不 write-result。
3. 否则按 child-judge.md 做完整三阶段判断 → 用 `write` 写 `result_<instance_code>.json`（唯一名，别用共享 `result.json`）。🔴【路径坑·zizhi Round4 实证】你的 `write` 工具可能把文件写进【你的 workspace】，而 `write-result` 默认在 skill 目录找 → 找不到。**所以 write-result 的第二个参数【必须传你刚写的文件的绝对完整路径】**（不是相对 `result_<code>.json`）：`node scripts/audit-tool.cjs write-result <instance_code> <你写的 result 文件的绝对路径>`，被打回就改完【重跑到 ok:true】。
   > verdict 字段【必须是纯中文】`通过/需补充/退回/转人工`（工具现会自动剥 emoji/空白，但你仍别加 emoji）。
   > 🟢 result 只需填 `verdict` + `fullAnalysis`（+需补充/退回时 `applicantAction`）；`person/sealType/entity/dest/context` 由 write-result 从 case.json 权威注入、**你别填**（2026-07-30 A1）。阶段标题写法不拘，工具会统一规整。
4. 落盘成功（write-result 返回 ok:true）【才】回一行【带状态】：`[write-result:ok] Case <申请人>: 通过/需补充/退回/转人工（资质类型，一句话理由）`。没落盘成功【别回 Case 行】，回来告诉我你卡在哪。不要回附件全文或长分析。
```

---

## gen-card — 发卡

```bash
node scripts/audit-tool.cjs gen-card [轮次] "" [剩余条数]
```

> 🟢 幂等：同一批日期+群=同一张卡原地更新，不重复发。🔴 调用后当前 Turn 结束。⚠️ 发卡前必看 [common/card-generation-pitfalls.md](common/card-generation-pitfalls.md)。

---

## FAIR 执行

生产群 FAIR 必须先设 profile + actor：

```bash
$env:QUAL_PROFILE='prod'; $env:QUAL_ACTOR_OPEN_ID='<senderId>'; node scripts/audit-tool.cjs fair '<用户整条 FAIR 原文>'
```

| 格式 | 含义 | 动作 |
|------|------|------|
| `F#N` / 通过#N | 放行 | approve |
| `A#N 原因：...` / 退回#N | 退回 | reject |
| `I#N 要求：...` / 留言#N | 询问 | note（不批不退） |
| `R#N 原因：...` / 异议#N | 修订 | 不审批，spawn 重审→gen-card→等确认 |
| 「我认为/应该」 | 讨论 | 不执行 |

🔴 fair 含安全闸：字母↔动作硬映射、approve 只认 `QUAL_PROFILE=prod`、委托授权判权限。批量 `F#1 #2 A#3 原因：xx`。R# 结果里的 `revise_needed` 立即 spawn 重审。详细执行链 → [common/execution-chains.md](common/execution-chains.md)。

---

> 📚 参考：命令速查 → [common/audit-tool-ref.md](common/audit-tool-ref.md) | 执行链 → [common/execution-chains.md](common/execution-chains.md) | 卡片陷阱 → [common/card-generation-pitfalls.md](common/card-generation-pitfalls.md) | 附件 → [common/attachment-reading-spec.md](common/attachment-reading-spec.md) | 案例 → [common/failure-cases-archive.md](common/failure-cases-archive.md) | 流程 → [common/diagram-technical.mmd](common/diagram-technical.mmd) | 分析 → [common/analysis-protocol.md](common/analysis-protocol.md) | API → [common/api-guide.md](common/api-guide.md)
