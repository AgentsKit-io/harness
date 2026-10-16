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
  - harness/docs/ADR-0020-terminal-reconciliation.md
  - harness/src/execution/verification.ts
  - harness/src/kernel/events.ts
  - harness/src/cli.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0020 - Reconciliação terminal

> [!tldr] Em linguagem comum
> Antes de dizer "completo", o harness confere projeção, digest e eventos de decisão; apagar um evento ou editar `run.json` faz a conclusão falhar.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

`reconcileRun` (API) e `ak-harness audit` (CLI) verificam a corrente de hashes, o vínculo evento→execução, o digest de verificação atual e os eventos e projeções de aprovação/autorização exigidos nos estados terminais. `ak-harness status` usa o mesmo portão. Escritas no log usam um lock atômico por execução e falham fechadas se outro escritor estiver ativo.

## Contexto

Ler `run.json` direto depois da aprovação poderia dar `COMPLETE` mesmo com digest, projeção de decisão ou evento removidos ou alterados.

## Consequências

- Implementação em `harness/src/execution/verification.ts:205-230` (`reconcileRun`); lock com `openSync(..., 'wx')` em `harness/src/kernel/events.ts:243`.
- CLI: `status` em `harness/src/cli.ts:576`, `audit` em `harness/src/cli.ts:577`.
- Projeções terminais de antes do protocolo de atestação precisam ser reverificadas, não tratadas como evidência corporativa.

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum. Complementado por [[harness ADR-0021 - Recuperação explícita de lock do log]].

## Fonte

`harness/docs/ADR-0020-terminal-reconciliation.md`.
