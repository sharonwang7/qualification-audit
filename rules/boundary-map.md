# 专有 / 通用 边界编目（boundary-map）· P0 非侵入式

> **本文件是元数据，不参与运行时。** SKILL.md 不引用它，agent 不加载它 → 对 agent 实际运行零影响。
> 目的：在**不动任何 live 文件一个字节**的前提下，标清"哪些是可跨行业复用的通用骨架、哪些是资质专有内容"，为后续（受 agent-eval 把关的）物理抽取提供地图，也为商业化"换一家公司要替换哪块"给出清单。
>
> 最高优先级（王爷定）：**不影响 agent 跑 skill 的稳定/高质/流畅**。故 P0 只编目、不切割；真正的物理抽取延后，且门槛见文末。

---

## 一、分类判据

- **通用骨架（可复用）**：方法、框架、决策哲学——换个行业照样成立。如"三阶段结构""被证明≠被说明""一次性列缺""四维度检查""四档结论""疑则补默认""错误降级"。
- **资质专有（要替换）**：填进框架的**领域内容**——换行业就得整包换。如具体证据物（双章合同/律师函）、证据链层级 7 行表、授权书数值边界、新项目四要素、退回/需补充的具体触发、水印文案、`entities.json` 内部主体引用。
- **混合**：同一段里框架与内容交织——记下"若抽取该怎么切"。

## 二、消费方 → 决定护栏

抽取时能不能廉价验证，取决于这块被谁读：

| 消费方 | 谁读它 | 物理抽取的护栏 |
|---|---|---|
| **代码** | deterministic-checker.js / scope-filter.js 等 | **golden T1 可测** → 移动+改 require 路径可用 golden 验证 |
| **agent 上下文** | 大模型读 SKILL.md/references 做判断 | **golden 测不到** → 必须**全量 agent-eval 盲评**把关 |

---

## 三、analysis-protocol.md 段落级边界（17KB，最交织的文件）

> 消费方 = **agent 上下文**（SKILL.md 步骤4 引用，判断前必读）。故此文件任何物理切割都属"改 agent 读到的文本"，护栏 = agent-eval，**不进 P0**。

| 行范围 | 内容 | 类别 | 若物理抽取怎么切 |
|---|---|---|---|
| 1–7 | 标题 + "三阶段" 引言 | 通用 | 留通用骨架 |
| 11–24 | 阶段一原则「被证明≠被说明」+ 场景证据表（平台/合作/诉讼/劳动仲裁） | **混合** | 原则=骨架；证据物（双章合同/律师函/仲裁书）=专有 |
| 26–45 | **合作/授权类 证据链层级 7 行表** + 有效性/一致性/缺证据≠造假 注释 | **专有** | 整块入资质 rubric（核心） |
| 49–56 | 阶段二原则「一次性列缺」 | 通用 | 骨架 |
| 58–70 | 四维度：看流向 / 看用途 表 | 混合 | 表结构=骨架；字段（相对方/平台/合同甲方）=专有 |
| 72–98 | 业务必要性 Q1/Q2 + 主体必要性 | 混合 | Q1/Q2/主体框架=骨架；例（法院起诉/中信证券/找回账号）+「为什么必须法人」=专有 |
| 100–105 | 三维度不重叠 + 无证据不脑补 | 通用 | 骨架 |
| 113–127 | 替代控制（概念 + 资质表：法人身份证/签字/授权书） | 混合 | 概念=骨架；资质表=专有 |
| 129–151 | **限制控制：退回/需补充触发 + 授权书数值边界 + 新项目四要素** | **专有** | 整块入资质 rubric（核心） |
| 153–161 | 风险提醒 + 技术控制（水印文案） | 专有 | 入资质 rubric |
| 167–169 | 判断归大模型 / 结论优先级 / 疑则补默认 | 通用 | 骨架（判定哲学） |
| 170–177 | 四档结论（通过/退回/需补充/转人工） | 混合 | 四档框架=骨架；具体触发（造假/双章合同/转授权）=专有 |
| 178–182 | 审核边界·负向规则（不做商业决策） | 混合 | "只判该不该担责"=骨架；internal_entities/证券R1–R5/法人已决策=专有 |
| 186–213 | 附录A 分析一致性 + 错误降级策略表 | 通用 | 骨架（工程机制；提及 hasAIComment 是实现引用） |

**小结**：核心资质 rubric = **26–45 + 129–151 + 153–161**（可整块抽），其余多为"骨架含专有例句"的混合段，切割需逐句分离——正是最需要 agent-eval 把关的部分。

---

## 四、其余专有资产编目

| 资产 | 消费方 | 类别 | 抽取护栏 |
|---|---|---|---|
| `common/scene-principles.md`（P01–P03 场景原则） | agent 上下文 | 专有 | agent-eval |
| `common/examples.md`（资质评论范例） | agent 上下文 | 专有 | agent-eval |
| `common/deterministic-rules.json`（R02/R05… 红线定义） | 代码（deterministic-checker） | 专有 | golden T1 |
| `common/entities.json`（内部/海外主体） | 代码 + 部分 agent 引用 | 专有 | golden（代码路径）；引用文案变更需 agent-eval |
| `common/overseas-entities.json` | 代码 | 专有 | golden T1 |
| `common/department-directors.json`（各中心负责人） | 代码（named-person-rank，fail-open） | 专有 | golden T1 |
| `common/trademark-registry-full.json`（商标库 82KB） | 代码（待确认消费方） | 专有 | golden T1（确认消费方后） |
| `lib/deterministic-checker.js`（确定性红线引擎） | 代码 | 专有 | golden T1 |
| `lib/scope-filter.js`（管辖范围 isInScope） | 代码 | 专有 | golden T1 |
| `lib/named-person-rank.js`（实名人职级，纯逻辑已解耦） | 代码 | 专有 | golden T1 |
| `scripts/build-trademark-registry.js`（商标库构建） | 构建期工具 | 专有 | 非运行时 |

> 注：标「待确认消费方」处未逐一核实读取方，物理抽取前须先确认，不得凭本表直接搬动。

---

## 五、物理抽取延后 —— 门槛

P0 **不做**任何物理切割。将来若做，按消费方分两条路：

1. **代码类专有**（deterministic-checker/scope-filter/named-person-rank + 各 JSON）→ 移入 `rules/` 包 + 改 require 路径，**用 golden T1 全绿验证**（这些块 golden 测得到，风险可控）。
2. **agent 上下文类专有**（analysis-protocol 专有段 / scene-principles / examples）→ 抽成独立 rubric 文件，**必须先建全量 agent-eval 盲评基线，抽取后 conclusion_key 零回归方可合入**。golden T1 对这层无效。

**在能廉价证明"判断质量无回归"之前，agent 上下文类一律不动。**

---

## 六、商业化视角：这张表就是"规则包"边界

换一家公司复用本平台时，需替换的 = 本文标「专有」的全部：
- **代码规则**：deterministic-rules.json + entities/overseas/department JSON + scope-filter/deterministic-checker 的行业逻辑
- **判断 rubric**：analysis-protocol 的专有段（证据链层级/数值边界/四要素/退回触发）+ scene-principles + examples

保留不变的 = 标「通用」的骨架：三阶段结构、四维度、四档结论、疑则补、降级策略、L1 飞书连接器（已 P0 收拢）。
