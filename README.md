# 💰 dsh-cost-meter

> **DSH 会话费用计量** —— 每一轮、整个会话，花了多少钱一目了然。

[English](README_EN.md) | 中文

[English](README_EN.md) | 中文

![License](https://img.shields.io/github/license/windy-0-0/dsh-cost-meter?style=flat-square)
![Release](https://img.shields.io/github/v/release/windy-0-0/dsh-cost-meter?style=flat-square)
![持久化投影](https://img.shields.io/badge/persistent-projection-4CAF50?style=flat-square)

## 为什么需要它

DSH 界面本身不显示费用。很多人只能去 API 平台看**每个 key 的总账单**，却不知道：

- 某一次对话花了多少钱？
- 每一轮回答花了多少钱？
- 哪一轮最烧钱、为什么烧钱？

自己拿 token 估算又经常不准——因为有三个陷阱：

1. **缓存命中不是免费**（DeepSeek 对 cache hit 单独计价，价格是 miss 的 1/30）；
2. **思考 token 不能重复计费**（`completion_tokens` 已包含 reasoning，社区有些插件的 `output + reasoning` 双加是多算的）；
3. **峰谷价**（工作日高峰时段价格翻倍，历史账单要按发生时刻分桶计价）。

**dsh-cost-meter 逐一解决了这三个问题**：直接消费 DSH 会话事件流里的权威 usage 数据，按官方定价逐 token 精确计费。

## 展示效果

- **每轮尾部**：`¥ 0.0123 · 45.6k tok · 峰时 · v4-flash`（悬停查看完整分解：输入未命中 / 缓存命中 / 输出含思考）；
- **会话标题行右侧**：`¥ 1.2345 · 12.3M tok`（本会话累计）；
- **实时速度**：模型流式输出时，输入框上方显示 `⚡ ¥0.0123/s · 12.3k/s`（6 秒滑窗均值，空闲自动隐藏）——像下载速度一样看钱在流动。

## 计费口径（准确性保证）

| Token 类别 | DSH usage 字段 | 单价 | 说明 |
|---|---|---|---|
| 输入未命中缓存 | `inputTokens` | miss 价 | `prompt_tokens - cache_hit`，disjoint 语义 |
| 输入缓存命中 | `cacheReadTokens` | hit 价 | 自动上下文缓存，价格约为 miss 的 1/30 |
| 输出（含思考） | `outputTokens` | out 价 | `completion_tokens` 总量；`reasoningTokens` 是子集，**不再重复计费** |

价格表（¥/百万 token，DeepSeek 2026-08-17 生效，峰价 = 北京时间工作日 9–12 / 14–18，2026-08-23 起周末全天谷价）：

| 模型 | hit（谷/峰） | miss（谷/峰） | out（谷/峰） |
|---|---|---|---|
| v4-flash / chat / reasoner / vision-exp | 0.05 / 0.1 | 1.5 / 3.0 | 4.5 / 9.0 |
| v4-pro | 0.15 / 0.3 | 4.5 / 9.0 | 13.5 / 27.0 |

历史事件**按发生时刻**分桶计价（含 8/23 周末规则生效分界），改价重放也不失真。

## 架构

- **Host 投影**（key `cost-meter`）：注册在 DSH 的 `sessionProjections` 上——会话事件流重放驱动，**历史会话自动重建、重启零丢失、无内存态**；
- **Client 展示**：`conversation.chat.turnTail`（每轮）+ `conversation.session.header.utilities`（累计徽章），纯 `useProjection` 消费，无网络请求；
- 零外部依赖、零存储写入，bundle ≈ 5KB。

## 安装

```bash
npm install dsh-cost-meter
# 加入 profile bundles 后重启，或使用 dsh-super-injector 热装配（dev_inject_plugin）
```

## Roadmap

- [x] v0.1 每轮/每会话精确费用
- [x] v0.2 实时消耗速度（¥/s · tok/s）
- [ ] 生成质量评估与任务交付评估（**调研已完成**：见 [docs/quality-evaluation-research.md](docs/quality-evaluation-research.md)——36 篇权威文献，两级方案：L1 确定性程序化指标 + L2 LLM-judge 防偏差协议）
- [ ] 生成效率与执行过程质量分析

## License

BSD-3-Clause
