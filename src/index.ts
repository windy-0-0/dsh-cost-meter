/**
 * dsh-cost-meter — host half.
 *
 * 会话费用计量投影（key: 'cost-meter'）：
 *  - 数据源：会话事件流（request/header → model；assistant/message → data.usage）
 *  - 计费口径（与 DSH TokenUsage 的 disjoint 语义一致，源码级核对过
 *    dsh-llm-deepseek 的 mapUsage）：
 *      inputTokens    = prompt 未命中缓存部分（miss）
 *      cacheReadTokens = prompt 缓存命中部分（hit）
 *      outputTokens   = completion_tokens 总量（已包含 reasoningTokens）
 *    费用 = input×miss价 + cacheRead×hit价 + output×out价
 *    （reasoningTokens 不再重复计费——社区插件 output+reasoning 双加是重复计费）
 *  - 峰谷定价：北京时间工作日 9–12 / 14–18 为峰价，其余谷价；
 *    2026-08-23 起周末全天谷价（历史事件按发生时刻分桶，带生效分界）。
 *  - 投影由 sessionProjections 按事件流重放：历史会话、重启后均自动重建，无内存态丢失。
 */
import { z } from 'zod'

export const name = 'dsh-cost-meter'
/** 声明式硬依赖：webServer 就绪前不激活（bundle 装配早于服务时 ctx.get 拿空，路由静默丢失） */
export const inject = ['webServer']

// ── 定价（2026-10-01 校准为官方现行价，与 dsh-usage-guard 同步）──
// 官方来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 校准方法：拉官方 /usage/by_api_key/amount（分时 token）+ /usage/by_api_key/cost（分时真实扣费）
//          配对拟合；2026-09-19…10-03 共 15 天（官方总额 ¥225.15）逐日吻合，每天差 <¥0.005。
// 旧价（hit 0.05/0.10、miss 1.5/3、out 4.5/9）已被官方下调，用它会把金额**高估约 1.4~1.9 倍**。
const PEAK_HOURS: ReadonlyArray<readonly [number, number]> = [[9, 12], [14, 18]]

/**
 * 2026 年法定节假日（国务院办公厅 2025-11-04 通知）。官方规则：**法定节假日全天按空闲时段计价**，
 * 且**只有「周一至周五 且 非法定节假日」才是工作日**；调休上班的周末（如 2026-09-20 周日上班）
 * 官方**仍按空闲**计 —— 故本表**不含**调休上班日（逐日核对 15 天确认，按工作日算当天差 ¥12.72）。
 */
const CN_HOLIDAYS_2026: ReadonlySet<string> = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',                                                       // 元旦
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', // 春节
  '2026-04-04', '2026-04-05', '2026-04-06',                                                       // 清明
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',                           // 劳动节
  '2026-06-19', '2026-06-20', '2026-06-21',                                                       // 端午
  '2026-09-25', '2026-09-26', '2026-09-27',                                                       // 中秋
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', // 国庆
])

interface PriceTable { hit: [number, number]; miss: [number, number]; out: [number, number] }

/** deepseek-flash（含旧名 v4-flash / v4-flash-vision-exp，官方按 Flash 价计费）：[空闲, 高峰] */
const BASE_PRICE: PriceTable = { hit: [0.02, 0.04], miss: [1.0, 2.0], out: [4.0, 8.0] }
const PRO_PRICE: PriceTable = { hit: [0.15, 0.30], miss: [4.5, 9.0], out: [13.5, 27.0] }

const PRICING: Record<string, PriceTable> = {
  'deepseek-v4-pro': PRO_PRICE,
  // 旧名仍可调用，但请求由 DeepSeek-V4.1-Flash 提供、按 Flash 价计费 ⇒ 落到 BASE_PRICE
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-flash': BASE_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
}

/**
 * 零价档：**免费通道与本机模型**。它们不产生 API 账单，必须计 0——
 * 若按模型名去付费表里查，`deepseek-web/deepseek-chat` 会命中付费的 `deepseek-chat` 档，
 * 等于把免费额度算成了花钱（2026-09-27 修：改为 provider 感知）。
 */
const ZERO_PRICE: PriceTable = { hit: [0, 0], miss: [0, 0], out: [0, 0] }

