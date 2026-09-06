/**
 * dsh-cost-meter — client half.
 * 数据获取：HTTP 轮询 host 直读 API /dsh-cost-meter/api/status?sessionId=...
 * （不依赖 useProjection 推送——解决投影注册晚于会话打开时数据不刷新的时序缺陷；
 *   速度徽章 1 秒轮询，其余 3 秒轮询。）
 * 展示点：
 *   1. 每条回答动作行（assistant-actions）本轮费用（仅每轮最后一条消息显示）
 *   2. 会话标题行（header.utilities）累计费用
 *   3. 输入框上方（input.dock）实时消耗速度 ¥/s · tok/s（6 秒滑窗）
 */
import * as React from 'react'

export const inject = ['slots']

const SEC = 'var(--dsw-alias-label-secondary, #888)'
const WARN = 'var(--dsw-alias-state-warn-primary, #b8860b)'

interface TurnRec {
  turn: number
  costCny: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  reasoningTokens: number
  model: string
  peak: boolean
  lastTs: number
  lastMessageId: string
}

interface CostView {
  turns: TurnRec[]
  totals: { inputTokens: number; cacheReadTokens: number; outputTokens: number; reasoningTokens: number; costCny: number }
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}

function shortModel(model: string): string {
  return String(model || '').replace(/^deepseek-/, '').replace(/-vision-exp$/, '-vx') || ''
}

/** 轮询 host 直读 API */
function useCostView(sessionId: string | undefined, intervalMs: number): CostView | null {
  const [data, setData] = React.useState<CostView | null>(null)
  React.useEffect(() => {
    if (sessionId === undefined || sessionId === null || sessionId === '') {
      setData(null)
      return
    }
    let alive = true
    const poll = () => {
      fetch('/dsh-cost-meter/api/status?sessionId=' + encodeURIComponent(String(sessionId)))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (alive && d && d.ok && d.data) setData(d.data as CostView)
          else if (alive && d && d.ok && d.data === null) setData(null)
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, intervalMs)
    return () => { alive = false; clearInterval(id) }
  }, [sessionId, intervalMs])
  return data
}

function TurnCost(props: { messageId?: unknown; sessionId?: string }): React.ReactElement | null {
  const view = useCostView(props.sessionId, 3000)
  if (view === null) return null
  const rec = view.turns.find((t) => t.lastMessageId !== '' && t.lastMessageId === props.messageId)
  if (rec === undefined || !Number.isFinite(rec.costCny)) return null
  const tokens = (rec.inputTokens ?? 0) + (rec.cacheReadTokens ?? 0) + (rec.outputTokens ?? 0)
  return React.createElement(
    'div',
    {
      style: {
        display: 'flex', alignItems: 'center', gap: '10px',
        fontSize: '11px', lineHeight: 1, color: SEC,
        padding: '0 2px', userSelect: 'none',
      },
      title: `输入(未命中缓存) ${fmtTokens(rec.inputTokens ?? 0)} · 缓存命中 ${fmtTokens(rec.cacheReadTokens ?? 0)} · 输出 ${fmtTokens(rec.outputTokens ?? 0)}（含思考 ${fmtTokens(rec.reasoningTokens ?? 0)}）`,
    },
    React.createElement('span', { style: { fontWeight: 600 } }, `¥ ${rec.costCny.toFixed(4)}`),
    React.createElement('span', null, `${fmtTokens(tokens)} tok`),
    rec.peak ? React.createElement('span', { style: { color: WARN } }, '峰时') : null,
    rec.model ? React.createElement('span', null, shortModel(rec.model)) : null,
  )
}

function TotalBadge(props: { sessionId?: string }): React.ReactElement | null {
  const view = useCostView(props.sessionId, 3000)
  const totals = view?.totals
  if (totals === undefined || !Number.isFinite(totals.costCny) || totals.costCny <= 0) return null
  const tokens = (totals.inputTokens ?? 0) + (totals.cacheReadTokens ?? 0) + (totals.outputTokens ?? 0)
  return React.createElement(
    'span',
    {
      style: { fontSize: '11.5px', color: SEC, userSelect: 'none', whiteSpace: 'nowrap' },
      title: `本会话费用：输入(未命中) ${fmtTokens(totals.inputTokens ?? 0)} · 缓存命中 ${fmtTokens(totals.cacheReadTokens ?? 0)} · 输出 ${fmtTokens(totals.outputTokens ?? 0)}（含思考 ${fmtTokens(totals.reasoningTokens ?? 0)}）`,
    },
    `¥ ${totals.costCny.toFixed(4)} · ${fmtTokens(tokens)} tok`,
  )
}

const WINDOW_MS = 6000
const IDLE_HIDE_MS = 3000
const MIN_RATE = 1e-6

interface SpeedSample { t: number; cost: number; tokens: number }

function SpeedBadge(props: { sessionId?: string }): React.ReactElement | null {
  const [samples, setSamples] = React.useState<SpeedSample[]>([])
  const [now, setNow] = React.useState<number>(Date.now())

  React.useEffect(() => {
    if (props.sessionId === undefined || props.sessionId === '') return
    let alive = true
    const poll = () => {
      fetch('/dsh-cost-meter/api/status?sessionId=' + encodeURIComponent(String(props.sessionId)))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!alive || !d || !d.ok || !d.data) return
          const totals = (d.data as CostView).totals
          if (!totals) return
          const tokens = (totals.inputTokens ?? 0) + (totals.cacheReadTokens ?? 0) + (totals.outputTokens ?? 0)
          setSamples((prev) => [...prev.slice(-120), { t: Date.now(), cost: totals.costCny, tokens }])
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, 1000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => { alive = false; clearInterval(id); clearInterval(tick) }
  }, [props.sessionId])

  if (samples.length < 2) return null
  const last = samples[samples.length - 1]
  if (now - last.t > IDLE_HIDE_MS) return null
  let first: SpeedSample | undefined
  for (const s of samples) {
    if (now - s.t <= WINDOW_MS) { first = s; break }
  }
  if (first === undefined || first === last) return null
  const dtSec = (last.t - first.t) / 1000
  if (dtSec <= 0.2) return null
  const rateCny = (last.cost - first.cost) / dtSec
  const rateTok = (last.tokens - first.tokens) / dtSec
  if (rateCny < MIN_RATE && rateTok <= 0) return null

  return React.createElement(
    'div',
    {
      style: {
        display: 'flex', alignItems: 'center', gap: '8px',
        fontSize: '11px', color: SEC,
        padding: '1px 6px 0', userSelect: 'none',
      },
      title: '实时消耗速度（6 秒滑窗均值）：费用 ¥/s 与 token/s',
    },
    React.createElement('span', { style: { fontWeight: 600 } }, `⚡ ¥${rateCny.toFixed(4)}/s`),
    React.createElement('span', null, `${fmtTokens(Math.round(rateTok))}/s`),
  )
}

export function apply(ctx: any): void {
  ctx.effect(() => ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register({ name: "conversation.chat.assistant-actions", id: "dsh-cost-turn", order: 40, label: () => "本轮费用" }, TurnCost),
  ), 'dsh-cost-meter: turn cost action')
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register({ name: "conversation.session.header.utilities", id: "dsh-cost-total", order: 60, label: () => "会话费用" }, TotalBadge),
  ), 'dsh-cost-meter: header total')
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({ name: "conversation.input.dock", id: "dsh-cost-speed", order: 35, label: () => "消耗速度" }, SpeedBadge),
  ), 'dsh-cost-meter: live speed')
}
