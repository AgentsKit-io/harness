import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { EmptyState, Shell } from '@/components/Shell'
import { IssueRow, RunActionButton } from '@/components/IssueRow'
import { archiveRun, cancelRun, decideIssue, resumePausedIssue, restoreRun, retryRun, useSnapshot } from '@/lib/api'
import { deriveArchived, deriveAvailable, deriveBlocked, deriveHistory, deriveInbox, deriveRunning, deriveReview } from '@/lib/derive'

const Metric = ({ label, value, tone }: { readonly label: string; readonly value: number; readonly tone?: 'accent' | 'warn' | 'danger' }): React.ReactElement => (
  <Card>
    <CardContent className="py-4">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={`mt-2 text-2xl font-bold tracking-tight ${tone === 'accent' ? 'text-accent' : tone === 'warn' ? 'text-warning' : tone === 'danger' ? 'text-danger' : ''}`}>{value}</div>
    </CardContent>
  </Card>
)

export const OperationPage = (): React.ReactElement => {
  const { snapshot, error, refresh } = useSnapshot()
  const navigate = useNavigate()
  const [busy, setBusy] = React.useState(false)

  const run = (action: () => Promise<unknown>): void => { setBusy(true); action().then(refresh).catch(refresh).finally(() => setBusy(false)) }

  if (!snapshot) return <Shell title="Operação" inboxCount={0} error={error}><EmptyState>Carregando…</EmptyState></Shell>

  const available = deriveAvailable(snapshot)
  const running = deriveRunning(snapshot)
  const review = deriveReview(snapshot)
  const blocked = deriveBlocked(snapshot)
  const history = deriveHistory(snapshot)
  const archived = deriveArchived(snapshot)
  const inbox = deriveInbox(snapshot)

  return (
    <Shell title="Operação" subtitle={`${snapshot.project.repo} · ${snapshot.project.baseBranch}`} inboxCount={inbox.length} error={error}>
      <div className="mb-6 grid grid-cols-4 gap-3">
        <Metric label="Executando" value={running.length} tone="accent" />
        <Metric label="Disponíveis" value={available.length} />
        <Metric label="Inbox" value={inbox.length} tone="warn" />
        <Metric label="Bloqueadas" value={blocked.length} tone="danger" />
      </div>

      <div className="grid gap-4">
        <Card>
          <CardHeader><CardTitle>Disponíveis</CardTitle><span className="text-xs text-ink-muted">selecione uma issue para começar</span></CardHeader>
          <CardContent>
            {available.length ? available.map((issue) => (
              <div key={issue.identifier} className="flex items-center justify-between gap-4 border-b border-line-ghost py-4 last:border-0">
                <div>
                  <div className="font-semibold">{issue.identifier} · {issue.title}</div>
                  <div className="mt-1 text-xs text-ink-muted">{issue.state}{issue.error ? ` · ${issue.error}` : ''}</div>
                </div>
                <Button size="sm" onClick={() => navigate(`/wizard/${encodeURIComponent(issue.identifier)}`)}>Abrir wizard</Button>
              </div>
            )) : <EmptyState>Nenhuma issue disponível agora.</EmptyState>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Executando</CardTitle><span className="text-xs text-ink-muted">{snapshot.capacity.running}/{snapshot.capacity.maxAgents} workers em uso</span></CardHeader>
          <CardContent>
            {running.length ? running.map((record) => (
              <IssueRow key={record.issue} record={record} actions={
                <RunActionButton variant="destructive" onClick={() => { if (window.confirm('Cancelar esta execução e remover terminal, worktree e lease?')) run(() => cancelRun(record.issue, 'cancelado pelo operador')) }}>Cancelar</RunActionButton>
              } />
            )) : <EmptyState>Nenhuma execução ativa.</EmptyState>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Em revisão</CardTitle></CardHeader>
          <CardContent>
            {review.length ? review.map((record) => (
              <IssueRow key={record.issue} record={record} actions={record.phase === 'needs-decision' ? (
                <>
                  <RunActionButton onClick={() => run(() => decideIssue(record.issue, 'close-issue'))}>Fechar issue</RunActionButton>
                  <RunActionButton onClick={() => run(() => decideIssue(record.issue, 'reopen'))}>Reabrir execução</RunActionButton>
                </>
              ) : undefined} />
            )) : <EmptyState>Nenhuma issue em revisão.</EmptyState>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Bloqueadas</CardTitle></CardHeader>
          <CardContent>
            {blocked.length ? blocked.map((record) => (
              <IssueRow key={record.issue} record={record} actions={
                <>
                  <RunActionButton onClick={() => run(() => resumePausedIssue(record.issue))}>Retomar</RunActionButton>
                  {record.run && <RunActionButton onClick={() => run(() => retryRun(record.issue))}>Tentar novamente</RunActionButton>}
                  {record.run && <RunActionButton onClick={() => run(() => archiveRun(record.issue))}>Arquivar</RunActionButton>}
                </>
              } />
            )) : <EmptyState>Nenhuma issue bloqueada.</EmptyState>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Histórico</CardTitle></CardHeader>
          <CardContent>
            {history.length ? history.map((record) => (
              <IssueRow key={record.issue} record={record} actions={record.run && <RunActionButton onClick={() => run(() => archiveRun(record.issue))}>Arquivar</RunActionButton>} />
            )) : <EmptyState>Nenhuma execução concluída ainda.</EmptyState>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Arquivados</CardTitle></CardHeader>
          <CardContent>
            {archived.length ? archived.map((record) => (
              <IssueRow key={record.issue} record={record} actions={<RunActionButton onClick={() => run(() => restoreRun(record.issue))}>Restaurar</RunActionButton>} />
            )) : <EmptyState>Nenhum registro arquivado.</EmptyState>}
          </CardContent>
        </Card>
      </div>
      {busy && <div className="pointer-events-none fixed inset-x-0 bottom-4 text-center text-xs text-ink-subtle">atualizando…</div>}
    </Shell>
  )
}
