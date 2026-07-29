# 附件读取详细方案

> 本文档为 qualification-audit Skill 的 Level 3 参考资料。
> **OCR 已解耦为独立 skill 包 `../ocr-paddle/`**；本包只负责下载 + 文本直读 + 调用 ocr-paddle，并对每个附件给出 `status` 供审核侧放行门用。

---

## 一、文件类型检测（文件头 Magic Bytes）

| 文件头（hex） | 真实类型 | 说明 |
|-------------|---------|------|
| `89504e47` | PNG | PNG 图片签名 |
| `ffd8` | JPG | JPEG 图片签名 |
| `25504446` | PDF | PDF 文件签名（`%PDF`） |
| `504b0304` | DOCX | ZIP 文件签名（DOCX 本质是 ZIP） |
| `d0cf11e0` | 旧版DOC | OLE2 复合文档签名 |
| 其他 | 未知 | 兜底处理 |

`lib/data-prep.js` 的 `getFileTypeByHeader()` 实现此表（URL 不含扩展名，必须按文件头判型）。

---

## 二、下载流程

飞书附件 URL 形如 `https://internal-api-drive-stream.feishu.cn/...?code=xxx`，**不含扩展名**。
`downloadAttachments()` 用 **Node 原生 https/http** 下载（不依赖 curl，跟随重定向、二进制安全、不走系统代理），先存 `.tmp` 再按文件头改名。表单附件落 `QUAL_ATTACH_DIR/<code前8位>/`，评论区附件落其 `comments/` 子目录。

---

## 三、读取分诊（7 类格式 → 3 条路）

`readAttachmentContent()` **两趟**处理：先分诊+直读，再把所有要 OCR 的一次性交给 ocr-paddle（per-case 批量，模型只加载一次）。

