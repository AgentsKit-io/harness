---
tipo: pacote
repo: harness
camada: ferramenta
visibilidade: publico
npm: "@agentskit/harness"
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; nada foi executado. Código e ADRs lidos; índice .doc-bridge/index.json lido só como evidência de documentação (cobre o site de docs, não o código); a CLI do doc-bridge não foi rodada (shell restrito a git neste ambiente)."
fontes:
  - harness/package.json
  - harness/AGENTS.md
  - harness/CONTRIBUTING.md
  - harness/docs/MODULE-BOUNDARIES.md
  - harness/docs/ORGANIZATION.md
  - harness/examples/minimum-profile.mjs
  - harness/.ak-harness/verification.json
  - harness/src/index.ts
  - harness/src/cli.ts
  - harness/src/kernel/constants.ts
  - harness/src/kernel/state-machine.ts
  - harness/src/kernel/events.ts
  - harness/src/kernel/errors.ts
  - harness/src/kernel/hash.ts
  - harness/src/kernel/policy.ts
  - harness/src/kernel/learning.ts
  - harness/src/execution/verification.ts
  - harness/src/execution/config.ts
  - harness/src/execution/files.ts
  - harness/src/execution/runtime.ts
  - harness/src/execution/agent.ts
  - harness/src/execution/bundle.ts
  - harness/src/execution/metrics.ts
  - harness/src/execution/coordination.ts
  - harness/src/context/index.ts
  - harness/src/delivery/index.ts
  - harness/src/delivery/review.ts
  - harness/src/profiles/index.ts
  - harness/scripts/verify-dependency-directions.mjs
  - harness/scripts/check-public-api.mjs
  - harness/vitest.config.ts
tags: [pacote, repo/harness, camada/ferramenta]
---

# harness-kernel

> [!tldr] Em linguagem comum
> É o fiscal do contrato: registra o que foi pedido, roda as checagens, guarda as provas num diário à prova de adulteração e só considera o trabalho encerrado depois de uma decisão humana — ou de uma regra explícita que a dispense.

← [[00 Hub - harness]]

## O que faz e por que existe

É a metade "biblioteca e protocolo de verificação" do pacote npm `@agentskit/harness` (`harness/package.json:2`): `src/kernel/`, `src/execution/`, `src/context/`, `src/delivery/`, `src/profiles/` e as exportações de `src/index.ts`. As outras três notas do repositório — [[harness-adapters]], [[harness-loop]] e [[harness-ui]] — são recortes do **mesmo** pacote; só o site [[harness-docs]] é um workspace separado.

O problema que resolve: dizer, sem depender da palavra de um agente, se uma tarefa terminou. Um contrato congelado (`.ak-harness/verification.json`) lista resultados esperados e checagens executáveis; cada checagem imprime como última linha um JSON que mapeia aos resultados que prova; a evidência fica presa a um `HEAD` commitado do git, e qualquer mudança em código, configuração ou contrato leva a execução a `STALE`. As regras de engenharia estão em `harness/AGENTS.md:5-9`: o Playbook documenta práticas, o Harness as **impõe**.

Limites: o kernel é neutro de provedor — "não adicione dependências diretas de Linear, GitHub, Orca, Doc Bridge ou provedor de modelo ao kernel" (`harness/AGENTS.md:61-62`). A fronteira é verificada por script (veja [[harness ADR-0026 - Fronteira entre kernel e adapters]]).

Máquina de estados de uma execução (`harness/src/kernel/constants.ts:3-21`): `CLARIFYING → PLANNED → IMPLEMENTING → VERIFYING → AWAITING_HUMAN_APPROVAL → (AWAITING_AUTHORIZATION) → COMPLETE`, mais `BLOCKED`, `STALE`, `CANCELLED` e `SUPERSEDED`. Caminho completo em [[Harness - Verificar e aprovar uma execução]].

## API e contratos

