# qualification-audit · CHANGELOG / 背景说明

> 原则：SKILL.md 正文只留「规则」；规则背后的「为什么 / 事故 / 重构原由」放这里，供人追溯，**不进每轮加载**（方案 F：变更日志隔离）。

## 2026-07-23

- **R14 触发条件改「是否涉及相关账号 ≠ 无」（弃用下线的「是否需要实名」字段）**（`lib/phone-roster-check.js`）：王爷指出审批表单已删除「是否需要实名」字段，旧 R14 用 `needRealname` 作弱提醒触发已失效；触发信号本应绑定「是否涉及相关账号」。改为与 R13(named-person-rank) 统一——复用其已 export 的 `involvesAccount(form)`（是否涉及相关账号 ≠ 无/空）作触发闸：涉及账号才查企业手机号名录；涉及账号却取不到手机号 → R14💧 弱提醒（旧逻辑因 needRealname 恒 false 会静默漏）；命中名录 return null、未命中 R14 MAJOR。全程 fail-open 不变。单测 5 情形全绿（涉账号+命中→null / 涉账号+未命中→MAJOR / 账号=无→null / 涉账号+无手机号→MINOR / 字段空→null）。背景：#62(易姑姑 TikTok Shop 开店)审核时王爷点出该维度，核查发现旧触发字段已下线。

## 2026-07-21

- **R→reject 误退事故 + FAIR 字母硬闸（改法一+二）**：用户回 `R#59`（修订/重判 欧鸿雁），大公子把 R 当英文 Reject、调了 `reject` → 审批实例被**终态退回**（不可撤，申请人须重新提单）。根因不在"约定太坑"，而在**核实开关接在主观确信上、不接在动作风险上**：R/A 恰好反接英文先验（A=退回、R=修订），越自信越错。且既有 5 道闸（allowApprove/pending/CLOSED/person 串号/委托授权）守的全是「该不该对这案子动手·谁动手·动过没·环境对不对」，**没有一道守「字母↔动作」这条轴**——person 串号只防「配错案子」，防不了「配错动作」。
  - **修复**（`scripts/audit-tool.cjs` `assertActionable` + dispatch）：新增唯一映射 `FAIR_MAP = {F:approve, A:reject, I:note, R:revise}`；approve/reject/note **必带 `--fair-letter <用户原始字母>`**，工具校验字母↔子命令一致，缺字母/不符/`R`误触审批按钮一律 **fail-closed 拒绝**。agent 职责缩成「照抄用户字母」，A/R 反接锁死在代码里、不经记忆。已在 test 干跑验证 6 种情形全符合预期（R拒、A→reject放行、A→approve拦、缺字母拦、F放行、非法字母拦）。SKILL.md 步骤 5-2 表 + execution-chains.md 同步要求 `--fair-letter`。

## 2026-07-13

- **LibreOffice 路径可移植性修复**（`lib/data-prep.js`）：`QUAL_SOFFICE_BIN`/`QUAL_LO_PROFILE` 显式设置时行为完全不变（生产 `.env` 已设，不受影响）；未设置时新增自动探测：soffice 依次查常见安装目录（`Program Files`/`/usr/bin` 等）→ PATH（`where`/`which`），仍找不到才降级为既有的".doc/非标DOCX 转人工"（不新增失败模式，不崩溃，仅多打一行 `[qual-audit]` 提示）；LO_PROFILE 未设置时默认落 `os.tmpdir()/fando_lo_profile` 并自动建目录，不再假设 `C:\temp` 存在。目的：换机器部署不必手工填这两个环境变量也能大概率直接跑起来。已验证：生产同款 env 加载后零告警（行为不变）；清空 env 模拟新机器加载不崩溃、按预期打印提示。

## 2026-06-30

- **list 翻页 + 状态驱动增量重构**：旧 `list` 只拉一页(100)再砍 50 → 50/100 名外的待办被静默漏审。重构为：工具层翻页拉【全量】(仅索引、不进上下文) → 状态过滤(PENDING_REVIEW/CLOSED 跳过) → 在途优先 + 最新在前 → 默认返回最新 12 条、剩余靠状态机下轮续。**用状态驱动增量、不用日期窗**（日期窗会漏久拖件）。N 上限由 `maxConcurrentRuns`/`timeoutSeconds`/限流/人确认量决定，不再受父 agent 上下文限制。

- **A#5 状态漂移事故**：执行 A#5（朱嘉仪退回）时手搓 `lark-cli` 拼评论+reject，绕过 `audit-tool.cjs reject` 的原子三步，漏了第三步 `setPAState(CLOSED)` → 飞书已拒绝但 pending_actions 仍 PENDING_REVIEW，三方不一致需人工补救。教训 →（a）SKILL「FAIR 只走 audit-tool 原子命令」铁律；（b）`cmdList` 加「对账自愈」：list 翻全量时，凡 pending_actions 标未结案却已不在待办集的，自动置 CLOSED。

- **1 实例 1 子代理架构**：父 agent 不应在单一上下文累积 N 条附件全文（会爆）→ 改为每条 `sessions_spawn` 独立子代理（各自上下文 O(1)），父 agent 只编排、不读附件。

- **OCR 批一/批二**：data-prep 修 `504b0304` 判型 bug（xlsx/zip 被误判 docx）、新增 xlsx(openpyxl)/zip(解包) 读取、三处 python 调用加 `PYTHONIOENCODING=utf-8`（防 `☑`/`\xa0` 崩）；图像识别由本地 ocr-paddle 改为子代理 `image()/pdf()`（`status:needs_vision` + `vision_paths`），ocr-paddle 降为 `QUAL_OCR_MODE=paddle` 离线兜底。完整方案见 `D:\agent-hub\workdir\OCR-替代方案-实施稿.md`。

- **gen_card 单条分组 bug**：PowerShell 管道结果 0/1/多 返回 $null/标量/数组，恰好 1 条时 `.Count` 失真致该结论组被吞 → 四个分组（pass/reject/review/human）+ `$allCases` 均 `@()` 强制成数组。

- **统一版历史路径**：旧版同一实例可能有多条 AI 评论致结论冲突，需写「统一版」。新流程每实例限一次评论，此路径已基本消除，仅 `comment` 返回 `needs_unified:true` 时兜底。
