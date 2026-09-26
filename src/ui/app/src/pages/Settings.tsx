import * as React from 'react'
import { AlertTriangle, Info, Search } from 'lucide-react'
import { EmptyState, Shell } from '@/components/Shell'
import { Loading, useFetched } from '@/components/Insights'
import { Button } from '@/components/ui/button'
import {
  ApiError, getConfig, proposeConfig, tuning, writeLocalConfig,
  type ConfigChange, type ConfigField, type ConfigLayer, type ConfigProposal, type EffectiveConfig,
} from '@/lib/api'
import { formatValue, obviouslyWeakens, parseValue } from '@/lib/format'
import { useLiveSnapshot } from '@/lib/snapshot'
import { cn } from '@/lib/utils'

const LAYER_CLASS: Readonly<Record<ConfigLayer, string>> = {
  default: 'text-ink-subtle', global: 'text-ink-subtle', team: 'text-accent-strong', 'team-overlay': 'text-accent-strong', personal: 'text-warning',
}
const LAYER_LABEL: Readonly<Record<ConfigLayer, string>> = { default: 'default', global: 'global', team: 'team', 'team-overlay': 'team overlay', personal: 'personal' }

interface Pending { readonly field: ConfigField; readonly value: unknown }

const errorText = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)
/** The server answers 409 when a change weakens a gate and `confirmWeakening` was not set. */
const refusedForWeakening = (cause: unknown): boolean => cause instanceof ApiError && cause.status === 409
const shortDate = (iso: string): string => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

const DiffLines = ({ lines }: { readonly lines: readonly string[] }): React.ReactElement => (
  <pre className="overflow-auto rounded-md bg-surface px-2.5 py-2 font-mono text-xs leading-[1.7]">
    {lines.map((line, index) => (
      <div key={index} className={line.startsWith('+') ? 'text-green-300' : line.startsWith('-') ? 'text-red-300' : 'text-ink-subtle'}>{line}</div>
    ))}
  </pre>
)

const FieldRow = ({ field, pending, onStage, onTuning }: {
  readonly field: ConfigField
  readonly pending: Pending | undefined
  readonly onStage: (field: ConfigField, value: unknown) => void
  readonly onTuning: (action: 'revert' | 'freeze' | 'unfreeze', path: string) => void
}): React.ReactElement => {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const open = (): void => { setDraft(formatValue(pending ? pending.value : field.value)); setEditing(true) }
  const submit = (event: React.FormEvent): void => { event.preventDefault(); onStage(field, parseValue(draft)); setEditing(false) }
  const note = field.tuning
    ? `auto-tuned ${shortDate(field.tuning.at)} · ${field.tuning.metric}${field.tuning.frozen ? ' · frozen' : ''}`
    : field.classification === 'gate' ? `gate · ${field.description}` : field.description
  const noteClass = field.tuning ? 'text-[#c4b5fd]' : field.classification === 'gate' ? 'text-red-300' : 'text-ink-subtle'
  return (
    <div className="border-b border-line-ghost">
      <div className="grid min-h-12 grid-cols-[minmax(0,1fr)_150px_90px_120px] items-center gap-2.5 py-1">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-xs">{field.path}</span>
          <span className={cn('truncate text-[11px]', noteClass)} title={note}>{note}</span>
        </span>
        <span className={cn('truncate font-mono text-[13px]', pending && 'text-warning')} title={formatValue(field.value)}>
          {pending ? `${formatValue(field.value)} → ${formatValue(pending.value)}` : field.tuning ? `${formatValue(field.tuning.from)} → ${formatValue(field.value)}` : formatValue(field.value)}
        </span>
        <span className={cn('font-mono text-[11px]', LAYER_CLASS[field.layer])}>{LAYER_LABEL[field.layer]}</span>
        <span className="flex justify-end gap-1.5">
          {field.tuning ? <>
            {!field.tuning.frozen && <Button size="sm" variant="outline" onClick={() => onTuning('revert', field.path)}>Revert</Button>}
            <Button size="sm" variant="ghost" onClick={() => onTuning(field.tuning?.frozen ? 'unfreeze' : 'freeze', field.path)}>{field.tuning.frozen ? 'Unfreeze' : 'Freeze'}</Button>
          </> : field.editable === 'readonly' ? <span className="text-xs text-ink-subtle">read-only</span>
            : <Button size="sm" variant="outline" aria-expanded={editing} onClick={open}>{field.editable === 'personal' ? 'Edit' : 'Propose'}</Button>}
        </span>
      </div>
      {editing && (
        <form onSubmit={submit} className="flex items-center gap-2 pb-2.5">
          <label className="sr-only" htmlFor={`edit-${field.path}`}>New value for {field.path}</label>
          <input id={`edit-${field.path}`} value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus
            className="h-8 grow rounded-md border border-line bg-surface px-2.5 font-mono text-xs text-ink outline-none focus:border-accent" />
          <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>Cancel</Button>
          <Button size="sm" variant="primary" type="submit">{field.editable === 'personal' ? 'Stage change' : 'Add to proposal'}</Button>
        </form>
      )}
    </div>
  )
}