/** 这些 provider 的调用没有 API 费用：网页免费通道 + 一切本机/局域网推理服务。 */
export function isFreeProvider(provider: string | undefined): boolean {
  const p = String(provider ?? '').toLowerCase()
  if (!p) return false
  if (p === 'deepseek-web') return true
  return /(^|[/@-])(local|localhost|ollama|lmstudio|llama\.cpp|vllm|mlx)([/@-]|$)/.test(p) || p.startsWith('local')
}

export function priceFor(model: string | undefined, provider?: string): PriceTable {
  if (isFreeProvider(provider)) return ZERO_PRICE
  const m = String(model ?? '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (m.includes(key)) return PRICING[key]
  }
  return BASE_PRICE
}

/**
 * 北京时间下该时刻是否属于**高峰时段**（决定计价档位）。
 *
 * 官方规则（2026-10-01 逐日核对确认）：仅「周一至周五 **且** 非法定节假日」为工作日，
 * 高峰时段为北京时间 9:00–12:00、14:00–18:00；其余（含周末、法定节假日全天）均为空闲时段。
 * 「调休上班的周末」官方仍按空闲计价，故**不能**用行政调休表把它算成工作日。
 *
 * @param timeSec 事件发生时刻（**Unix 秒**，不是毫秒）
 * @returns true = 高峰价
 */
