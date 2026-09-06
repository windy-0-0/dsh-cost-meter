# 💰 dsh-cost-meter

> **Session cost metering for DeepSeek Harness** — know exactly what every turn and every session costs.

English | [中文](README.md)

![License](https://img.shields.io/github/license/windy-0-0/dsh-cost-meter?style=flat-square)
![Release](https://img.shields.io/github/v/release/windy-0-0/dsh-cost-meter?style=flat-square)
![persistent projection](https://img.shields.io/badge/persistent-projection-4CAF50?style=flat-square)

## Why

DSH's UI shows no costs. Most people only see the **per-key total bill** on the API platform — they never learn:

- How much did one conversation cost?
- How much did one reply cost?
- Which turn was the most expensive, and why?

Manual token math is unreliable because of three traps:

1. **Cache hits are not free** (DeepSeek bills cache hits separately, at ~1/30 of miss price);
2. **Reasoning tokens must not be double-counted** (`completion_tokens` already includes reasoning — some community plugins' `output + reasoning` double-counts);
3. **Peak/off-peak pricing** (weekday peak hours double the price; history must be bucketed by occurrence time).

**dsh-cost-meter solves all three**: it consumes the authoritative usage data from DSH's session event stream and bills token-by-token against the official price table.

## What you see

- **Per-turn**: `¥ 0.0123 · 45.6k tok · peak · v4-flash` on the finalized answer's action row (hover for the full breakdown: input miss / cache hit / output incl. reasoning);
- **Per-session**: a `¥ 1.2345 · 12.3M tok` badge in the session title row;
- **Live speed**: `⚡ ¥0.0123/s · 12.3k/s` above the composer while the model streams (6-second sliding window, hides automatically when idle).

## Billing accuracy

| Token bucket | DSH usage field | Price | Notes |
|---|---|---|---|
| Input cache miss | `inputTokens` | miss | `prompt_tokens - cache_hit`, disjoint semantics |
| Input cache hit | `cacheReadTokens` | hit | automatic context caching, ~1/30 of miss price |
| Output incl. reasoning | `outputTokens` | out | `completion_tokens` total; `reasoningTokens` is a subset, never billed again |

Price table (CNY / 1M tokens, DeepSeek effective 2026-08-17; peak = Beijing working days 9–12 / 14–18; weekends all off-peak since 2026-08-23):

| Model | hit (off/peak) | miss (off/peak) | out (off/peak) |
|---|---|---|---|
| v4-flash / chat / reasoner / vision-exp | 0.05 / 0.1 | 1.5 / 3.0 | 4.5 / 9.0 |
| v4-pro | 0.15 / 0.3 | 4.5 / 9.0 | 13.5 / 27.0 |

History is bucketed by occurrence time (including the 8/23 weekend-rule boundary), so repricing replays stay correct.

## Architecture

- **Host projection** (key `cost-meter`), registered on DSH's `sessionProjections`: driven by session event replay — historical sessions rebuild automatically, nothing is lost across restarts, no in-memory state;
- **Client views**: `conversation.chat.assistant-actions` (per-turn) + `conversation.session.header.utilities` (totals) + `conversation.input.dock` (live speed), all via `useProjection`, zero network requests;
- Zero external deps, zero storage writes, ~5KB bundle.

## Install

```bash
npm install dsh-cost-meter
# add to your profile bundles and restart, or hot-load via dsh-super-injector (dev_inject_plugin)
```

## Roadmap

- [x] v0.1 per-turn / per-session accurate cost
- [x] v0.2 live consumption speed (¥/s · tok/s)
- [ ] generation quality & task delivery evaluation (**research done**: see [docs/quality-evaluation-research.md](docs/quality-evaluation-research.md) — 36 references, two-tier design: L1 deterministic programmatic metrics + L2 LLM-judge with debiasing protocols)
- [ ] efficiency & execution-process quality analysis

## License

BSD-3-Clause
