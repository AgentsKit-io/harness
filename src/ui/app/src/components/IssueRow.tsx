import * as React from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { phaseTone, type IssueRecord } from '@/lib/derive'

const PHASE_LABEL: Record<IssueRecord['phase'], string> = {
  available: 'disponível', running: 'em execução', review: 'em revisão', 'needs-input': 'aguardando decisão',
  'needs-decision': 'fechar ou reabrir', blocked: 'bloqueada', completed: 'concluída',
}

export interface IssueRowProps {
  readonly record: IssueRecord
  readonly actions?: React.ReactNode
}

export const IssueRow = ({ record, actions }: IssueRowProps): React.ReactElement => (
  <div className="flex items-center justify-between gap-5 border-b border-line-ghost py-4 last:border-0">
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 font-semibold">
        <Link to={`/runs/${encodeURIComponent(record.issue)}`} className="hover:text-accent">{record.issue}{record.title ? ` · ${record.title}` : ''}</Link>
        <Badge tone={phaseTone(record.phase)}>{PHASE_LABEL[record.phase]}</Badge>
        {record.reviewState && <Badge>{record.reviewState}</Badge>}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-ink-muted">
        {record.run && <span>{record.run.builder} · flow {record.run.flow ?? 'padrão'}</span>}
        {record.dispatch?.branch && <span className="font-mono">{record.dispatch.branch}</span>}
        {record.pullRequest && <span>PR #{record.pullRequest.number}</span>}
        {record.error && <span className="text-red-300">{record.error}</span>}
      </div>
    </div>
    <div className="flex shrink-0 flex-wrap justify-end gap-2">{actions}</div>
  </div>
)

export const RunActionButton = ({ onClick, children, variant }: { readonly onClick: () => void; readonly children: React.ReactNode; readonly variant?: 'outline' | 'destructive' }): React.ReactElement => (
  <Button size="sm" variant={variant ?? 'outline'} onClick={onClick}>{children}</Button>
)
