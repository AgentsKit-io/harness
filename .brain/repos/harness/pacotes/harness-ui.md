---
tipo: pacote
repo: harness
camada: ferramenta
visibilidade: publico
npm: "@agentskit/harness"
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; nada foi executado (a interface não foi aberta num navegador). Código de src/ui lido; ADR-0040 conferido."
fontes:
  - harness/README.md
  - harness/package.json
  - harness/src/cli.ts
  - harness/src/ui/api/server.ts
  - harness/src/ui/api/http.ts
  - harness/src/ui/api/store.ts
  - harness/src/ui/api/projection.ts
  - harness/src/ui/api/attention.ts
  - harness/src/ui/api/reconcile.ts
  - harness/src/ui/api/actions.ts
  - harness/src/ui/api/jobs.ts
  - harness/src/ui/api/board.ts
  - harness/src/ui/api/wizard.ts
  - harness/src/ui/api/route-modules.ts
  - harness/src/ui/api/routes-actions.ts
  - harness/src/ui/api/routes-core.ts
  - harness/src/ui/api/routes-config.ts
  - harness/src/ui/api/routes-system.ts
  - harness/src/ui/api/routes-feed.ts
  - harness/src/ui/api/routes-insights.ts
  - harness/src/ui/app/vite.config.ts
  - harness/src/ui/app/src/App.tsx
  - harness/src/ui/app/src/lib/api.ts
  - harness/vitest.config.ts
tags: [pacote, repo/harness, camada/ferramenta]
---

# harness-ui

> [!tldr] Em linguagem comum
> É o painel local do loop: mostra primeiro o que precisa de uma pessoa (decisões, itens travados, coisas fora de sincronia), deixa escolher uma issue para entrar na fila e responde aos gates humanos — tudo no próprio computador, sem banco de dados nem serviço novo.

← [[00 Hub - harness]]

## O que faz e por que existe

Um servidor HTTP Node em `127.0.0.1:4321` (`harness/src/ui/api/server.ts:46-47`) mais uma aplicação React/Vite (`harness/src/ui/app/`) empacotadas no mesmo pacote npm. Comando: `ak-harness ui` (`harness/src/cli.ts:42`). Ele **projeta** arquivos e eventos de `<stateDir>` e executa, como "jobs" tipados, as mesmas funções que a CLI chama — não existe lógica de negócio própria nem endpoint de deploy ([[harness ADR-0040 - Plano de controle v2]]). O fluxo principal é "issue primeiro": escolher uma issue, congelar contrato/perfil/limites no assistente (wizard), enfileirar, e resolver só as decisões humanas na Caixa de entrada persistente (`harness/README.md:13`).

A tela inicial é uma **fila de atenção** ordenada (decisões humanas → travado/falho → fora de sincronia → sistema; depois o mais antigo): função pura `buildAttention` (`harness/src/ui/api/attention.ts:127`). A UI também **concilia** projeção, tracker e Orca antes de oferecer ações destrutivas (`harness/src/ui/api/reconcile.ts:76`, `:124`), e recusa com 409 enquanto a issue está travada (`harness/src/ui/api/server.ts:393-395`).

É distinta do site público [[harness-docs]] (outro workspace, outro propósito) e da interface de terminal Ink do instalador, que vive em `src/loop/ui/`.

## API e contratos