Toda a API suportada passa por `harness/src/index.ts` (256 linhas, só `export`); quem importa caminhos internos está fora do suporte (`harness/docs/ORGANIZATION.md:30-31`). O snapshot dos nomes exportados está em `harness/docs/stability/public-api-v1.json` e é conferido por `pnpm check:public-api` (`harness/scripts/check-public-api.mjs:153-174`).

| Símbolo | Tipo | Para que serve | Onde |
|---|---|---|---|
| `STATES`, `LEGAL_TRANSITIONS` | const | Estados e transições legais de uma execução | `harness/src/kernel/constants.ts:3`, `:9` |
| `transition`, `assertHuman`, `approvedDecision` | função | Move o estado (falha em transição ilegal); exige ator `human`; normaliza "approved/yes/ok" | `harness/src/kernel/state-machine.ts:5`, `:12`, `:16` |
| `HarnessError`, `HARNESS_ERROR_CODES`, `fail` | classe/const | Erros tipados e fail-closed (`INVALID_STATE`, `STALE`, `HUMAN_APPROVAL_REQUIRED`, …) | `harness/src/kernel/errors.ts:1-16` |
| `loadConfig`, `validateConfig`, `resolveConfigPath` | função | Carrega o contrato (`.ak-harness/verification.json`, com fallback `.codex/verification.json`) | `harness/src/execution/config.ts:141`, `:76`, `:134` |
| `planRun`, `startRun`, `verifyRun`, `approveRun`, `authorizeRun`, `retryRun`, `cancelRun`, `reconcileRun`, `cleanTaskArtifacts` | função | O protocolo de uma execução | `harness/src/execution/verification.ts:77`, `:98`, `:112`, `:232`, `:250`, `:260`, `:104`, `:205`, `:272` |
| `FileEventStore`, `HARNESS_EVENT_TYPES`, `EVENT_LOG_GENESIS`, `inspectEventLogLock`, `recoverEventLogLock` | classe/const/função | Log NDJSON append-only e encadeado por hash, com lock | `harness/src/kernel/events.ts:229`, `:13`, `:12`, `:277`, `:283` |
| `createPluginRegistry`, `createPluginSlot`, `HARNESS_PLUGIN_API_VERSION` | função/const | Registro de plugins tipado em memória | `harness/src/kernel/plugins.ts:57`, `:10`, `:6` |
| `CONTEXT_PROVIDER_SLOT`, `hashContextSnapshot(s)`, `readContextSnapshots`, `validateContextSnapshot(s)` | const/função | Contexto com procedência e hash do snapshot | `harness/src/context/index.ts:92`, `:40-41`, `:85`, `:51`, `:90` |
| `createPolicyGate` | função | Política ordenada, nega por padrão | `harness/src/kernel/policy.ts:32` |
| `createSessionRecorder` | função | Gravador de sessão de agente (só hashes) | `harness/src/execution/agent.ts:49` |
| `createToolRuntime`, `createProcessToolRuntime`, `createDockerToolRuntime`, `createConfiguredToolRuntime` | função | Executores de ferramenta: em processo, processo filho e Docker | `harness/src/execution/runtime.ts:146`, `:186`, `:243`, `:69` |
| `exportEvidenceBundle`, `verifyEvidenceBundle`, `readEvidenceTrustStore` | função | Pacote de evidência assinado (Ed25519) | `harness/src/execution/bundle.ts:75`, `:107`, `:135` |
| `benchmarkRuns`, `recordBenchmarkObservation`, `loadBenchmarkManifest`, `validateBenchmarkManifest` | função | Benchmarks locais (ADRs 0004–0016, 0024) | `harness/src/execution/metrics.ts:363`, `:311`, `:307`, `:264` |
| `assessPreflight`, `composePullRequest`, `assessIntegration`, `assessProduction`, `assessAcceptance`, `assessWorktreeCleanup`, `runAdversarialReview` | função | Portões G2–G5 de entrega e revisão adversarial por lentes | `harness/src/delivery/index.ts:34`, `:60`, `:112`, `:140`, `:155`, `:124`; `harness/src/delivery/review.ts:28` |
| `createDispatchLedger` | função | Claims atômicos de issue/worktree e registro de despacho | `harness/src/execution/coordination.ts:69` |
| `classifyFailure`, `runWithRecovery`, `planFilePreflight`, `validateSafeCommand`, `scanForPii` | função | Resiliência e segurança determinísticas | `harness/src/kernel/resilience.ts:42`, `:67`; `harness/src/kernel/preflight.ts:41`, `:31`; `harness/src/kernel/pii.ts:42` |
| `parseRetro`, `promoteLearnings`, `LOOP_AUTO_ACTOR` | função/const | Aprendizados: só `human` ou `loop-auto` promovem | `harness/src/kernel/learning.ts:36`, `:61`, `:58` |
| `createPhaseProfile`, `planPhaseProfile`, `executePhaseProfile`, `FileArtifactStore` | função/classe | Executor de fases declarativo e artefatos com procedência | `harness/src/kernel/phase-executor.ts:213`, `:215`, `:241`; `harness/src/kernel/artifacts.ts:175` |
| `createLlmCache`, `compareOptimization`, `runEvalBattery`, `assessCompatibility`, `createQualityMatrix`, `createModelPolicy` | função | Contratos de cache, otimização, eval, compatibilidade, qualidade e política de modelo | `harness/src/kernel/cache.ts:42`, `harness/src/kernel/optimization.ts:105`, `harness/src/kernel/eval.ts:181`, `harness/src/kernel/compatibility.ts:108`, `harness/src/kernel/quality.ts:116`, `harness/src/kernel/model-policy.ts:24` |

