import * as React from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '@/components/Shell'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { enqueueBatch, getJob, getWizard, type BatchRunSettings, type UiJobRecord, getCachedContracts, type CachedContract } from '@/lib/api'
import { formatAge, useLiveSnapshot } from '@/lib/snapshot'
import { availableIssues } from '@/lib/runs'
import type { WizardData } from '@/pages/Wizard'

type Options = Pick<WizardData, 'flows' | 'defaultFlow' | 'builderModels' | 'limits'>

const FIELD = 'h-[38px] rounded-[7px] border border-line bg-panel-alt px-2.5 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-info'
const LABEL = 'flex flex-col gap-1.5 text-xs text-ink-subtle'
const builderId = (model: { readonly provider: string; readonly model: string }): string => `${model.provider}/${model.model}`

const SettingsFields = ({ options, value, onChange }: {
  readonly options: Options
  readonly value: BatchRunSettings
  readonly onChange: (next: BatchRunSettings) => void
}): React.ReactElement => (
  <div className="grid grid-cols-2 gap-3">
    <label className={LABEL}>Flow
      <select className={FIELD} value={value.flow ?? ''} onChange={(event) => onChange({ ...value, flow: event.target.value || null })}>
        <option value="">project default{options.defaultFlow ? ` (${options.defaultFlow})` : ''}</option>
        {options.flows.map((flow) => <option key={flow} value={flow}>{flow}</option>)}
      </select>
    </label>
    <label className={LABEL}>Builder
      <select className={FIELD} value={value.builder ?? ''} onChange={(event) => onChange({ ...value, builder: event.target.value })}>
        {options.builderModels.map((model) => <option key={builderId(model)} value={builderId(model)}>{builderId(model)}</option>)}
      </select>
    </label>
    <label className={LABEL}>Max fix rounds
      <input type="number" min={0} max={options.limits.maxFixRounds} className={cn(FIELD, 'font-mono')} value={value.maxFixRounds ?? ''}
        onChange={(event) => onChange({ ...value, maxFixRounds: Number(event.target.value) })} />
    </label>
    <label className={LABEL}>Tokens per issue
      <input type="number" min={0} step={1000} className={cn(FIELD, 'font-mono')} value={value.perIssueTokens ?? ''}
        onChange={(event) => onChange({ ...value, perIssueTokens: Number(event.target.value) })} />
    </label>
  </div>
)

/** Only what differs from the shared defaults is an override; the rest keeps following the defaults. */
export const diffFrom = (defaults: BatchRunSettings, next: BatchRunSettings): BatchRunSettings =>
  Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== defaults[key as keyof BatchRunSettings])) as BatchRunSettings

const JOB_TONE: Readonly<Record<string, string>> = { succeeded: 'text-success', running: 'text-accent-strong', 'needs-input': 'text-warning', blocked: 'text-warning', failed: 'text-danger' }
const settled = (job: UiJobRecord): boolean => job.status !== 'running' && job.status !== 'cancel-pending'

/** Which listed issues already have a stored contract; a fresh one is reused instead of generated. */
const useCachedContracts = (ids: readonly string[]): Readonly<Record<string, CachedContract>> => {
  const [contracts, setContracts] = React.useState<Readonly<Record<string, CachedContract>>>({})
  const key = ids.slice(0, 100).join(',')
  React.useEffect(() => {
    if (!key) return
    getCachedContracts(key.split(',')).then((value) => setContracts(value.contracts)).catch(() => { /* column stays empty */ })
  }, [key])
  return contracts
}

const ContractTag = ({ contract }: { readonly contract: CachedContract | undefined }): React.ReactElement | null => {
  if (!contract) return <span className="font-mono text-xs text-ink-subtle">no contract</span>
  if (!contract.dispatchable) return <span className="font-mono text-xs text-warning" title="The stored contract has open ambiguities">contract needs input</span>
  return contract.fresh
    ? <span className="font-mono text-xs text-success" title={`Frozen ${new Date(contract.generatedAt).toLocaleString('en-US')}`}>contract cached</span>
    : <span className="font-mono text-xs text-ink-subtle" title="Older than contract.reuseHours; it will be regenerated">contract expired</span>
}

