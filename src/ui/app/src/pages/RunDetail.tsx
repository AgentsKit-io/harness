import * as React from 'react'
import { Link, useParams } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState, Shell } from '@/components/Shell'
import { phaseTone } from '@/lib/derive'
import { getTimeline, useSnapshot, type TimelineEvent } from '@/lib/api'

const BackHome = (): React.ReactElement => <Button asChild variant="outline" size="sm" className="mt-3"><Link to="/">← Voltar para a Operação</Link></Button>

const eventDetail = (event: TimelineEvent): string => {
  for (const key of ['reason', 'error', 'message', 'status']) { const value = event[key]; if (typeof value === 'string') return value }
  return event.type
}

export const RunDetailPage = (): React.ReactElement => {
  const { issue = '' } = useParams<{ readonly issue: string }>()
  const { snapshot, error } = useSnapshot()
  const [events, setEvents] = React.useState<readonly TimelineEvent[]>([])

  React.useEffect(() => { getTimeline(issue).then(({ events: value }) => setEvents(value)).catch(() => setEvents([])) }, [issue])

  const record = snapshot?.issues.find((item) => item.issue === issue)
  if (!snapshot) return <Shell title={issue} inboxCount={0} error={error}><EmptyState>Carregando…<br /><BackHome /></EmptyState></Shell>
  if (!record) return <Shell title={issue} inboxCount={0} error={error}><EmptyState>Issue não encontrada na projeção.<br /><BackHome /></EmptyState></Shell>

  return (
    <Shell title={`${record.issue}${record.title ? ` · ${record.title}` : ''}`} inboxCount={0} error={error}>
      <div className="grid gap-4">
        <Button asChild variant="outline" size="sm" className="justify-self-start"><Link to="/">← Voltar para a Operação</Link></Button>
        <Card>
          <CardHeader><CardTitle>Estado</CardTitle><Badge tone={phaseTone(record.phase)}>{record.phase}</Badge></CardHeader>
          <CardContent className="grid grid-cols-2 gap-px overflow-hidden bg-line-ghost text-sm">
            <div className="bg-panel p-4"><div className="text-[11px] text-ink-muted">Flow congelado</div><div className="mt-1">{record.run?.flow ?? 'padrão'}</div></div>
            <div className="bg-panel p-4"><div className="text-[11px] text-ink-muted">Builder congelado</div><div className="mt-1 font-mono">{record.run?.builder ?? '—'}</div></div>
            <div className="bg-panel p-4"><div className="text-[11px] text-ink-muted">Contrato</div><div className="mt-1 font-mono">{record.run?.contractDigest ?? '—'}</div></div>
            <div className="bg-panel p-4"><div className="text-[11px] text-ink-muted">Tentativa</div><div className="mt-1">{record.run?.attempt ?? '—'}</div></div>
            <div className="bg-panel p-4"><div className="text-[11px] text-ink-muted">Branch</div><div className="mt-1 font-mono">{record.dispatch?.branch ?? 'pendente'}</div></div>
            <div className="bg-panel p-4"><div className="text-[11px] text-ink-muted">PR</div><div className="mt-1">{record.pullRequest ? `#${record.pullRequest.number} · ${record.pullRequest.state}` : 'pendente'}</div></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Linha do tempo</CardTitle><span className="text-xs text-ink-muted">mais recentes primeiro</span></CardHeader>
          <CardContent>
            {events.length ? events.map((event, index) => (
              <div key={`${event.at}-${index}`} className="grid grid-cols-[150px_150px_1fr] gap-3 border-b border-line-ghost py-3 text-xs last:border-0">
                <span className="text-ink-subtle">{new Date(event.at).toLocaleString('pt-BR')}</span>
                <span className="font-mono text-accent">{event.type}</span>
                <span className="truncate text-ink-muted">{eventDetail(event)}</span>
              </div>
            )) : <EmptyState>Nenhum evento registrado ainda.</EmptyState>}
          </CardContent>
        </Card>
      </div>
    </Shell>
  )
}
