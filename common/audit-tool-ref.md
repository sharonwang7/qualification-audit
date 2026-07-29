# audit-tool.cjs 命令速查参考

> 全部命令通过 `node scripts/audit-tool.cjs <subcommand> [args]` 调用。
> 工具受 `QUAL_PROFILE` 控制（默认 `test`），执行前看启动打印的 `[qual-audit] PROFILE=...` 确认环境。

---

## 一、父 Agent 编排阶段（父专用，子代理不调）

### `list [N] [--since <天>|--all]`
拉本日待审清单，翻页拉全量再节流返回前 N 条。

| 参数 | 说明 |
|---|---|
| `N` | 本轮返回上限，默认 12；经验值 12–15，勿超 30 |
| `--since <天>` | 日期窗天数，覆盖 `QUAL_SINCE_DAYS`（默认 7） |
| `--all` | 关闭日期窗，扫全量历史待办（清库存用） |

**关键返回字段：**
```json
{
  "total_pending": 5,
  "returned": 5,
  "remaining": 0,
  "since_days": 7,
  "tasks": [{ "instance_code": "xxx", "task_id": "yyy", "pa_state": null, "applicant": "张三", "quals": "法人章", "reason": "事由摘要" }]
}
```
`remaining` > 0 时卡片需注明"另有 N 条待下轮"（传给 gen-card 第 3 参）。

---

### `gen-card [round] [date_YYYYMMDD] [remaining]`
发审核卡片。内置状态机硬闸：本批未全 settled → 拒发（`ok:false, ready:false`）；全 settled 或超 30min 总超时 → 发卡。

| 参数 | 说明 |
|---|---|
| `round` | 轮次，默认 1；重发时传 2、3... |
| `date` | 覆盖日期（YYYYMMDD），省略用今日 |
| `remaining` | `list` 返回的 remaining 值，传入则卡片显示"另有 N 条待下轮" |

**返回（拒发时）：**
```json
{ "ok": false, "ready": false, "pending": ["code1", "code2"], "hint": "..." }
```
**返回（空卡时）：**
```json
{ "ok": false, "empty": true, "hint": "本批无任何可渲染内容..." }
```
**返回（成功）：** PS1 脚本的 stdout 文本（卡片发送结果）。

> 🔴 gen-card 成功后当前 Turn 必须结束（INTERRUPT），不得在同 Turn 调 approve/reject/note。
> 应急强发：`QUAL_FORCE_CARD=1`；每轮独立新卡：`QUAL_CARD_NEW=1`（调试用）。

---

### `safety-net-spec [remaining]`
生成一次性兜底 cron JSON，防完成事件丢失导致父永不被唤醒。

**返回：** `{ "cron_add": { ...cron配置... } }` → 原样传给 `cron action=add`。

---

### `register-orphans`
找回"写了 `result_<code>.json` 却漏跑 write-result"的孤儿件，自动补注册为 done。

**返回：** `{ "registered": ["code1"], "count": 1 }`

---

### `batch-fail <instance_code>`
父唤醒后发现子代理既没 write-result 也没 batch-skip（真失败/超时）时，手动登记 failed，防账本永远等它。

**返回：** `{ "ok": true }`

---

### `await-batch [timeoutSec]`
> ⚠️ **降级/调试用**，正式编排不用（违反"禁止 poll"）。阻塞等本批全 settled 或超时，再 gen-card。默认 660s。

---

## 二、子代理审核阶段（子专用，父不调）

### `case <instance_code> [force]`
读取单条案件的全部数据（表单+附件摘要+OCR+确定性红线）。一条命令，直接等返回。

| 参数 | 说明 |
|---|---|
| `instance_code` | 审批实例码 |
| `force` | 传任意值强制重拉（忽略缓存） |

**关键返回字段：**
```json
{
  "in_scope": true,
  "should_skip": false,
  "fast_track": { "flag": false },
  "form": { "applicant": "...", "quals": "...", "reason": "...", "platform": "...", "reg_no": "...", "counterparty": "...", "comments_summary": "..." },
  "attachments_summary": [{ "idx": 0, "name": "xxx.pdf", "status": "ok|failed|needs_vision|truncated", "seal_count": 2, "text": "...", "vision_paths": [] }],
  "ocr_gate": { "all_ok": true, "needs_human": false },
  "deterministic": { "issues": [], "passed": true },
  "applink": "https://...",
  "case_file": "/绝对路径/case_xxx.json"
}
```
`in_scope=false` 或 `should_skip=true` → 跑 `batch-skip` 登记后回 `[skip]`。

