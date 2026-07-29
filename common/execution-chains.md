# FAIR 执行链细节（原 SKILL.md 步骤 5-2 详细段落）

> 本文件由 SKILL.md 步骤 5-2 引用。SKILL.md 正文已有紧凑的「用户回复格式 → 执行路径」决策表，**日常执行照那张表走就够**；只有需要核对具体命令顺序/参数时才展开本文件。
> 安全关键的委托授权接线、群判定规则、note 先于 approve/reject 铁律，仍在 SKILL.md 正文内联，不搬到这里。

---

### 执行前检查清单（每次执行 F/A/I 前必过）

```
□ 用户消息含明确指令词（F/A/I/R 或中文等价词）+ #N 编号
□ 用 lookup-case-by-n N 查 instanceCode（#N 已在 write-result 时由全局单调 nextN 永久绑定；
  发卡时同步冻结到 scratch/card_map_latest.json 作快照，可对照确认）
□ instanceCode 对应的 person 姓名与卡片上该 #N 一致（最后防线）
→ 全部满足才执行 approve/reject（note 已内置于 approve/reject，无需单独调用）
```

---

### F/A 执行链（放行 / 反对）

```
1. lookup-case-by-n N → 获取 instanceCode + person
2. 确认 person 姓名与卡片 #N 一致（双重保险）
3. approve(instanceCode) 或 reject(instanceCode, reason)
   ↑ 内部顺序：写评论（note）→ 评论失败则抛错中止 → 执行审批
   ↑ 评论失败时工具自己中止，不需要外部再调 note
```

> 🔴 **`--fair-letter` 必填（2026-07-21）**：approve/reject/note 都必须带用户敲的**原始 FAIR 字母**。工具持有唯一映射 `F=approve / A=reject / I=note / R=revise`，会校验「字母↔子命令」一致，不符即 fail-closed 拒绝。你只管**照抄用户字母**，别再凭记忆挑动词（防 R/A 反接英文先验的误 reject，2026-07-21 事故）。**R 永不走这三个动作**——R=修订走 write-result 重判。

```bash
# 放行（工具内部：先写评论，成功再通过）；用户敲 F → --fair-letter F
node scripts/audit-tool.cjs approve <instance_code> <expected_person> --fair-letter F

# 反对（工具内部：先写评论+原因，成功再拒绝）；用户敲 A → --fair-letter A
node scripts/audit-tool.cjs reject <instance_code> <reason_textfile> <expected_person> --fair-letter A

# 查 #N 对应 instanceCode
node scripts/audit-tool.cjs lookup-case-by-n <N>
```

### I 执行链（询问）

```
1. 读 audit_reports，找 instanceCode
2. 执行 note(instanceCode)           ← 写补充要求评论
3. note 成功 → 审批保持开启，等申请人回复补材料
```

```bash
# 询问（只写补充要求评论，不动审批按钮）；用户敲 I → --fair-letter I
node scripts/audit-tool.cjs note <instance_code> <expected_person> --fair-letter I
```

### R 执行链（修订重新分析）

```
1. 读 audit_reports，找完整 case 信息（instanceCode + fullAnalysis）
2. 结合用户修订原因，执行完整三阶段分析（不能简化）
3. 构造新 result.json，write-result 覆盖原结论
4. gen-card -Round N（卡片头部标注「修订复审 #N」）
5. Turn 结束 → 再次 INTERRUPT，等用户 F#N 或 A#N 确认
```

**注意**：
- F 路径：`approve` 执行后审批通过，申请人得到资质。
- A 路径：`reject` 执行后审批实例**终止**，申请人须重新提交新申请（新 instanceCode，触发全流程）。
- I 路径：审批保持开启，申请人在评论区补充后，Phase 1 下次轮询到有新评论时含入分析。