Os binários `ak-harness` e `ak-verify` são o mesmo arquivo (`harness/package.json:6-9`); o protocolo de verificação sai de `src/cli.ts`: `plan`, `start`, `verify`/`run`, `approve`, `authorize`, `retry`, `cancel`, `status`, `audit`, `events {verify,lock,unlock,export,verify-bundle}`, `benchmark [baseline]`, `clean`, `doctor`, `context resolve`, e os subcomandos de avaliação (`discovery`, `wip`, `experiment`, `delivery`, `pilot`, `cycle`, `block`, `preflight`, `snapshot`, `learning`, `coordination`, `artifacts`) — referência completa gerada em `harness/apps/docs/content/docs/reference/cli.mdx`.

**Exemplo real** — o perfil mínimo de adoção, que roda após `pnpm build` (`harness/examples/minimum-profile.mjs:16-23`):

```js
const profile = createPhaseProfile({ id: 'minimum', mode: 'yolo', phases: [{ id: 'implement', effect: 'write', outputs: ['result'] }], maxConcurrency: 1 })
const agent = createCodingAgentAdapter({ id: 'fake-agent', version: '1.0.0', execute: () => ({ output: { ok: true }, diff: '', usage: { status: 'measured', inputTokens: 1, outputTokens: 1, totalTokens: 2 } }) })
// …
const execution = await executePhaseProfile(profile, { preflight: () => ({ decision: 'pass' }), handlers: { implement: () => ({ decision: 'pass', outputs: { result: 'ok' } }) } })
```

E o protocolo de uma execução real, como o CI do próprio repositório o encena (`harness/.github/workflows/release-harness.yml:45-47`):

```bash
node dist/cli.js plan approved --by human --config .ak-harness/verification.json --json
node dist/cli.js start --config .ak-harness/verification.json --json
node dist/cli.js run --config .ak-harness/verification.json --json
```

## Quem usa e do que depende

