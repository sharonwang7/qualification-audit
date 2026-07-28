# qualification-audit 实操陷阱

## audit-tool.cjs stdout 解析陷阱

**症状**：`node scripts/audit-tool.cjs case <code> | ConvertFrom-Json` 报 `Invalid JSON primitive: INFO` 或类似错误，或 `ConvertFrom-Json` 解析到非预期内容。

**根因**：audit-tool 启动时，PaddleOCR（Python OCR 库）固定向 stderr 输出初始化 warning，例如：
```
INFO: Could not find files for the given pattern(s).
UserWarning: `lang` and `ocr_version` will be ignored...
Creating model: ('PP-OCRv5_mobile_det', None, None)
```
在 PowerShell 里用 `2>&1` 合并流时，这些 warning 会混入 JSON 输出流，导致 `ConvertFrom-Json` 失败。

**正确解析方式**：

```powershell
# ❌ 错误：2>&1 把 OCR warning 混入 JSON
node scripts/audit-tool.cjs case $code 2>&1 | ConvertFrom-Json

# ✅ 方式1：用 Select-String 提取特定字段（推荐，最稳定）
node scripts/audit-tool.cjs case $code 2>&1 | Select-String '"in_scope"' | Select-Object -First 1

# ✅ 方式2：stderr 重定向到 $null，stdout 保持干净
$result = node scripts/audit-tool.cjs case $code 2>$null | Out-String | ConvertFrom-Json

# ✅ 方式3：写到文件再读（适合需要完整 JSON 的场合）
node scripts/audit-tool.cjs case $code 2>$null | Out-File -Encoding utf8 "$tmp\case.json"
$result = Get-Content "$tmp\case.json" | ConvertFrom-Json
```

**注意**：`2>$null` 在 PowerShell 5.1 对 native exe 的 stderr 有时不完全抑制。最保险是 `Select-String` 提取需要的字段，而不是整体 parse JSON。

---

## comment 命令需要两个参数

`node scripts/audit-tool.cjs comment <instance_code> <comment_textfile>` 需要两个参数：实例 code 和评论文本文件路径。

文本文件应只包含评论正文（不是 result JSON 的 `comment` 字段 wrapper，是纯文本），write-result 命令也需要完整的 result JSON 文件（含 `verdict` 和 `comment` 字段）。

---

## 评论删除（DELETE）

见飞书 API 实操陷阱：`user_id`+`user_id_type` 必须在 query params，`--as bot`。`FEISHU_USER_OPEN_ID` 在 `.env` 文件中。
