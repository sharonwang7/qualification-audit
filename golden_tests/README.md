# 黄金测试计划 · qualification-audit 回归测试

> 目标：在改代码前，先用黄金测试集跑通旧逻辑，确认基线；
> 改代码后，同一套测试验证新规则不破坏旧功能 + 新规则到位。

## 变更清单（待测修改）

| 编号 | 改动 | 类型 | 测试层级 |
|------|------|------|---------|
| C01 | spawn 模板 `&&` → `;`（PS兼容） | prompt模板文本 | 集成 |
| C05 | gen-card → fair 之间加 `card_was_generated` 守卫 | 代码逻辑 | 单元 |
| C06 | fair 遇 1390001 停链不继续 | 代码逻辑 | 单元 |
| C07 | fair 加 `--source` 守卫，拒绝 agent 自造指令 | 代码逻辑 | 单元 |
| C08 | gen-card 卡 <1KB 时发纯文本 fallback | 代码逻辑+消息 | 集成 |

> C02(spawn遗漏机制已存在、我未执行)/C04(list格式非bug) 无需测试。
> C03(kimi-k3不稳定的问题用指定model解决，非代码改动)。

---

## 一、测试策略

### 分层

```
T1 - 纯单元测试（完全不依赖飞书API/子代理）
  → C05, C06, C07
  → 用 mock 文件模拟 pending_actions.json / card_map.json 状态
  → 单文件脚本，10秒跑完

T2 - 集成测试（需要 mock 飞书 API 或真实文件系统交互）
  → C01 (spawn模板 → 验证PS下能否执行 cd + node)
  → C08 (gen-card mock 0KB输出 → 验证fallback消息)
  → 需要 mock lark-cli / 真实文件IO

T3 - 全流程黄金剧本（从list → spawn → write-result → gen-card → fair）
  → 重放完整"用户对话"场景
  → 验证秩序守卫不被绕过
```

### 测试目录结构

```
golden_tests/
├── README.md                    # 本计划
├── runner.cjs                   # 测试驱动器
├── fixtures/                    # mock 数据
│   ├── pending_actions.empty.json
│   ├── pending_actions.review.json    # 含 PENDING_REVIEW 条目
│   ├── card_map.existing.json         # 已有发卡记录
│   ├── card_map.none.json             # 无发卡记录
│   ├── mock_case_1.json               # 标准通过件
│   ├── mock_case_2.json               # OCR-GATE触发件
│   └── ...
├── tests/
│   ├── T1_fair_source_guard/     # C07
│   ├── T1_fair_1390001_stop/     # C06
│   ├── T1_fair_no_card_guard/    # C05
│   ├── T2_gen_card_fallback/     # C08
│   ├── T2_spawn_template/        # C01
│   └── T3_golden_flow/           # 全流程
└── expected/                     # 期望输出（json diff用）
```

---

## 二、单元测试（T1）：详细设计

### T1.1 — C07：fair source 守卫

**场景**：fair 收到自行构造的指令 vs 用户消息

**输入**：
```
# 测试 1.1a：agent来源被拒
fair("通过：F#99", { source: "agent" })

# 测试 1.1b：message来源放行  
fair("通过：F#99", { source: "message" })
```

**期望**：
- 1.1a → throw / return `{ok:false, reason: /source.*agent/}`
- 1.1b → 正常执行（无守卫阻断）

**隔离要求**：
- mock 掉 `cmdApprove`（不真调飞书API）
- mock 掉 `readPendingActions` 返回提前 mock 好的数据

### T1.2 — C06：fair 1390001 停链

**场景**：多条 token 中一条报 `approval process has ended`

**输入**：
```
# 模拟 3 条 token：第1条成功、第2条报1390001、第3条也应被跳过
mock(token1 -> {ok:true})
mock(token2 -> throw(1390001))
mock(token3 -> {ok:true})  // 不应被执行

fair("通过：F#99 通过：F#100 通过：F#101")
```

**期望**：
- token2 报 1390001 后，token3 **未执行**
- 返回 `{stopped: true, stopped_at: "F#100"}`
- 或返回 `{ok:false, reason: /已停止|1390001.*停链/}`

**隔离要求**：
- mock `cmdApprove` 的行为（按 token 序号返回不同结果）
- mock `readPendingActions` + `isSettled` 等相关函数

### T1.3 — C05：card_was_generated 守卫

**场景**：write-result → PENDING_REVIEW → fair，但没有 gen-card

**输入**：
```
# mock pending_actions 含 PENDING_REVIEW 条目
# mock card_map.json 不存在（从未发过卡）

fair("通过：F#72")
```

**期望**：
- 返回 `{ok:false, reason: /card.*未生成|first.*gen-card/}`
- pending_actions 状态不变（仍为 PENDING_REVIEW）

**正向用例**：
```
# mock card_map.json 存在
fair("通过：F#72")
```
- 正常执行

---

## 三、集成测试（T2）

### T2.1 — C08：gen-card 卡 <1KB 时发纯文本 fallback

