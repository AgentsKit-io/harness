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
  - harness/docs/ADR-0038-worker-guard-real-time-enforcement.md
  - harness/src/loop/worker-guard.ts
  - harness/src/loop/tick.ts
  - harness/src/loop/deliver.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0038 - Worker guard em tempo real

> [!tldr] Em linguagem comum
> Um hook instalado no worktree impede o worker de editar arquivos protegidos ou parecidos com segredo enquanto trabalha, para `claude`, `grok` e `opencode`; `codex` continua protegido só pelo portão no PR.

← [[00 Decisões - harness]]

## Status e datas

Aceito, parcial: `codex` deliberadamente não coberto (`harness/docs/ADR-0038-worker-guard-real-time-enforcement.md:5`). Sem data no documento; no histórico git desde 2026-09-22.

## A decisão em linguagem comum

`ak-harness loop worker-guard` lê um evento `PreToolUse` na stdin (`{tool_name, tool_input, cwd}`), julga o arquivo contra `delivery.selfEditPaths` e `secretFilePatterns` (a mesma `touchesProtectedPaths` do portão do PR) e sai com 2 para bloquear ou 0 para permitir. O loop instala o hook no worktree antes de abrir o terminal do worker e de novo no handoff:

- **claude** — `.claude/settings.local.json`, hook em `Write|Edit|MultiEdit|NotebookEdit`, verificado ao vivo (os hooks disparam antes da checagem de permissão, mesmo em `bypassPermissions`).
- **grok** — `.grok/hooks/config.json`, mesmo formato; tem seu próprio diálogo de confiança na pasta que exige `--trust`.
- **opencode** — sem hook; regras estáticas `deny` em `permission.edit`, gravadas em `.opencode/opencode.json` (com `.gitignore` de `*` quando o diretório é nosso).
- **codex** — não coberto: bugs upstream fazem um hook `deny` poder ser ignorado (`apply_patch`) e não há como pré-confiar o hook sem flag perigosa.

O hook grava o caminho absoluto da build que o instalou; atualizar o harness com workers em voo pode deixar o hook apontando para um arquivo que sumiu (pnpm) — e qualquer saída diferente de 2 é "permitir" nos CLIs. `delivery.workerGuard.enabled` (padrão `true`) é a válvula de escape.

## Contexto

Todo gate anterior rodava *depois* do worker: o harness só descobria uma escrita indevida quando o PR existia, porque a sessão do worker é opaca.

## Consequências

- Regras em `harness/src/loop/worker-guard.ts:53` (`assessWorkerGuard`) e `:70` (`runWorkerGuard`); instalação em `:139` (`installWorkerGuard`: `claude` `:154`, `grok` `:155`, `opencode` `:156-170`, resto `:171`); chamada no despacho em `harness/src/loop/tick.ts:968`; flag no registro `workerGuardInstalled` (`harness/src/loop/tick.ts:122`).
- `workerGuardInstalled: true` significa "o arquivo do hook foi escrito", não "toda escrita foi checada"; um `Bash` que grava o mesmo caminho (`echo > .env`) não é pego por nenhum dos dois portões.
- Entrada ilegível não falha fechado (`harness/src/loop/worker-guard.ts:72`): o portão do PR é o backstop.

## Pacotes afetados

[[harness-loop]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0038-worker-guard-real-time-enforcement.md`.