| Símbolo / rota | Tipo | Para que serve | Onde |
|---|---|---|---|
| `startUiServer` | função | Sobe o servidor (loopback, token de sessão, SSE, estáticos/proxy Vite) e devolve `{url, token, close}` | `harness/src/ui/api/server.ts:304` |
| `UiSnapshot`, `UI_SNAPSHOT_SCHEMA_VERSION` | tipo/const | Snapshot servido em `GET /api/v1/state` e por SSE (`schemaVersion` 1) | `harness/src/ui/api/server.ts:57`, `:62` |
| `GET /api/v1/health`, `/state`, `/events` (SSE), `/events/recent`, `/contracts`, `/jobs`, `/metrics`, `/search`, `/system`, `/config` | rota | Leitura: saúde, estado, feed, contratos em cache, jobs, métricas, busca, sistema, configuração efetiva | `harness/src/ui/api/server.ts:338-339`, `:454`; `harness/src/ui/api/routes-feed.ts:28`, `:37`; `harness/src/ui/api/routes-insights.ts:11`, `:17`; `harness/src/ui/api/routes-system.ts:135`; `harness/src/ui/api/routes-config.ts:24` |
| `/api/v1/wizard/<issue>` (GET/PUT, `…/contract` POST) | rota | Rascunho do assistente e geração de contrato como job | `harness/src/ui/api/server.ts:344-361` |
| `POST /api/v1/runs`, `/issues/<id>/{cancel,retry,archive,restore,decision,resume,decisions/<rid>/answer}`, `GET /issues/<id>/timeline` | rota | Fila, ciclo de vida e respostas a decisões | `harness/src/ui/api/server.ts:366-441` |
| `/api/v1/issues/<id>/{detail,reconcile,tracker-sync}` | rota | Detalhe e conciliação de uma issue | `harness/src/ui/api/routes-core.ts:83` |
| `POST /api/v1/system/doctor`, `/automations/reinstall`, `PUT /config/local`, `POST /config/proposal` | rota | Doctor como job, reinstalar automações, escrever só a camada pessoal, gerar diff para o time | `harness/src/ui/api/routes-system.ts:136`, `:150`; `harness/src/ui/api/routes-config.ts:25`, `:29` |
| `enqueueRun`, `cancelRun`/`cancelUiRun`, `retryRun`/`retryUiRun`, `decideIssue`, `answerDecision`, `generateOrReuseContract`, `resumePausedIssue`, `reconcileIssue` | função | Ações do operador, cada uma chamando funções do loop | `harness/src/ui/api/actions.ts:178`, `:192`, `:210`, `:266`, `:319`, `:70`, `:288`, `:342`; reexport com alias em `harness/src/index.ts:166-171` |
| `reduce`, `syncProjection`, `readCurrentProjection`, `emptyProjection` | função | Projeção por issue: reducer puro + cursor persistido sobre `events.ndjson` | `harness/src/ui/api/projection.ts:132`; `harness/src/ui/api/store.ts:220`, `:212`; `harness/src/ui/api/projection.ts:103` |
| `createUiJobManager`, `UiJobConflictError` | função/classe | Fila de jobs duráveis com heartbeat (o wizard consulta o job de contrato) | `harness/src/ui/api/jobs.ts:107`, `:86` |
| `createIssueBoardCache`, `createIssueBoardReader` | função | Quadro do tracker (Linear ou GitHub) em cache | `harness/src/ui/api/board.ts:161`, `:95` |
| `createUiWizardStore`, `uiWizardPath` | função | Rascunhos do assistente em disco | `harness/src/ui/api/wizard.ts:46`, `:82` |

Frontend: rotas `/` (atenção), `/runs`, `/runs/trends`, `/costs`, `/system`, `/explore`, `/settings`, `/batch`, `/wizard/:issue`; o detalhe da issue é um painel lateral, não uma rota (`harness/src/ui/app/src/App.tsx:15-31`). O cliente envia o token no cabeçalho `x-harness-session` (`harness/src/ui/app/src/lib/api.ts:35`).

**Exemplo real** — o cliente do wizard enfileirando uma issue já com contrato congelado (`harness/src/ui/app/src/lib/api.ts:51-60`), e o servidor que valida o corpo (`harness/src/ui/api/server.ts:224-240`):

```ts
export const enqueueRun = (input: EnqueueRunInput): Promise<{ readonly runId: string }> => api('runs', { method: 'POST', body: JSON.stringify({ ...input, preflight: true }) })
```

O servidor recusa se `configHash` mudou, se falta `contractDigest`, se o preflight não passou, se `maxFixRounds`/`perIssueTokens` excedem os tetos do projeto ou se o builder não é um candidato declarado e roteável.

## Quem usa e do que depende

| Relação | Nota / evidência |
|---|---|
| Consumidor | A pessoa que opera o loop (`ak-harness ui`); uso em CI não existe |
| Dependência | [[harness-loop]]: `runTick`, `runDeliver`, `runLoopDoctor`, `approveHeldDelivery`, `approvePlan`, `approveRelease`, `installLoopAutomations`, `createIssueQueue`, `createHitlStore` (`harness/src/ui/api/server.ts:13-17`, `harness/src/ui/api/routes-actions.ts:7-17`) |
| Dependência | [[harness-adapters]] para detectar provedores e ler o tracker (`harness/src/ui/api/server.ts:9-10`) e [[harness-kernel]] para ledger e hash |
| Bibliotecas do frontend | React 19, `react-router-dom`, Vite, Tailwind e Radix (devDependencies do pacote raiz, `harness/package.json:119-141`); gráficos são SVG próprios, sem biblioteca de charts (ADR-0040 item 7) |
| Externo | Orca (para observar worktrees e automações) e o tracker/GitHub via adapters |

