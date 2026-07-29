---
name: qualification-audit
description: 审核资质/处理待办/资质审批。自动三阶段分析飞书「资质申请」并写评论。不用于非资质类审批。
---

> ⚠️ **运行环境**：当前路径约定针对 Windows（`D:\`、`C:\`）；Linux/Mac 需适配 `QUAL_ATTACH_DIR`、`QUAL_SOFFICE_BIN`、`QUAL_CARD_SCRIPT` 等路径类环境变量。

> 📦 **首次使用？** 请先阅读 [install.md](install.md) 完成环境配置。

> **环境依赖**：PyMuPDF ✅ | python-docx ✅ | ocr-paddle(PP-OCRv5 经典管线，独立 skill 包) ✅ | LibreOffice ✅（可选；未装则 .doc/非标DOCX 标 failed → 转人工）
> 附件读取全部由 `audit-tool.cjs`(data-prep) 完成，分诊策略/status 语义/OCR 降级等详细规范：读取并遵循 [references/attachment-reading-spec.md](references/attachment-reading-spec.md)；判断侧"读不出字≠没问题"的处理铁律见 [references/child-judge.md](references/child-judge.md) 附件铁律节。

# 资质智能审核助手 v2.1

**适用审批**：资质申请（definition_code: `0E0BBB7F-A4C8-471F-8051-3E4E88A83856`）

| 配置项 | 环境变量 | 默认值 |
|--------|---------|--------|
| 飞书 appId | `FEISHU_APP_ID` | `cli_9cb844403dbb9108` |
| 审批定义码 | `QUAL_DEFINITION_CODE` | `0E0BBB7F-A4C8-471F-8051-3E4E88A83856` |
| 执行用户 open_id | `FEISHU_USER_OPEN_ID` | 大公子桥：`ou_102cae80079463e6c8281777fec96f47`；OpenClaw：`ou_dc58e9efc5ed5cf4c73d48249d7f8e70`（按实际运行身份设定） |
| 附件/OCR缓存目录 | `QUAL_ATTACH_DIR` | `D:\fando-ocr-cache` |
| ocr-paddle CLI | `QUAL_OCR_CLI` | 按 `__dirname` 自动解析到 `../ocr-paddle/scripts/ocr.cjs` |
| LibreOffice 路径 | `QUAL_SOFFICE_BIN` | `D:\软件\program\soffice.exe`（.doc/非标DOCX 转换用，可选） |
| LibreOffice 用户配置 | `QUAL_LO_PROFILE` | `file:///C:/temp/fando_lo_profile` |
| 卡片生成脚本 | `QUAL_CARD_SCRIPT` | （必填，无默认；示例：`D:\agent-hub\scripts\gen_card_from_json.ps1`） |

## 全局原则（进来先读，全程适用）

**1. 判断由大模型做，不是关键词规则。** 工具 `scripts/audit-tool.cjs` 只给数据、跑确定性红线兜底；"看流向 / 用途 / 背景、要素提取、业务合理性"这些判断由 agent 按 [`references/child-judge.md`](references/child-judge.md) 推理。批量定时跑与人工交互审核**用同一套规格，禁止简化版**（见附录A）。skill 本身不调模型，用哪个大模型由 OpenClaw 决定。

**2. 🔴 观点 ≠ 指令 · gen-card = Turn 结束。**
> - 「我认为 / 感觉 / 应该退回 / 这个有问题」等**意见、观点表达，不触发任何执行动作**。只有明确的 **FAIR 快捷指令**（`F#N` / `A#N 原因：...` / `I#N 要求：...` / `R#N 原因：...`）或其中文等价词（通过/退回/留言/异议）+ 编号，才触发执行；无编号 → 询问确认后再执行。
> - **gen-card 是 Phase 1 最后一步**：调用后**当前 Turn 必须结束**，本 Turn 内不得再调用 `approve` / `reject` / `note`；等用户回复 FAIR 指令，新 Turn 再执行。

