# 卡片生成 · 排序 · 隔离 陷阱（gen_card_from_json.ps1）

> 本文汇总资质卡片生成/排序/发送的**可复用踩坑**。任何驱动方（OpenClaw agent-2、大公子桥、手工）发多条卡片都会遇到，务必遵守。2026-07-01 集中修复。

## 1. 🔴 PS5.1 `@(管道 | ConvertFrom-Json)` 把多元素数组折叠成 1 条

**症状**：飞书卡片里多条 case **全挤在一个块里**——`#1 2 3` 拼一起、多个姓名/资质用空格连在一行、多段三阶段分析首尾相接、审批链接把多个 instanceId 拼一起。**单条时正常**（迷惑性极强）。

**根因**：PS5.1 里 `ConvertFrom-Json` 把 JSON 数组作为**一个**管道对象输出；`@(pipeline)` 把这一整个数组包成"1 个元素" → `.Count=1`，N 条被折叠成一条，各字段变成 N 值的数组。单条时 ConvertFrom-Json 返单对象、`@()` 正好包成 1，所以侥幸正常。

**正确写法**（先落变量再包裹）：
```powershell
# ❌ 错：$all = @([IO.File]::ReadAllText($p) | ConvertFrom-Json)   → 多条折叠成 1
$parsed = [System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8) | ConvertFrom-Json
$all = @($parsed)   # 对【已赋值变量】@() 才正确展开成 N 条（1 条也正确成数组）
```

**通用教训**：**多条渲染异常时，第一步读真实卡片 JSON（`C:\claude\_card_from_json.json`），别凭用户描述猜。** 2026-07-01 因为凭描述猜，连续误诊为"太长""顺序乱"两轮才发现真凶是这个折叠。

## 2. 并行落盘竞态 → `#N` 乱序 → 发卡前按等待时间重排

**根因**：`write-result` 的 `n` 在落盘那一刻从全局计数器分配；父 agent **并行** spawn 子代理（OpenClaw `maxConcurrentRuns` / workflow parallel），谁先写完谁先拿号 → `#N` 按"完成竞态"排，非提交时间、非 list 顺序，且每轮都变。

**修法**：`audit-tool.cjs cmdGenCard` 在发卡前调 `renumberReportByWaitTime`——按 `createTime` 升序（**等待最久=#1**）重排 `n`，保留原 n 值集合仅重新分配（零撞号），**加锁同步写报告 + pending_actions**（保证 `#N` 与 FAIR 的 `lookup-case-by-n` 一致）。gen_card 按 n 扁平渲染，不按 verdict 分组。

## 3. gen_card 必须认隔离环境变量（否则测试会污染生产 / 读不到隔离报告）

`gen_card_from_json.ps1` 历史上硬编码了生产路径，隔离测试时读不到 `_test` 报告、还会发到生产群。已修为：
- 报告路径认 `QUAL_AUDIT_DIR`（默认 `D:\agent-hub\audit_reports`）。
- pending_actions 认 `QUAL_PENDING_ACTIONS`。
- 目标群认 `LARK_AUDIT_CHAT_ID`（取不到才回落硬编码群——**别依赖回落**）。
- 发卡 bot = `config.json` 的 `claude_bot`（即桥 bot `cli_aaa274…`），**不是**审核 app `cli_9cb844…`；要发某群，该 bot 必须先在群里，否则 `230002 Bot/User can NOT be out of the chat`。

## 4. 临时文件走 scratchpad，绝不写技能包目录

落盘用的 result.json 等临时件写会话 scratchpad（`...\Temp\claude\...\scratchpad\`）+ 传绝对路径给 `write-result`；**绝不写技能包根目录**——那是符号链接指向 OpenClaw live 包，会污染生产、可能被误加载。

## 5. 🔴 `**加粗标题**` 被 run-on 拆行正则切断 → `**` 字面漏出、不加粗（2026-07-16）

**症状**：卡片里 `**阶段一·证据链核实**`、`**阶段二·逻辑穿透**` 等粗体小节标题**不加粗**，且 `**` 以**字面文本**出现在独立一行。源报告 JSON 的 `fullAnalysis` 明明是规整单行 `**阶段一·…**：…`（源头无辜，别怀疑模型产出）。

**根因**：`toFeishuMd` 里"拆 run-on 粘连小节标记"的正则用了过宽的 lookbehind `(?<=\S)`——只要"阶段X / ①-⑤"前一字符是**任意非空白**就插换行。标题被 `**` 包裹时，"阶段一"前一字符正是 `*` → 在 `**` 与 `阶段一` 之间插换行 → `**…**` 行内配对断裂 → 飞书把 `**` 当字面输出。同函数的 `#` 标题拆行早已用 `(?<=[^\s#])` 排除 `#` 防孤 `#`，唯独"阶段""①②"两条漏排除 `*`。潜伏于 07-06「保留源换行结构」改造，子代理近期统一改用 `**粗体标题**` 后触发（潜伏＋触发叠加）。

**修法**：lookbehind 排除 markdown 语法符 `*`：
```powershell
# ❌ $s = [regex]::Replace($s, '(?<=\S)(阶段[一二三四])', "`n`$1")
$s = [regex]::Replace($s, '(?<=[^\s*])(阶段[一二三四])', "`n`$1")
$s = [regex]::Replace($s, '(?<=[^\s*])([①②③④⑤])', "`n`$1")
```
`**阶段一` 前是 `*` → 不拆（加粗完整）；真 run-on `内容阶段二` 前是汉字 → 仍拆。已干跑验证。

**通用教训**：对模型产出做正则后处理时，`\S`/"非空白"边界会**误吃 markdown 语法符**（`*` `_` `~` 等）；凡在语法符与其作用文字之间插换行，都会打断行内格式配对。新增任何拆行/分段正则，先把语法符排除出 lookbehind/lookahead。