const PersonalCard = ({ config, changes, onDiscard, onSaved }: {
  readonly config: EffectiveConfig
  readonly changes: readonly Pending[]
  readonly onDiscard: () => void
  readonly onSaved: (config: EffectiveConfig) => void
}): React.ReactElement => {
  const [acked, setAcked] = React.useState(false)
  const [serverAsks, setServerAsks] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const weakening = serverAsks || changes.some((change) => obviouslyWeakens(change.field.classification, change.field.value, change.value))
  const file = config.layers.find((layer) => layer.layer === 'personal')?.file ?? 'personal overlay'
  const save = (): void => {
    setBusy(true); setError(null)
    writeLocalConfig({ changes: changes.map((change): ConfigChange => ({ path: change.field.path, value: change.value })), confirmWeakening: weakening && acked })
      .then((next) => { setAcked(false); setServerAsks(false); onSaved(next) })
      .catch((cause: unknown) => { if (refusedForWeakening(cause) && !(weakening && acked)) setServerAsks(true); else setError(errorText(cause)) })
      .finally(() => setBusy(false))
  }
  return (
    <div className={cn('flex flex-col gap-2.5 rounded-[10px] border p-3.5', weakening ? 'border-[#5a4618] bg-[#1e1a10]' : 'border-line-soft bg-panel')}>
      <div className="flex items-center gap-2">
        <span className="rounded-[5px] bg-warning px-[7px] py-0.5 font-mono text-[11px] font-semibold text-[#1a1206]">personal</span>
        <span className="truncate font-mono text-xs text-ink-muted">{file}</span>
      </div>
      <DiffLines lines={changes.flatMap((change) => [`- ${change.field.path}: ${formatValue(change.field.value)}`, `+ ${change.field.path}: ${formatValue(change.value)}`])} />
      {weakening && <>
        <div className="flex gap-2 text-xs text-[#fde68a]">
          <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
          <span>Weakens a team gate: your runs get a lower guarantee than the team configured. Only your runs use it, and each one carries a <span className="font-mono">personal override</span> badge.</span>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={acked} onChange={(event) => setAcked(event.target.checked)} className="size-4 accent-warning" />
          I understand this lowers the guarantee for my runs
        </label>
      </>}
      {error && <div role="alert" className="rounded-md border border-danger/40 bg-danger-dim px-3 py-2 text-xs text-red-200">{error}</div>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onDiscard}>Discard</Button>
        <Button size="sm" className={weakening ? 'bg-warning text-[#1a1206]' : undefined} variant="primary" disabled={busy || (weakening && !acked)} onClick={save}>Save personal override</Button>
      </div>
    </div>
  )
}

