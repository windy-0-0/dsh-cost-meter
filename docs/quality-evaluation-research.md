# 质量评估功能调研报告（v0.1，2026-09）

> 本报告为 dsh-cost-meter 二期"生成质量/任务交付/效率/过程评估"功能的设计依据。
> 调研方法：权威论文与工业实践综述；证据标注：【论文支撑】= 有同行评议论文直接支撑；【工业实践】= 主流产品/开源项目实践；【合理推断】= 工程推断未经直接实验验证。

## 核心结论（TL;DR）

1. 单轮文本质量评估的学界主流是 **LLM-as-a-judge**（GPT-4 评委与人类一致性 >80%，接近人类间一致性上限 ~81%），但存在位置偏差、冗长偏差、自我偏好、评委漂移、采样方差等系统性偏差，必须配合 rubric、参考答案、多采样、位置交换、多评委等协议使用【论文支撑】。
2. **任务交付质量的金标准是程序化可执行验证**（SWE-bench 的 fail-to-pass 测试、WebArena 功能性 reward、τ-bench 数据库状态断言、OSWorld 执行态验证）：确定性、可复现、零额外 LLM 成本【论文支撑】。
3. 生成效率与执行过程质量尚无公认指标：可借鉴 AgentBoard 的 progress rate（进展率）、AgentOhana 的 token 成本度量、ProcessBench 的"过程监督"思路【论文支撑】。
4. 事实性检测有 FActScore（原子事实核验）、SelfCheckGPT（采样一致性）、RAGAS（faithfulness）等成熟方法【论文支撑】。
5. 提示词注入会直接威胁评估管线本身——评估器必须把被评内容视为不可信数据、优先依赖确定性指标【论文支撑】。
6. 推荐**两级方案**：Level 1 = 确定性程序化指标（实时、零 LLM 成本、抗注入）；Level 2 = LLM-judge（按需触发、多采样 + rubric + 参考 + 防偏差协议）。

## 与 dsh-cost-meter 的落地映射

| 评估对象 | 主要方法谱系 | 落地层级 |
|---|---|---|
| 文本生成质量 | LLM-as-a-judge / G-Eval / AlpacaEval / MT-Bench | L1 代理信号 + L2 评委 |
| 任务交付结果 | SWE-bench / WebArena / τ-bench / OSWorld 程序化验证 | **L1 为主（金标准）** |
| 生成效率 | AgentOhana、缓存计费口径 | L1 为主（v0.1 已实现费用层） |
| 执行过程质量 | PRM/ProcessBench、AgentBoard progress rate、ToolEmu | L1 代理信号 + L2 抽样轨迹评审 |
| 轮级/会话总体 | 上述方法时间序列聚合 | L1 全量 + L2 抽样/会话末 |

## 关键偏差与缓解协议（L2 实施必读）

| 偏差 | 证据 | 缓解 |
|---|---|---|
| 位置偏差 | Zheng 2023; Wang et al. 2023 | 双序评分取平均；一次只评一个对象 |
| 冗长偏差 | Zheng 2023; Saito 2023; Dubois 2024 | rubric 明示惩罚冗余；长度控制回归（LC） |
| 自我偏好 | Zheng 2023; Panickssery 2024 | 评委与被评模型分离；多评委交叉 |
| 评委漂移 | Zhu et al. 2024（Judging the Judges） | 固定评委版本；固定协议模板；分数仅内部可比 |
| 采样方差 | SelfCheckGPT/self-consistency 思路 | n≥3 采样，报告 mean±std；判定类用多数 |
| 提示敏感 | Wang et al. 2023 | 评分标准版本化、冻结 |

已发表的缓解协议：位置交换+双序平均、rubric+参考答案（一致性最高）、多模型评审团（Verga 2024，最高约 16× 成本优势）、评委校准（CALM，Ye 2024）、长度控制回归、人校准集持续回归（50–100 条，目标 κ>0.7）。

## 提示词注入下的评估可靠性（评估器自身是攻击面）

1. L1 优先：确定性指标完全不受注入影响，是最可靠的抗注入层；
2. L2 把被评内容当**不可信数据**：分隔符声明 + instruction hierarchy（Wallace 2024）；
3. "是否完成/是否真实存在"一律交 L1 程序化判定，评委只评文本相对质量；
4. 评估器绝不执行被评内容中的动作（URL/命令/文件）；
5. 评委调用不携带历史被评内容进入系统提示（防注入累积）。

## 后续实施路线（建议）

- **Phase A**：L1 指标引擎（工具调用成功率/重试/重复调用/错误循环/无进展步占比 + 格式合规 + 引用存在性）——全部为日志纯函数，零 LLM 成本；
- **Phase B**：会话级聚合与趋势（成功率、token、缓存命中、循环次数）；
- **Phase C**：L2 按需评委（触发条件 = L1 告警/随机抽样/会话末），严格按偏差缓解协议，人校准集回归；
- 阈值校准：先在真实历史日志上验证区分度再启用告警。

## 参考文献（节选 36 篇，完整列表见项目 docs）

LLM-as-a-Judge (arXiv:2306.05685) · Chatbot Arena (2403.04132) · LLMs are not Fair Evaluators (2305.17926) · Length-Controlled AlpacaEval (2404.04475) · Juries (2404.18796) · Judging the Judges (2406.12624) · G-Eval (2303.16634) · SWE-bench (2310.06770) · WebArena (2307.13854) · OSWorld (2404.07972) · τ-bench (2406.12045) · AgentBench (2308.03688) · AgentBoard (2401.13178) · Agent-as-a-Judge (2410.10934) · ToolEmu (2309.15817) · PRM (2305.20050) · ProcessBench (2412.06559) · FActScore (2305.14251) · SelfCheckGPT (2303.08896) · RAGAS (2309.15217) · AgentDojo (2406.13352) · Instruction Hierarchy (2404.13208) · Lost in the Middle (2307.03172) · Self-Consistency (2203.11171) · Efficient LLMs Survey (TMLR 2024) 等
