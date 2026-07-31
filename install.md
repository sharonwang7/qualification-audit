# 安装指南

## 概述

资质审核技能包（qualification-audit）是一个基于 OpenClaw/FanDo 的自动化审批助手，支持法人岗（faren）和非法人岗（feifaren）两种角色。

---

## 一、前置要求

| 工具 | 版本要求 | 用途 |
|------|----------|------|
| **Git** | 任意 | 克隆仓库 + 版本管理 |
| **Node.js** | 18+ | 运行 audit-tool.cjs |
| **Python 3 + uv** | 3.10+ | 文本层 PDF/DOCX 直读（pymupdf/python-docx） |
| **lark-cli** | 最新 | 飞书命令行工具（调飞书API） |
| **PowerShell** | 5.1+ | gen-card 脚本（Windows 自带） |
| **LibreOffice** | 7.x+ | 可选 — .doc 旧格式 / 非标 DOCX 需要 |

---

## 二、安装步骤

### 步骤 1：安装 lark-cli

```bash
npm install -g @larksuite/cli
lark-cli auth login
lark-cli auth status   # 确认登录成功
```

### 步骤 2：安装 Python 依赖

```bash
uv pip install pymupdf python-docx requests pillow
```

### 步骤 3：安装 LibreOffice（可选）

仅当你需要用 `.doc` 旧格式 Word 或非标 DOCX 转换时才需要。

下载：https://www.libreoffice.org/download/

安装后运行一次 `node scripts/audit-tool.cjs setup`，AI 会自动检测 LibreOffice 路径并写入 `.env`。无需手动配置路径。

### 步骤 4：克隆仓库

```bash
git clone https://github.com/sharonwang7/qualification-audit.git
cd qualification-audit
```

### 步骤 5：复制环境变量模板

```bash
copy .env.example .env
```

然后编辑 `.env`，填入你自己的飞书应用信息：
- `FEISHU_APP_ID`：你的飞书应用 ID
- `FEISHU_USER_OPEN_ID`：你的审批人 open_id（从飞书后台获取）

### 步骤 6：自动配置 QUAL_DEFINITION_CODE（新！v3.2.0）

**不再需要手动去飞书后台复制审批定义 code。**

```bash
node scripts/audit-tool.cjs setup
```

AI 会调用飞书 API 列出你应用下所有审批定义清单，每行显示序号、审批名称、分组。

找到「资质申请」（或你对应的审批名称）的**序号**，运行：

```bash
node scripts/audit-tool.cjs setup-set <序号>
```

QUAL_DEFINITION_CODE 自动写入 `.env`，一步完成。

### 步骤 7：设置岗位角色

编辑 `.env`，去掉 `QUAL_AUDIT_ROLE` 的注释并设为你的岗位：

```bash
QUAL_AUDIT_ROLE=faren      # 法人岗：法人/董事/股东类 + cross-type
QUAL_AUDIT_ROLE=feifaren   # 非法人岗：品牌/商标/授权书类
```

不设则在首次运行时 AI 会弹卡片让你选择。

### 步骤 8：设置数据目录（🔴 生产必做）

```bash
QUAL_AUDIT_DIR=D:\agent-hub\audit_reports
QUAL_PENDING_ACTIONS=C:\Users\<你的用户名>\...\pending_actions.json
```

### 步骤 9：验证安装

```bash
node scripts/audit-tool.cjs --help
```

输出应显示所有子命令（list / case / write-result / fair / gen-card / setup 等）。

### 步骤 10：运行冒烟测试（推荐）

```bash
node scripts/smoke.cjs                     # 运行时冒烟
node golden_tests/runner.cjs               # 结构+守卫+一致性回归
```

两闸全绿 → 安装完成。

---

## 三、常用命令速查

| 命令 | 用途 |
|------|------|
| `node scripts/audit-tool.cjs list` | 列出待审批件 |
| `node scripts/audit-tool.cjs case <code>` | 审计单件 |
| `node scripts/audit-tool.cjs fair "<用户原文>"` | 批量执行 F#/A#/I#/R# 裁决 + 发卡 |
| `node scripts/audit-tool.cjs write-result <code> <json>` | 手动落盘审核结果 |
| `node scripts/audit-tool.cjs setup` | 探测审批定义列表 |
| `node scripts/audit-tool.cjs setup-set <序号>` | 认领审批定义、写入 .env |

---

## 四、更新技能包

当远程仓库有新版本时：

```bash
git pull origin master
node scripts/smoke.cjs       # 确认冒烟绿
```

---

## 五、常见问题

- **Q: lark-cli 报 auth 错误？** A: 先跑 `lark-cli auth login` 重新登录
- **Q: gen-card 报找不到 PS1？** A: 检查 `.env` 中 `QUAL_CARD_SCRIPT=scripts/gen_card_from_json.ps1`
- **Q: .doc 文件读不了？** A: 安装 LibreOffice，AI 会自动检测路径（无需手动配）
- **Q: setup 命令列表里没有「资质申请」？** A: API 默认返回前 50 条，如果审批在更后面，手动把 code 写入 `.env` 的 `QUAL_DEFINITION_CODE=...`
- **Q: 附件缓存目录在哪？** A: 启动时自动检测/创建，无需手动配置。优先使用 `D:\fando-ocr-cache`；若无 D 盘则自动创建到系统临时目录