**3. 审核本质（核心术语）。**
- **资质 = 申请材料**。资质本身不是风险，**通过资质这个行为**才是风险来源。
- **审核通过资质 = 公司对外确认关系并承担法律责任的行为**。
- **审核本质 = 判断"公司该不该为这件事承担责任"**，不是判断"材料对不对"。
- 证据链核实（材料真伪）只是辅助判断，**逻辑穿透（业务合理性 + 责任判断）才是核心**。
- **分析一致性**：同一审批实例的所有评论必须使用**同一套完整三阶段分析逻辑**，绝对禁止用简化版/快速规则替代。

**4. 分工。** 判断规格 = [`references/child-judge.md`](references/child-judge.md)（子代理 + R 修订 + 大公子 inline 都读它）；本 SKILL.md 的**步骤 = 父 agent 的编排与 FAIR 执行规格**（子代理用不到）。

---

## 运行环境 Profile（prod / test）

> 🟢🔴 **所有 `audit-tool.cjs` 命令受 `QUAL_PROFILE` 控制，默认 `test`（fail-safe，忘设不会误伤生产）**（设计见 D:\agent-hub\projects\P01-资质审核\Profile隔离设计-20260702.md）。
> - **生产运行必须显式 `QUAL_PROFILE=prod`**（大公子桥=生产）：发卡→生产群 `oc_231f`（2026-07-12 起替代旧群 oc_b3f3cf）、状态→生产台账、`approve/reject/note` 放行、身份=桥 `ou_102cae`。**忘设则默认 test** → 卡发测试群、approve 被硬锁拦（生产会"看起来没反应"）。
> - **测试用 `QUAL_PROFILE=test`**（OpenClaw=测试）：自动隔离到 `_test` 台账 + 测试群 `oc_e819` + **物理禁止真实审批**（碰不到生产、打不了真飞书）。
> - 工具每次运行把当前 profile 打到 stderr：`[qual-audit] PROFILE=... chat=... allowApprove=...`——**动手前先看这行确认没跑错环境**。

---

## 主流程（父 agent 编排循环）

本 skill 由 **OpenClaw 资质审核助手(agent) 自己驱动**：判断由 agent 大模型完成，机械活 / 确定性硬规则由工具 `scripts/audit-tool.cjs` 完成（详见「全局原则」第 1 条）。

> **工作目录**：下列 `node scripts/...` 用相对路径，执行前先 `cd` 到本技能包根目录（定时任务里由「工作目录」字段设定）。

> 🔴 **前提**：本 cron job 必须 `sessionTarget="isolated"` + `payload.kind="agentTurn"`，否则无法 `sessions_spawn` 子代理（main session 只能注入 systemEvent，spawn 不了）。

> 🧠 **核心架构：1 实例 = 1 子代理**。父 agent **只编排**（拿清单 → 逐条 spawn → 收一句话 → 发卡），**绝不亲自跑 `case`/读附件/做三阶段**；每条在各自独立子代理上下文展开，父 agent 上下文恒小。（原由见 references/CHANGELOG.md）

**cron 唤醒父 agent 后，按此编排循环：**

1. 跑 `node scripts/audit-tool.cjs list` 拿待审工作清单（含 instance_code、task_id、申请人、资质、事由摘要）。工具已【翻页拉全量待办】→ 状态过滤（PENDING_REVIEW/CLOSED 跳过）→ 在途优先、最新在前 → 默认只返回最新 **12 条/轮**（节流）。记下返回里的 `remaining`（本轮没返回、留待下轮的条数）；**未返回的不会丢**（无 pa 条目，下轮 list 自动重现）。