| Relação | Nota / evidência |
|---|---|
| Consumidor interno | [[harness-loop]] reutiliza ledger, resiliência, preflight, aprendizados, política, modelos e hash (`harness/src/loop/tick.ts:11`, `:27`; `harness/src/loop/deliver.ts:14`, `:34`) |
| Consumidor interno | [[harness-ui]] chama `createDispatchLedger` e lê estado de entrega (`harness/src/ui/api/actions.ts:4`) |
| Consumidor interno | A CLI (`harness/src/cli.ts:4`) importa tudo pela API pública, de propósito (`harness/docs/MODULE-BOUNDARIES.md:119-120`) |
| Consumidor externo | Qualquer projeto que instale `@agentskit/harness`; a trilha do ecossistema aparece em [[00 Hub - harness]] |
| Dependência | `@agentskit/core` — hash canônico (`harness/src/kernel/hash.ts:1`) e estimativa de tokens (`harness/src/kernel/tokens.ts:1`); ver [[harness ADR-0042 - Hash canônico compartilhado]] e [[00 Hub - agentskit]] |
| Dependência | `@agentskit/cross-platform` — processos, caminhos e linhas portáveis (`harness/src/kernel/process-tree.ts:2`, `harness/src/execution/runtime.ts:2`, `harness/src/execution/source.ts:8`) |
| Dependência | `zod` (`harness/src/kernel/json-file.ts`), `commander` (`harness/src/cli.ts:3`); `git` no PATH (`harness/src/execution/source.ts`) |
| Dependência opcional | `docker` para o runtime Docker (`harness/src/execution/runtime.ts:295`) |

## Dados e efeitos

| Onde | O quê | Evidência |
|---|---|---|
| `.ak-harness/verification.json` | Contrato lido (padrão); `.codex/verification.json` é o fallback legado | `harness/src/execution/config.ts:123`, `:131` |
| `<stateDir>/runs/<runId>/run.json` e `latest.json` | Projeção da execução (mutável) | `harness/src/execution/files.ts:17-19` |
| `<stateDir>/runs/<runId>/events.ndjson` (+ `.lock`) | Diário append-only encadeado | `harness/src/kernel/events.ts:179-180` |
| `<stateDir>/runs/<runId>/checks/<id>.stdout/.stderr` | Saída bruta de cada checagem | `harness/src/execution/verification.ts:124`, `:162-164` |
| `<stateDir>/runs/<runId>/artifacts/<id>.json/.md` | Artefatos com procedência | `harness/src/kernel/artifacts.ts:172-173` |
| Pacote de evidência (arquivo escolhido pelo operador) | Hashes, assinatura Ed25519, chave pública | `harness/src/execution/bundle.ts:95` |
| Processos filhos | Cada checagem do contrato roda com `shell: true` e herda `process.env`; atenção: o contrato é código confiável | `harness/src/execution/verification.ts:30` |
| Git | Lê revisão e status para ligar evidência ao `HEAD` | `harness/src/execution/source.ts:30` |
| Rede | Nenhuma no kernel; Docker e processos são locais | `harness/AGENTS.md:61` |

Variáveis de ambiente (só nomes): `HARNESS_REQUIRE_DOCKER` (só no script de teste `test:docker-runtime`, `harness/package.json`); o kernel em si não lê variáveis, mas repassa `process.env` às checagens (`harness/src/execution/verification.ts:30`) e aplica `spawnEnvironment` às ferramentas (`harness/src/execution/runtime.ts:119`). `AK_HARNESS_CLI_INTROSPECT` só desliga o `parseAsync` para gerar a referência de CLI (`harness/src/cli.ts:615`).

Capacidades exigidas: leitura/escrita no `stateDir`, `git` no PATH, nenhuma permissão de rede; `--by human` para toda decisão (`harness/src/kernel/state-machine.ts:12`).

## Como mexer (para agentes)

**Comece por** `harness/src/index.ts` (o que é público), `harness/src/execution/verification.ts` (protocolo) e `harness/src/kernel/events.ts` (diário).

