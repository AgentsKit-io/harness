---
tipo: pacote
repo: harness
camada: ferramenta
visibilidade: publico
npm: "@agentskit/harness"
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; nada foi executado. Código de src/loop e src/cli.ts lido; docs/LOOP.md e os ADRs 0027–0043 conferidos contra o código (divergências em Auditoria - harness). Índice .doc-bridge/index.json usado só como evidência do corpus de documentação."
fontes:
  - harness/README.md
  - harness/docs/LOOP.md
  - harness/loop.config.example.yaml
  - harness/package.json
  - harness/src/cli.ts
  - harness/src/loop/tick.ts
  - harness/src/loop/deliver.ts
  - harness/src/loop/deliver-state.ts
  - harness/src/loop/config.ts
  - harness/src/loop/contract.ts
  - harness/src/loop/plan-vote.ts
  - harness/src/loop/plan-stage.ts
  - harness/src/loop/release.ts
  - harness/src/loop/connectors.ts
  - harness/src/loop/runner-connector.ts
  - harness/src/loop/artifacts.ts
  - harness/src/loop/dod.ts
  - harness/src/loop/flows.ts
  - harness/src/loop/event-bus.ts
  - harness/src/loop/worker-guard.ts
  - harness/src/loop/resilience-state.ts
  - harness/src/loop/budget.ts
  - harness/src/loop/retro.ts
  - harness/src/loop/observe-stage.ts
  - harness/src/loop/install.ts
  - harness/src/loop/stage-lock.ts
  - harness/src/loop/index.ts
  - harness/.github/workflows/release-harness.yml
tags: [pacote, repo/harness, camada/ferramenta]
---

# harness-loop

> [!tldr] Em linguagem comum
> É a esteira que transforma uma issue em trabalho de agente, revisão e entrega: congela o que "pronto" significa, deixa um agente trabalhar num espaço separado, confere as provas que ele deixa e só então faz o merge — parando para uma pessoa nos pontos que a política define.

← [[00 Hub - harness]]

## O que faz e por que existe

Compõe, em cima do Orca, do tracker (Linear ou GitHub Issues) e do GitHub, um ciclo que drena a fila de uma pessoa 24 h por dia: `intake → contrato → (plano → votos) → despacho → PR → checks → verificação → revisão → definição de pronto → merge`, mais planejamento (`loop plan`), liberação (`loop release`) e estágios de saúde e melhoria (`observe`, `retro`, `intake`, `maintain`). O harness fornece as partes determinísticas; o Orca, a agenda, os worktrees e os terminais (`harness/docs/LOOP.md:3-6`).

Princípio de projeto: **um modelo produz conteúdo; a máquina decide a transição** ([[harness ADR-0032 - Estágios como máquinas de estado]]). O worker é um CLI opaco (`claude`, `codex`, `grok`, `opencode`): o harness não vê suas chamadas de modelo ou de ferramenta, só o worktree. Por isso o contrato entre os dois é feito de **arquivos** em `.ak-loop/` no worktree: `plan.md`, `verify.json` e `dod.json` (`harness/src/loop/artifacts.ts:9-14`).

Estrutura do trabalho (`src/loop/`), em grupos:
- **Entrada e despacho:** `tick.ts` (intake, admissão, contrato, plano/voto, worktree, brief, terminal), `contract.ts`, `plan-vote.ts`, `brief.ts`, `skills.ts`, `base-view.ts`, `slots.ts`, `routing.ts`, `budget.ts`, `rotation.ts`.
- **Entrega:** `deliver.ts` (máquina por PR) e `deliver-state.ts`, `dod.ts`, `artifacts.ts`, `layers.ts`, `flows.ts`, `worker-guard.ts`, `github-intake.ts`.
- **Planejar e liberar:** `plan-stage.ts`, `documents.ts`, `release.ts`, `intake.ts` (alertas/manutenção).
- **Operação e saúde:** `doctor.ts`, `install.ts`, `automations.ts`, `guided-install.ts`, `debrief.ts`, `watch.ts`, `observability.ts`, `observe-stage.ts`, `retro.ts`, `tuning.ts`, `agent-improvement.ts`, `resilience-state.ts`, `stage-lock.ts`, `detached-worker.ts`.
- **Costuras e estado:** `connectors.ts`, `runner-connector.ts`, `queue.ts`, `hitl.ts`, `lifecycle.ts`, `agent-runs.ts`, `event-bus.ts`, `event-vocabulary.ts`, `notify.ts`, `config.ts`, `presets.ts`, `init.ts`, `fs-atomic.ts`.

