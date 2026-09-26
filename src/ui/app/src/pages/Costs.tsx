import * as React from 'react'
import { EmptyState, SectionTitle, Shell } from '@/components/Shell'
import { Loading, Panel, RangeChips, useFetched, useOpenIssue } from '@/components/Insights'
import { Legend, LineChart, StackedBars, seriesColor, tone, type LineSeries } from '@/components/charts'
import { getMetrics, type MetricsReport, type MetricsWindow } from '@/lib/api'
import { capLevel, planDomain, projection, formatBucket, formatClock, formatPercent, formatTokens, windowLabel } from '@/lib/format'
import { cn } from '@/lib/utils'

type CostsWindow = Extract<MetricsWindow, '24h' | '7d' | '30d'>
const RANGES: readonly { readonly value: CostsWindow; readonly label: string }[] = [
  { value: '24h', label: 'Today' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' },
]

const LEVEL_COLOR = { ok: tone.accent, warn: tone.warning, over: tone.danger } as const
const LEVEL_TEXT = { ok: 'text-ink-muted', warn: 'text-warning', over: 'text-danger' } as const

const remainingColor = (percent: number | null): string => percent === null ? tone.muted : percent <= 10 ? tone.danger : percent <= 25 ? tone.warning : tone.accent

const Kpi = ({ label, value, sub, className }: { readonly label: string; readonly value: string; readonly sub: string; readonly className?: string }): React.ReactElement => (
  <div className="flex flex-col gap-1.5 rounded-[10px] border border-line-soft bg-panel px-[18px] py-4">
    <span className="text-xs text-ink-subtle">{label}</span>
    <span className={cn('font-mono text-2xl font-semibold', className)}>{value}</span>
    <span className="text-xs text-ink-subtle">{sub}</span>
  </div>
)

type Provider = MetricsReport['providers'][number]

const forecast = (provider: Provider, now: number): string => {
  if (provider.cooldownUntil && Date.parse(provider.cooldownUntil) > now) return `Cooldown until ${formatClock(provider.cooldownUntil, now)} · routing skips it`
  if (provider.projectedZeroAt) return `At current pace: lasts until ~${formatClock(provider.projectedZeroAt, now)}`
  return provider.remainingPercent === null ? 'No usage reading yet' : 'Not falling at current pace'
}

const CostsBody = ({ report }: { readonly report: MetricsReport }): React.ReactElement => {
  const openIssue = useOpenIssue()
  const now = Date.now()
  const { tokens } = report
  const mergedCount = report.throughput.reduce((sum, point) => sum + point.merged, 0)
  const nearCap = tokens.perIssue.filter((row) => capLevel(row.tokens, row.cap) !== 'ok')
  const overCap = nearCap.filter((row) => capLevel(row.tokens, row.cap) === 'over').length
  const roles = Object.entries(tokens.byRole).sort((a, b) => b[1] - a[1]).map(([role], index) => ({ key: role, label: role, color: seriesColor(index) }))
  const domain = planDomain(report)
  const providerColor = (index: number): string => seriesColor(index)
  const planSeries: LineSeries[] = report.providers.map((provider, index) => ({
    label: provider.provider,
    color: providerColor(index),
    points: provider.series.map((point) => ({ x: Date.parse(point.at), y: point.remainingPercent })),
    projection: projection(provider, domain[1]),
  }))
  const firstZero = report.providers.filter((provider) => provider.projectedZeroAt).sort((a, b) => Date.parse(a.projectedZeroAt ?? '') - Date.parse(b.projectedZeroAt ?? ''))[0]
  const perIssue = [...tokens.perIssue].sort((a, b) => (b.cap ? b.tokens / b.cap : 0) - (a.cap ? a.tokens / a.cap : 0) || b.tokens - a.tokens)
  const unit = report.bucket === 'hour' ? 'hour' : 'day'
  return (
    <div className="flex flex-col gap-[18px]">
      <div className="grid grid-cols-4 gap-4">
        <Kpi label={report.window === '24h' ? 'Tokens today' : `Tokens, last ${windowLabel[report.window]}`} value={formatTokens(tokens.total)}
          sub={`in ${formatTokens(tokens.input)} · out ${formatTokens(tokens.output)} · cache hit ${formatPercent(tokens.cacheHitRate)}`} />
        <Kpi label="Median per merged issue" value={formatTokens(tokens.medianPerMergedIssue)} sub={`last ${windowLabel[report.window]}, ${mergedCount} merged`} />
        <Kpi label="Runs above 80% of cap" value={String(nearCap.length)} className={nearCap.length ? 'text-warning' : undefined}
          sub={overCap ? `${overCap} at the cap (cost guard)` : 'none at the cap'} />
        <Kpi label="Saved by memory recall" value={`~${formatTokens(report.memorySavedChars)}`} className="text-success" sub="approx. chars not resent" />
      </div>

      <div className="flex h-[236px] shrink-0 gap-5">
        <Panel className="grow" title={`Tokens per ${unit}, by role`} aside={<Legend items={roles} />}>
          {report.tokens.series.length === 0 ? <EmptyState>No token usage in this window.</EmptyState> : <>
            <StackedBars className="min-h-0 grow" keys={roles}
              label={`Tokens per ${unit} by role, total ${formatTokens(tokens.total)}: ${roles.map((role) => `${role.label} ${formatTokens(tokens.byRole[role.key] ?? 0)}`).join(', ')}.`}
              data={tokens.series.map((point) => ({ label: formatBucket(point.at, report.bucket), values: point.byRole }))} />
            <div className="flex justify-between font-mono text-[11px] text-ink-subtle" aria-hidden>
              <span>{formatBucket(tokens.series[0]?.at ?? report.from, report.bucket)}</span><span>now {formatClock(report.to, now)}</span>
            </div>
          </>}
        </Panel>
        <Panel className="w-[430px] shrink-0" title="Plan left, with projection"
          aside={<span className="flex gap-3 font-mono text-[11px]">{report.providers.map((provider, index) => <span key={provider.provider} style={{ color: providerColor(index) }}>{provider.provider}</span>)}</span>}>
          {report.providers.length === 0 ? <EmptyState>No provider plan readings.</EmptyState> : <>
            <LineChart className="min-h-0 w-full grow" series={planSeries} xDomain={domain} yMax={100} guides={[50]} marker={Date.parse(report.to)}
              label={`Plan left: ${report.providers.map((provider) => `${provider.provider} ${provider.remainingPercent ?? '—'}%${provider.projectedZeroAt ? `, hits 0 around ${formatClock(provider.projectedZeroAt, now)}` : ''}`).join('; ')}.`} />
            <div className="flex justify-between font-mono text-[11px] text-ink-subtle">
              <span aria-hidden>{formatClock(report.from, now)}</span><span aria-hidden>now</span>
              <span>{firstZero ? `${firstZero.provider} hits 0 ~${formatClock(firstZero.projectedZeroAt, now)}` : 'no plan runs out at this pace'}</span>
            </div>
          </>}
        </Panel>
      </div>

      <div className="flex min-h-0 gap-5">
        <section aria-label="Provider plans" className="flex w-[430px] shrink-0 flex-col gap-3">
          <SectionTitle>Plan usage by provider</SectionTitle>
          {report.providers.length === 0 && <EmptyState>No providers reported.</EmptyState>}
          {report.providers.map((provider) => {
            const color = remainingColor(provider.remainingPercent)
            return (
              <div key={provider.provider} className="flex flex-col gap-2.5 rounded-[10px] border border-line-soft bg-panel px-4 py-3.5">
                <div className="flex items-baseline gap-2.5">
                  <span className="text-sm font-semibold">{provider.provider}</span>
                  <span className="text-xs text-ink-subtle">{provider.roles.join(' · ')}</span>
                  <span className="ml-auto font-mono text-xl font-semibold" style={{ color }}>{provider.remainingPercent === null ? '—' : `${Math.round(provider.remainingPercent)}% left`}</span>
                </div>
                <div className="flex h-2 overflow-hidden rounded bg-line-soft" role="img" aria-label={`${provider.provider}: ${provider.remainingPercent === null ? 'unknown' : `${Math.round(100 - provider.remainingPercent)}% used`}`}>
                  <span className="chart-grow-x h-2" style={{ width: `${100 - (provider.remainingPercent ?? 100)}%`, background: color }} />
                </div>
                <span className="text-xs text-ink-subtle">{forecast(provider, now)}</span>
              </div>
            )
          })}
        </section>

        <section aria-label="Per issue" className="flex min-w-0 grow flex-col gap-3">
          <SectionTitle>Per issue vs cap</SectionTitle>
          <div className="flex flex-col rounded-[10px] border border-line-soft bg-panel px-4 py-1.5">
            {perIssue.length === 0 && <EmptyState>No issue spent tokens in this window.</EmptyState>}
            {perIssue.map((row) => {
              const level = capLevel(row.tokens, row.cap)
              const pct = row.cap ? Math.min(1, row.tokens / row.cap) * 100 : 0
              return (
                <button key={row.issue} type="button" onClick={() => openIssue(row.issue)}
                  aria-label={`${row.issue}: ${formatTokens(row.tokens)} of ${row.cap ? formatTokens(row.cap) : 'no cap'} tokens. Open issue.`}
                  className="grid h-11 grid-cols-[80px_minmax(0,1fr)_220px_90px] items-center gap-3 border-b border-line-ghost text-left text-[13px] last:border-0 hover:bg-panel-alt focus-visible:outline-2 focus-visible:outline-info">
                  <span className="font-mono font-semibold text-accent-strong">{row.issue}</span>
                  <span className="truncate">{row.title ?? '—'}</span>
                  <span className="flex h-1.5 rounded-sm bg-line-soft" aria-hidden>
                    {row.cap !== null && <span className="chart-grow-x h-1.5 rounded-sm" style={{ width: `${pct}%`, background: LEVEL_COLOR[level] }} />}
                  </span>
                  <span className={cn('text-right font-mono text-xs', LEVEL_TEXT[level])}>{formatTokens(row.tokens)}/{row.cap ? formatTokens(row.cap) : '—'}</span>
                </button>
              )
            })}
          </div>
          <p className="text-xs text-ink-subtle">Cap comes from each run's frozen <span className="font-mono">perIssueTokens</span>. At 100% the cost guard stops the run and it shows up in Attention. Token counts only — no dollar figures.</p>
        </section>
      </div>
    </div>
  )
}

export const CostsPage = (): React.ReactElement => {
  const [range, setRange] = React.useState<CostsWindow>('24h')
  const { data, error, loading } = useFetched(() => getMetrics(range), [range])
  return (
    <Shell title="Costs" subtitle={<span className="font-sans">Tokens and plan usage. No dollar estimates.</span>} error={error}
      actions={<RangeChips label="Time range" options={RANGES} value={range} onChange={setRange} />}>
      {data ? <CostsBody report={data} /> : loading ? <Loading /> : <EmptyState>No cost data available.</EmptyState>}
    </Shell>
  )
}