| 格式 | 路 | 处理 | status 来源 |
|------|----|------|------------|
| 文本层 PDF | 直读 | PyMuPDF 文本块面积占比判有无文本层，有则直接抽文字 | ok |
| 标准 DOCX | 直读 | python-docx 读段落+表格 | ok / empty(读空) |
| 扫描 PDF | OCR | 无文本层 → 交 ocr-paddle(内部 fitz 渲染各页再识别) | ok/empty/failed |
| JPG / PNG | OCR | 交 ocr-paddle | ok/empty/failed |
| 旧版 .DOC | 转换 | LibreOffice `soffice --convert-to docx` → 再 python-docx 读（soffice 在 `D:\软件\`） | ok / 转换失败→failed |
| 非标 DOCX | 转换 | python-docx 读空 → LibreOffice 转 PDF → 文本层/OCR | ok / empty |
| 未知 | 兜底 | 读前 2KB 当文本,可打印率够则留摘要,否则 failed | empty/failed |

### 文本层 PDF 判据
用"文本块覆盖页面面积占比"（`ratio≥0.03` 或正文≥200字）判定有无真实文本层——比旧的"数中文字"稳（页眉水印骗不过）。无文本层 → 走 OCR。

### 调用 ocr-paddle（图片 / 扫描PDF）
`data-prep` 把本 case 所有图片+扫描PDF 拼成清单，一次性调 CLI：
```
node <QUAL_OCR_CLI> <manifest.json>   # {"files":[{"path","kind":"image|pdf"}]}
```
返回每文件 `{status, text, segments:[{text,score,bbox}], low_conf, engine}`。详见 `../ocr-paddle/SKILL.md`。
- `QUAL_OCR_CLI` 默认按 `__dirname` 解析到 `../ocr-paddle/scripts/ocr.cjs`（不靠 cwd）。
- 引擎 = PP-OCRv5 mobile 经典管线，纯 CPU，一页 4~16 秒，单线程（可复现）。
- CLI/引擎任何失败 → 该文件 `status:failed`，不抛异常、不中断整批。

### ⚠️ PowerShell GBK 编码坑（仍适用）
Windows PowerShell 默认 GBK，Python 直接 `print()` 生僻 Unicode（‱ † ‡ © ® 等合同/法律符号）会 `UnicodeEncodeError` 崩。**原则**：Python 输出走 UTF-8 文件或由 Node 捕获 stdout，不直接 print 到终端；ocr-paddle 的 `ocr_core.py` 已把 stdout 设为 UTF-8。

---

## 四、附件结果对象（含 status）

```json
[
  { "source":"attach_1.png", "type":"image", "status":"ok",
    "low_conf":false, "segments":[{"text":"...","score":0.93,"bbox":[x0,y0,x1,y1]}],
    "content":"识别出的文字...", "size_kb":89, "engine":{"engine_id":"..."} },
  { "source":"attach_2.pdf", "type":"pdf", "status":"ok", "content":"...", "size_kb":256 }
]
```

- `content`：始终是非空字符串（ok=正文；empty/failed=占位说明），供预览/红线兼容用。
- `status`：`ok` / `empty`(认空) / `failed`(读失败)。**`status≠ok` → 跳过该附件，须在评论标注（文件名+原因+"需人工核查原件"）；结论依据剩余可读信息是否覆盖四维度决定（不是依据附件是否失败）：可读信息足够 → 结论照给（附带标注）；可读信息不足某维度 → ⚠️需补充（标注缺失维度）；全部附件均失败且表单信息不足时才给 🔴转人工。**
- `low_conf`：页级置信度参考（advisory）；要严判请下钻 `segments[].score`。
- 全文写盘到 `case_file`，`audit-tool.cjs read-attachment <code> <idx>` 按需有界读，绝不一次灌全。

### 红线/置信度（审核侧）
`deterministic-checker` 入口对 `status≠ok` 或 `low_conf` 的附件标注 `OCR-GATE`（CRITICAL）供人工参考，**但不强制 `passed=false`**——最终结论由大模型基于可读信息做四维度判断后给出，不被附件失败机械覆盖。`audit-tool case` 另回 `ocr_gate.all_ok`。
> 注：`getAttachText*` 这类按 `type` 取文本的辅助逻辑仍以 `type∈{pdf,docx,image...}` 为准；新增 status 字段不改变 type 词表。

---

## 五、读取成功率保障

| 风险 | 解决 |
|------|------|
| PDF 文本层 | **逐页判定**(文本块面积占比/字符数)：有字页直接抽文本；**混合件**(部分页有字部分是图)用抽到的文本+标注图片页，不整份 OCR；**纯扫描件**(0 文字页)→ 走下方"扫描PDF渲染" |
| DOCX 乱码 | python-docx（自动处理 XML 命名空间/编码） |
| 大文件内存溢出 | 单文件 >30MB 跳过并标 failed |
| 扫描PDF（2026-07 改） | **渲染前 N 页(dpi150)为图片 → 子代理视觉**（`QUAL_VISION_MAX_PAGES` 默认3，按 case 封顶 `QUAL_CASE_MAX_VISION` 默认8）；结果 `status:needs_vision` + `vision_paths`(多张页图) + `truncated_pages:true`。**paddle 降为渲染失败/`QUAL_OCR_MODE=paddle` 离线兜底**。17MB/30页扫描：整份 paddle 5min+ → 渲前3页 2.3s。⚠️ `truncated_pages` 附件：关键证据没在已读页确认就结论保守(需补充/需人工核) |
| 图片(jpg/png) | 子代理视觉(needs_vision，1 张) |
| OCR 读不出/低置信 | **不静默**：status≠ok → OCR-GATE 标注 + 跳过该附件，基于可读信息判断四维度；可读信息足够 → 结论照给，不足 → ⚠️需补充；low_conf 仅参考，不升级结论 |
| .doc / 非标DOCX | LibreOffice 自动转换(soffice 在 `D:\软件\`，soffice 偶发提前退出已加输出轮询兜底)；真转换失败 → status:failed → ⚠️需补充（标注转换失败原因） |

---

## 六、附件使用规则

1. **读取是前置** — 步骤3 在步骤4 之前。
2. **不机械复述** — 附件内容转化为各维度判断依据。
3. **按需读取** — 用 `read-attachment` 取需要的附件全文，不一次灌全。
4. **跨文档对照** — 多附件交叉验证。
5. ⚠️ **读不出 → 跳过，基于可读信息判断** — `status≠ok` 时跳过失败附件，用剩余可读信息做完整四维度判断：可读信息足够 → 结论照给（评论逐一标注失败附件+原因+"需人工核查原件"）；可读信息不足某维度 → ⚠️需补充（标注缺失维度+所有失败附件）；全部失败且表单信息不足才给 🔴转人工；`low_conf` 仅参考，绝不因它升级结论。