const TeamCard = ({ changes, onDiscard }: { readonly changes: readonly Pending[]; readonly onDiscard: () => void }): React.ReactElement => {
  const [proposal, setProposal] = React.useState<ConfigProposal | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    let cancelled = false
    setProposal(null); setError(null)
    proposeConfig(changes.map((change) => ({ path: change.field.path, value: change.value })))
      .then((value) => { if (!cancelled) setProposal(value) })
      .catch((cause: unknown) => { if (!cancelled) setError(errorText(cause)) })
    return () => { cancelled = true }
  }, [changes])
  const copy = (): void => { if (proposal) void navigator.clipboard.writeText(proposal.diff).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1_500) }) }
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-line-soft bg-panel p-3.5">
      <div className="flex items-center gap-2">
        <span className="rounded-[5px] bg-[#0f2a3a] px-[7px] py-0.5 font-mono text-[11px] font-semibold text-accent-strong">team proposal</span>
        <span className="truncate font-mono text-xs text-ink-muted">{proposal?.file ?? '…'}</span>
      </div>
      {proposal ? <DiffLines lines={proposal.diff.split('\n')} /> : !error && <span className="text-xs text-ink-subtle" role="status">Building diff…</span>}
      {error && <div role="alert" className="rounded-md border border-danger/40 bg-danger-dim px-3 py-2 text-xs text-red-200">{error}</div>}
      <span className="text-xs text-ink-subtle">Not written to the versioned file. Commit it or open a PR so the team reviews it.</span>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onDiscard}>Discard</Button>
        <Button size="sm" variant="primary" disabled={!proposal} onClick={copy}>{copied ? 'Copied' : 'Copy diff'}</Button>
        <span className="sr-only" role="status">{copied ? 'Diff copied to clipboard' : ''}</span>
      </div>
    </div>
  )
}

