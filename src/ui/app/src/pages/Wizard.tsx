import * as React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input, Label } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Shell } from '@/components/Shell'
import { enqueueRun, generateContract, getJob, getWizard, saveWizardDraft } from '@/lib/api'

interface WizardData {
  readonly issue: { readonly identifier: string; readonly title: string; readonly state: string; readonly labels: readonly string[] }
  readonly configHash: string
  readonly contract: { readonly status: string; readonly digest: string | null; readonly summary?: string }
  readonly flows: readonly string[]
  readonly defaultFlow: string | null
  readonly builderModels: readonly { readonly provider: string; readonly model: string }[]
  readonly limits: { readonly maxFixRounds: number; readonly perIssueTokens: number }
  readonly capacity: { readonly maxAgents: number; readonly running: number; readonly free: number }
  readonly preflight: { readonly status: string; readonly reason?: string }
  readonly draft: { readonly step: number; readonly flow: string | null; readonly builder: string | null; readonly contractDigest: string | null; readonly maxFixRounds: number | null; readonly perIssueTokens: number | null } | null
}

const STEPS = ['Issue', 'Contrato', 'Flow', 'Builder', 'Limites', 'Revisão'] as const

export const WizardPage = (): React.ReactElement => {
  const { issue = '' } = useParams<{ readonly issue: string }>()
  const navigate = useNavigate()
  const [data, setData] = React.useState<WizardData | null>(null)
  const [step, setStep] = React.useState(0)
  const [flow, setFlow] = React.useState<string | null>(null)
  const [builder, setBuilder] = React.useState<string | null>(null)
  const [contractDigest, setContractDigest] = React.useState<string | null>(null)
  const [maxFixRounds, setMaxFixRounds] = React.useState(0)
  const [perIssueTokens, setPerIssueTokens] = React.useState(0)
  const [generating, setGenerating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(() => {
    getWizard(issue).then((raw) => {
      const value = raw as unknown as WizardData
      setData(value)
      setStep(value.draft?.step ?? 0)
      setFlow(value.draft?.flow ?? value.defaultFlow)
      setBuilder(value.draft?.builder ?? (value.builderModels[0] ? `${value.builderModels[0].provider}/${value.builderModels[0].model}` : null))
      setContractDigest(value.draft?.contractDigest ?? value.contract.digest)
      setMaxFixRounds(value.draft?.maxFixRounds ?? value.limits.maxFixRounds)
      setPerIssueTokens(value.draft?.perIssueTokens ?? value.limits.perIssueTokens)
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [issue])

  React.useEffect(load, [load])

  const persist = (patch: Record<string, unknown>): void => { void saveWizardDraft(issue, patch) }
  const goto = (next: number): void => { setStep(next); persist({ step: next }) }

  const runContractGeneration = (refresh: boolean): void => {
    setGenerating(true); setError(null)
    generateContract(issue, refresh).then(async ({ job }) => {
      let current = job
      while (current.status === 'running' || current.status === 'cancel-pending') {
        await new Promise((resolve) => setTimeout(resolve, 700))
        current = (await getJob(current.id)).job
      }
      if (current.status !== 'succeeded' && current.status !== 'needs-input' && current.status !== 'blocked') throw new Error(current.error?.message ?? 'Não foi possível gerar o contrato.')
      load()
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setGenerating(false))
  }

  const confirm = (): void => {
    if (!builder || !contractDigest || !data) return
    setError(null)
    enqueueRun({ issue, configHash: data.configHash, flow, builder, contractDigest, maxFixRounds, perIssueTokens })
      .then(() => navigate('/'))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  if (!data) return <Shell title="Wizard" inboxCount={0} error={error}><p className="text-ink-muted">Carregando…</p><Button variant="outline" size="sm" className="mt-3" onClick={() => navigate('/')}>← Voltar para a Operação</Button></Shell>

  const contractValid = data.contract.status === 'valid' && Boolean(contractDigest)
  const stepValid = [true, contractValid, true, Boolean(builder), maxFixRounds >= 0 && perIssueTokens >= 0, true][step]

  return (
    <Shell title={`Configurar ${data.issue.identifier}`} inboxCount={0} error={error}>
      <div className="mb-5 grid grid-cols-6 gap-1">
        {STEPS.map((name, index) => (
          <div key={name} className={`border-b-2 pb-2 text-center text-[11px] ${index === step ? 'border-accent text-accent' : index < step ? 'border-success text-success' : 'border-line text-ink-subtle'}`}>{index + 1}. {name}</div>
        ))}
      </div>
      <Card>
        <CardContent className="grid gap-5 py-6">
          {step === 0 && (
            <div>
              <h2 className="mb-1 text-lg font-semibold">Confirme a issue</h2>
              <p className="mb-4 text-sm text-ink-muted">Confira os dados recebidos do tracker.</p>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md bg-line-ghost">
                <div className="bg-panel p-4"><div className="text-[11px] text-ink-muted">Issue</div><div className="mt-1 font-mono">{data.issue.identifier}</div></div>
                <div className="bg-panel p-4"><div className="text-[11px] text-ink-muted">Título</div><div className="mt-1">{data.issue.title}</div></div>
              </div>
            </div>
          )}
          {step === 1 && (
            <div>
              <h2 className="mb-1 text-lg font-semibold">Prepare o contrato</h2>
              <p className="mb-4 text-sm text-ink-muted">O contrato define o que o agente precisa entregar e como a conclusão será verificada.</p>
              {data.contract.status === 'valid' ? (
                <div className="grid gap-3">
                  <div className="flex items-center justify-between rounded-md border border-line-ghost px-3 py-2"><span>Contrato válido</span><Badge tone="ok">aprovado</Badge></div>
                  <pre className="max-h-64 overflow-auto rounded-md border border-line bg-surface p-4 text-xs whitespace-pre-wrap">{data.contract.summary}</pre>
                </div>
              ) : (
                <div className="grid gap-3">
                  <div className="flex items-center justify-between rounded-md border border-line-ghost px-3 py-2"><span>Contrato disponível</span><Badge tone="bad">{data.contract.status}</Badge></div>
                  {data.contract.summary && <p className="text-sm text-ink-muted">{data.contract.summary}</p>}
                </div>
              )}
              <Button className="mt-4" onClick={() => runContractGeneration(true)} disabled={generating}>{generating ? 'Gerando…' : 'Gerar novamente'}</Button>
            </div>
          )}
          {step === 2 && (
            <div>
              <h2 className="mb-1 text-lg font-semibold">Escolha o Flow</h2>
              <RadioGroup value={flow ?? ''} onValueChange={(value) => { setFlow(value || null); persist({ flow: value || null }) }} className="mt-4">
                <label className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-3"><RadioGroupItem value="" /><span>Padrão do projeto</span></label>
                {data.flows.map((name) => <label key={name} className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-3"><RadioGroupItem value={name} /><span>{name}</span></label>)}
              </RadioGroup>
            </div>
          )}
          {step === 3 && (
            <div>
              <h2 className="mb-1 text-lg font-semibold">Escolha o agente builder</h2>
              <RadioGroup value={builder ?? ''} onValueChange={(value) => { setBuilder(value); persist({ builder: value }) }} className="mt-4">
                {data.builderModels.map((model) => { const id = `${model.provider}/${model.model}`; return <label key={id} className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-3 font-mono text-sm"><RadioGroupItem value={id} /><span>{id}</span></label> })}
              </RadioGroup>
            </div>
          )}
          {step === 4 && (
            <div className="grid gap-4">
              <h2 className="text-lg font-semibold">Defina os limites</h2>
              <div className="grid gap-1.5"><Label>Máximo de rodadas de correção (teto {data.limits.maxFixRounds})</Label><Input type="number" min={0} value={maxFixRounds} onChange={(event) => { const value = Number(event.target.value); setMaxFixRounds(value); persist({ maxFixRounds: value }) }} /></div>
              <div className="grid gap-1.5"><Label>Tokens por issue (teto {data.limits.perIssueTokens || '—'})</Label><Input type="number" min={0} value={perIssueTokens} onChange={(event) => { const value = Number(event.target.value); setPerIssueTokens(value); persist({ perIssueTokens: value }) }} /></div>
            </div>
          )}
          {step === 5 && (
            <div>
              <h2 className="mb-1 text-lg font-semibold">Revise e confirme</h2>
              <p className="mb-4 text-sm text-ink-muted">A issue entra na fila; a página não espera o agente.</p>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md bg-line-ghost text-sm">
                <div className="bg-panel p-4"><div className="text-[11px] text-ink-muted">Flow</div><div className="mt-1">{flow ?? 'padrão'}</div></div>
                <div className="bg-panel p-4"><div className="text-[11px] text-ink-muted">Builder</div><div className="mt-1 font-mono">{builder}</div></div>
                <div className="bg-panel p-4"><div className="text-[11px] text-ink-muted">Limites</div><div className="mt-1">{maxFixRounds} rodadas · {perIssueTokens || 'sem teto'} tokens</div></div>
                <div className="bg-panel p-4"><div className="text-[11px] text-ink-muted">Fila</div><div className="mt-1">{data.capacity.free > 0 ? 'pode iniciar quando confirmado' : 'aguardará slot'}</div></div>
              </div>
            </div>
          )}
          <div className="flex justify-between border-t border-line-ghost pt-5">
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => navigate('/')}>Cancelar</Button>
              {step > 0 && <Button variant="outline" onClick={() => goto(step - 1)}>Voltar</Button>}
            </div>
            {step < STEPS.length - 1 ? <Button onClick={() => goto(step + 1)} disabled={!stepValid}>Continuar</Button> : <Button onClick={confirm} disabled={!builder || !contractDigest}>Confirmar e enfileirar execução</Button>}
          </div>
        </CardContent>
      </Card>
    </Shell>
  )
}