**Invariantes que não podem quebrar** (`harness/AGENTS.md:64-71`):
- Gate obrigatório falha fechado com exit ≠ 0; evidência ausente não é sucesso.
- Ambiguidade e decisão de negócio continuam humanas; `assertHuman` não aceita outro ator (`harness/src/kernel/state-machine.ts:12`).
- Um adapter não pode enfraquecer o kernel; kernel não importa adapter nem, por valor, `execution`/`context`/`delivery`/`profiles` (`harness/scripts/verify-dependency-directions.mjs:40-42`).
- Aprovação recalcula o digest da verificação e confere o log (`harness/src/execution/verification.ts:190-195`); hashes antigos precisam continuar válidos (`harness/src/kernel/hash.ts:18`).
- Nunca auto-commitar resíduo, expor credenciais amplas nem aprovar a própria saída.

**Testes por parte** (todos em `harness/test/`): lifecycle e atestação `harness.test.ts`, `contract.test.ts`, `source.test.ts`; log e lock `lock.test.ts`, `kernel-events.test.ts`; pacote `bundle.test.ts`; sessão e política `agent.test.ts`, `policy.test.ts`; runtime `runtime.test.ts`, `execution-runtime.test.ts`; entrega `delivery.test.ts`, `review.test.ts`; métricas `metrics.test.ts`; contexto `context.test.ts`; perfis `profiles.test.ts`; fronteiras `boundaries.test.ts`. O mapa critério→script está no `package.json` (dezenas de scripts `test:*`, cada um imprimindo os critérios que prova) e nas saídas do contrato; `harness/AGENTS.md:79-83` fala em 47 scripts, 18 saídas e 22 checks e esse texto está desatualizado quanto ao contrato — o arquivo tem 19 saídas e 23 checks (`harness/.ak-harness/verification.json:14-34`, `:46-68`). A contagem de 47 scripts não foi reconferida.

**Comando exato de validação do que você tocou** (escolha o estreito): `pnpm test:boundaries`, `pnpm test:contract`, `pnpm test:event-log`, `pnpm test:signed-bundle`, `pnpm test:policy-gate`, `pnpm test:runtime` etc. (lista em `harness/package.json`); para fechar uma issue: `pnpm typecheck && pnpm test && pnpm build && ak-verify run --config .ak-harness/verification.json --json` (`harness/CONTRIBUTING.md:26-34`). Receita completa em [[Validar uma mudança no Harness]].

**Armadilhas**
- API pública é intencional: mudar `src/index.ts` exige `pnpm check:public-api:update` e revisão do snapshot (`harness/CONTRIBUTING.md:44-50`); receita em [[Mudar a API pública do Harness]].
- `cancelRun` e `retryRun` existem em dois sentidos (protocolo de verificação e fila da UI); o índice reexporta os da UI como `cancelUiRun`/`retryUiRun` (`harness/src/index.ts:166-171`).
- Em autonomia `yolo`, `verifyRun` vai direto a `COMPLETE` se todas as checagens passam, sem rastreio exigido e sem ambiguidades (`harness/src/execution/verification.ts:180-181`); o contrato do próprio repositório é `yolo` (`harness/.ak-harness/verification.json:6`) — por isso o CI só precisa de `plan approved --by human`, `start` e `run`.
- Cada checagem deve imprimir JSON de evidência na última linha; sem ele a checagem falha mesmo com exit 0 (`harness/src/execution/verification.ts:60`).
- Piso de cobertura: 89 % instruções, 79 % ramos, 88 % funções, 93 % linhas (`harness/vitest.config.ts:26-29`).
- Estilo: "ponytail" (menor solução correta) e commits em estilo "caveman" (`harness/AGENTS.md:16-40`).

**Quem revisa:** `harness/.github/CODEOWNERS` indica um dono para tudo (`@EmersonBraun`); o PR precisa de revisão de mantenedor para API pública, CLI, máquina de estados, segurança ou release (`harness/CONTRIBUTING.md:86-88`).

## Decisões e história

