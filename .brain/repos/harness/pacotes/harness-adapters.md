---
tipo: pacote
repo: harness
camada: ferramenta
visibilidade: publico
npm: "@agentskit/harness"
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; nada foi executado. Nota nova da v2: recorte de src/adapters/ do pacote @agentskit/harness (v1 não tinha nota própria)."
fontes:
  - harness/docs/MODULE-BOUNDARIES.md
  - harness/src/adapters/command.ts
  - harness/src/adapters/orca-cli.ts
  - harness/src/adapters/orca.ts
  - harness/src/adapters/providers.ts
  - harness/src/adapters/linear-orca.ts
  - harness/src/adapters/github-cli.ts
  - harness/src/adapters/code-review.ts
  - harness/src/adapters/doc-bridge.ts
  - harness/src/adapters/rag-context.ts
  - harness/src/adapters/mcp.ts
  - harness/src/adapters/tracking.ts
  - harness/src/adapters/agent.ts
  - harness/src/loop/process.ts
  - harness/scripts/verify-dependency-directions.mjs
tags: [pacote, repo/harness, camada/ferramenta]
---

# harness-adapters

> [!tldr] Em linguagem comum
> São as tomadas do Harness para o mundo de fora — Orca, Linear, GitHub, o revisor de código, o índice do Doc Bridge e o MCP. Cada tomada só monta o comando e interpreta a resposta; quem executa é um "executor de comandos" que o chamador entrega.

← [[00 Hub - harness]]

## O que faz e por que existe

Mantém num só lugar tudo o que o Harness sabe sobre ferramentas de terceiros, para que o kernel ([[harness-kernel]]) e as regras do loop ([[harness-loop]]) não precisem saber. A regra de ouro: **argv, nunca shell** — todo adapter recebe um `CommandRunner` (`harness/src/adapters/command.ts:29`) e passa uma lista de argumentos com timeout; o executor real é `createProcessRunner` (`harness/src/loop/process.ts:58`) e os testes entregam fakes. Um envelope `ok:false` do Orca falha fechado (`harness/src/adapters/orca-cli.ts:150`).

Limites: adapters podem depender de contratos do kernel, mas o kernel não pode importar adapters, e `adapters` ↔ `execution` não se importam (`harness/scripts/verify-dependency-directions.mjs:40-42`); por isso ficam fora do kernel Linear, GitHub, Orca, Doc Bridge, provedores de modelo e MCP (`harness/AGENTS.md:61-62`; [[harness ADR-0026 - Fronteira entre kernel e adapters]]).

## API e contratos

| Símbolo | Tipo | Para que serve | Onde |
|---|---|---|---|
| `CommandRunner`, `CommandResult`, `CommandRunOptions` | interface | Executor de comandos sem shell (`run(argv, {timeoutMs, cwd, env, promptOnStdin})`) | `harness/src/adapters/command.ts:29`, `:4`, `:12` |
| `findExecutable`, `parseJsonEnvelope` | função | Acha um executável no PATH (com `PATHEXT` no Windows) e lê o envelope `{ok,result}` do Orca | `harness/src/adapters/command.ts:45`, `:60` |
| `orcaJson` e família `orca*` | função | Chamadas tipadas a `orca … --json`: versão, status, worktrees, terminais (create/send/wait/screen/close), automações | `harness/src/adapters/orca-cli.ts:143` (`orcaJson`), `:220` (`orcaWorktreeCreate`), `:267` (`orcaTerminalCreate`), `:321` (`orcaTerminalSend`), `:355` (`orcaTerminalWait`), `:381`, `:397`, `:406` (automações) |
| `createOrcaDispatchPlan`, `createOrcaLifecycleProjection` | função | Plano idempotente de `orca worktree create` (só monta argv, não executa) e projeção do estado do lease | `harness/src/adapters/orca.ts:63`, `:89` |
| `detectProviders`, `parseProviderUsage`, `remainingUsagePercent`, `cooldownUntil`, `undeclaredOrcaProviders` | função | Quais CLIs de agente podem trabalhar agora (binário, autenticação, janelas de uso do Orca, esgotamento, cooldown, sonda opcional) | `harness/src/adapters/providers.ts:109`, `:71`, `:144`, `:134`, `:188` |
| `fetchLinearQueue`, `fetchLinearIssue`, `linearStatusSet`, `linearCommentAdd`, `linearLabelAdd`, `linearAttach`, `writeIdFor`, `createLinearTrackingAdapter` | função | Linear **via `orca linear …`**; escritas com `--write-id` determinístico para deduplicar | `harness/src/adapters/linear-orca.ts:133`, `:162`, `:197`, `:198`, `:208`, `:210`, `:165`, `:213` |
| `githubPullRequest`, `githubOpenPullRequests`, `assessChecks`, `touchesProtectedPaths`, `githubMerge`, `githubComment`, `githubPreflight` e as de issue (`githubIssue*`) | função | GitHub via `gh`: PR, checks, guarda de caminhos, merge por REST com `sha=` da cabeça revisada, comentários, labels | `harness/src/adapters/github-cli.ts:85` (`assessChecks`), `:107`, `:324-326` (merge), `:336-338`, `:272` |
| `runCodeReview`, `buildReviewArgv`, `parseReviewResult`, `renderFindingsForWorker`, `REVIEW_SEVERITIES` | função/const | Roda o `agentskit-review`; exit 0/1/2 + arquivo `--result` decidem limpo/achados/incompleto | `harness/src/adapters/code-review.ts:164`, `:151`, `:107`, `:208`, `:8` |
| `createDocBridgeContextProvider`, `inspectDocBridgeIndex` | função | Contexto determinístico do `.doc-bridge/index.json` (até 8 referências, guarda de idade) | `harness/src/adapters/doc-bridge.ts:82`, `:68` |
| `createRagContextProvider`, `createArgvRagContextProvider` | função | Contexto de RAG por função injetada ou por argv; sem dependência estática de `@agentskit/rag` | `harness/src/adapters/rag-context.ts:81`, `:99` |
| `createMcpToolBridge` | função | Ponte MCP com allowlist + `PolicyGate`; padrão negar | `harness/src/adapters/mcp.ts:40` |
| `createTrackingAdapter`, `createTrackingTransition` | função | Transição idempotente de tracker por chave de idempotência; `dryRun` não chama o handler | `harness/src/adapters/tracking.ts:31`, `:26` |
| `createCodingAgentAdapter` | função | Execução de agente de código com timeout e classificação de falha; telemetria `unknown` honesta | `harness/src/adapters/agent.ts:56` |

