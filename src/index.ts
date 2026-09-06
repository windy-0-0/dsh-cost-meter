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

// ── 定价（DeepSeek 2026-08-17 生效，¥ / 百万 token，[谷价, 峰价]）──
const PEAK_HOURS: ReadonlyArray<readonly [number, number]> = [[9, 12], [14, 18]]
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000) // 北京时间 2026-08-23 00:00

interface PriceTable { hit: [number, number]; miss: [number, number]; out: [number, number] }

const BASE_PRICE: PriceTable = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
const PRO_PRICE: PriceTable = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }

const PRICING: Record<string, PriceTable> = {
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
}

function priceFor(model: string | undefined): PriceTable {
  const m = String(model ?? '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (m.includes(key)) return PRICING[key]
  }
  return BASE_PRICE
}

function isPeakTime(timeSec: number): boolean {
  if (!Number.isFinite(timeSec)) return false
  const bj = new Date(timeSec * 1000 + 8 * 3600 * 1000)
  const dow = bj.getUTCDay() // 0=周日 6=周六（按 UTC 读取即为北京日历日）
  if (timeSec >= WEEKEND_VALLEY_FROM_SEC && (dow === 0 || dow === 6)) return false
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
}

function init(): CostState {
  return {
    turns: [],
    totals: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0, costCny: 0 },
    currentModel: '',
  }
}

function reduceCost(state: CostState, event: any): CostState {
  if (event === null || typeof event !== 'object') return state
  const type: unknown = event.type
  const data: any = event.data
  if (type === 'request/header') {
    const model = data?.header?.config?.model
    if (typeof model === 'string' && model) state.currentModel = model
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
  const price = priceFor(model)
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
  const webServer = ctx.get('webServer')
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
