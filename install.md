# 安装指南

## 前置要求

- **Node.js** 18+
- **Python** 3.10+（文本层 PDF/DOCX 直读用）
- **Git**（版本管理）
- **lark-cli**（飞书命令行工具）
- **Windows PowerShell**（gen-card 脚本用）
- **LibreOffice**（可选 — .doc / 非标 DOCX 需要，未装则此类附件标 failed → 转人工）

## 安装步骤

### 1. lark-cli

```bash
npm install -g @larksuite/cli
lark-cli auth login
lark-cli auth status
```

### 2. Python 依赖（文本层文件读取）

```bash
uv pip install pymupdf python-docx requests pillow
```

### 3. LibreOffice（可选）

用于 `.doc` 旧格式 Word、非标 DOCX 的格式转换。不装则此类附件标记为读取失败、转人工审核。

下载：https://www.libreoffice.org/download/  
装完后在 `.env` 中配置 `QUAL_SOFFICE_BIN`（指向 soffice.exe），或靠自动探测（依次搜常见安装路径）。

### 4. 环境变量

复制 `.env.example` 为 `.env` 并填入你自己的配置：

```
FEISHU_APP_ID=<你的飞书应用ID>
FEISHU_USER_OPEN_ID=<审批人open_id>
QUAL_ATTACH_DIR=<附件缓存目录，如 D:\fando-ocr-cache>
QUAL_CARD_SCRIPT=scripts/gen_card_from_json.ps1
LARK_AUDIT_CHAT_ID=<审核结果发卡群chat_id>
QUAL_SOFFICE_BIN=<LibreOffice路径，如 D:\Program\soffice.exe>  # 可选
```

### 5. 验证安装

```bash
cd <skill 目录>
node scripts/audit-tool.cjs --help
```

输出应该显示所有子命令（list / case / write-result / fair / gen-card 等）。

## 常见问题

- **Q: `lark-cli` 报 auth 错误？** A: 先跑 `lark-cli auth login` 登录飞书账号
- **Q: gen-card 报找不到 PS1？** A: PS1 已在 `scripts/gen_card_from_json.ps1`，检查 `.env` 中 `QUAL_CARD_SCRIPT=scripts/gen_card_from_json.ps1`
- **Q: 附件为图片/扫描 PDF，OCR 读不出来？** A: 本技能包使用子代理视觉模型（`image()`）读取图片，不依赖外部 OCR 引擎。如有特殊需求可另行安装 ocr-paddle skill 包
- **Q: .doc 文件读不了？** A: 安装 LibreOffice 并在 `.env` 中配置 `QUAL_SOFFICE_BIN`