2. **逐条 `sessions_spawn` 子代理审核**：对清单里每个 `instance_code`，父 agent 用下方【子代理 spawn prompt 模板】spawn 一个子代理。模板已**自包含**（case→判断→落盘→回话），判断规格指向 `references/child-judge.md`（子代理专读的紧凑规格）。父 agent **只编排——绝不亲自跑 case/读附件/做三阶段**。
   > 子代理的落盘铁律、分类/场景/三阶段/附件规则，全在【模板 + child-judge.md】里，父不必重复也不该内联。
   > 并发由 OpenClaw `maxConcurrentRuns`（默认 8）自动管；父照清单顺序 spawn 即可，无需自己控并发。
   > 容错：子代理超时/失败没 write-result（也没 batch-skip）→ 父收网时 register-orphans 找回"写了没注册"的、其余 batch-fail；没落盘的下轮 list 自动重新捞回，**不丢、不重**。
   > case 工具对**账号实名件**自动 live-query 两项硬闸写进 `deterministic.issues`（实名人职级 R13、实名手机号是否公司名录号 R14，均 fail-open）。

3. **收网（按运行时分叉——判断规格与工具层状态机共享，只有"父 agent 怎么等子代理"不同）**：
   - 🟦 **OpenClaw 运行时（zizhi，异步 spawn）· 收网纪律（不可违背，逐条照做）**：
     spawn 完本轮全部子代理后 →
     **(B) 先挂一次性兜底 cron**（防"完成事件丢失致父永不被唤醒"的极端卡死）：跑 `node scripts/audit-tool.cjs safety-net-spec <remaining>` → 把返回的 `cron_add` **原样**交给你的 `cron action=add`（一次性、round+31min 触发一个 isolated agentTurn 跑 gen-card；正常收网了它幂等 PATCH 无害，卡住了它触发 30min 自愈出「未审结」卡）。
     **再调 `sessions_yield`** 结束本轮、等系统推送完成事件（`sessions_spawn` 异步、完成推送式；**禁止 poll 轮询** `await-batch`/`subagents list`）。
     🔴 **每次被完成事件唤醒，无条件按此三步走——绝不允许自己判断"还没齐、再等等"就 `NO_REPLY`/结束 Turn（这正是 2026-07-09 首轮卡死 17min 的直接原因）**：
       ① **先自动找回，再失败登记**：先跑 `node scripts/audit-tool.cjs register-orphans`（自动把"写了 `result_<code>.json` 却漏跑 write-result"的孤儿件补注册为 done——弱模型极常漏这步或校验打回后没重跑）；之后对【仍没落盘】的子代理（真失败/中止/超时，既没 write-result 也没 batch-skip）跑 `node scripts/audit-tool.cjs batch-fail <该 instance_code>` 登记 failed（否则账本永远等它 → 卡死）；
       ② **无条件跑 `node scripts/audit-tool.cjs gen-card 1 "" <remaining>`**（别自己判断该不该发，交给硬闸）；
       ③ 据返回决定：`ready:false`（还有没回的）→ **再 `sessions_yield` 继续等**；`ok:true`（全 settled 或过 30min 超时自愈）→ 出卡、**本 Turn 结束**。
     > 🧠 账本靠【事件】闭合：每个子代理无论成/败都产生完成事件，父每次唤醒登记（write-result=done / batch-skip=skip / batch-fail=failed），**末个事件到达即全 settled → gen-card 出卡**（失败/超时件列「⚠️未审结·待人工」）。**极端兜底**：万一完成事件丢失、父再不被唤醒 → 上面 (B) 那个一次性兜底 cron 在 round+31min 兜调一次 gen-card 触发 30min 自愈出卡，绝不永久无输出。
   - 🟩 **大公子桥（同步）**：没有 sessions_spawn/sessions_yield；inline 或用 Agent 工具**同步审完本轮每条**（每条 write-result；跳过的 batch-skip / 越界 scope-dismiss 都要登记）→ 直接跑步骤 4 的 `gen-card`。
   > 🧠 **原理**：子代理各自异步写盘 `write-result`/`batch-skip`，真相全在磁盘账本 `current_batch.json`（expected/outcomes）；父每次唤醒只读盘判定，天然抗多次 yield 的上下文丢失。gen-card 的状态机硬闸兜住 #2「空卡」，sessions_yield/同步等齐兜住 #1「断了」。
