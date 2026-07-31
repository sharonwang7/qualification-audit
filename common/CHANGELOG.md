# qualification-audit · CHANGELOG / 背景说明

> 原则：SKILL.md 正文只留「规则」；规则背后的「为什么 / 事故 / 重构原由」放这里，供人追溯，**不进每轮加载**（方案 F：变更日志隔离）。

## 2026-08-01

> 本轮主线：治两个「靠运行时/靠用户」的脆弱点 —— ①setup 现场拉审批定义靠 app scope 不可预测；②list 返回 0/报错却让用户自己排查。协作：静态清单主体由 zizhi（资质审核助手）预拉+落地，list 异常兜底与配置加固由大公子实现并整合验证。发版 v3.2.3 @ 6ba12c4。

- **静态审批流清单：预拉一次、烘焙进技能包，setup 零 API 调用**（`common/approval-definitions.json` 新增 · `scripts/refresh-approval-defs.cjs` 新增 · `lib/connector-feishu.js` · `scripts/audit-tool.cjs`）：
  - **背景**：老 `setup` 走 `lark-cli api GET /approval/v4/approvals --as user` 现场拉审批定义。实测——桥 app(cli_aaa274 王伊瑄)有 `approval:task/instance` scope 但**缺 `approval:definition`** → setup 报 99991679 missing_scope 拉不到；zizhi 的 app 有该 scope → 能拉到 72 条。**谁跑、用哪个 app 决定成败**，对新团队(如益智虾)不可预测。
  - **原因与逻辑**：公司审批工作流是**固定**的（月级才变），本不该每次交互都现场拉。固定的东西就该**预拉一次、缓存进技能包** → 之后零 API 调用、零 scope 依赖 → 对所有团队/所有 agent 都稳，从根上绕开「靠运行时 app scope」这个病。
  - **措施与逻辑**：(a) 有 scope 的 app(zizhi)预拉全部 72 条 → 存 `common/approval-definitions.json`（name/code/group，0E0BBB7F 资质申请在列）。(b) `listApprovalDefinitions()` 改读本地缓存，不再调 API。(c) setup/setup-set 读缓存返回全量供用户点选。(d) 新增 `refresh-approval-defs.cjs`：审批流变更时由有 scope 者手动重拉刷新 + 提交（低频维护通道）。(e) 顺手修 cmdSetupSet 显示 `undefined`（`chosen.name`→`approval_name`）。

- **list 异常自动兜底：识别 + 翻译成人话，不再 crash / 不再让用户自查**（`scripts/audit-tool.cjs` `cmdList` + 新增 `translateLarkError`）：
  - **背景**：原先说「list 返回 0 条就报错提示用户」被王爷否掉——大部分 0 条是**正常业务态**（真没待办/日期窗/everClosed 收敛/角色过滤），报错=打扰。真正该兜的是**技能包能自动判、判了能省用户时间的配置/环境异常**。zizhi 把路径穷举后筛出 3 类真异常，大公子采纳并合并。
  - **原因与逻辑**：异常分两类——(异常3)API 调用**失败**：未登录/scope不足/token过期/网络故障，老代码 `lark()` throw 出原始 JSON、进程 crash，AI 和用户都看不懂；(异常1)API 调**通但拉 0 条**且 code 不对：飞书对错 code 不报错、只给空，用户以为「没活」。两者都是「技能包知道异常在哪、但没说出来」。
  - **措施与逻辑**：
    - **异常3**：`cmdList` 翻页整段包 try/catch + 逐页查错码 → 命中即 `translateLarkError` 翻译成人话({ok:false,error,hint,raw})返回，不 crash、不静默当 0。**合并了 zizhi 原「异常2 未登录预检」**——未登录同样会被这层 try/catch 抓到翻译，无需每次 list 都多跑一次 `lark auth status` 子进程（省一次开销、同样兜底）。
    - **实测校正**：跑 bogus code 发现飞书返回的是 `{message:"definition code not found"}` **API 错误、非空数组**（推翻 zizhi「错 code 静默返回空」的假设）→ 给 `translateLarkError` 加**最优先分支**精确翻成「QUAL_DEFINITION_CODE 查不到、大概率配错、帮你重选审批流(setup)」。
    - **异常1（双保险）**：拉到 0 条且 DEFINITION_CODE 不在缓存清单 → 加 `definition_code_warning` 诊断，区分「配错 vs 真没待办」；仅 0 条时校验避免误报。应对「格式对但错的 code 返回空」的残余情况。
    - **正常 0 条不动**：真没待办/日期窗(window_scanned/dropped)/everClosed 收敛/角色过滤(role_dropped) 已各有诊断字段，不加噪。

- **配置加固：把静默坏变成当场可见 + doctor 体检覆盖**（`scripts/audit-tool.cjs` 模块级 + `cmdDoctor` · `.env.example`）：
  - **背景**：益智虾出现「App ID 填错」——`.env.example` 的 `FEISHU_APP_ID=<你的飞书应用ID>` 占位符被 AI 当成「必须填」→ 填成自己的 bot app，而 `FEISHU_APP_ID` 只用于 `buildApplink` 生成审批跳转链接、填错**静默失效**（点链接才发现，无拒发闸）。同理 code 配错要能被体检抓到。
  - **原因与逻辑**：凡岛团队的默认(`cli_9cb844403dbb9108` / `0E0BBB7F`)**本就是对的**，真 bug 是 AI **覆盖了对的默认**。治本=不给占位符诱导 AI 乱填 + 配错时当场报出来。
  - **措施与逻辑**：(a) 模块加载时校验 `FEISHU_APP_ID` 是否 `cli_` 格式，非法则 fail-loud warn 到 stderr（不阻断 list）。(b) `doctor` 增查：FEISHU_APP_ID 格式(非 cli_→⚠️)、QUAL_DEFINITION_CODE 是否在 `approval-definitions.json` 清单内(不在→⚠️会拉 0 条)——⚠️不计入 🔴 阻断，凡岛默认配置体检全绿。(c) `.env.example`：FEISHU_APP_ID 直接给默认值+「凡岛不要改」注释、QUAL_DEFINITION_CODE 注明默认即对无需配（zizhi）。

- **验证**：golden 132/0 · smoke 7/7 · doctor 真机全绿(FEISHU_APP_ID✅ / DEFINITION_CODE 在清单内✅) · 异常端到端(bogus code→精确「code 配错」提示、正确 code→拉到 188 条正常且 warning=null，证明异常3 不误伤正常成功) · 全程 test profile + scratch 台账隔离、未碰生产状态。

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
