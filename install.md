# 安装指南

## 🤖 小白模式（推荐：一句话安装）

你不需要懂 GitHub、不需要装任何命令行工具。直接跟你的 AI 助手说：

> **「帮我安装资质审核技能包」**

AI 会自动完成：下载 → 装依赖 → 探测审批定义 → 创建目录 → 验证。全程只需要你点一两次确认。

---

## 💻 命令行模式（如果你会用 Git）

### 下载（首次安装）

打开终端（PowerShell 或 CMD），输入：

```bash
git clone https://github.com/sharonwang7/qualification-audit.git
cd qualification-audit
```

这会把整个技能包下载到你当前目录下的 `qualification-audit` 文件夹里。

### 配置

```bash
# 1. 复制环境变量模板
copy .env.example .env

# 2. 编辑 .env，填入你的飞书信息
notepad .env
```

需要填的：
- `FEISHU_APP_ID`：你的飞书应用 ID
- `FEISHU_USER_OPEN_ID`：你的审批人 open_id
- `QUAL_AUDIT_ROLE=faren` 或 `feifaren`

### 自动探测审批定义（新！v3.2.0）

不用去飞书后台复制 code，AI 帮你列清单：

```bash
node scripts/audit-tool.cjs setup
```

从列表里找到「资质申请」的序号，然后：

```bash
node scripts/audit-tool.cjs setup-set <序号>
```

其他配置（附件目录、数据目录）启动时自动检测，**不需要手动配**。

### 验证安装

```bash
node scripts/audit-tool.cjs --help     # 看所有命令
node scripts/smoke.cjs                  # 运行时冒烟测试
node golden_tests/runner.cjs            # 结构+守卫回归测试
```

---

## 🔄 更新技能包（以后出新版本时）

只需要一行命令：

```bash
git pull origin master
```

拉完后再跑一下冒烟确认没问题：

```bash
node scripts/smoke.cjs
```

---

## 🖱️ 纯手动下载（不会用 Git 也装不了 AI）

1. 浏览器打开 👉 **https://github.com/sharonwang7/qualification-audit**
2. 点页面中间的 **绿色「Code」按钮** → 选 **「Download ZIP」**
3. 解压到任意文件夹
4. 把文件夹路径发给 AI：「技能包在 XXX 路径，帮我完成安装配置」

---

## 📋 你需要准备的东西

| 需要什么 | 在哪找 |
|----------|--------|
| 飞书账号 | 你每天用的那个 |
| 飞书应用 ID | 问 IT，或让 AI 帮你查 |
| 审批人 open_id | 问 IT，或让 AI 帮你查 |
| Git（命令行模式需要） | https://git-scm.com/download/win |