4. 父 agent 跑 `node scripts/audit-tool.cjs gen-card 1 "" <remaining>`（第 3 参 = 步骤 1 的 `remaining`，卡片显示"另有 M 条待下轮"）。**gen-card 内置状态机硬闸**：本批未全 settled(done/skip/failed/timeout) → 返回 `ok:false`+`pending` 列表（**OpenClaw 分支此时应再 `sessions_yield` 等推送**，别当失败）；全 settled 或过 **30min 总超时** → 出卡。返回含 `timed_out` 非空 = 有子代理超时未审结（**卡上已显式列「⚠️未审结·待人工」区**，台账保留下轮自动重审，绝不静默漏审、绝不给假 verdict）。应急强发 `QUAL_FORCE_CARD=1`。→ **当前 Turn 结束（INTERRUPT）**，不得再执行 approve/reject/note。
   > await-batch 命令已降级为**手动/调试用**（阻塞轮询违反运行时"禁止 poll"，正式编排不用它）。
5. 用户回复 FAIR 指令（`F#N` / `A#N 原因：...` / `I#N 要求：...` / `R#N 原因：...`）→ 新 Turn 按**步骤 5-2** 执行。A 路径退回后等申请人重提新审批，新审批走完整流程（回到步骤 1）。

## 子代理 spawn 模板

父 agent 对每条 `instance_code` 用此 prompt 调 `sessions_spawn`（`<...>` 替换为实际值，`<技能包根目录>` = 本 skill 所在目录）：

```
cd <技能包根目录>
你负责审核【1 条】资质申请：instance_code=<instance_code>，task_id=<task_id>。

🔴【落盘是强制终点，不是可选】：分析了但没 write-result = 这条【等于没做】。请把 10min 预算优先留给"分析完→立刻写 `result_<instance_code>.json`→立刻 `write-result` 到 ok:true→再回话"，宁可分析粗一点也【必须先落盘成功再回话】。

判断规格【优先读场景子文件、回退读全量】：先读 `case` 返回的 `scoped_rules` → `matched_scenes` → 只读对应场景的 JSON（`references/scenes/<scene>.json`）+ 公共判据（`references/scenes/common.json`）。场景覆盖不到的边缘情况才回退读 `references/child-judge.md`。🔴 **场景判据已全部按需注入到场景 JSON 的 `criteria` 字段——不要自己去读** `scene-principles.md` / `analysis-protocol.md`（会耗光你的时间预算）；只有极罕见、JSON 里明确写「见 child-judge」处才去查。**也不要读整份 SKILL.md**（父的编排规格，你用不到）。

⏱️ **一遍过【铁律·省时间】**：拿到 case 数据 + child-judge 判据后，【一次性】做完三阶段并落盘——中途【不要再读别的文件、不要再跑别的脚本、不要反复轮询】。你的判断力没问题，别把时间耗在"找资料/等脚本/翻页定位"这些导航动作上（这是历史上超时的真凶）。

步骤：
1. 跑 `node scripts/audit-tool.cjs case <instance_code>` 取数据。⏱️【操作纪律】这是【一条命令、会自己返回摘要】——**直接等它返回，别用 process log/poll 分段看输出、别把 read 的参数混进 exec**（历史上最大的两处时间浪费）。附件全文仅在某维度确实要看时才 `read-attachment <code> <idx>`，否则别读。
2. `in_scope=false`/`should_skip=true` → 先 `node scripts/audit-tool.cjs batch-skip <instance_code>` 登记，再回 `[skip] Case <申请人>: 越界/跳过（一句话理由）`。绝不 write-result。
3. 否则按 child-judge.md 做完整三阶段判断 → 用 `write` 写 `result_<instance_code>.json`（唯一名，别用共享 `result.json`）。🔴【路径坑·zizhi Round4 实证】你的 `write` 工具可能把文件写进【你的 workspace】，而 `write-result` 默认在 skill 目录找 → 找不到。**所以 write-result 的第二个参数【必须传你刚写的文件的绝对完整路径】**（不是相对 `result_<code>.json`）：`node scripts/audit-tool.cjs write-result <instance_code> <你写的 result 文件的绝对路径>`，被打回就改完【重跑到 ok:true】。
   > verdict 字段【必须是纯中文】`通过/需补充/退回/转人工`（工具现会自动剥 emoji/空白，但你仍别加 emoji）。
4. 落盘成功（write-result 返回 ok:true）【才】回一行【带状态】：`[write-result:ok] Case <申请人>: 通过/需补充/退回/转人工（资质类型，一句话理由）`。没落盘成功【别回 Case 行】，回来告诉我你卡在哪。不要回附件全文或长分析。
```

