---
tipo: adr
repo: harness
camada: ferramenta
visibilidade: publico
status: aceito
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; ADR lido e conferido contra o código citado; nada foi executado"
fontes:
  - harness/docs/ADR-0027-keep-pushing-loop.md
  - harness/docs/LOOP.md
  - harness/src/loop/tick.ts
  - harness/src/loop/deliver.ts
  - harness/src/loop/install.ts
  - harness/src/adapters/command.ts
  - harness/src/loop/process.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0027 - Loop keep-pushing sobre o Orca

> [!tldr] Em linguagem comum
> O loop que esvazia a fila de issues de uma pessoa, 24 horas por dia, é uma composição: o harness traz as partes determinísticas e o Orca traz agenda, worktrees e terminais.

← [[00 Decisões - harness]]

## Status e datas

Aceito, 2026-09-11 (`harness/docs/ADR-0027-keep-pushing-loop.md:3-4`).

## A decisão em linguagem comum

1. O loop mora neste pacote como **adapter + composição** (`src/adapters/*` e `src/loop/*`); o kernel não muda e nunca o importa.
2. Tudo que é específico de projeto vive em `loop.config.yaml`, validado por zod: o código não carrega repositório, pessoa, caminho ou ID de modelo; nomes de variáveis de ambiente podem aparecer, valores nunca.
3. Sistemas externos são alcançados só por processos com argv e timeout, via `CommandRunner` injetado; adapters nunca criam shell.
4. O Orca é o agendador e a superfície de visibilidade: duas automações (`<prefix>-tick`, `<prefix>-deliver`) com precheck somente leitura; nada de cron, launchd ou daemon próprio.
5. Roteamento de modelo por papel (`orchestrator`, `reviewer`, `builder`, `watcher`) com o primeiro provedor disponível por tier; falha de autenticação ou cota esfria o provedor.
6. Envelope de autonomia: pode reivindicar tickets, congelar contratos, despachar, cutucar, revisar, fazer squash-merge com revisão limpa e CI verde, mover estados e limpar worktrees; não pode mergear PR que toque `selfEditPaths`, forçar push, contornar aprovações, nem recuperar leases (só humano, [[harness ADR-0021 - Recuperação explícita de lock do log]]).

## Contexto

Equipes querem um loop que drene a fila do Linear de uma pessoa: pegar o ticket, congelar contrato verificável, rodar um worker em worktree isolado, revisar, mergear e repetir, sem exceder a máquina nem adivinhar critérios faltantes. O harness já tinha ledger, pressão de máquina, gates e evidência; o Orca tinha agenda, worktrees, terminais e acesso ao Linear; ninguém compunha os dois.

## Consequências

- `runTick` em `harness/src/loop/tick.ts:523`, `runDeliver` em `harness/src/loop/deliver.ts:1300`, `installLoopAutomations` em `harness/src/loop/install.ts:48`; `CommandRunner` em `harness/src/adapters/command.ts:29`; runner real em `harness/src/loop/process.ts:58`.
- `yaml` e `zod` viram dependências de runtime (`harness/package.json`, `dependencies`).
- Provedores (`claude`, `codex`, `grok`, `opencode`) são configuração, não código.
- Windows via modelo de processos do Node; WSL é detectado e limitado a um worker (`harness/src/loop/slots.ts:63`).
- Superado em detalhes por: automações viram "detached workers" ([[harness ADR-0032 - Estágios como máquinas de estado]]) e a UI virou plano de controle ([[harness ADR-0040 - Plano de controle v2]]). O tracker agora também aceita GitHub ([[harness ADR-0034 - Conectores de tracker SCM e runner]]).

## Pacotes afetados

[[harness-loop]], [[harness-adapters]]

## Substitui / substituído por

Nenhum formalmente.

## Fonte

`harness/docs/ADR-0027-keep-pushing-loop.md`, `harness/docs/LOOP.md`.