## API e contratos

Tudo é exportado por `harness/src/index.ts:104-256`. (`harness/src/loop/index.ts` é um barril paralelo que **ninguém importa** — veja o aviso no fim.)

| Símbolo | Tipo | Para que serve | Onde |
|---|---|---|---|
| `LoopConfigSchema`, `loadLoopConfig`, `composeLoopConfig`, `mergeLoopConfig`, `validateLoopConfig` | zod/função | Schema da configuração e carga em quatro camadas | `harness/src/loop/config.ts:105`, `:1201`, `:1183`, `:1137`, `:1052` |
| `runTick`, `precheckTick`, `gatherLoopState`, `launchWorkerTerminal`, `busyIssues`, `appendLoopEvent` | função | Um tick: estado → candidatos → contrato → plano → despacho; log de eventos | `harness/src/loop/tick.ts:523`, `:494`, `:441`, `:193`, `:300`, `:395` |
| `runDeliver`, `precheckDeliver`, `approveHeldDelivery`, `listDispatched`, `readDeliveryState` | função | Uma passada de entrega sobre cada despacho e cada PR de intake | `harness/src/loop/deliver.ts:1300`, `:1295`; `harness/src/loop/deliver-state.ts:79`, `:93`, `:51` |
| `generateContract`, `assessContract`, `readStoredContract`, `contractIsFresh`, `TaskContractSchema` | função/zod | Contrato congelado e juízo de "despachável" | `harness/src/loop/contract.ts:376`, `:155`, `:166`, `:180`, `:118` |
| `runPlanWithVotes`, `tallyVotes`, `readStoredPlan` | função | Plano por issue com votos (2 de 3) antes de abrir worktree | `harness/src/loop/plan-vote.ts:238`, `:197`, `:64` |
| `startPlan`, `interviewRound`, `approvePlan`, `architectRound`, `approveDesign`, `decomposeRound`, `createPlannedIssues` | função | Objetivo → PRD → design → issues, com dois gates humanos | `harness/src/loop/plan-stage.ts:153`, `:281`, `:298`, `:311`, `:355`, `:364`, `:405` |
| `readReleaseBatch`, `approveRelease`, `runReleaseStage` | função | Promover o lote aprovado e fazer deploy/smoke/rollback | `harness/src/loop/release.ts:49`, `:77`, `:103` |
| `resolveFlow`, `resolveFlowSettings`, `workerPhaseEnabled` | função | Perfil de fluxo por issue (qual rigor, quais fases) | `harness/src/loop/flows.ts:31`, `:65`, `:145` |
| `assessDod`, `readPhaseArtifacts`, `missingArtifacts`, `verifyProofs` | função | Duas listas de pronto e artefatos do worker | `harness/src/loop/dod.ts:87`; `harness/src/loop/artifacts.ts:68`, `:86`, `:90` |
| `createLoopEventBus`, `loadLoopPlugins` | função | Barramento local e hooks `before*/after*` | `harness/src/loop/event-bus.ts:44`, `:90` |
| `resolveConnectors`, `createRunnerConnector`, `createOrcaRunner`, `createLocalRunner` | função | Costuras de tracker/SCM/runner | `harness/src/loop/connectors.ts:277`; `harness/src/loop/runner-connector.ts:141`, `:40`, `:72` |
| `installLoopAutomations`, `uninstallLoopAutomations`, `loopStatus`, `runGuidedInstall` | função | Automações no Orca, idempotentes por nome | `harness/src/loop/install.ts:48`, `:87`, `:109`; `harness/src/loop/guided-install.ts:82` (`runGuidedInstall`) |
| `runLoopDoctor`, `buildDebriefReport`, `watchDeliveries`, `runObservability`, `runObserveStage`, `runRetroStage` | função | Leituras: saúde, estado atual, observação e retro | `harness/src/loop/doctor.ts:76`; `harness/src/loop/debrief.ts:154`; `harness/src/loop/watch.ts:134`; `harness/src/loop/observability.ts:157`; `harness/src/loop/observe-stage.ts:116`; `harness/src/loop/retro.ts:295` |
| `installWorkerGuard`, `runWorkerGuard` | função | Hook de edição no worktree (`loop worker-guard`) | `harness/src/loop/worker-guard.ts:139`, `:70` |
| `rankModels`, `routeAllRoles`, `assessSlots`, `issueBudget`, `modelForChange` | função | Roteamento por papel, vagas de máquina e tetos de custo | `harness/src/loop/routing.ts:211`, `:203`; `harness/src/loop/slots.ts:66`; `harness/src/loop/budget.ts:86`, `:106` |