---

## 步骤 0/3/4/5a：判断规格 · 附件铁律 · 三阶段 · result 落盘 → 全在 `references/child-judge.md`

> 🧠 **判断侧全部规格集中在一处** [`references/child-judge.md`](references/child-judge.md)（子代理专读的紧凑规格），含：资质分类 + 印章边界、场景速查、附件铁律（status≠ok / needs_vision / seal_count / 核原件-物料流向）、三阶段判断、result schema + applicantAction 铁律、落盘强制终点。深度细则见 [`analysis-protocol.md`](references/analysis-protocol.md) / [`scene-principles.md`](references/scene-principles.md)。
> - **子代理**：由 spawn 模板指过去读 child-judge.md，父不必内联判断规格。
> - **父 agent 需要亲自判断时**（R 修订复审、大公子桥 inline 同步审核）→ 也读 child-judge.md，同一套规格（禁简化版）。
> **📦 Context 压缩**：每条 `write-result` 返回 `ok:true` 后立即丢弃该 case 全文/推理，context 只留一行 `Case N: 结论`，数据已在 JSON。

---

## 步骤 1：查询待办

```bash
node scripts/audit-tool.cjs list
```

返回 `{total_pending, worklist_total, returned, remaining, since_days, window_scanned, has_more, tasks:[{instance_code, task_id, pa_state, applicant, quals, reason}], note}`。`tasks` 是本轮工作清单（最新在前、默认上限 12）；`since_days` = 本轮日期窗天数（null=全量），`window_scanned` = 日期窗扫描的实例数。底层【翻页拉全量】、按 task_id 倒序排、状态过滤、限流重试、@file 传参已封装在工具里。

> **覆盖与节流**：`list` 工具层翻页拉全量待办(仅索引、不进上下文)，杜绝"100/50 名外漏审"；每轮只返回最新 N 条(默认 **12**，传 `list <N>` 可调)，剩余靠状态机下轮续。N 上限受 `maxConcurrentRuns`(并发8)+`timeoutSeconds`+限流+人确认量，经验值 12–15，勿超 30。
>
> **🗓️ 日期窗**：`list` 默认只审近 `QUAL_SINCE_DAYS` 天（默认 7）提交的待办；`list --since <天>` 改窗、`list --all` 关窗跑全量。⚠️ **窗口外老 backlog 不被默认覆盖，需定期 `list --all` 清库存**（逆转"永不漏审"的权衡背景见 references/CHANGELOG.md）。

**故障排查：返回 0 条？**
1. token 是否有效：`lark-cli auth status`
2. 确认审批后台确实有待办
3. 底层命令细节参见 [references/api-guide.md](references/api-guide.md)

---

## 步骤 2：读取表单 + 下载附件（由工具完成）

```bash
node scripts/audit-tool.cjs case <instance_code>
```

一步返回 `{in_scope, should_skip, form, attachments_summary, ocr_gate, deterministic, applink, case_file}`：读表单、下载附件、文件头判类型、OCR(ocr-paddle 经典管线)提取、确定性红线检查全部封装在内。`in_scope=false` 或 `should_skip=true` 直接跳过该条。附件全文不内联，按需用 `read-attachment <code> <idx>` 取。

> 字段解读（含旧表单字段兼容）、场景豁免覆盖 deterministic 标记的规则（如 L01 诉讼仲裁豁免 R11/R05）、知识库查阅（商标注册表/海外主体/部门负责人）**全部内联在 [`references/child-judge.md`](references/child-judge.md)**——判断侧只维护这一份，SKILL.md 不重复。