**Exemplo real** — o merge otimista por SHA (`harness/src/adapters/github-cli.ts:324`) montado como argv, usado pelo `deliver` (`harness/src/loop/deliver.ts:1178`):

```ts
const merged = await githubMerge(ctx.runner, { repo: config.project.repo, number: pr.number, headSha: pr.headSha, method: config.delivery.merge.method, title: `${pr.title} (#${pr.number})` })
```

O GitHub recusa se a cabeça mudou depois da revisão — é a garantia "o que foi revisado é o que foi mergeado".

## Quem usa e do que depende

| Relação | Nota / evidência |
|---|---|
| Consumidor | [[harness-loop]] usa praticamente todos (`harness/src/loop/tick.ts:4-10`, `harness/src/loop/deliver.ts:4-13`) |
| Consumidor | [[harness-ui]] lê o quadro do tracker e Orca por estes adapters (`harness/src/ui/api/server.ts:9-10`) |
| Dependência (kernel) | `errors`, `hash`, `policy`, `preflight`, `adapter-contract` (`harness/docs/MODULE-BOUNDARIES.md:73-82`) |
| Ferramenta externa | CLI `orca` (Orca) e `gh` (GitHub) no PATH; `agentskit-review` do repo [[00 Hub - code-review]] (`harness/src/adapters/code-review.ts:151`) |
| Ferramenta externa | Índice `.doc-bridge/index.json` produzido por [[00 Hub - doc-bridge]] |
| Biblioteca | `@agentskit/cross-platform` só via `createProcessRunner` (`harness/src/loop/process.ts:1`); `@agentskit/net` no catálogo de modelos (`harness/src/loop/model-catalog/index.ts:4`) |

## Dados e efeitos

- **Rede indireta:** nenhum adapter abre socket; tudo passa por processos `orca`, `gh` e o CLI de revisão.
- **Escritas em sistemas externos:** Linear (status, comentário, label, atribuição, anexo, criação de issue) via `orca linear` com `--write-id` (`harness/src/adapters/linear-orca.ts:165-213`); GitHub (merge, comentário, remoção de label, criação/edição/fechamento de issue) via `gh` (`harness/src/adapters/github-cli.ts:324-338`).
- **Arquivos:** `runCodeReview` grava um arquivo de resultado por cabeça de PR e, se necessário, um `--config` temporário apagado no fim (`harness/src/adapters/code-review.ts:169-180`).
- **Variáveis de ambiente (só nomes):** `AGENTSKIT_REVIEW_SUBPROCESS_TIMEOUT_MS` é injetada na chamada de revisão (`harness/src/adapters/code-review.ts:175`); a detecção de provedores consulta os nomes em `models.providers.<id>.envKeys` (`harness/src/adapters/providers.ts:94`); `PATH`/`PATHEXT` em `harness/src/adapters/command.ts:48-49`; `GITHUB_TOKEN`/`GH_TOKEN` são derivados de `gh auth token` no `deliver` (`harness/src/loop/deliver.ts:1319`).
- **Permissões:** conta autenticada no `gh` com escrita no repositório; `githubPreflight` confere login, permissão e labels antes de um job mutante (`harness/src/adapters/github-cli.ts:272`).

## Como mexer (para agentes)

**Comece por** `harness/src/adapters/command.ts` (o contrato do executor) e pelo adapter mais próximo da mudança.

**Invariantes**
- Argv, nunca string de shell; todo comando com timeout; falha de transporte ou envelope vira `HarnessError` (`harness/src/adapters/orca-cli.ts:147-150`).
- Um adapter nunca converte erro de provedor em "passou" (`harness/docs/ADR-0026-kernel-adapters-boundary.md`, item 5).
- Envie texto livre (prompt, comentário) como elemento único de argv; só os argumentos estruturais passam por `validateSafeCommand` (`harness/src/adapters/orca.ts:83-84`).
- `orcaTerminalSend` nunca usa um timeout menor que a janela `--wait-submit` mais folga (`harness/src/adapters/orca-cli.ts:323-328`).
- Sem import `adapters → execution` (e vice-versa): `pnpm test:boundaries`.

**Testes:** `harness/test/adapters.test.ts`, `adapters-orca.test.ts`, `adapters-orca-cli-gaps.test.ts`, `adapters-github-cli-gaps.test.ts`, `adapters-linear-orca-gaps.test.ts`, `adapters-providers-gaps.test.ts`, `adapters-code-review.test.ts`, `adapters-command.test.ts`, `adapters-tracking.test.ts`, `adapters-agent.test.ts`, `doc-bridge.test.ts`, `rag-context.test.ts`, `mcp-adapter.test.ts`.

**Comando de validação:** `pnpm test:adapters` (adapters), `pnpm test:doc-bridge` (contexto), `pnpm test:boundaries` (direção de import) — scripts em `harness/package.json`. Receita geral: [[Validar uma mudança no Harness]].

**Armadilhas**
- Para adicionar um novo provedor externo (tracker, SCM, modelo, memória, MCP), ele entra como adapter ou plugin, nunca no kernel (`harness/docs/MODULE-BOUNDARIES.md:133-135`).
- O Linear é acessado **através do Orca** (`orca linear …`), não por SDK próprio — sem Orca não há Linear (`harness/src/adapters/linear-orca.ts:93`).
- `touchesProtectedPaths` aceita `*` e `**`, mas só sobre nomes de arquivo; conteúdo não é inspecionado (`harness/src/adapters/github-cli.ts:95-110`).

**Quem revisa:** igual ao pacote; mudança de adapter que toque gate de merge exige olhar de mantenedor ([[harness-kernel]]).

## Decisões e história

ADRs: [[harness ADR-0003 - Contexto do Doc Bridge ligado à execução]], [[harness ADR-0025 - Controles portáteis de orquestração]], [[harness ADR-0026 - Fronteira entre kernel e adapters]], [[harness ADR-0027 - Loop keep-pushing sobre o Orca]], [[harness ADR-0028 - MCP só como adapter]], [[harness ADR-0034 - Conectores de tracker SCM e runner]]. Índice: [[00 Decisões - harness]].

Mudanças recentes (`git log -- src/adapters`):
- 2026-10-09 · `724aa82` · responde à pergunta de confiança de workspace num worktree novo.
- 2026-10-07 · `9df92e4` · o timeout do `terminal send` passa a ter piso igual à janela `waitSubmitSeconds`.
- 2026-10-03 · `ba803cc` · estimativa de tokens de contexto compartilhada; 2026-10-02 · `5717a9c` guarda de "record".
- 2026-09-27 · `19f19f7` nunca digitar num shell nu; `6afc025` preflight do GitHub reporta labels ausentes; `a30a9ce` deliver não espera para sempre uma revisão "findings" sem itens bloqueantes.
- 2026-09-26 · `9e726ff` runs de agente e specs (ADR-0041); 2026-09-25 · `de47e92` pipeline de revisão no Windows.

> [!info]- Detalhe técnico
> - Lista completa dos módulos e dependências: `harness/docs/MODULE-BOUNDARIES.md:73-82`.
> - Inventário de integrações e efeitos: `harness/docs/MODULE-BOUNDARIES.md:163-178`.
> - Exportações públicas: `harness/src/index.ts:15-21`, `:50-51`, `:74-77`, `:96-103`, `:125-130`, `:142-143`.
> - `createRunnerConnector` (Orca ou tmux) vive no loop, não aqui: `harness/src/loop/runner-connector.ts:141`.

> [!bug] Existe, mas ninguém usa
> `createMcpToolBridge` só tem chamador no autoteste do `doctor` com `call: async () => null` (`harness/src/loop/doctor.ts:213`); tick e deliver não o chamam, por decisão ([[harness ADR-0028 - MCP só como adapter]]). `createArgvRagContextProvider` é usado só pela geração de contrato quando `memory.contextProviders` inclui `rag` (`harness/src/loop/contract.ts:389`; config em `harness/src/loop/config.ts:489`). `createOrcaLifecycleProjection` e `createCodingAgentAdapter` só aparecem em testes, exemplos e na API pública. Ver [[Capacidades não usadas]].
