import type { MetricsReport } from '../../../api/contract'

/** Pure display helpers shared by the insight screens (Trends, Costs, Explore, System, Settings). */

export const formatTokens = (n: number | null): string => {
  if (n === null) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M`
  if (abs >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}

export const formatDuration = (ms: number | null): string => {
  if (ms === null) return '—'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export const formatPercent = (ratio: number | null, digits = 0): string => ratio === null ? '—' : `${(ratio * 100).toFixed(digits)}%`

/** `14:20` for today, `Sep 24 14:20` otherwise. */
export const formatClock = (iso: string | null, now = Date.now()): string => {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  return new Date(now).toDateString() === date.toDateString() ? time : `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`
}

/** Axis tick for a bucket start: hours as `14:00`, days as `Sep 12`. */
export const formatBucket = (iso: string, bucket: 'hour' | 'day'): string => {
  const date = new Date(iso)
  return bucket === 'hour'
    ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export const formatAgo = (iso: string | null, now = Date.now()): string => {
  if (!iso) return '—'
  const ms = now - Date.parse(iso)
  if (Number.isNaN(ms)) return '—'
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1_000))}s ago`
  return `${formatDuration(ms)} ago`
}

export const windowLabel: Record<'24h' | '7d' | '14d' | '30d', string> = { '24h': '24 hours', '7d': '7 days', '14d': '14 days', '30d': '30 days' }

/** "Median down 24% vs previous 14 days"; `null` when either side is unknown. */
export const leadTimeDelta = (median: number | null, previous: number | null): { readonly text: string; readonly better: boolean } | null => {
  if (median === null || previous === null || previous <= 0) return null
  const change = Math.round(((median - previous) / previous) * 100)
  if (change === 0) return { text: 'Median unchanged', better: true }
  return { text: `Median ${change < 0 ? 'down' : 'up'} ${Math.abs(change)}%`, better: change < 0 }
}

/** Mean fix rounds from the histogram. ponytail: `3+` and `cap` count as 3; the average is a floor, labelled "~". */
export const averageFixRounds = (buckets: readonly { readonly label: string; readonly count: number }[]): number | null => {
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0)
  if (total === 0) return null
  const rounds = (label: string): number => Number.parseInt(label, 10) || (label === '0' ? 0 : 3)
  return buckets.reduce((sum, bucket) => sum + rounds(bucket.label) * bucket.count, 0) / total
}

/** Usage colour for a token-vs-cap ratio: ≥100% danger, ≥80% warning. */
export const capLevel = (tokens: number, cap: number | null): 'ok' | 'warn' | 'over' => {
  if (!cap) return 'ok'
  const ratio = tokens / cap
  return ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok'
}

/** Config values as they appear in diffs and rows. */
export const formatValue = (value: unknown): string => typeof value === 'string' ? value : value === undefined ? '—' : JSON.stringify(value)

/** Editor input back to a value: JSON when it parses (numbers, booleans, arrays), else the raw string. */
export const parseValue = (text: string): unknown => {
  try { return JSON.parse(text) as unknown } catch { return text }
}

/**
 * Whether a change to a `gate` field obviously lowers the guarantee: turning a boolean off, or a number to 0.
 * Anything subtler is the server's call — `writeLocalConfig` refuses without `confirmWeakening` and the page
 * then asks for the acknowledgement.
 */
export const obviouslyWeakens = (classification: string, from: unknown, to: unknown): boolean =>
  classification === 'gate' && ((from === true && to === false) || (typeof from === 'number' && from !== 0 && to === 0) || (from !== null && to === null))

type Provider = MetricsReport['providers'][number]

/** The plan chart spans the window plus room for projections, capped at half a window past now. */
export const planDomain = (report: Pick<MetricsReport, 'from' | 'to' | 'providers'>): readonly [number, number] => {
  const from = Date.parse(report.from)
  const to = Date.parse(report.to)
  const zeros = report.providers.map((provider) => provider.projectedZeroAt ? Date.parse(provider.projectedZeroAt) : Number.NaN).filter((at) => at > to)
  return [from, zeros.length ? Math.min(Math.max(...zeros), to + (to - from) / 2) : to]
}

/** Dashed segment from the last reading to 0 at `projectedZeroAt`, cut at the chart's right edge. */
export const projection = (provider: Provider, end: number): readonly { readonly x: number; readonly y: number }[] | undefined => {
  const last = provider.series.at(-1)
  if (!last || !provider.projectedZeroAt) return undefined
  const x0 = Date.parse(last.at)
  const zero = Date.parse(provider.projectedZeroAt)
  if (!(zero > x0)) return undefined
  const x1 = Math.min(zero, end)
  return [{ x: x0, y: last.remainingPercent }, { x: x1, y: last.remainingPercent * (1 - (x1 - x0) / (zero - x0)) }]
}