**输入**：
```
# mock gen-card 输出 0.6KB
# 检查是否有纯文本消息发送逻辑
```

**期望**：
- gen-card 返回值含 `fallback_text` 字段
- fallback_text 包含：verdict、人员、审批链接
- （通过 mock `message.send` 检查消息内容）

**注意**：如果 gen-card 在 PS1 里，这个测试需要在 PS 环境中验证。

### T2.2 — C01：spawn 模板 PS 兼容性

**输入**：
```
cd C:\...\qualification-audit; node scripts/audit-tool.cjs case <code>
```

**期望**：
- 在 PowerShell 下执行成功（exit code 0）
- 对比 ``cd ... && node ...`` 在 PS 下 exit code 非零

---

## 四、全流程黄金剧本（T3）

### 剧本 1：标准通过流程

```
步骤：
1. list 返回 expected = [test_golden_001]
2. spawn 子代理 → 子代理 write-result 落盘 → 返回 ok
3. gen-card → card_map.json 生成 ✓
4. fair "通过：F#N" → 通过 ✓

验证：
- pending_actions: test_golden_001 → CLOSED
- card_map.json 存在
- 无错误返回
```

### 剧本 2：卡未发直接 fair 被拦

```
步骤：
1. write-result → pending_actions.PENDING_REVIEW
2. fair "通过：F#N" → 拒绝(ED_NO_CARD) ✓

验证：
- pending_actions: 仍 PENDING_REVIEW
- 拒绝消息含"card.*未生成"
```

### 剧本 3：子代理超时被 register-orphans 兜底

```
步骤：
1. list expected = [test_golden_003a, test_golden_003b]
2. spawn 两条 → 但只一条 write-result
3. register-orphans → 003a 有 result_file → 自动 register done
                     003b 无 → 跳过
4. batch-fail 003b → failed
5. gen-card → 1 done + 1 failed ✓

验证：
- outcomes: test_golden_003a.done, test_golden_003b.failed
- 卡片包含 2 条
```

### 剧本 4：公平测试 — false positive 不得通过

```
步骤：
1. write-result 提交 verdict=通过
   但 fullAnalysis 缺"业务必要性"板块
   → 被 WR_G5 拒绝 ✓

验证：
- write-result 返回 ok:false
- 错误消息含 "WR_G5"
```

---

## 五、测试驱动器设计

```js
// runner.cjs 核心接口
const runner = {
  // 重置测试环境：清空 mock 目录
  reset(scope) {
    // scope = 'all' | 'T1' | 'T2' | 'T3'
  },

  // 注册 mock 文件
  mock(path, content) { 
    fs.writeFileSync(join(MOCK_DIR, path), content);
  },

  // 注册 mock 函数
  mockFn(module, fnName, behavior) {
    // behavior: { return: val } | { throw: err }
  },

  // 执行被测试的函数
  run(subject, args) {
    // 通过子进程调用 audit-tool.cjs method
    // 或直接 require 后调用
  },

  // 断言
  assert(actual, expected) {
    // deep diff + 自定义匹配
  },

  // 报告
  report() {
    // 表格输出：通过/失败/跳过
  }
};
```

---

## 六、执行顺序

```
Phase 1: 不改代码跑基线
  T1.1, T1.2, T1.3（mock pending_actions 即可）
  → 确认 baseline 下这些测试失败（因为守卫还不存在）或通过

Phase 2: 改守卫代码
  audit-tool.cjs:
    - fair() 入口加 --source 检查  (C07)
    - fair() 遇 1390001 停链       (C06)  
    - cmdApprove 里检查 card_map   (C05)

Phase 3: 再跑 T1，确认通过
Phase 4: 跑 T2，确认 C08 + C01
Phase 5: 跑 T3 全流程剧本
```

---

## 七、预期结果矩阵

| 测试ID | 基线 | 改后 | 说明 |
|--------|------|------|------|
| T1.1a | 通过(无守卫) | 拒绝 | C07生效 ✅ |
| T1.1b | 通过 | 通过 | source=message 不受影响 ✅ |
| T1.2 | 全部token通过 | 1390001后停止 | C06生效 ✅ |
| T1.3(负向) | 通过(无守卫) | 拒绝 | C05生效 ✅ |
| T1.3(正向) | 通过 | 通过 | 有card_map不受影响 ✅ |
| T2.1 | 空卡无声 | 空卡+fallback消息 | C08生效 ✅ |
| T2.2 | `&&` 在PS下失败 | `;` 在PS下成功 | C01生效 ✅ |
| T3-1 | 通过 | 通过 | 标准流程不受影响 ✅ |
| T3-2 | 跑通(提前fair) | 被拦(ED_NO_CARD) | 秩序守卫 ✅ |
| T3-3 | 死等30min | register-orphans兜底 | 现有机制被激活 ✅ |
| T3-4 | 通过(侥幸) | WR_G5拒绝 | 现有机制确认 ✅ |