> **📦 Context 压缩规则**：每条 `write-result` 后立即丢弃该 case 全文/推理，context 只留一行摘要（判断规格 + 落盘 schema 见「步骤 0/3/4/5a」指向的 child-judge.md）。

---

## 步骤 5b：生成卡片发给用户

**发卡前必须先等本批子代理全部 settled**（见主流程步骤 3 的收网分叉：OpenClaw→`sessions_yield` 等推送；大公子→同步审完）——否则 gen-card 状态机硬闸会拒发（本批件未全部 write-result/batch-skip 时返回 `ok:false`+pending 列表，防空卡/半卡；OpenClaw 分支遇 `ready:false` 就再 `sessions_yield`，别当失败）。等齐后：

```bash
node scripts/audit-tool.cjs gen-card
# 重发时（第 N 轮）：
node scripts/audit-tool.cjs gen-card 2
# 本轮有余量时把 list 的 remaining 传进来（卡片显示"另有 M 条待下轮"）：
node scripts/audit-tool.cjs gen-card 1 "" 145
```

脚本自动读取今日 JSON（`D:\agent-hub\audit_reports\YYYYMMDD.json`），按通过/需补充/退回分组发卡片。`gen-card` 第 3 参数 = 本轮 `list` 返回的 `remaining`（>0 时卡片汇总行下方提示"另有 M 条待下轮审核，已自动排队"）。

> 🟢 **gen-card 幂等 · 一批一张卡（2026-07-06 稳定性铁律）**：卡片更新键 = `batchDate + 目标群chatId`，存在 `scratch/audit_card_ids.json`。同一批再次 `gen-card` **会原地 PATCH 同一张卡**、绝不重复发。因此：
> - **绝不手动 `Set-Content audit_card_ids.json {}` / 删该文件**——那会抹掉 message_id → 下次变成新发一张 → "每次 2 张卡"的元凶。
> - 返回里 `updated:false` = **本批首次新建（正常）**，`card_action` 字段有明确中文说明；**不要因 `updated:false` 以为失败而重跑 gen-card**（重跑也只会 PATCH 同一张，但没必要）。
> - R 修订复审同样走 gen-card → 原地更新那张卡为"修订复审"，历史意见已在 `revisions.jsonl` 落库，不靠多发卡留存。

> 🔴 **gen-card 调用成功后，当前 Turn 立即结束，不得再调用 `approve` / `reject` / `note`。**
> 等用户回复 FAIR 指令（F#N / A#N / I#N / R#N），由新 Turn 执行。

> **⚠️ 卡片发送**：大卡（15–20KB）必须走 `feishu-common.ps1` REST；`lark-cli im send-card --as bot` 与 MCP `im_v1_message_create` 都会失败——具体报错/大小限制见 [references/card-generation-pitfalls.md](references/card-generation-pitfalls.md)（底部已列为发卡前必看）。
> **交互方式**：用户在卡片下方文字回复（见步骤 5-2），不使用卡片按钮回调。

---

## 步骤 5-2：执行用户决策（FAIR 快捷指令）

### 🎯 首选执行方式（2026-07-24 改法一·把"执行"从模型手里拿走）：一条 `fair` 命令

**收到 FAIR 回复（含 `F#N` / `A#N` / `I#N` / `R#N` / `S#N` 或中文等价词+编号）→ 你唯一要做的就是一条命令**，把用户整条 FAIR 原文原样传进去；工具确定性地解析+逐条执行+刷卡：

```
# 生产群 FAIR：先设 prod（解锁 approve）+ 本条指令发送人（委托授权闸），再一条 fair 传原文
$env:QUAL_PROFILE='prod'; $env:QUAL_ACTOR_OPEN_ID='<bridge_context.senderId>'; node scripts/audit-tool.cjs fair '<用户整条 FAIR 原文，原样贴入>'
```