**Comandos** (`ak-harness loop …`, definidos em `harness/src/cli.ts`; referência gerada em `harness/apps/docs/content/docs/reference/cli.mdx:326-805`): `init`, `validate`, `doctor`, `precheck`, `tick`, `deliver`, `stage`, `contract`, `install`, `uninstall`, `status`, `approve`, `resume`, `paused`, `hook`, `debrief`, `issue-timeline`, `run {list,show}`, `worker-guard`, `observe`, `watch`, `retro`, `plan {start,answer,show,approve,architect,approve-design,decompose}`, `release {status,approve,run}`, `learning {list,promote,reject,promoted}`; internos: `tick-worker`, `deliver-worker`.

**Exemplo real** — uso como biblioteca (`harness/README.md:166-175`):

```ts
import { loadLoopConfig, resolveFlowSettings, assessDod, readPhaseArtifacts } from '@agentskit/harness'

const { config } = loadLoopConfig('loop.config.yaml')
const flow = resolveFlowSettings(config, { labels: ['sev1'] })
// → flow.review.votes, flow.merge.requireChecks, flow.flow.name === 'incident'

const artifacts = readPhaseArtifacts('/path/to/worktree', config)
```

E um plugin local (`plugins.modules`), no formato descrito em `harness/docs/LOOP.md:208-221`:

```js
export default {
  id: 'slack-notify',
  apply(bus) {
    bus.on('worker.dispatched', (event) => { /* … */ })
    bus.hook('beforeMerge', (payload) => { if (isFrozeWindow()) return { block: true, reason: 'release freeze' } })
  },
}
```

## Quem usa e do que depende

| Relação | Nota / evidência |
|---|---|
| Consumidor | [[harness-ui]] roda `runTick`, `runDeliver`, `runLoopDoctor`, aprova gates e lê o estado (`harness/src/ui/api/server.ts:13-17`, `harness/src/ui/api/routes-actions.ts:7-16`) |
| Consumidor | A CLI `ak-harness loop …` e as automações do Orca, que chamam `loop stage <x>` (`harness/src/cli.ts:113-247`) |
| Consumidor | O skill `ak-harness-loop`, que ensina agentes a inspecionar/operar o loop (`harness/skills/ak-harness-loop/SKILL.md:1-14`); a distribuição fica no repositório [[00 Hub - skills]] (não verificado aqui) |
| Dependência interna | [[harness-kernel]] (ledger, resiliência, preflight, aprendizados, hash, política) e [[harness-adapters]] (Orca, GitHub, Linear, revisão) |
| Dependência externa | Orca (CLI `orca`): worktrees, terminais, automações, uso das contas — `harness/src/adapters/orca-cli.ts` |
| Dependência externa | [[00 Hub - code-review]] — `agentskit-review` (`harness/src/adapters/code-review.ts:151`; nota do motor: [[code-review-engine]]) |
| Dependência externa | [[00 Hub - doc-bridge]] — contexto de documentação para o brief (`harness/src/loop/contract.ts:276`) |
| Dependência externa | Tracker Linear (via Orca) ou GitHub Issues (via `gh`); GitHub para PRs e merge |
| Bibliotecas | `@agentskit/core`, `@agentskit/cross-platform`, `@agentskit/net`, `yaml`, `zod`, `ink`/`react` para o TUI do instalador (`harness/package.json:109-118`) |
| Não demonstrado | Integração direta com [[00 Hub - fleet]]: não há nenhuma ocorrência de "fleet" em `src/`, `docs/`, `README.md` ou `skills/` (busca `git grep -i fleet`) |

## Dados e efeitos