export function isPeakTime(timeSec: number): boolean {
  if (!Number.isFinite(timeSec)) return false
  // 平移到北京时间后按 UTC 取值（避免依赖宿主时区）
  const bj = new Date(timeSec * 1000 + 8 * 3600 * 1000)
  const dow = bj.getUTCDay() // 0=周日 6=周六（按 UTC 读取即为北京日历日）
  if (dow === 0 || dow === 6) return false                              // 周末 → 空闲
  if (CN_HOLIDAYS_2026.has(bj.toISOString().slice(0, 10))) return false // 法定节假日全天 → 空闲
  const h = bj.getUTCHours()
  return PEAK_HOURS.some(([start, end]) => h >= start && h < end)
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

// ── 投影 schema ──
const turnSchema = z.object({
  turn: z.number(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  costCny: z.number(),
  model: z.string(),
  peak: z.boolean(),
  lastTs: z.number(),
  lastMessageId: z.string(),
})

const totalsSchema = z.object({
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  costCny: z.number(),
})

const stateSchema = z.object({
  turns: z.array(turnSchema),
  totals: totalsSchema,
  currentModel: z.string(),
  currentProvider: z.string().optional(),
})

type CostState = {
  turns: Array<{
    turn: number
    inputTokens: number
    cacheReadTokens: number
    outputTokens: number
    reasoningTokens: number
    costCny: number
    model: string
    peak: boolean
    lastTs: number
    lastMessageId: string
  }>
  totals: {
    inputTokens: number
    cacheReadTokens: number
    outputTokens: number
    reasoningTokens: number
    costCny: number
  }
  currentModel: string
  currentProvider?: string
}

function init(): CostState {
  return {
    turns: [],
    totals: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0, costCny: 0 },
    currentModel: '',
    currentProvider: '',
  }
}

function reduceCost(state: CostState, event: any): CostState {
  if (event === null || typeof event !== 'object') return state
  const type: unknown = event.type
  const data: any = event.data
  if (type === 'request/header') {
    const cfg = data?.header?.config
    const model = cfg?.model
    if (typeof model === 'string' && model) state.currentModel = model
    const provider = cfg?.provider ?? data?.header?.provider ?? data?.source?.provider
    if (typeof provider === 'string' && provider) state.currentProvider = provider
    return state
  }
  if (type !== 'assistant/message') return state
  const usage = data?.usage
  if (usage === null || typeof usage !== 'object') return state

  const input = num(usage.inputTokens)
  const cacheRead = num(usage.cacheReadTokens)
  const output = num(usage.outputTokens)
  const reasoning = num(usage.reasoningTokens)
  if (input + cacheRead + output === 0) return state

  const turn = Number.isInteger(data?.turn) ? data.turn : (state.turns.length > 0 ? state.turns[state.turns.length - 1].turn : 0)
  const tsSec = (typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()) / 1000
  const model = typeof data?.model === 'string' && data.model ? data.model : state.currentModel
  const provider = (typeof data?.source?.provider === 'string' && data.source.provider)
    ? data.source.provider
    : state.currentProvider
  const price = priceFor(model, provider)
  const peak = isPeakTime(tsSec)
  const off = peak ? 1 : 0
  const cost = (input / 1e6) * price.miss[off] + (cacheRead / 1e6) * price.hit[off] + (output / 1e6) * price.out[off]

  let entry = state.turns.find((t) => t.turn === turn)
  if (entry === undefined) {
    entry = {
      turn, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0,
      costCny: 0, model, peak, lastTs: tsSec, lastMessageId: '',
    }
    state.turns.push(entry)
  }
  entry.inputTokens += input
  entry.cacheReadTokens += cacheRead
  entry.outputTokens += output
  entry.reasoningTokens += reasoning
  entry.costCny += cost
  entry.model = model || entry.model
  entry.peak = entry.peak || peak
  entry.lastTs = tsSec
  const mid = data?.message?.id
  if (typeof mid === 'string' && mid) entry.lastMessageId = mid

  state.totals.inputTokens += input
  state.totals.cacheReadTokens += cacheRead
  state.totals.outputTokens += output
  state.totals.reasoningTokens += reasoning
  state.totals.costCny += cost

  return state
}

function view(state: CostState) {
  return {
    turns: state.turns.map((t) => ({
      turn: t.turn,
      costCny: t.costCny,
      inputTokens: t.inputTokens,
      cacheReadTokens: t.cacheReadTokens,
      outputTokens: t.outputTokens,
      reasoningTokens: t.reasoningTokens,
      model: t.model,
      peak: t.peak,
      lastTs: t.lastTs,
      lastMessageId: t.lastMessageId,
    })),
    totals: state.totals,
  }
}

export function apply(ctx: any): void {
  // HTTP 直读 API：client 轮询拉取投影状态（绕开投影推送对已打开会话的时序缺陷）
  // ctx.webServer 由模块级 inject 保证可用
  const webServer = ctx.webServer
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => {
      const dispose = webServer.register({
      kind: 'prefix',
      path: '/dsh-cost-meter/api',
      handler: async (req: any, res: any) => {
        const send = (code: number, obj: unknown) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(obj))
        }
        try {
          const u = new URL(req.url ?? '/', 'http://localhost')
          const path = u.pathname.replace(/^\/dsh-cost-meter\/api/, '') || '/'
          // 定价自测口：把「哪个 provider/模型算多少钱」直接暴露出来，便于长期校准。
          if (req.method === 'GET' && path === '/price') {
            const provider = u.searchParams.get('provider') ?? undefined
            const model = u.searchParams.get('model') ?? undefined
            return send(200, {
              ok: true,
              provider: provider ?? null,
              model: model ?? null,
              free: isFreeProvider(provider),
              price: priceFor(model, provider),
            })
          }
          if (req.method === 'GET' && path === '/status') {
            const sid = u.searchParams.get('sessionId')
            if (!sid) return send(400, { ok: false, error: 'sessionId required' })
            const sessions = ctx.get('sessions')
            const sp = ctx.get('sessionProjections')
            const session = sessions && typeof sessions.list === 'function'
              ? sessions.list().find((s: any) => s && String(s.id) === sid)
              : undefined
            if (!session) return send(404, { ok: false, error: 'session not found' })
            if (!sp || typeof sp.stateOf !== 'function') return send(500, { ok: false, error: 'no projection service' })
            try {
              const state = sp.stateOf(session, 'cost-meter')
              if (state === undefined) return send(200, { ok: true, data: null })
              return send(200, { ok: true, data: view(state) })
            } catch (e) {
              return send(500, { ok: false, error: String(e instanceof Error ? e.message : e) })
            }
          }
          return send(404, { ok: false, error: 'not found' })
        } catch (e) {
          return send(500, { ok: false, error: String(e instanceof Error ? e.message : e) })
        }
      },
    })
      return () => { if (typeof dispose === 'function') dispose() }
    })
  }
  ctx.inject(['sessionProjections'], (projectionCtx: any) => {
    projectionCtx.sessionProjections.register({
      key: 'cost-meter',
      stateSchema,
      init,
      apply: reduceCost,
      wire: { viewSchema: z.object({ turns: z.array(z.any()), totals: totalsSchema }), view },
      stateVersion: 2,
    })
  })
}
