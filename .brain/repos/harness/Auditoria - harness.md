---
tipo: guia
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; as notas v1 foram conferidas contra o código no commit acima; nada foi executado"
fontes:
  - harness/src/loop/config.ts
  - harness/src/loop/runner-connector.ts
  - harness/src/loop/tick.ts
  - harness/src/loop/event-bus.ts
  - harness/src/loop/index.ts
  - harness/src/cli.ts
  - harness/src/execution/runtime.ts
  - harness/apps/docs/package.json
  - harness/docs/LOOP.md
  - harness/docs/MODULE-BOUNDARIES.md
  - harness/docs/ADR-0009-process-runtime-boundary.md
  - harness/docs/ADR-0030-loop-event-bus-orchestration-hooks.md
  - harness/docs/ADR-0034-connectors-tracker-scm-runner.md
  - harness/docs/ADR-0039-gate-floor-and-the-unwired-local-runner.md
  - harness/AGENTS.md
  - harness/.ak-harness/verification.json
tags: [guia, repo/harness, camada/ferramenta]
---

# Auditoria - harness

> [!tldr] Em linguagem comum
> O que a primeira versão das notas do Harness dizia de errado (e foi corrigido) e onde a documentação do próprio repositório já não bate com o código.

← [[00 Hub - harness]]

## Erros da v1 (corrigidos nesta versão)

| # | O que a v1 dizia | O que o código mostra | Onde foi corrigido |
|---|---|---|---|
| 1 | Hub e fluxo "Da issue ao merge": o despacho usa "runner Orca **ou local** (git/tmux/crontab)" | `connectors.runner: "local"` é rejeitado na validação (`harness/src/loop/config.ts:1093`) e `tick` chama `orcaWorktreeCreate` direto (`harness/src/loop/tick.ts:963`); `createLocalRunner` só é exercido por testes | [[00 Hub - harness]], [[Harness - Da issue ao merge]], [[harness-loop]] |
| 2 | Nota `harness-docs` com `visibilidade: publico` | O workspace é `"private": true` (`harness/apps/docs/package.json:4`); o próprio hub v1 já dizia "apps de docs são pacotes privados" — as duas notas se contradiziam | [[harness-docs]] |
| 3 | `harness-kernel` "usa … e adaptadores do próprio repo" | O kernel **não** importa adapters (`harness/scripts/verify-dependency-directions.mjs:40-42`); as dependências externas reais são `@agentskit/core`, `@agentskit/cross-platform` e `zod` | [[harness-kernel]] |
| 4 | Fluxo "Da issue ao merge": o worker deixa sempre `plan.md`, `verify.json` e `dod.json` | `plan.md` só é exigido quando o planejador está ligado (`harness/src/loop/deliver.ts:1092`) | [[Harness - Da issue ao merge]] |
| 5 | Citações como `harness/src/ui/api/server.ts:37` para "loopback, sessão e origem" | A linha 37 é um `import`; o código está em `harness/src/ui/api/server.ts:102-115` e `:307-309` | [[harness-ui]] |
| 6 | Hub: "[[00 Hub - skills]] lê estado para relatórios" | Nada no repositório prova isso; o que existe é o skill `ak-harness-loop` empacotado em `harness/skills/` | [[00 Hub - harness]] (agora só afirma o que está no repo) |
| 7 | Faltavam: nota de adapters, ADRs, guias, fluxo do protocolo de verificação, caminhos de dados, variáveis de ambiente | — | Todo o conjunto v2 |
| 8 | Citações com prefixo `harness/…:1` (início de arquivo) em vez do símbolo | — | Todas as notas v2 citam a linha do símbolo |

## Divergências entre a documentação do repositório e o código

Não são erros do vault, mas quem usa as docs como fonte deve saber:

