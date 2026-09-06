/**
 * dsh-cost-meter — client half.
 * 展示点 1：每条回答的动作行（conversation.chat.assistant-actions）本轮费用 + token + 峰谷标记 + 模型
 *          —— 只在每轮最后一条 assistant 消息上显示（与官方 feedback/filesnap 动作并列共存）。
 * 展示点 2：会话标题行（conversation.session.header.utilities）本会话累计费用。
 * 展示点 3：输入框上方实时速度（conversation.input.dock）——像下载速度一样显示
 *          ¥/s 与 tok/s（6 秒滑窗均值，流式结束后自动隐藏）。
 * 数据全部来自 host 投影 'cost-meter'（useProjection 消费，无需任何网络请求）。
 */
import * as React from 'react'

export const inject = ['slots']

const SEC = 'var(--dsw-alias-label-secondary, #888)'
const WARN = 'var(--dsw-alias-state-warn-primary, #b8860b)'

function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}

function shortModel(model: string): string {
  return String(model || '').replace(/^deepseek-/, '').replace(/-vision-exp$/, '-vx') || ''
}

/** assistant-actions：owner 提供 messageId；从投影里找 lastMessageId 匹配的轮记录 */
function TurnCost(props: { messageId?: unknown; useProjection?: any }): React.ReactElement | null {
  const view = props.useProjection?.('cost-meter')
  const rec = view?.turns?.find((t: { lastMessageId?: string }) => t.lastMessageId !== '' && t.lastMessageId === props.messageId)
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

/** 会话累计费用徽章（标题行右侧） */
function TotalBadge(props: { useProjection?: any }): React.ReactElement | null {
  const view = props.useProjection?.('cost-meter')
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

/** 实时消耗速度徽章（¥/s · tok/s，6 秒滑窗） */
function SpeedBadge(props: { useProjection?: any }): React.ReactElement | null {
  const view = props.useProjection?.('cost-meter')
  const totals = view?.totals
  const cost = totals?.costCny
  const tokens = (totals?.inputTokens ?? 0) + (totals?.cacheReadTokens ?? 0) + (totals?.outputTokens ?? 0)
  const samplesRef = React.useRef<SpeedSample[]>([])
  const [now, setNow] = React.useState<number>(Date.now())
  const [sampleVersion, setSampleVersion] = React.useState<number>(0)

  React.useEffect(() => {
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      samplesRef.current = [...samplesRef.current.slice(-120), { t: Date.now(), cost, tokens }]
      setSampleVersion((n) => n + 1)
    }
  }, [cost, tokens])

  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  void sampleVersion
  const samples = samplesRef.current
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