ADRs que moldam esta parte: [[harness ADR-0001 - Núcleo extensível com eventos append-only]], [[harness ADR-0002 - Perfis e provedores de contexto opcionais]], [[harness ADR-0006 - Protocolo de sessão de agente]], [[harness ADR-0007 - Política de ferramentas negar por padrão]], [[harness ADR-0008 - Executor de ações em runtime limitado]], [[harness ADR-0009 - Runtime de processo sem shell]], [[harness ADR-0010 - Runtime Docker opcional]], [[harness ADR-0017 - Log de eventos encadeado por hash]], [[harness ADR-0018 - Atestação da projeção de verificação]], [[harness ADR-0019 - Decisão humana atestada]], [[harness ADR-0020 - Reconciliação terminal]], [[harness ADR-0022 - Pacote de evidência assinado]], [[harness ADR-0025 - Controles portáteis de orquestração]], [[harness ADR-0026 - Fronteira entre kernel e adapters]], [[harness ADR-0042 - Hash canônico compartilhado]]. Índice completo em [[00 Decisões - harness]].

Mudanças recentes (de `git log -- src/kernel src/execution src/context src/delivery src/profiles`):
- 2026-10-03 · `ba803cc` · estimativa de tokens de contexto passa a ser compartilhada (`@agentskit/core`).
- 2026-10-02 · `5717a9c` · guarda de "record" compartilhada (`src/record.ts`); `21290f6` · sufixos de run id criptográficos.
- 2026-09-29 · `f479ae1` · hash canônico compartilhado (ADR-0042).
- 2026-09-27 · `7bed233` · `@agentskit/cross-platform` para portabilidade; `b918ba0` · leitura de JSON com BOM; `0a2eb1e` · "16 falhas escondidas" (gates que passavam).
- 2026-09-21..24 · `7b1f33a` (0.15.0), `4093d33` (validação de todo JSON lido de volta), `4fe476a` (plano de controle de lifecycle).

> [!info]- Detalhe técnico
> - `harness/src/index.ts:1-79` (kernel/execução), `:96-256` (adapters e loop).
> - Dependências de runtime declaradas: `@agentskit/core ^1.13.0`, `@agentskit/cross-platform ^0.1.0`, `@agentskit/net ^0.2.0`, `commander`, `ink`, `react`, `yaml`, `zod` (`harness/package.json:109-118`). `engines.node >=22` (`harness/package.json:35`). Build: `tsup` com entradas `index` e `cli`, ESM, sourcemap (`harness/tsup.config.ts:4-11`).
> - Classes de módulo e dependências permitidas: `harness/docs/MODULE-BOUNDARIES.md:8-16`; exceções aceitas (tipo apenas): `:118-131`.
> - Contrato do repositório: 19 resultados e 23 checagens (`harness/.ak-harness/verification.json:14-34`, `:46-68`).
> - doc-bridge: `.doc-bridge/index.json` indexa apenas o corpus do site (`harness/doc-bridge.config.json:7-15`); não descreve entidades de `src/`.

> [!bug] Existe, mas ninguém usa
> Dentro do repositório, estas capacidades da API pública só têm chamador em testes e na própria CLI (ou nenhum): `createSessionRecorder` (`harness/src/execution/agent.ts:49`), `createToolRuntime`/`createProcessToolRuntime`/`createDockerToolRuntime`/`createConfiguredToolRuntime`, `createPluginRegistry` (`harness/src/kernel/plugins.ts:57`), `createLlmCache`, `createModelPolicy`, `compareOptimization`, `runEvalBattery`, `assessCompatibility`, `createQualityMatrix`. A busca em `src/` e `scripts/` por chamadas não achou nenhuma fora de testes. `createPolicyGate` só aparece no `doctor` do loop (`harness/src/loop/doctor.ts:212`). Podem ter consumidores externos que esta análise não enxerga. Ver [[Capacidades não usadas]].

> [!question] Dúvida
> O CI do próprio repositório encena `plan approved --by human` em uma máquina (`harness/.github/workflows/release-harness.yml:41-45`); o ADR-0039 chama isso de "re-encenação" de uma aprovação feita em revisão. Quem de fato aprova o contrato não é rastreável pelo código. Ver [[Dúvidas abertas]].