- 🔴 **别自己逐条解析、别分别调 approve/reject/note、别口头解释"F 是什么意思"。就调这一条。**
- `fair` 内部：正则解析所有 token+原因 → 每个 `#N` 确定性查 instanceCode → 复用 `approve`/`reject`/`note`/`scope-dismiss` 原子执行（字母→动作**代码里写死**：F→approve / A→reject / I→note / S→scope-dismiss；R→记录修订原因+置回重审队列）→ 刷新卡片 → 返回 `results` 逐条摘要。
- 返回的 `results` 每条带 `token`/`action`/`ok`/`error`/`note`——**原样转述给用户即可**（成功几条、哪条失败为什么），别自己编。
- 安全闸全保留（都在被复用的子命令内部、`fair` 不绕过）：approve 硬锁（只认显式 `QUAL_PROFILE=prod`）、note-先于-approve 原子、字母↔动作硬闸、委托授权闸（读 `QUAL_ACTOR_OPEN_ID`）。忘设 `QUAL_PROFILE=prod` → approve 被拦（fair 结果里那条报 allowApprove=false，你照实转述、别当成功）。
- **R#（修订）· 即时重审（phase2，2026-07-25）**：`fair` 记录修订原因并在返回里给出 **`revise_needed`**（每项含 instance_code + 你的修订原因）。**收到 `revise_needed` 后【立即】对里面每个 instance_code spawn 一个子代理重审**（用下面「子代理 spawn 模板」；`case` 已把用户修订原因挂成显眼复审闸 + `revise_reason`，子代理据此正面回应质疑、不得照抄上轮）→ 子代理 write-result 覆盖结论 → **gen-card 出修订卡主动推给用户**。**绝不等下一轮 `list`**（这是修早先 R# 拖到下轮的回归）。

> 下面的逐 token 命令表 = `fair` 内部所做的事 / 需要单条精确操作或排障时的底层参考。**日常 FAIR 一律走上面那一条 `fair`，不要手动逐条跑。**

> 🔴 **铁律：FAIR 执行只准走 `audit-tool.cjs` 的 `approve` / `reject` / `note`**（它把三步绑成原子事务：写评论 → 飞书审批动作 → 更新 pending_actions=CLOSED）。**绝对禁止手搓 `lark-cli api POST 评论` / `approval tasks reject` 自己拼审批动作**——那样只做飞书侧、漏掉第三步状态记账 → 缓存漂移、三方不一致（A#5 事故，见 references/CHANGELOG.md）。
> ⚠️ 注意分阶段：「别裸调脚本」的约定只针对**分析/编排阶段**（防绕过 INTERRUPT 写未确认评论）；**FAIR 执行阶段恰恰必须调这些原子命令**——它们就是为安全落地设计的，绕开反而更危险。两阶段别混为一谈。
> 🟢 **生产 FAIR 必须 `QUAL_PROFILE=prod`**：否则默认 test，`approve/reject/note` 会被硬锁拒绝（报 `allowApprove=false`）。执行前确认工具启动打印的 `PROFILE=prod`。
> 🔴 **群判定规则（2026-07-02 实测踩坑；2026-07-12 生产群改为 oc_231f）**：用户在生产群 `oc_231fbee0b63f15721bc550e75897b818` 回 FAIR 会拉起【新的大公子会话】，它默认 test 会拦下审批。**处理生产群 FAIR 前，先看 `bridge_context.chatId`：若 == `oc_231fbee0b63f15721bc550e75897b818`（旧群 oc_b3f3cf 已废） → 先 `$env:QUAL_PROFILE='prod'` 再跑 audit-tool。**
>
> 🔴 **委托授权接线（2026-07-06，安全关键）**：执行 FAIR（approve/reject/note）前，**必须** `$env:QUAL_ACTOR_OPEN_ID='<bridge_context.senderId>'`（本条 FAIR 指令的发送人 open_id）再跑 audit-tool。委托授权闸据此判权限：王爷(operator)全权；委托人(`QUAL_DELEGATES`，如 Card B 群的杜益/余佩琳)只能处理其类别的案件，越权/陌生人拒。**不设 = 闸 fail-safe 放行 = 委托限制形同虚设**（等于谁在群里都能 F/A 任何案）。Card B 群(`oc_b3d2d2…`)的 FAIR 尤其必设。