export const BatchPage = (): React.ReactElement => {
  const { snapshot } = useLiveSnapshot()
  const [selected, setSelected] = React.useState<readonly string[]>([])
  const [options, setOptions] = React.useState<Options | null>(null)
  const [defaults, setDefaults] = React.useState<BatchRunSettings>({})
  const [overrides, setOverrides] = React.useState<Readonly<Record<string, BatchRunSettings>>>({})
  const [editing, setEditing] = React.useState<string | null>(null)
  const [jobs, setJobs] = React.useState<readonly UiJobRecord[] | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const issues = snapshot ? availableIssues(snapshot) : []
  const contracts = useCachedContracts(issues.map((issue) => issue.identifier))
  const first = selected[0] ?? null

  // Flows, builders and limits are project-wide; the wizard endpoint of any one issue carries them.
  React.useEffect(() => {
    if (!first || options) return
    getWizard(first).then((raw) => {
      const data = raw as unknown as WizardData
      setOptions(data)
      setDefaults({ flow: data.defaultFlow, builder: data.builderModels[0] ? builderId(data.builderModels[0]) : undefined, maxFixRounds: data.limits.maxFixRounds, perIssueTokens: data.limits.perIssueTokens })
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [first, options])

  React.useEffect(() => {
    if (!jobs || jobs.every(settled)) return
    const timer = setTimeout(() => {
      Promise.all(jobs.map((job) => settled(job) ? job : getJob(job.id).then((value) => value.job))).then(setJobs).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
    }, 1_000)
    return () => clearTimeout(timer)
  }, [jobs])

  const toggle = (issue: string): void => setSelected((current) => current.includes(issue) ? current.filter((item) => item !== issue) : [...current, issue])

  const submit = (): void => {
    setBusy(true); setError(null)
    enqueueBatch({ defaults, issues: selected.map((issue) => ({ issue, ...overrides[issue] })) })
      .then((result) => setJobs(result.jobs))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  const board = snapshot?.board
  const boardAge = snapshot && board?.fetchedAt ? Date.parse(snapshot.generatedAt) - Date.parse(board.fetchedAt) : null

  return (
    <Shell bare title="New batch" error={error}
      subtitle={<span className="font-sans">Pick issues from the tracker, set shared defaults, override per issue.</span>}
      actions={<>
        <Link to="/runs" className="text-[13px] text-accent-strong no-underline">‹ Runs</Link>
        {first && <Link to={`/wizard/${encodeURIComponent(first)}`} className="text-[13px] text-accent-strong no-underline">Single issue wizard ›</Link>}
      </>}>
      <div className="flex min-h-0 grow">
        <section aria-label="Tracker issues" className="flex min-w-0 grow flex-col gap-3 overflow-auto border-r border-line-soft py-5 pr-6 pl-8">
          <div className="flex items-center gap-2">
            {board && <span className="rounded-md bg-[#121820] px-2 py-1 font-mono text-xs text-ink-muted">{board.provider} · {board.repo}</span>}
            <span className="ml-auto text-xs text-ink-subtle">{board ? `board ${board.status} · ${formatAge(boardAge)}` : 'no tracker board'}</span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {issues.map((issue) => {
              const on = selected.includes(issue.identifier)
              return (
                <li key={issue.identifier}>
                  <label className={cn('flex h-[50px] cursor-pointer items-center gap-3 rounded-lg border px-3.5', on ? 'border-[#2b6f95] bg-[#0f1a24]' : 'border-line-soft bg-panel')}>
                    <input type="checkbox" checked={on} onChange={() => toggle(issue.identifier)} className="size-[18px] accent-accent" />
                    <span className="w-24 shrink-0 font-mono text-[13px] font-semibold text-accent-strong">{issue.identifier}</span>
                    <span className="grow truncate text-sm">{issue.title}</span>
                    <ContractTag contract={contracts[issue.identifier]} />
                    <span className="font-mono text-xs text-ink-subtle">{issue.state}</span>
                    {issue.labels.length > 0 && <span className="max-w-[160px] truncate font-mono text-xs text-ink-subtle">{issue.labels.join(', ')}</span>}
                  </label>
                </li>
              )
            })}
          </ul>
          {snapshot && issues.length === 0 && <p className="py-8 text-center text-sm text-ink-subtle">No tracker issues available to queue.</p>}
        </section>

        <section aria-label="Batch settings" className="flex w-[440px] shrink-0 flex-col gap-[18px] overflow-auto py-5 pr-8 pl-6">
          {jobs ? (
            <>
              <h2 className="text-[13px] font-semibold tracking-[.06em] text-[#c5ccd8] uppercase">Freezing contracts</h2>
              <ul className="flex flex-col gap-1.5">
                {jobs.map((job) => (
                  <li key={job.id} className="flex items-center gap-2.5 rounded-[7px] border border-line-soft bg-panel px-3 py-2 text-[13px]">
                    <span className="font-mono font-semibold text-accent-strong">{job.issue ?? job.kind}</span>
                    <span className="grow truncate text-xs text-ink-subtle">{job.error?.message ?? job.phase}</span>
                    <span className={cn('font-mono text-xs', JOB_TONE[job.status] ?? 'text-ink-muted', job.status === 'running' && 'pulse rounded-full px-1')}>{job.status}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-ink-muted">{jobs.every(settled) ? 'Done. Queued runs appear in Runs; ambiguities wait in Attention.' : 'Contracts are being generated in parallel…'}</p>
              <div className="flex gap-2.5">
                <Button asChild variant="outline"><Link to="/" className="no-underline">Go to Attention</Link></Button>
                <Button asChild variant="outline"><Link to="/runs" className="no-underline">View runs</Link></Button>
                <Button variant="ghost" onClick={() => { setJobs(null); setSelected([]); setOverrides({}) }}>New batch</Button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-[13px] font-semibold tracking-[.06em] text-[#c5ccd8] uppercase">Shared defaults</h2>
              {options
                ? <SettingsFields options={options} value={defaults} onChange={setDefaults} />
                : <p className="text-xs text-ink-subtle">{first ? 'Loading options…' : 'Select an issue to load flows, builders and limits.'}</p>}
              <div className="flex flex-col gap-2">
                <div className="flex items-center"><h2 className="text-[13px] font-semibold tracking-[.06em] text-[#c5ccd8] uppercase">Selected</h2><span className="ml-auto font-mono text-xs text-ink-subtle">{selected.length} issues</span></div>
                {selected.map((issue) => {
                  const override = overrides[issue]
                  return (
                    <div key={issue} className="flex flex-col gap-2 rounded-[7px] border border-line-soft bg-panel px-3 py-2 text-[13px]">
                      <div className="flex items-center gap-2.5">
                        <span className="font-mono font-semibold text-accent-strong">{issue}</span>
                        <span className="grow truncate text-xs text-ink-subtle">{override && Object.keys(override).length > 0 ? Object.entries(override).map(([key, value]) => `${key} ${String(value ?? 'default')}`).join(' · ') : 'defaults'}</span>
                        {override && <Button size="sm" variant="ghost" className="h-[26px]" onClick={() => setOverrides(({ [issue]: _, ...rest }) => rest)}>Reset</Button>}
                        <Button size="sm" variant="outline" className="h-[26px] bg-transparent" disabled={!options} aria-expanded={editing === issue}
                          onClick={() => setEditing(editing === issue ? null : issue)}>Override</Button>
                      </div>
                      {editing === issue && options && (
                        <SettingsFields options={options} value={{ ...defaults, ...override }}
                          onChange={(next) => setOverrides((current) => ({ ...current, [issue]: diffFrom(defaults, next) }))} />
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="mt-auto flex flex-col gap-2.5 rounded-[10px] border border-line-soft bg-panel p-3.5 text-xs text-ink-muted">
                <span>Contracts are generated in parallel. Ambiguities go to <span className="text-warning">Attention</span> as decisions; those issues wait there, the rest queue right away.</span>
                <span className="font-mono text-ink-subtle">{snapshot?.capacity.free ?? 0} {snapshot?.capacity.free === 1 ? 'slot' : 'slots'} free now</span>
              </div>
              <Button className="h-[46px] rounded-[9px] text-[15px]" disabled={selected.length === 0 || !options || busy} onClick={submit}>
                {busy ? 'Queuing…' : `Freeze contracts & queue ${selected.length} ${selected.length === 1 ? 'run' : 'runs'}`}
              </Button>
            </>
          )}
        </section>
      </div>
    </Shell>
  )
}
