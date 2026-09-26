import * as React from 'react'
import { Link } from 'react-router-dom'
import { EmptyState, Shell } from '@/components/Shell'
import { Loading, Panel, RangeChips, useFetched } from '@/components/Insights'
import { Bars, HBarList, Legend, LineChart, Ring, SegmentBar, tone } from '@/components/charts'
import { getMetrics, type MetricsReport, type MetricsWindow } from '@/lib/api'
import { averageFixRounds, formatBucket, formatDuration, formatPercent, leadTimeDelta, windowLabel } from '@/lib/format'

type TrendsWindow = Extract<MetricsWindow, '24h' | '14d' | '30d'>
const RANGES: readonly { readonly value: TrendsWindow; readonly label: string }[] = [
  { value: '24h', label: '24h' }, { value: '14d', label: '14 days' }, { value: '30d', label: '30 days' },
]

/** Runs → Table | Trends switch; shared look with the Runs header. */
const ViewToggle = (): React.ReactElement => (
  <div className="flex rounded-[9px] border border-line-soft bg-panel p-[3px] font-sans">
    <Link to="/runs" className="flex h-[30px] items-center rounded-md px-3.5 text-[13px] text-ink-muted no-underline hover:text-ink">Table</Link>
    <span aria-current="page" className="flex h-[30px] items-center rounded-md bg-[#1c2530] px-3.5 text-[13px] font-semibold text-ink">Trends</span>
  </div>
)

const FIX_ROUND_COLOR: Readonly<Record<string, string>> = { '0': tone.success, '1': tone.accent, '2': tone.warning, '3+': tone.warning, cap: tone.danger }

/** ponytail: stop reasons are free text; colour by keyword so the list scans like the design. */
const stopColor = (reason: string): string =>
  /human|hitl|decision|approv|cost|token|budget/i.test(reason) ? tone.warning
    : /conflict|drift|out of sync/i.test(reason) ? tone.drift
      : /tracker|sync|automation/i.test(reason) ? tone.system
        : tone.danger

/** First / middle / last bucket labels under a time axis; the last reads "today" or "now". */
const AxisTicks = ({ points, bucket }: { readonly points: readonly { readonly at: string }[]; readonly bucket: 'hour' | 'day' }): React.ReactElement | null => {
  if (points.length === 0) return null
  const middle = points[Math.floor(points.length / 2)]
  return (
    <div className="flex justify-between font-mono text-[11px] text-ink-subtle" aria-hidden>
      <span>{formatBucket(points[0]?.at ?? '', bucket)}</span>
      {points.length > 2 && middle && <span>{formatBucket(middle.at, bucket)}</span>}
      <span>{bucket === 'day' ? 'today' : 'now'}</span>
    </div>
  )
}