**Arquivos de configuração (camadas):** `~/.agentskit/harness.yaml`, `loop.config.yaml`, `loop.config.team.<key>.yaml`, `loop.config.local.yaml` (`harness/src/loop/config.ts:12-20`); exemplo comentado em `harness/loop.config.example.yaml`.

**Estado em `<stateDir>` (padrão `.ak-loop`, `harness/src/loop/config.ts:122`; deve ficar fora do git):**

| Caminho | O que guarda | Evidência |
|---|---|---|
| `events.ndjson` (+ `.lock`, `events-archive-<ms>.ndjson`) | Log de eventos; roda a 10 MiB e arquivos velhos vencem em 30 dias | `harness/src/loop/tick.ts:365`, `:372-373`, `:395-416` |
| `issues/<id>/contract.json`, `plan.json`, `dispatch.json`, `brief.md`, `delivery.json`, `failures.json`, `restarts.json`, `review-<head>.json` | Estado por issue | `harness/src/loop/contract.ts:164`; `harness/src/loop/plan-vote.ts:62`; `harness/src/loop/tick.ts:316-317`; `harness/src/loop/deliver-state.ts:49`, `:115`; `harness/src/loop/resilience-state.ts:37`; `harness/src/loop/deliver.ts:1038` |
| `issues/pr-<n>/intake.json` | PRs rastreados por label | `harness/src/loop/github-intake.ts:19` |
| `coordination/claims/…`, `coordination/dispatch-ledger.ndjson` | Leases e ledger | `harness/src/execution/coordination.ts:71-72` |
| `provider-cooldowns.json`, `tracker-cooldown.json`, `paused.json`, `queue-owner.json` | Cooldowns, pausas, rotação de dono da fila | `harness/src/loop/cooldown.ts:9`; `harness/src/loop/tracker-cooldown.ts:25`; `harness/src/loop/resilience-state.ts:133`; `harness/src/loop/rotation.ts:10` |
| `queue.json`, `lifecycle.json`, `hitl/requests/*.json` | Fila explícita da UI, ciclo de vida e decisões humanas pendentes | `harness/src/loop/queue.ts:142`; `harness/src/loop/lifecycle.ts:80`; `harness/src/loop/hitl.ts:86` |
| `plans/<id>/state.json`, `release.json`, `intake.json`, `observer-state.json`, `tuning.json`, `learnings.json`, `agent-improvements.json` | Planejamento, liberação, intake, observador, tuning, aprendizados, melhoria de agentes | `harness/src/loop/plan-stage.ts:131`; `harness/src/loop/release.ts:35`; `harness/src/loop/intake.ts:29`; `harness/src/loop/observe-stage.ts:31`; `harness/src/loop/tuning.ts:33`; `harness/src/loop/memory.ts:186`; `harness/src/loop/agent-improvement.ts:88` |
| `runs/<issue>-<n>/`, `base-view/`, `catalog/`, `.stage-<stage>.lock`, `tick-worker.log` | Runs de agente (ADR-0041), cópia da base para o orquestrador, cache de catálogo, locks de estágio, log do worker destacado | `harness/src/loop/agent-runs.ts:81-82`; `harness/src/loop/base-view.ts:8`; `harness/src/loop/model-catalog/index.ts:69`; `harness/src/loop/stage-lock.ts:45`; `harness/src/cli.ts:198` |

**No worktree do worker:** `.ak-loop/brief.md` (brief entregue como arquivo + uma linha apontando para ele, `harness/src/loop/tick.ts:160`, `:196-199`), `.ak-loop/{plan.md,verify.json,dod.json}` (`harness/src/loop/artifacts.ts:78-82`), `specs/<issue>/*.md` quando `spec.enabled` (`harness/src/loop/spec.ts:18`), e o hook do worker guard (`.claude/settings.local.json`, `.grok/hooks/config.json`, `.opencode/opencode.json`, `harness/src/loop/worker-guard.ts:154-156`). `.ak-loop/` é excluído do git em `info/exclude` (`harness/src/loop/artifacts.ts:99`).