---

### `read-attachment <instance_code> <idx> [maxChars]`
按需读取指定附件全文（`status=ok` 的大附件）。`idx` 从 0 起，对应 `attachments_summary` 顺序。`maxChars` 默认不限。

**返回：** `{ "content": "全文...", "status": "ok" }`

---

### `write-result <instance_code> <result_json_文件绝对路径>`
登记本条审核结果到账本。🔴 路径必须是绝对路径（子代理的 `write` 工具可能把文件写进 workspace 而非 skill 目录）。

**返回：** `{ "ok": true, "errors": [] }` 或 `{ "ok": false, "errors": ["verdict 字段缺失", ...] }`
失败则修正 JSON 后重跑直到 `ok:true`。

---

### `batch-skip <instance_code>`
子代理判 `in_scope=false` 或 `should_skip=true` 时登记 skip，让父收网不空等。

**返回：** `{ "ok": true }`

---

## 三、FAIR 执行阶段（新 Turn，用户回复 FAIR 后）

> 执行前必须设 `QUAL_ACTOR_OPEN_ID=<bridge_context.senderId>` 和 `QUAL_PROFILE=prod`（生产环境）。

### `approve <instance_code> [expected_person]`
原子执行通过：写审批评论 → 飞书审批通过 → pending_actions 状态改 CLOSED。
`expected_person` 传申请人姓名做串号硬校验（防操作错件）。

**返回：** `{ "ok": true, "comment_id": "..." }`

---

### `reject <instance_code> <reason_file> [expected_person]`
原子执行退回：写退回原因评论 → 飞书审批退回 → 状态 CLOSED。
`reason_file` 为包含退回原因文本的文件路径。

**返回：** `{ "ok": true }`

---

### `note <instance_code> [expected_person]`
原子执行留言（I 路径）：写补充要求评论，不执行 approve/reject，状态留 PENDING_REVIEW。

**返回：** `{ "ok": true, "comment_id": "..." }`

---

### `lookup-case-by-n <N>`
通过卡片上的 `#N` 编号反查 `instance_code`（FAIR 时常用）。

**返回：** `{ "instance_code": "xxx", "task_id": "yyy", "applicant": "..." }`

---

## 四、诊断与调试

| 命令 | 用途 |
|---|---|
| `revisions <code>` | 查该件所有 R 修订历史（含每次重分析的结论变化） |
| `revision-card <code> [round]` | 生成修订复审卡片（R 路径完成后调） |
| `comments <code>` | 查该件所有审批评论（含AI和人工） |
| `scope-dismiss <code>` | 手动将越界件登记为 dismissed（list 不再返回） |
| `cache-from-doc <doc_id> [caseN:code...]` | 从飞书文档批量缓存多件分析结果（大批量补录用） |
| `comment-from-doc <code> <doc_id> <case_no>` | 从飞书文档指定章节写审批评论（降级流程） |
| `comment <code> <comment_textfile>` | 直接写评论（最原始降级，不走 approve/reject 状态机） |

---

## 快速错误排查

| 现象 | 原因 | 解法 |
|---|---|---|
| `gen-card` 返回 `ready:false` | 本批有件未 settled | OpenClaw：`sessions_yield` 继续等；大公子：审完/登记残余件再 gen-card |
| `gen-card` 返回 `empty:true` | 本批无可渲染内容（全 skip 或全未完成） | 确认子代理确实跑了；用 `QUAL_FORCE_CARD=1` 仅在调试时强发 |
| `write-result` 返回 `ok:false` | 路径错/verdict 非法/必填字段空 | 修正 JSON，检查 verdict 是纯中文（通过/需补充/退回/转人工），重跑 |
| `approve` 报 `assertActionable failed` | 件已 CLOSED 或串号 | 用 `lookup-case-by-n` 核实 #N → code 映射，或检查是否已处理过 |
| `approve` 报 `allowApprove=false` | `QUAL_PROFILE` 未设 prod | `$env:QUAL_PROFILE='prod'` 后重跑 |
| `list` 返回 0 条 | token 过期 / 无待办 | `lark-cli auth status` 核实 token；确认审批后台确实有待办 |
