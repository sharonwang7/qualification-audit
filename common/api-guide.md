# API 命令模板

## 查询待办

```bash
lark-cli approval tasks query \
  --params @tasks_params.json \
  --as user --format json
```

tasks_params.json:
```json
{"topic": 1, "page_size": 100}
```

注意：
- 必须用 `--as user`
- 必须传 `topic=1`（"1"=待办）
- `--params` 需用 `@file.json` 文件方式

**⚠️ PowerShell 用户**：
- 不要直接用管道传 JSON（`echo {...} | lark-cli ... --params -`）
- 必须先将 JSON 写入文件，再用 `--params @file.json`
- 参数文件必须 UTF-8 编码，不能带 BOM

---

## 获取审批详情

```bash
lark-cli approval instances get \
  --params @instance_params.json \
  --as user --format json
```

instance_params.json:
```json
{"instance_code": "C6F2BBE9-7120-4A10-BFC8-DF21CE69CB21"}
```

**⚠️ 关键：必须用 UUID 格式的 `instance_code`**
- ✅ 正确：`instance_code` = `C6F2BBE9-7120-4A10-BFC8-DF21CE69CB21`（从 tasks.query 获取）
- ❌ 错误：不能用数字格式的 `instanceId`（如 `7647100670738287844`）
- Bitable 的 `SourceID` 可用 base64 解码获取 `instance_code`

返回 `data.form` 字段，需解析JSON字符串获取各字段值：
- `申请资质` — 资质类型（数组）
- `申请事由` — 申请理由（字符串）
- `附件（要求出具相关资质截图/双章合同）` — 附件URL列表（数组）
- `品牌` / `所属品牌` — 品牌名称
- `使用平台` / `资质流向方全称（公司/自然人/平台）` — 对方信息
- `提供注册号` / `注册号` — 商标注册号
- **v2.1新增**：`合同明细`、`是否跟对方存在合作关系`、`对方要求出具资质的截图附件`

---

## 写评论

```bash
lark-cli api POST "/open-apis/approval/v4/instances/{instance_code}/comments" \
  --data @body.json \
  --params @params.json \
  --as bot --format json
```

body.json（`content` 必须是 stringified JSON）:
```json
{"content": "{\"text\":\"评论内容\",\"files\":null}"}
```

params.json（`user_id` 必须在 **query params**，不能放 body）:
```json
{"user_id_type": "open_id", "user_id": "ou_102cae80079463e6c8281777fec96f47"}
```

🔴 **关键注意**：
- `user_id` / `user_id_type` 必须在 `--params`（query params），放 `--data`（body）会报 **99992402** "field validation failed"
- `content` 必须是 stringified JSON `{"text":"...","files":null}`，纯文本会报 **60001** "content invalid"
- 必须用 `--as bot`（user token 报 99991668；该接口不支持 user token）
- `user_id` 必须是**本 app（cli_aaa274a26fba9cca，大公子桥）的用户**，用其他 app 的 open_id 报 **99992361** "cross app"
- 不能使用 `elements` 格式（会导致内容为空）

## 读评论

```bash
lark-cli api GET "/open-apis/approval/v4/instances/{instance_code}/comments" \
  --params @params.json \
  --as bot --format json
```

params.json:
```json
{"user_id_type": "open_id", "user_id": "ou_102cae80079463e6c8281777fec96f47"}
```

⚠️ **重要**：
- GET 返回的 `content` 字段也是 stringified JSON，需 `JSON.parse(c.content).text` 才能取到文本
- DELETE 是**软删除**：`is_delete=1` 的评论仍出现在 GET 响应里。查重前必须过滤：`comments.filter(c => !c.is_delete)`
- **PowerShell 检查活跃评论**：`Where-Object { $_.is_delete -eq 0 }` **错误**（`is_delete` 为 0 时 API 不返回该字段，`$null -eq 0` 是 `$false`，全部活跃评论会被误过滤）。正确：`Where-Object { -not $_.is_delete }` 或 `Where-Object { $_.is_delete -ne 1 }`

## 删除评论

```bash
lark-cli api DELETE "/open-apis/approval/v4/instances/{instance_code}/comments/{comment_id}" \
  --params @params.json \
  --as bot --format json
```

params.json 同写评论。注意：删除是软删除，评论仍可在 GET 里看到（`is_delete=1`）。

---

## 通过审批

```bash
lark-cli approval tasks approve \
  --data @approve.json \
  --as user --yes --format json
```

approve.json:
```json
{"instance_code":"UUID","task_id":"数字ID","comment":"审批意见"}
```

---

## 拒绝审批

```bash
lark-cli approval tasks reject \
  --data @reject.json \
  --as bot --yes --format json
```

reject.json:
```json
{"instance_code":"UUID","task_id":"数字ID","comment":"拒绝理由"}
```

注意：拒绝操作使用 `--as bot`（PowerShell管道编码问题），通过操作使用 `--as user`

---

## 故障排查

### Q1: tasks.query 返回 0 条？

排查顺序：
1. 检查 `--as user` 是否正确（不是 `--as bot`）
2. 检查 JSON 参数是否通过文件传递（`--params @file.json`，不是管道）
3. 检查 token 是否有效：`lark-cli auth status`
4. 确认审批后台确实有待办

### Q2: instances.get 返回 "not found"？

排查顺序：
1. 检查是否用了数字 `instanceId` 而不是 UUID `instance_code`
2. 检查 `instance_code` 拼写是否正确
3. 确认审批未被删除或已完成

### Q3: 报错 "instance code not found"（1390003）？

- 通常是用错了 instance 标识符格式
- 不是数据迁移到了自定义小程序（此前误判）
- 确认使用 UUID 格式的 `instance_code`

### Q4: `--params @file.json` 报找不到文件？

**根因**：`@filename` 相对于 lark-cli 的进程 CWD（即 Node.js execFileSync 的 `cwd` 参数，通常是技能包根目录），**不是 PowerShell 当前目录**。

- 如果在 PowerShell 里用 `Set-Location` 切了目录，lark-cli 的 CWD 不会跟着变
- 解决方案：把参数文件写到与 lark-cli CWD 一致的目录（通常是技能包根目录 `C:\Users\FD\AppData\Roaming\FanDo\openclaw\skills\qualification-audit\`），或使用绝对路径（但 `@` 只支持相对路径，所以必须写到对的目录）

### Q5: 写评论报 99992402 / 60001 / 99991668 / 99992361？

| 错误码 | 原因 | 修复 |
|--------|------|------|
| 99992402 | `user_id` 放在了 body 而不是 query params | 把 user_id 移到 `--params` |
| 60001 | `content` 是纯文本而不是 stringified JSON | 改为 `{"text":"...","files":null}` |
| 99991668 | 用了 `--as user` | 改为 `--as bot` |
| 99992361 | 用了其他 app 的 open_id | user_id 必须用 大公子桥 app（cli_aaa274a26fba9cca）的用户 open_id |