**Efeitos em sistemas externos:** cria e remove worktrees e terminais no Orca; escreve no tracker (estado, comentários, labels, atribuição, anexos, criação de issues planejadas); comenta, remove label e **faz squash-merge** de PRs (`harness/src/adapters/github-cli.ts:324`); `loop release run` empurra `<head>:refs/heads/<release.branch>` e roda o deploy/smoke/rollback do projeto (`harness/src/loop/release.ts:165-194`); `git fetch origin <base>` antes de criar um worktree (`harness/src/loop/tick.ts:961`). Notificações saem por webhook (URL lida de uma variável de ambiente indicada em `notifications.webhook.urlEnv`) ou comando local (`harness/docs/LOOP.md:237-254`).

**Variáveis de ambiente (só nomes):** `AK_HARNESS_CONFIG`, `AK_HARNESS_HOME`, `AK_HARNESS_NO_GLOBAL`, `AK_LOOP_TEAM` (`harness/src/loop/config.ts:23-32`, `:1173`); `GITHUB_TOKEN`/`GH_TOKEN` (derivadas de `gh auth token` se ausentes, `harness/src/loop/deliver.ts:1319`); `WSL_DISTRO_NAME`, `WSL_INTEROP` (`harness/src/loop/slots.ts:63`); a variável nomeada por `notifications.webhook.urlEnv`; chaves de API listadas em `models.providers.<id>.envKeys` (nomes, `harness/src/loop/config.ts:43`).

**Capacidades exigidas:** Orca em versão ≥ `orca.minVersion` (padrão 1.4.200, `harness/src/loop/config.ts:146`) e acessível; `gh` autenticado com escrita no repositório; `git`; os CLIs de agente no PATH do ambiente em que o Orca roda (`harness/docs/LOOP.md:129-130`); `agentskit-review` no PATH.

## Como mexer (para agentes)

**Comece por** `harness/src/loop/tick.ts:523` (`runTick`) e `harness/src/loop/deliver.ts:931` (`handlePullRequest`) — os dois arquivos que ditam o comportamento — e por `harness/src/loop/config.ts` para qualquer chave nova.

**Invariantes**
- Um estágio é uma máquina: o modelo escreve, a máquina decide (ADR-0032). Nunca deixe um modelo decidir uma transição.
- **Argv, nunca shell**; entrada de issue entra no prompt como dado não confiável (`untrusted`, `harness/src/loop/contract.ts:194`).
- **Piso do auto-merge:** pelo menos um portão examinou o diff, senão `held` (`harness/src/loop/deliver.ts:1155`; ADR-0039). Merge sempre por SHA revisado (`harness/src/adapters/github-cli.ts:324`).
- Arquivo ausente do worker volta como fix round **nomeando o arquivo** (`harness/src/loop/deliver.ts:1094-1097`); item sem prova é `missing`, prova falha é `failed` (`harness/src/loop/dod.ts:100-114`).
- Listas de gate (`delivery.selfEditPaths`, `secretFilePatterns`, `requiredChecks`) acumulam entre camadas e só encolhem com `!entrada` (`harness/src/loop/config.ts:1124`).
- Nunca rodar `tick`/`deliver` à mão em projeto com automações instaladas (corrida, duplo despacho): use `--dry-run` ou as leituras (`harness/docs/GETTING-STARTED.md:88-92`).
- Todo estado gravado via `writeJsonAtomic` (`harness/src/loop/fs-atomic.ts:42`); todo JSON lido volta validado por schema (`harness/src/kernel/json-file.ts:25`).
- A janela de leitura é limitada: nada lê log sem limite (`windowed:` em `harness/AGENTS.md:104-107`).

**Testes por parte** (`harness/test/`): despacho `loop-tick.test.ts`, `loop-launch-worker.test.ts`, `loop-issue-queue.test.ts`; entrega `loop-deliver.test.ts`, `loop-worker-guard.test.ts`, `loop-github-intake.test.ts`; contrato/plano `loop-contract-*.test.ts`, `loop-plan-vote.test.ts`, `loop-plan-stage.test.ts`; DoD e artefatos `loop-dod.test.ts`, `loop-artifacts.test.ts`; config `loop.test.ts`, `loop-config-layers.test.ts`, `loop-layers.test.ts`, `loop-presets-init.test.ts`; fluxos `loop-flows.test.ts`; release `loop-release.test.ts`; instalação `loop-install.test.ts`, `loop-guided-install*.test.ts`; observação `loop-observability.test.ts`, `loop-observe-stage.test.ts`, `loop-debrief.test.ts`, `loop-watch.test.ts`; retro/tuning `loop-retro.test.ts`, `loop-tuning.test.ts`, `loop-auto-promote.test.ts`; runner `loop-connectors.test.ts`; barramento `loop-event-bus.test.ts`.

