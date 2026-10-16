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
  - harness/docs/ADR-0032-loop-stages-as-state-machines.md
  - harness/src/loop/event-vocabulary.ts
  - harness/src/cli.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0032 - Estágios como máquinas de estado

> [!tldr] Em linguagem comum
> O modelo escreve conteúdo; quem decide a transição é a máquina — por isso o mesmo estado dá sempre a mesma decisão e o caminho fica no log.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-21).

## A decisão em linguagem comum

Todo estágio é uma máquina de estado que o harness executa. Um modelo pode produzir conteúdo (contrato, plano, voto, revisão, triagem de alerta), mas a máquina lê o conteúdo e decide a transição. Estágios: `tick` (fila → contrato → plano/voto → despacho), `deliver` (PR → checks → verify → review → DoD → merge), `plan` (objetivo → entrevista → PRD → design → voto → issues, com dois gates humanos), `observe` (varredura somente leitura; seu exit code é a única decisão), `release` (lote → aprovação humana ligada ao SHA → promover → deploy → smoke → rollback) e `intake`/`maintain` (alertas e checagens viram issues deduplicadas por fingerprint). Cada transição escreve um evento declarado.

## Contexto

Cada novo estágio poderia ter sido escrito como "pergunte a um modelo o que fazer"; essa forma falha sempre do mesmo jeito: o modelo decide a transição e duas execuções divergem sem explicação.

## Consequências

- Vocabulário declarado em `harness/src/loop/event-vocabulary.ts:11` (`LOOP_EVENT_TYPES`) e `:243` (`isLoopEventType`); o estágio roda dentro do precheck do Orca e sai com 1, exceto `observe` (`harness/src/cli.ts:157-165`).
- Hoje `tick` e `deliver` não fazem o trabalho dentro do precheck: o precheck só espia o lock e dispara um worker destacado (`harness/src/cli.ts:174-199`), com as funções `runTick`/`runDeliver` executadas por `tick-worker`/`deliver-worker` (`harness/src/cli.ts:312-317`). `LOOP.md:118-120` ainda diz que `deliver` roda inline — ver [[Auditoria - harness]].
- Testar um estágio não exige modelo; acrescentar uma fase é acrescentar estado e evento, não um prompt.

## Pacotes afetados

[[harness-loop]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0032-loop-stages-as-state-machines.md`.