## Dados e efeitos

- **Lê:** `events.ndjson` por janela (≤ 30 dias, cache por tamanho e mtime), `issues/<id>/dispatch.json`/`delivery.json`, `queue.json`, `hitl/requests`, configuração efetiva com procedência, quadro do tracker (cache em `ui/github-issues.json` para GitHub, `harness/README.md:139-141`).
- **Grava em `<stateDir>/ui/`:** `projection.json` e `cursor.json` (versão de schema 2, reconstruídos se o reducer mudar — `harness/src/ui/api/store.ts:27`, `:33-34`), `jobs/*.json` (`harness/src/ui/api/jobs.ts:109`), `wizards/` (`harness/src/ui/api/wizard.ts:82`). A fila e as decisões continuam em `queue.json` e `hitl/` do loop.
- **Configuração:** só a camada pessoal (`loop.config.local.yaml`); valores de time voltam como diff para commitar; afrouxar um gate exige confirmação e a run enfileirada grava `weakenedGates` (`harness/src/ui/api/actions.ts:176`).
- **Rede:** o servidor só aceita `host` de loopback (`harness/src/ui/api/server.ts:102`, `:307`); chamadas externas saem pelos adapters (Orca, `gh`).
- **Segurança:** token aleatório de 24 bytes por processo (`harness/src/ui/api/server.ts:309`), exigido no cabeçalho `x-harness-session` (ou `?session=`); `Origin` precisa ser loopback na mesma porta (`harness/src/ui/api/server.ts:104-115`); corpo de requisição limitado a 64 KiB (`harness/src/ui/api/http.ts:19`); identificadores validados por `SAFE_IDENTIFIER` (`harness/src/ui/api/http.ts:6`). O token é injetado no `index.html` servido, nunca na URL (`harness/src/ui/api/server.ts:129`).
- **Variáveis de ambiente (só nomes):** nenhuma lida pelo servidor; as do loop (`AK_HARNESS_CONFIG` etc.) valem via `loadLoopConfig`.
- **Sondagem:** snapshot a cada 1 s com aba aberta; 60 s sem aba só para alertas; heartbeat de 15 s (`harness/src/ui/api/server.ts:48-52`). O snapshot de Orca e automações é memoizado (10 s e 60 s, `harness/src/ui/api/server.ts:266-267`).

## Como mexer (para agentes)

**Comece por** `harness/src/ui/api/server.ts` (rotas embutidas e snapshot), `harness/src/ui/api/projection.ts` (reducer) e `harness/src/ui/api/attention.ts` (classificação). O frontend entra por `harness/src/ui/app/src/main.tsx` e `App.tsx`.

**Invariantes**
- Cada ação chama o mesmo código da CLI; nunca reimplemente uma regra de gate no servidor (ADR-0040 item 3). O ator de um gate é `linear.person` ou `operator` (`harness/src/ui/api/routes-actions.ts:40`).
- Dado ausente nunca é "fresco": tracker desconhecido não vira "fechado"; destrutivos recusam enquanto travados (`harness/src/ui/api/server.ts:324`).
- Mudou o `reduce()`? Incremente `PROJECTION_SCHEMA_VERSION` — senão registros antigos continuam dobrados pela lógica velha (`harness/src/ui/api/store.ts:21-27`).
- Nunca ler histórico sem janela; o servidor bind só em loopback; a UI não instala automações ao iniciar (ADR-0040 item 4).
- Contagem de vagas igual à do tick: `countRunningWorkers` e `machine.ceiling ?? max(floor, cpus/2)` (`harness/src/ui/api/server.ts:173-180`).

**Testes:** `harness/test/ui-api-server.test.ts`, `ui-core-server.test.ts`, `ui-core-attention.test.ts`, `ui-core-reconcile.test.ts`, `ui-projection.test.ts`, `ui-store.test.ts`, `ui-api-jobs.test.ts`, `ui-api-actions.test.ts`, `ui-actions.test.ts`, `ui-config.test.ts`, `ui-feed.test.ts`, `ui-insights.test.ts(x)`, `ui-sse.test.ts`, `ui-system.test.ts`, `ui-app-ops.test.tsx`, `github-board.test.ts`, `github-tracker.test.ts`, `loop-ui-components.test.tsx`.