用户在卡片下方用固定格式回复（FAIR 指令或中文等价词均可）：

| 用户回复格式 | 含义 | 执行路径 |
|-------------|------|---------|
| `F#N` / `通过 #N` | 放行（同意 AI，执行通过） | [F 链路] 查 instanceCode → `approve <ic> <person> --fair-letter F` |
| `A#N 原因：...` / `退回 #N 原因：...` | 反对（退回，终止申请） | [A 链路] 查 instanceCode → `reject <ic> <reason_file> <person> --fair-letter A` |
| `I#N 要求：...` / `留言 #N` | 询问（等申请人补材料） | [I 链路] 查 instanceCode → `note <ic> <person> --fair-letter I`，不执行 approve/reject |
| `R#N 原因：...` / `异议 #N 我的意见：...` | 修订（不同意 AI，重新分析） | [R 链路] **不执行任何审批**（R 传给 approve/reject/note 会被工具 fail-closed 拒绝）；重新分析 → write-result 覆盖 → gen-card → 再次 INTERRUPT 等确认 |
| `「我认为」「应该」「感觉」等` | 意见表达 | 仅讨论，**不执行任何命令** |
| 有意图但无 `#N` 编号 | 模糊输入 | 询问确认编号，不猜测 |

> 🔴 **FAIR 字母硬闸（2026-07-21，改法一+二）**：`approve/reject/note` **必带 `--fair-letter <用户敲的原始字母>`**。工具持唯一映射 `F=approve / A=reject / I=note / R=revise`，校验「字母↔子命令」一致，不符或缺字母即 **fail-closed 拒绝**；`R` 传给这三个动作一律拒（R 只走 write-result 重判）。**你的职责缩成「照抄用户字母」，不再凭记忆挑动词**——这道闸键在可核对数据、不由你的确信度决定（防 A/R 反接英文先验的误 reject 事故）。

**批量示例**：`F#1 #2 A#3 原因：不合规 I#5 要求：补材料`

> 执行前检查清单 + F/A/I/R 四条执行链的逐步命令走位 → [references/execution-chains.md](references/execution-chains.md)（日常照上表走即可；只在需要核对具体命令顺序/参数时才展开）。安全关键的委托授权 / 群判定 / note 铁律仍在上方正文内联。

---

## 步骤 5c（降级兜底）

**触发条件**：`write-result` JSON 未生成，或卡片流（步骤 5b）不可用时。正常情况走步骤 5a/5b/5-2。

读取并遵循 [references/legacy-comment-flow.md](references/legacy-comment-flow.md)（该文件另收录：原步骤 5-1「分析报告格式」在 examples.md、原步骤 6「修正版」在 legacy-comment-flow.md 末尾）。

---

## 附录A：分析一致性 · 错误降级策略

读取并遵循 [references/analysis-protocol.md](references/analysis-protocol.md) 第三节（同一审批只写一次评论、发现冲突写统一版、绝对禁止简化版替代三阶段、错误降级策略表）。

---

> **audit-tool.cjs 子命令速查（参数/返回值/错误排查）：[references/audit-tool-ref.md](references/audit-tool-ref.md)**
> 底层 API 命令报错时，查阅故障排查：[references/api-guide.md](references/api-guide.md)
> 写评论时对照输出示例：[references/examples.md](references/examples.md)
> 遇到判断疑难时查阅历史案例：[references/failure-cases-archive.md](references/failure-cases-archive.md)
> 附件读取规范（步骤 3 执行前读取并遵循）：[references/attachment-reading-spec.md](references/attachment-reading-spec.md)
> **卡片生成/排序/隔离/PS5.1 陷阱（步骤 5b 发卡前读，多条卡片必看）：[references/card-generation-pitfalls.md](references/card-generation-pitfalls.md)**
> **端到端流程全貌（含全部分支、状态机节点、规则触发点）：[references/diagram-technical.mmd](references/diagram-technical.mmd)（技术流程图，Mermaid；`references/push-diagrams.ps1` 可推送到飞书白板查看）——需要俯瞰整体编排/排查某分支落在哪一步时看它。**