const SettingsBody = ({ config, onConfig, reload, setError }: {
  readonly config: EffectiveConfig
  readonly onConfig: (config: EffectiveConfig) => void
  readonly reload: () => void
  readonly setError: (error: string | null) => void
}): React.ReactElement => {
  const { snapshot } = useLiveSnapshot()
  const [section, setSection] = React.useState<string | null>(null)
  const [filter, setFilter] = React.useState('')
  const [pending, setPending] = React.useState<ReadonlyMap<string, Pending>>(new Map())
  const [saved, setSaved] = React.useState(false)
  const sections = [...new Set(config.fields.map((field) => field.section))]
  const needle = filter.trim().toLowerCase()
  const visible = config.fields.filter((field) => (section === null || field.section === section) && (!needle || `${field.path} ${field.description}`.toLowerCase().includes(needle)))
  const groups = sections.map((name) => ({ name, fields: visible.filter((field) => field.section === name) })).filter((group) => group.fields.length > 0)
  const personal = React.useMemo(() => [...pending.values()].filter((change) => change.field.editable === 'personal'), [pending])
  const team = React.useMemo(() => [...pending.values()].filter((change) => change.field.editable === 'propose'), [pending])

  const stage = (field: ConfigField, value: unknown): void => {
    setSaved(false)
    setPending((prev) => {
      const next = new Map(prev)
      if (JSON.stringify(value) === JSON.stringify(field.value)) next.delete(field.path); else next.set(field.path, { field, value })
      return next
    })
  }
  const drop = (kind: 'personal' | 'propose'): void => setPending((prev) => new Map([...prev].filter(([, change]) => change.field.editable !== kind)))
  const onTuning = (action: 'revert' | 'freeze' | 'unfreeze', path: string): void => {
    // Revert freezes the knob server-side; the undo itself is a team change (the UI never writes loop.config.yaml),
    // so it lands in the team proposal panel as the previous value.
    const field = config?.fields.find((item) => item.path === path)
    tuning(action, path).then(() => {
      setError(null)
      if (action === 'revert' && field?.tuning) stage(field, field.tuning.from)
      reload()
    }).catch((cause: unknown) => setError(errorText(cause)))
  }
  const running = snapshot?.capacity.running ?? 0

  return (
    <div className="flex min-h-0 grow">
      <nav aria-label="Settings sections" className="flex w-[200px] shrink-0 flex-col gap-0.5 overflow-auto border-r border-line-soft px-3 py-[18px]">
        {[null, ...sections].map((name) => {
          const marks = [...pending.values()].filter((change) => name === null || change.field.section === name).length
          return (
            <button key={name ?? '__all'} type="button" aria-current={section === name ? 'true' : undefined} onClick={() => setSection(name)}
              className={cn('flex h-9 items-center rounded-[7px] px-2.5 text-left text-[13px]', section === name ? 'bg-raised text-ink' : 'text-ink-muted hover:bg-[#121821]')}>
              <span className="grow truncate">{name ?? 'All'}</span>
              {marks > 0 && <span className="font-mono text-[11px] text-warning" aria-label={`${marks} pending`}>{marks}</span>}
            </button>
          )
        })}
      </nav>

      <section aria-label="Fields" className="flex min-w-0 grow flex-col gap-3.5 overflow-auto px-6 py-[18px]">
        <label className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line-soft bg-panel-alt px-3 text-[13px] text-ink-subtle focus-within:border-accent">
          <Search className="size-[15px]" aria-hidden />
          <span className="sr-only">Filter settings</span>
          <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter keys, e.g. review, tokens, ceiling"
            className="grow border-0 bg-transparent text-ink outline-none placeholder:text-ink-subtle" />
        </label>
        {groups.length === 0 && <EmptyState>No setting matches “{filter}”.</EmptyState>}
        {groups.map((group) => (
          <div key={group.name} className="flex flex-col">
            <h2 className="mb-1.5 text-xs font-semibold tracking-[.06em] text-ink-muted uppercase">{group.name}</h2>
            {group.fields.map((field) => <FieldRow key={field.path} field={field} pending={pending.get(field.path)} onStage={stage} onTuning={onTuning} />)}
          </div>
        ))}
      </section>

      <aside aria-label="Pending changes" className="flex w-[400px] shrink-0 flex-col gap-3.5 overflow-auto border-l border-line-soft py-[18px] pr-6 pl-5">
        <h2 className="text-xs font-semibold tracking-[.06em] text-ink-muted uppercase">Pending changes</h2>
        {pending.size === 0 && <p className="text-xs text-ink-subtle">{saved ? 'Personal override saved.' : 'Edit a personal value or propose a team value to collect changes here.'}</p>}
        {personal.length > 0 && <PersonalCard config={config} changes={personal} onDiscard={() => drop('personal')} onSaved={(next) => { onConfig(next); drop('personal'); setSaved(true) }} />}
        {team.length > 0 && <TeamCard changes={team} onDiscard={() => drop('propose')} />}
        {config.weakenedGates.length > 0 && (
          <div className="flex flex-col gap-1 rounded-lg border border-[#5a4618] px-3 py-2.5 text-xs text-[#fde68a]">
            <span>Your personal layer weakens {config.weakenedGates.length} team gate{config.weakenedGates.length === 1 ? '' : 's'}; runs record it:</span>
            {config.weakenedGates.map((path) => <span key={path} className="font-mono">{path}</span>)}
          </div>
        )}
        <div className="mt-auto flex gap-2 rounded-lg border border-dashed border-line p-3 text-xs text-ink-muted">
          <Info className="size-4 shrink-0 text-accent-strong" aria-hidden />
          <span>Applies to runs queued after saving. {running === 0 ? 'Running runs keep' : `The ${running} running run${running === 1 ? '' : 's'} keep`} the config frozen at enqueue.</span>
        </div>
      </aside>
    </div>
  )
}

export const SettingsPage = (): React.ReactElement => {
  const { data, error, loading, reload } = useFetched(getConfig, [])
  const [override, setOverride] = React.useState<EffectiveConfig | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  React.useEffect(() => setOverride(null), [data])
  const config = override ?? data
  return (
    <Shell title="Settings" bare error={actionError ?? error}
      subtitle={config ? `effective config · hash ${config.hash.slice(0, 4)}…${config.hash.slice(-3)} · ${config.layers.length} layers` : undefined}
      actions={config && (
        <ul aria-label="Config layers" className="flex gap-1.5 font-mono text-[11px]">
          {config.layers.map((layer) => (
            <li key={layer.layer} className={cn('rounded-md bg-[#121820] px-2 py-1', LAYER_CLASS[layer.layer])}>{LAYER_LABEL[layer.layer]}{layer.file ? ` · ${layer.file}` : ''}</li>
          ))}
        </ul>
      )}>
      {config ? <SettingsBody config={config} onConfig={setOverride} reload={reload} setError={setActionError} /> : loading ? <Loading /> : <EmptyState>Config unavailable.</EmptyState>}
    </Shell>
  )
}