**Comando de validação:** `pnpm test:ui` (`harness/package.json`, script `test:ui`); tipos do app: `pnpm typecheck` (inclui `tsc -p src/ui/app/tsconfig.json`); build do frontend: `pnpm ui:build` (saída em `dist/app`, `harness/src/ui/app/vite.config.ts:12`); desenvolvimento: `pnpm ui:dev` + `ak-harness ui --dev` (proxy para `http://127.0.0.1:5173`, `harness/src/cli.ts:43`). Receita: [[Rodar e alterar a UI local do Harness]].

**Armadilhas**
- O app é construído em `dist/app` e o servidor resolve `./app` ao lado do módulo compilado: os dois caminhos precisam concordar (`harness/src/ui/app/vite.config.ts:6-12`, `harness/src/ui/api/server.ts:317`). Sem `pnpm build`, a UI responde `503 ui_not_built` (`harness/src/ui/api/server.ts:136`).
- `src/ui/app/**` fica fora do piso de cobertura e é verificada por typecheck e Vitest com alias `@/` (`harness/vitest.config.ts:6-10`, `:24`).
- Há dois "cancelRun/retryRun" na API pública: os da UI levam alias `cancelUiRun`/`retryUiRun` (`harness/src/index.ts:166-171`).
- Uma issue do GitHub tem identificador `owner/repo#N`: ids guardados em caminhos aninhados exigem `safeIssue` (`harness/src/ui/api/routes-actions.ts:59-60`).

**Quem revisa:** mantenedor, para qualquer mudança que adicione ação com efeito no mundo (`harness/CONTRIBUTING.md:86-88`).

## Decisões e história

ADRs: [[harness ADR-0040 - Plano de controle v2]], [[harness ADR-0039 - Piso de auto-merge e runner local não ligado]], [[harness ADR-0041 - Runs de agente e specs renderizadas]], [[harness ADR-0033 - Quatro camadas de configuração e presets]], [[harness ADR-0031 - Observabilidade somente leitura do loop]]. Índice: [[00 Decisões - harness]].

Mudanças recentes (`git log -- src/ui`):
- 2026-10-02 · `5717a9c` · guarda de "record" compartilhada.
- 2026-09-29 · `5496091` · linha de base do guarda de custo por provedor e por tentativa.
- 2026-09-28 · `afc400e` · uma run que falhou antes do despacho aparece na Atenção.
- 2026-09-27 · `07833ce` tentativa arquivada não esconde a anterior; `c0c3ea5` Retry retoma num PR aberto depois da parada; `8ad94d2` reinício nunca destrói trabalho e decisões liberam o lease; `e8a725f` conta vagas como o tick; `40337db` reconstrói a projeção quando o reducer muda.
- 2026-09-25 · `bd59e8c` reescrita do plano de controle (projeção unificada, UI React); `047c918` plano de controle v2.

> [!info]- Detalhe técnico
> - Módulos de rota na ordem tentada: `coreRoutes`, `feedRoutes`, `actionRoutes`, `systemRoutes`, `insightsRoutes`, `configRoutes` (`harness/src/ui/api/route-modules.ts:10-17`).
> - Fases e subestados da projeção: `IssuePhase` e `ReviewSubstatus` em `harness/src/ui/api/projection.ts:19`, `:22`; `RunStatus` em `:23`.
> - Reconciliação: estados de tracker considerados fechados em `harness/src/ui/api/reconcile.ts:53-57`.
> - Build: o frontend entra em `pnpm build` (`harness/package.json:38`, `tsup && pnpm ui:build`).
> - doc-bridge não cobre esta parte (índice só indexa o site de docs).

> [!bug] Existe, mas ninguém usa
> O modo `--dev` do `ak-harness ui` fixa o proxy em `http://127.0.0.1:5173`, porta fixa de `vite` com `strictPort` (`harness/src/cli.ts:43`, `harness/src/ui/app/vite.config.ts:13`); sem `pnpm ui:dev` em paralelo, todas as páginas retornam 502. Não é capacidade morta, mas é um acoplamento invisível. Nada mais foi identificado sem chamador nesta parte.
