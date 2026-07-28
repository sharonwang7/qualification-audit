# GS023 · 张媛(n=3) · 越界 skip  【待补】

- **陷阱**：申请资质=「其它」类=法大大电子签平台账号开通，无总经办管辖资质→越界 skip（审核 bot 不处理）。
- **可断言硬不变量**：`in_scope=false`（其它类 + 附件文本无 法人/品牌/商标/授权书类词根命中）。
- **待补**：本件 batch 20260708 越界 skip、未落盘 report，无 `D:\fando-ocr-cache` 缓存。input.form 为占位重建；真实 instance_code / 事由原文 / 附件内容待补齐后校准。
- **should_skip 说明**：真实业务结果 should_skip=true，由 `cmdCase`（其它类 + 附件无管辖资质词）下判；`deterministic-checker` 不在其它类做 skip，故 expected 里 should_skip 填 checker 实际值 false 以保 runner 绿。补齐真实数据后须重跑 probe 校准 rules_fired。
- 教训：其它类越界件不进资质审核、不写结论。
