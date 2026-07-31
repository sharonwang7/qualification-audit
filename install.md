# 安装指南

## 🤖 小白模式（推荐：全程跟 AI 说人话，不碰 GitHub）

你不需要懂 GitHub、不需要命令行。**四句话上手**：

1. **「帮我安装/更新资质审核技能包」** → AI 下载最新版、建好数据目录。
2. **「帮我检查并修复资质审核配置」** → AI 跑 `doctor` 自动修：删无效的卡片路径、把发卡群设成【你当前这个群】、告诉你现在是什么环境。缺飞书凭证时 AI 会带你补。
3. **「跑 list」** → 首次会弹卡片让你【选岗位：法人岗 / 非法人岗】，选完自动按你岗位过滤（法人岗审法人/董事/股东类；非法人岗审品牌授权书/商标类）。
4. **「审核」** → AI 审完出卡片【到你自己的群】，你点 F/A/I/R 确认。

> 🧪 **默认是测试环境**：能走完整流程、能在自己群看到卡，但点 F/A/I/R **不会真审批**（安全练手）、台账隔离。
> 流程确认 OK 后，跟 AI 说 **「切正式环境」** 才开始真审批真执行。

> 💡 装过一次但配置出过问题？**不用重装重来**——只要 ①「更新技能包」②「帮我检查并修复配置」（doctor 自动修）③「跑 list」，当场就好。

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

需要填的（或直接让 AI 跑 `node scripts/audit-tool.cjs doctor --fix --chat-id <你的群>` 自动补）：
- `FEISHU_APP_ID`：你的飞书应用 ID
- `FEISHU_USER_OPEN_ID`：你的审批人 open_id
- `LARK_AUDIT_CHAT_ID`：发卡群 = **你当前这个群**的 chat_id
- 🔴 岗位（faren/feifaren）**别在这里填**——留空，首次跑 `list` 会弹卡片让你选（填了就跳过选岗流程）。
- `QUAL_CARD_SCRIPT` / 数据目录 / 附件目录：**不用配**，代码自动定位。

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
node scripts/audit-tool.cjs doctor     # 🩺 配置体检：缺啥/坏啥一目了然（加 --fix [--chat-id <群>] 自动修）
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