| # | Documento | Diz | Código |
|---|---|---|---|
| 1 | `harness/docs/LOOP.md:118-120`, `:127` | `deliver` "roda inline" no precheck de 600 s | `loop stage deliver` também dispara um worker destacado (`harness/src/cli.ts:174-199`; commit `ce35a49`) |
| 2 | `harness/docs/LOOP.md:675-677` | `resilience.maxUsageDeltaPercent` desligado por padrão | Padrão **40** (`harness/src/loop/config.ts:623`) |
| 3 | `harness/docs/ADR-0034-connectors-tracker-scm-runner.md` | `connectors.tracker` aceita só `linear` | Aceita `linear` e `github` (`harness/src/loop/config.ts:698`, `harness/src/loop/connectors.ts:147`) |
| 4 | `harness/docs/LOOP.md:462-469`, `harness/apps/docs/content/docs/guides/local-runner.mdx`, ADR-0034 | O runner `local` é utilizável com `connectors.runner: local` | Recusado na validação; ADR-0039 registra o motivo |
| 5 | `harness/docs/ADR-0030-loop-event-bus-orchestration-hooks.md` | Listener ou hook que lança erro é engolido | Um `before*` que lança passa a **bloquear** (`harness/src/loop/event-bus.ts:73`) |
| 6 | `harness/docs/ADR-0009-process-runtime-boundary.md` | O runtime usa `spawn` com `shell: false` | Usa `spawnNodeChild` do `@agentskit/cross-platform` (`harness/src/execution/runtime.ts:217`); continua sem shell |
| 7 | `harness/docs/ADR-0039-gate-floor-and-the-unwired-local-runner.md` | O CI está em `ci.yml` | O workflow é `release-harness.yml`; o próprio arquivo explica que o nome é decisivo para o npm (`harness/.github/workflows/release-harness.yml:3-8`) |
| 8 | `harness/AGENTS.md:79-83`, comentário em `release-harness.yml:76-77` | 47 scripts, 18 resultados, 22 checks | `harness/.ak-harness/verification.json` tem 19 resultados e 23 checagens (`:14-34`, `:46-68`) |
| 9 | `harness/docs/MODULE-BOUNDARIES.md:12`, `:25-72` | Kernel só usa stdlib; "inventário completo" de módulos | O kernel importa `@agentskit/core` (`harness/src/kernel/hash.ts:1`) e `@agentskit/cross-platform` (`harness/src/kernel/process-tree.ts:2`); o inventário é da base de 2026-09-10 e não lista, por exemplo, `plan-stage`, `queue`, `hitl`, `lifecycle`, `agent-runs`, `deliver-state` nem `src/ui/**` |
| 10 | `harness/apps/docs/source.config.ts:6-8`, `harness/apps/docs/lib/site.ts:4` | "37 ADRs … em português", "workflow Pages" | 43 ADRs em inglês; publicação por Cloudflare (`harness/wrangler.toml`) |
| 11 | `harness/src/loop/index.ts` | Barril do loop | Ninguém o importa; divergiu de `src/index.ts` (`harness/src/index.ts:104-256`) |
| 12 | `harness/compatibility/manifest.json:4`, `harness/release/manifest.json:7` | `harnessVersion` 0.4.0; `sourceRevision` de uma versão anterior | O pacote está em 0.22.3 (`harness/package.json:3`) |

> [!question] Dúvida
> Para o ADR-0039: o "piso do auto-merge" só soma "a revisão" quando ela rodou **nesta** passagem (`harness/src/loop/deliver.ts:1150`); numa passagem em que a revisão limpa vem do cache do estado, `review` é `null`. Se for intencional, vale um comentário; se não, é um possível falso "nada examinou". Não foi executado. Registrado em [[Dúvidas abertas]].

> [!info]- Detalhe técnico
> Método: para cada afirmação factual das notas v1 (hub, kernel, loop, ui, docs, dois fluxos), procurei o símbolo ou arquivo no commit `40d033b` (código idêntico ao de `724aa82`, usado pela v1; a diferença é só o commit de sementes do `.brain`). Os comandos usados foram `git grep`, `git log` e leitura direta. A CLI do doc-bridge não foi executada.