const TrendsGrid = ({ report }: { readonly report: MetricsReport }): React.ReactElement => {
  const merged = report.throughput.reduce((sum, point) => sum + point.merged, 0)
  const failed = report.throughput.reduce((sum, point) => sum + point.failed, 0)
  const delta = leadTimeDelta(report.leadTime.medianMs, report.leadTime.previousMedianMs)
  const avgRounds = averageFixRounds(report.fixRounds)
  const criteria = report.criteriaAtMerge
  const criteriaTotal = criteria.proven + criteria.waived + criteria.held
  const share = (n: number): string => criteriaTotal ? formatPercent(n / criteriaTotal) : '—'
  const stops = report.stopReasons.reduce((sum, item) => sum + item.count, 0)
  const x = (index: number): number => index
  return (
    <div className="grid min-h-full grid-cols-3 grid-rows-[minmax(260px,1fr)_minmax(260px,1fr)] gap-[18px]">
      <Panel className="col-span-2" title="Throughput" caption={`issues merged per ${report.bucket} · failed or cancelled stacked on top`}
        aside={<><span className="font-mono text-[22px] font-semibold text-success">{merged}</span><span className="text-xs text-ink-subtle">merged · {failed} failed</span></>}>
        {report.throughput.length === 0 ? <EmptyState>No runs finished in this window.</EmptyState> : <>
          <Bars className="min-h-32 grow" gap={10} colors={[tone.success, tone.danger]}
            label={`Throughput over the last ${windowLabel[report.window]}: ${merged} merged, ${failed} failed or cancelled, across ${report.throughput.length} ${report.bucket}s.`}
            data={report.throughput.map((point) => ({ label: formatBucket(point.at, report.bucket), values: [point.merged, point.failed] }))}
            valueLabel={(datum) => String(datum.values[0] ?? 0)} />
          <AxisTicks points={report.throughput} bucket={report.bucket} />
        </>}
      </Panel>

      <Panel title="Lead time" caption="queued → merged">
        <div className="flex gap-5">
          <div className="flex flex-col"><span className="font-mono text-[22px] font-semibold text-accent">{formatDuration(report.leadTime.medianMs)}</span><span className="text-xs text-ink-subtle">median</span></div>
          <div className="flex flex-col"><span className="font-mono text-[22px] font-semibold text-drift">{formatDuration(report.leadTime.p90Ms)}</span><span className="text-xs text-ink-subtle">p90</span></div>
        </div>
        <LineChart className="min-h-24 w-full grow"
          label={`Lead time: median ${formatDuration(report.leadTime.medianMs)}, p90 ${formatDuration(report.leadTime.p90Ms)}.`}
          xDomain={[0, Math.max(1, report.leadTime.series.length - 1)]}
          series={[
            { label: 'p90', color: tone.drift, points: report.leadTime.series.map((point, index) => ({ x: x(index), y: point.p90Ms })) },
            { label: 'median', color: tone.accent, points: report.leadTime.series.map((point, index) => ({ x: x(index), y: point.medianMs })) },
          ]} />
        {delta
          ? <span className={delta.better ? 'text-xs text-success' : 'text-xs text-warning'}>{delta.text} vs previous {windowLabel[report.window]}</span>
          : <span className="text-xs text-ink-subtle">No previous window to compare.</span>}
      </Panel>

      <Panel title="Fix rounds per issue" aside={<span className="font-mono text-xs text-ink-subtle">{avgRounds === null ? '—' : `avg ~${avgRounds.toFixed(1)}`}</span>}>
        <Bars className="min-h-24 grow" gap={14} colors={[tone.accent]}
          label={`Fix rounds per issue: ${report.fixRounds.map((bucket) => `${bucket.label === 'cap' ? 'cap hit' : bucket.label}: ${bucket.count}`).join(', ')}.`}
          data={report.fixRounds.map((bucket) => ({ label: bucket.label, values: [bucket.count], color: FIX_ROUND_COLOR[bucket.label] ?? tone.accent }))}
          valueLabel={(datum) => String(datum.values[0] ?? 0)} />
        <div className="flex justify-around font-mono text-[11px] text-ink-subtle" aria-hidden>
          {report.fixRounds.map((bucket) => <span key={bucket.label}>{bucket.label === 'cap' ? 'cap hit' : bucket.label}</span>)}
        </div>
      </Panel>

      <Panel title="Review and evidence">
        <div className="flex items-center gap-4">
          <Ring value={report.firstReviewApprovalRate} label={`${formatPercent(report.firstReviewApprovalRate)} approved on the first review`}>
            <span className="font-mono text-xl font-semibold">{formatPercent(report.firstReviewApprovalRate)}</span>
          </Ring>
          <span className="text-[13px] text-ink-muted">approved on the first review</span>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs text-ink-subtle">Contract criteria at merge time</span>
          <SegmentBar label={`Criteria at merge: proven ${share(criteria.proven)}, waived by human ${share(criteria.waived)}, held ${share(criteria.held)}.`}
            segments={[
              { label: 'proven', value: criteria.proven, color: tone.success },
              { label: 'waived', value: criteria.waived, color: tone.warning },
              { label: 'held', value: criteria.held, color: tone.danger },
            ]} />
          <Legend items={[
            { label: 'proven', value: share(criteria.proven), color: tone.success },
            { label: 'waived by human', value: share(criteria.waived), color: tone.warning },
            { label: 'held', value: share(criteria.held), color: tone.danger },
          ]} />
        </div>
      </Panel>

      <Panel title="Why runs stop" aside={<span className="font-mono text-xs text-ink-subtle">{stops} stops</span>}>
        {report.stopReasons.length === 0
          ? <EmptyState>No run stopped in this window.</EmptyState>
          : <div className="min-h-0 overflow-auto"><HBarList label="Why runs stop" items={report.stopReasons.map((item) => ({ label: item.reason, value: item.count, color: stopColor(item.reason) }))} /></div>}
      </Panel>
    </div>
  )
}

export const TrendsPage = (): React.ReactElement => {
  const [range, setRange] = React.useState<TrendsWindow>('14d')
  const { data, error, loading } = useFetched(() => getMetrics(range), [range])
  return (
    <Shell title="Runs" subtitle={<ViewToggle />} error={error}
      actions={<RangeChips label="Time range" options={RANGES} value={range} onChange={setRange} />}>
      {data ? <TrendsGrid report={data} /> : loading ? <Loading /> : <EmptyState>No metrics available.</EmptyState>}
    </Shell>
  )
}