**Comando de validação:** `pnpm test:loop` (lista completa em `harness/package.json`, script `test:loop`); para um arquivo, `pnpm vitest run test/loop-deliver.test.ts`; fronteira `pnpm test:boundaries`; CI cruzado Ubuntu/macOS/Windows roda um subconjunto (`harness/.github/workflows/release-harness.yml:84-104`). Antes de abrir PR: [[Validar uma mudança no Harness]]. Para mudar a configuração: [[Adicionar ou mudar uma chave de configuração do loop]].

**Armadilhas**
- `connectors.runner: local` é recusado na validação (`harness/src/loop/config.ts:1093`) embora `createLocalRunner` exista e seja testado ([[harness ADR-0039 - Piso de auto-merge e runner local não ligado]]); documentos antigos (`harness/apps/docs/content/docs/guides/local-runner.mdx`) ainda o apresentam como funcional.
- `loop stage tick` e `loop stage deliver` **não** fazem o trabalho no precheck do Orca: espiam o lock e disparam um worker destacado, e saem com 1 (`harness/src/cli.ts:174-223`); o resultado real fica no log e em `<stateDir>/tick-worker.log`, não no histórico do Orca.
- Um `before*` que lança erro **bloqueia** (`harness/src/loop/event-bus.ts:73`).
- `resilience.maxUsageDeltaPercent` tem padrão 40 (`harness/src/loop/config.ts:623`), ao contrário do que `LOOP.md` diz ("desligado por padrão").
- Padrões que surpreendem em `delivery` (`harness/src/loop/config.ts:349-472`): `merge.auto` é **`true`** por padrão (`:399`), `merge.method` é `squash`, `requireChecks` é `true`, `requireHumanApproval` é `false` (`:407`); `maxFixRounds` 2 (`:425`); `workerIdleTimeoutMin` 45 (`:426`); revisão `fast`, 1 voto, piso `med` (`:358-362`); `selfEditPaths` começa em `loop.config.yaml` e `.github/**` (`:443`); `workerGuard.enabled` é `true` (`:462`); `worker.plan` desligado, 3 votantes, 2 aprovações, 3 ciclos (`:739-746`).
- Atualizar o harness com workers em voo pode deixar hooks do worker guard apontando para um caminho que sumiu (ADR-0038).
- Chaves desconhecidas no YAML são removidas pelo zod e só reportadas por `loop validate`/`doctor` (`harness/src/loop/config.ts:1106`).

**Quem revisa:** mudanças em gates de merge, `selfEditPaths`, estado de entrega ou CLI pedem revisão de mantenedor (`harness/CONTRIBUTING.md:86-88`).

## Decisões e história

ADRs: [[harness ADR-0027 - Loop keep-pushing sobre o Orca]], [[harness ADR-0029 - Resiliência, pinagem de brief e intake do GitHub]], [[harness ADR-0030 - Barramento de eventos e hooks de orquestração]], [[harness ADR-0031 - Observabilidade somente leitura do loop]], [[harness ADR-0032 - Estágios como máquinas de estado]], [[harness ADR-0033 - Quatro camadas de configuração e presets]], [[harness ADR-0034 - Conectores de tracker SCM e runner]], [[harness ADR-0035 - Definição de pronto em duas listas]], [[harness ADR-0036 - Automodificação limitada]], [[harness ADR-0037 - Custo política tetos e alavancas]], [[harness ADR-0038 - Worker guard em tempo real]], [[harness ADR-0039 - Piso de auto-merge e runner local não ligado]], [[harness ADR-0041 - Runs de agente e specs renderizadas]], [[harness ADR-0043 - Fronteira do módulo de estado de entrega]]; e a emenda de [[harness ADR-0019 - Decisão humana atestada]]. Índice: [[00 Decisões - harness]].

