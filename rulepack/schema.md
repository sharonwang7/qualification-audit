# 五件套 Schema（规则包中间表示 IR）

> 业务知识 → 机器可执行的确定性判定，桥梁 = 这套统一中间表示。规则包 = 声明式数据；推理内核 = 通用执行器；二者靠加载契约解耦。

## 0. 通用约定

- 各件共享 `pack_meta` 头。ID 前缀：`fld_* / rule_* / rl_* / kb_* / gs_* / stg_*`。
- **四档 verdict**：`pass`(通过) / `warn`(预警·转人工复核·默认兜底) / `reject`(驳回) / `manual`(转人工·规则无法判定)。
- **effect**：`gate`(闸门,参与结论) / `advisory`(提醒,只附建议不改结论)。
- 五件套通过稳定 ID 互相引用：`rules.field_ref → fields.id`；`rules.knowledge_ref → knowledge.id`；`strategy.applies_to → rules.tags`。

```json
// pack_meta（每个包的头）
{ "$schema_version":"1.0", "pack_id":"qualification", "pack_name":"资质审核规则包",
  "domain":"legal.qualification", "version":"0.1.0-draft", "status":"draft",
  "source_refs":[{"type":"doc","ref":"child-judge.md + scenes","note":"资质历史经验"}],
  "generated_by":"rulepack-factory/prompt-chain@1.0", "updated":"2026-08-01" }
```

## 【一】字段定义 fields —— 表单字段 ↔ 审核要素

```json
{ "id":"fld_applicant", "name":"申请人", "type":"string",
  "source":{"channel":"oa_form","locator":"申请人"},
  "aliases":["申请人全称","经办人"], "required":true, "nullable":true,
  "extract_hint":"表单没填则用发起人 open_id 反查真名" }
```
- `type`：`string|money|date|datetime|enum|number|entity|file`
- `source.channel`：`ocr|oa_form|linked_form|knowledge|manual`
- `aliases`：字段名变体，抽取时归一（解决"申请资质 vs 申请类型"同义）
- `extract_hint`：消歧提示；`nullable`：空≠错误，交给缺失兜底

## 【二】规则 rules（核心）—— 数据源A ⟨算子⟩ 数据源B → 判定档

```json
// 同字段不同方向不同档 = 两条独立规则
{ "id":"rule_seal_scope", "subject":"申请资质 vs 本岗位管辖范围", "effect":"gate",
  "datasource_a":{"field_ref":"fld_quals"}, "operator":"in_set",
  "datasource_b":{"knowledge_ref":"kb_my_audit_quals"},
  "direction":"not_in", "verdict_on_hit":"pass", "verdict_on_miss":"manual",
  "reason_template":"申请资质「{a}」不在本岗位管辖，转人工/降越界。",
  "priority":30, "tags":["scope"] }
```
- `effect`：`gate` 参与结论 / `advisory` 只进 notes
- `rule_kind`：`compare`(默认) / `mapping`(映射型,配 `mapping.table_ref`) / `crosscheck`(预留)
- `datasource_*.field_ref`：引用 `fields.id`，可数组=多字段联合
- `threshold`：`{ratio}` / `{grace}` 容差 / `{value}` 常量
- `verdict_on_hit` / `verdict_on_miss`：同字段不同档的落点
- `on_missing_data`：缺数据档，覆盖全局默认
- `priority`：越小越先算；`reason_template`：占位由引擎渲染（`{b-a}` / `{a.title}`）
- **算子表**：`lt/gt/eq/ne/gte/lte`；`gt_ratio/lt_ratio`；`date_after/date_before`(带 grace)；`range_covers/range_overlaps`；`entity_match`(查库归一,配 match_keys)；`in_set/not_in_set`(配 knowledge_ref)；`regex`

## 【三】红线 redlines —— 一票否决

```json
{ "id":"rl_cross_type_to_faren", "name":"跨类型资质硬规则归法人岗",
  "trigger":{"operator":"...","datasource_a":{"field_ref":"fld_quals"}},
  "verdict":"...", "hard_stop":true, "priority":0,
  "reason_template":"...", "audit_note":"硬规则·不可豁免", "tags":["redline"] }
```
- 与普通 `reject` 规则的区别 = `hard_stop:true` 短路整个聚合 + `priority:0` 恒最高 + 单独审计命名空间。普通 reject 不短路（跑完收集全部理由再聚合）。

## 【四】知识/题库 knowledge —— 基准表(registry) + 案例(golden)

```json
{ "id":"kb_my_audit_quals", "kind":"registry", "name":"本岗位管辖资质清单",
  "schema":["qual","note"], "match_index":["qual"],
  "rows":[{"qual":"法定代表人签名","note":"..."}], "source_ref":"MY_AUDIT_QUALS" }

{ "id":"gs_qualification_golden", "kind":"golden", "name":"资质 golden 案例集",
  "cases":[{"case_id":"gs_001","desc":"跨类型→归法人岗",
            "inputs":{"fld_quals":["法定代表人签名","品牌授权书"]},
            "expect":{"verdict":"...","fired_rules":["rl_cross_type_to_faren"]}}] }
```
- `golden.cases[].expect` 同时约束**结论档 + 命中规则集**，是回归锚点。案例须覆盖四档 + 边界 + 至少 1 个历史翻案 case。

## 【五】判断策略 strategy —— 四档聚合

```json
{ "id":"stg_qualification_v1", "playbook":"multi_doc_crosscheck",
  "verdict_scale":["pass","warn","reject","manual"],
  "default_on_missing_data":"warn", "default_on_ambiguous":"warn",
  "aggregation":{
    "order":["redline","gate","advisory"],
    "rule":["任一redline命中→reject(短路)","否则任一gate=reject→reject",
            "否则任一gate=manual→manual","否则任一gate=warn→warn","否则→pass",
            "advisory永不改verdict,只汇入notes"],
    "severity_order":["reject","manual","warn","pass"] },
  "human_review":{"trigger_verdicts":["warn","manual"],"route":"..."},
  "explainability":{"require_reason_per_fired_rule":true,"attach_evidence_refs":true} }
```
- `playbook`：`simple_check | single_doc | multi_doc_crosscheck | complex_multistep`
- 默认档=疑则补·预警；聚合按 severity 取最严；advisory 硬隔离（实现层禁止参与 verdict）

## 承载性（关键需求都有落点）

| 需求 | 落点 |
|---|---|
| 同字段不同方向不同档 | 拆两条 rule，共享 field_ref、方向/档独立 |
| 映射表型规则 | `rule_kind:mapping` + `kb_*` registry |
| 红线优先级 | `redlines` priority:0 + hard_stop，聚合 order 首位 |
| 闸门 vs 提醒 | `effect:gate/advisory` + aggregation 显式隔离 |

> 下一步：把本 schema 抽成正式 JSON Schema(draft-2020-12) 做校验器；把提炼链固化成流水线；用资质真实资料端到端跑通产出资质规则包 + golden。
