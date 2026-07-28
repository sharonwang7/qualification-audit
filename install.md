# 安装指南

## 前置要求

- **Node.js** 18+
- **Python** 3.10+
- **Git**（版本管理）
- **lark-cli**（飞书命令行工具）
- **Windows PowerShell**（gen-card 脚本依赖）

## 安装步骤

### 1. lark-cli

```bash
npm install -g @larksuite/cli
```

验证：
```bash
lark-cli auth status
```

### 2. Python 依赖（OCR + 文件处理）

```bash
uv pip install paddleocr pymupdf python-docx requests pillow
```

### 3. 验证安装

```bash
cd <skill 目录>
node scripts/audit-tool.cjs --help
```

输出应该显示所有子命令（list / case / write-result / fair / gen-card 等）。

## 环境变量

复制 `.env.example` 为 `.env` 并填入你自己的配置：

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 ID |
| `FEISHU_USER_OPEN_ID` | 审批人 open_id |
| `QUAL_ATTACH_DIR` | 附件缓存目录 |
| `QUAL_CARD_SCRIPT` | gen_card_from_json.ps1 路径 |
| `LARK_AUDIT_CHAT_ID` | 审核结果发卡群 chat_id |

## 常见问题

- **Q: `lark-cli` 报 auth 错误？** A: 先跑 `lark-cli auth login` 登录飞书账号
- **Q: PaddleOCR 安装失败？** A: 用 `uv pip install paddlepaddle` 先装 paddle 再装 paddleocr
- **Q: gen-card 报找不到 PS1？** A: 检查 `QUAL_CARD_SCRIPT` 指向正确的 `gen_card_from_json.ps1` 路径
