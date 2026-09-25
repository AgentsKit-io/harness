import * as React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label, Textarea } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { EmptyState, Shell } from '@/components/Shell'
import { answerDecision, useSnapshot, type Decision } from '@/lib/api'
import { deriveInbox } from '@/lib/derive'

const ANCHOR = 'none-of-the-above'

const DecisionCard = ({ decision, onAnswered }: { readonly decision: Decision; readonly onAnswered: () => void }): React.ReactElement => {
  const [optionId, setOptionId] = React.useState<string | null>(null)
  const [freeText, setFreeText] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)

  const submit = (): void => {
    if (!optionId) { setError('Selecione uma resposta para continuar.'); return }
    if (optionId === ANCHOR && !freeText.trim()) { setError('Descreva a alternativa escolhida.'); return }
    setSending(true); setError(null)
    answerDecision(decision.issue, decision.id, { optionId, expectedDigest: decision.digest, ...(optionId === ANCHOR ? { freeText: freeText.trim() } : {}) })
      .then(onAnswered)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSending(false))
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{decision.issue} · {decision.title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 pb-5">
        {decision.message && <p className="rounded-md border border-line-ghost bg-surface px-3 py-3 text-sm text-ink-muted whitespace-pre-wrap">{decision.message}</p>}
        <RadioGroup value={optionId ?? undefined} onValueChange={setOptionId} className="gap-2">
          {decision.options.map((option) => (
            <label key={option.id} className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-3 ${optionId === option.id ? 'border-accent bg-accent-dim' : 'border-line bg-surface'}`}>
              <RadioGroupItem value={option.id} className="mt-0.5" />
              <span className="text-sm">
                <span className="font-semibold">{option.title}</span>
                {option.id === decision.recommendedOptionId && <span className="ml-2 text-[10px] text-accent">recomendado</span>}
                {option.description && <span className="mt-0.5 block text-ink-muted">{option.description}</span>}
              </span>
            </label>
          ))}
          <label className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-3 ${optionId === ANCHOR ? 'border-accent bg-accent-dim' : 'border-line bg-surface'}`}>
            <RadioGroupItem value={ANCHOR} className="mt-0.5" />
            <span className="text-sm font-semibold">Nenhuma das anteriores</span>
          </label>
        </RadioGroup>
        {optionId === ANCHOR && (
          <div className="grid gap-1.5">
            <Label htmlFor={`freetext-${decision.id}`}>Explique como você quer proceder</Label>
            <Textarea id={`freetext-${decision.id}`} value={freeText} onChange={(event) => setFreeText(event.target.value)} maxLength={5000} placeholder="Descreva a alternativa (obrigatório)" />
          </div>
        )}
        {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
        <div><Button onClick={submit} disabled={sending}>{sending ? 'Enviando…' : 'Enviar resposta'}</Button></div>
      </CardContent>
    </Card>
  )
}

export const InboxPage = (): React.ReactElement => {
  const { snapshot, error, refresh } = useSnapshot()
  if (!snapshot) return <Shell title="Inbox" inboxCount={0} error={error}><EmptyState>Carregando…</EmptyState></Shell>
  const decisions = deriveInbox(snapshot)
  return (
    <Shell title="Inbox" subtitle="decisões pendentes de humano" inboxCount={decisions.length} error={error}>
      <div className="grid gap-4">
        {decisions.length ? decisions.map((decision) => <DecisionCard key={decision.id} decision={decision} onAnswered={refresh} />) : <EmptyState>Nenhuma decisão humana pendente.</EmptyState>}
      </div>
    </Shell>
  )
}