Mudanças recentes (`git log -- src/loop`):
- 2026-10-09 · `724aa82` · responde automaticamente à pergunta de confiança de workspace de um worktree novo (`acceptWorkspaceTrust`, `harness/src/loop/tick.ts:171`).
- 2026-10-07 · `818c844` · issue com pedido HITL aberto não busca mais o tracker a cada tick (`harness/src/loop/tick.ts:732-749`).
- 2026-10-03 · `b1df6b0` · estado de entrega isolado em `deliver-state.ts` (ADR-0043).
- 2026-09-29 · `5496091`/`6d236dc` · linha de base do guarda de custo por provedor e por tentativa; banner antigo de uso não remarca o provedor como esgotado.
- 2026-09-27 · `7db1da8` worker que saiu para o shell conta como ocioso; `9a6a568` bloqueia (não segura) após duas revisões incompletas; `d5fd36c` reenvia os achados que o worker nunca recebeu; `fcd12f4` aborta e reinicia uma run que perdeu o rastro.

> [!info]- Detalhe técnico
> - Passos de um tick no código: estado (`harness/src/loop/tick.ts:441`) → pausa (`:715`) → HITL aberto (`:741`) → detalhe da issue (`:751`) → fluxo (`:769`) → contrato (`:805-856`) → despachável? (`:858-871`) → plano/voto (`:875-929`) → claim (`:938`) → hook `beforeDispatch` (`:951`) → `git fetch` (`:961`) → worktree com retentativas (`:963`) → worker guard (`:968`) → comando de preparo (`:971-984`) → spec (`:986-991`) → brief (`:1001-1019`) → terminal (`:1020`) → registro de despacho e evento `worker.dispatched` (`:1022-1026`) → transição de tracker e comentário (`:1049-1052`).
> - Resultados de `deliver` (`DeliverOutcome`): `waiting`, `reviewed`, `fix-round`, `nudged`, `handed-off`, `merged`, `held`, `needs-input`, `blocked`, `stuck`, `abandoned`, `failed`, `restarted`, `dry-run` (`harness/src/loop/deliver-state.ts:13`). Erros transitórios: 3 seguidos viram `failed` (`harness/src/loop/deliver.ts:123`, `:1451-1459`).
> - Ordem dos portões em um PR (`handlePullRequest`, `harness/src/loop/deliver.ts:931-1182`): rascunho → caminhos protegidos → arquivo com cara de segredo → conflito → checks → verify local → revisão → artefatos → spec renderizada → DoD → fronteira de camada → piso → `merge.auto` → aprovação humana → smoke → hook `beforeMerge` → merge por SHA.
> - Estágios do Orca: `tick`, `deliver`, `retro`, `observe` (+ `release`, `intake`, `maintain` rodáveis por `loop stage`, `harness/src/cli.ts:141-165`); nome das automações em `harness/src/loop/runner-connector.ts:136`.
> - doc-bridge: o índice cobre só o site de documentação (`harness/doc-bridge.config.json:7-15`); a descrição dos estágios em `harness/apps/docs/content/docs/concepts/stages.mdx` e `state-machines.mdx` é a leitura canônica para pessoas.

> [!bug] Existe, mas ninguém usa
> - `src/loop/index.ts` é um barril paralelo a `src/index.ts` que **nenhum arquivo importa** (busca por `loop/index` em `src`, `test`, `scripts` e `tsup.config.ts` não achou nada) e já divergiu: não exporta, por exemplo, `queue`, `hitl`, `lifecycle` nem `connectors` completo. Pode ser removido sem efeito? **Não confirmado** — ver abaixo.
> - `createLocalRunner` (git worktree + tmux + crontab) só é exercido por testes (`harness/test/loop-connectors.test.ts:92-130`); a UI chama `createRunnerConnector` apenas para observar workspaces e sempre obtém o runner do Orca (`harness/src/ui/api/server.ts:266`).
> - `createMcpToolBridge` só no autoteste do `doctor` ([[harness-adapters]]).
> Ver [[Capacidades não usadas]].

> [!question] Dúvida
> (1) Quando uma revisão limpa é reaproveitada de uma passagem anterior, `review` fica `null` e "a revisão" não conta como portão no piso (`harness/src/loop/deliver.ts:983`, `:1150`) — intencional? (2) `src/loop/index.ts` pode ser apagado? Ambas em [[Dúvidas abertas]].
