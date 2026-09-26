import * as React from 'react'
import { AlertTriangle, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatAge } from '@/lib/snapshot'

export interface ConfirmBasis {
  readonly label: string
  readonly value: string
  /** Age of the fact in ms; `null` = unknown, which counts as stale. */
  readonly ageMs: number | null
  readonly stale: boolean
}

export interface ConfirmRequest {
  readonly title: React.ReactNode
  /** Exactly what will happen, one line each. */
  readonly effects: readonly string[]
  /** The facts the action relies on, each with its age. Any stale fact disables the confirm button. */
  readonly basis: readonly ConfirmBasis[]
  /** When set, the operator must type this (the issue id) to enable confirm. */
  readonly typeToConfirm?: string
  readonly confirmLabel: string
  readonly tone: 'danger' | 'gate' | 'normal'
  /** Extra acknowledgement checkbox (e.g. weakening a gate). */
  readonly acknowledge?: string
  readonly onConfirm: () => Promise<unknown>
}

/**
 * The one confirmation surface for destructive actions and gates (PRD rule 4): lists effects and the data they
 * rely on with its age; refuses while any of that data is stale ("Reconcile first").
 */
export const ConfirmDialog = ({ request, onClose }: { readonly request: ConfirmRequest | null; readonly onClose: () => void }): React.ReactElement | null => {
  const [typed, setTyped] = React.useState('')
  const [acked, setAcked] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => { setTyped(''); setAcked(false); setBusy(false); setError(null) }, [request])
  if (!request) return null
  const stale = request.basis.some((item) => item.stale)
  const ready = !stale && !busy && (!request.typeToConfirm || typed.trim() === request.typeToConfirm) && (!request.acknowledge || acked)
  const confirm = (): void => {
    setBusy(true); setError(null)
    request.onConfirm().then(onClose).catch((cause: unknown) => { setBusy(false); setError(cause instanceof Error ? cause.message : String(cause)) })
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(4,6,9,.72)]" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(event) => event.stopPropagation()}
        className="flex w-[560px] flex-col gap-4 rounded-2xl border border-line bg-panel p-6 shadow-[0_30px_80px_rgba(0,0,0,.6)]">
        <div className="flex items-center gap-2.5">
          <AlertTriangle className={request.tone === 'danger' ? 'size-5 text-danger' : 'size-5 text-warning'} aria-hidden />
          <h2 id="confirm-title" className="text-lg font-semibold">{request.title}</h2>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold tracking-[.06em] text-ink-subtle uppercase">This will</span>
          {request.effects.map((effect) => <div key={effect} className="flex gap-2.5 text-[13px]"><span className="font-mono text-danger">→</span><span>{effect}</span></div>)}
        </div>
        {request.basis.length > 0 && (
          <div className="flex flex-col gap-2 rounded-xl border border-line-soft bg-surface px-3.5 py-3">
            <span className="text-xs font-semibold tracking-[.06em] text-ink-subtle uppercase">Based on</span>
            {request.basis.map((item) => (
              <div key={item.label} className="flex gap-2.5 font-mono text-xs">
                <span className="w-[110px] text-ink-subtle">{item.label}</span>
                <span className="grow text-ink-muted">{item.value}</span>
                <span className={item.stale ? 'text-warning' : 'text-success'}>{item.stale ? `stale · ${formatAge(item.ageMs)}` : formatAge(item.ageMs)}</span>
              </div>
            ))}
          </div>
        )}
        {request.acknowledge && (
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={acked} onChange={(event) => setAcked(event.target.checked)} className="size-4 accent-warning" />{request.acknowledge}</label>
        )}
        {request.typeToConfirm && (
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-muted">
            <span>Type <span className="font-mono text-ink">{request.typeToConfirm}</span> to confirm</span>
            <input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus
              className="h-10 rounded-lg border border-line bg-surface px-3 font-mono text-sm text-ink outline-none focus:border-accent" />
          </label>
        )}
        {error && <div role="alert" className="rounded-md border border-danger/40 bg-danger-dim px-3 py-2 text-sm text-red-200">{error}</div>}
        <div className="flex justify-end gap-2.5">
          <Button variant="outline" onClick={onClose}>Keep as is</Button>
          <Button variant={request.tone === 'danger' ? 'destructive' : 'primary'} disabled={!ready} onClick={confirm}>{stale ? 'Reconcile first' : request.confirmLabel}</Button>
        </div>
        {stale && <div className="flex gap-2 border-t border-line-soft pt-3 text-xs text-ink-subtle"><Lock className="size-3.5 text-drift" aria-hidden />Some of the data above is stale or out of sync. Refresh or reconcile before acting.</div>}
      </div>
    </div>
  )
}

/** Hook form: `const { ask, dialog } = useConfirm()`; render `{dialog}` once, call `ask({...})` from handlers. */
export const useConfirm = (): { readonly ask: (request: ConfirmRequest) => void; readonly dialog: React.ReactElement | null } => {
  const [request, setRequest] = React.useState<ConfirmRequest | null>(null)
  return { ask: setRequest, dialog: <ConfirmDialog request={request} onClose={() => setRequest(null)} /> }
}
