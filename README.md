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

价格表（¥/百万 token，**2026-10-01 校准为官方现行价**；峰价 = 北京时间工作日 9–12 / 14–18，
周末与**法定节假日**全天谷价）：

| 模型 | hit（谷/峰） | miss（谷/峰） | out（谷/峰） |
|---|---|---|---|
| flash（含旧名 v4-flash / v4-flash-vision-exp / chat / reasoner） | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| v4-pro | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

> ⚠️ **此处与本插件 `src/index.ts` 的定价表必须同步**——历史上两处都曾各自过期，
> 导致金额**高估 1.4~1.9 倍**（见 `LESSONS.md` 的 L-2026-10-01-07 / -08）。
> 改价后请跑 `node ~/dsh-hardening/scripts/price-parity-check.mjs`（它同时比对
> 两插件定价、旧价残留、官方定价页、以及节假日表是否过期）。
>
> ⚠️ **口径**：本插件显示的是「按官方价目表折算的**等效估算**」，**不是平台实际扣费**。
> 走第三方中转平台（codearts / buddy / lobsterai / trae）或网页免费通道时**不扣 DeepSeek 官方余额**，
> 此时面板金额与真实账单本就不是一回事；真实扣费请看 `dsh-usage-guard`
> （它直读官方 `/usage/by_api_key/cost`）。UI 上的 `~¥` 前缀即表示「估算值」。

历史事件**按发生时刻**分桶计价，改价重放也不失真。

## 自测

```bash
node scripts/selftest.mjs
```

覆盖定价表是否为官方现行价、峰谷时段、**法定节假日全天空闲**、以及
**调休上班的周末官方仍按空闲计**（这两条不符合直觉，但已被官方账单逐日核对证实）。

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
