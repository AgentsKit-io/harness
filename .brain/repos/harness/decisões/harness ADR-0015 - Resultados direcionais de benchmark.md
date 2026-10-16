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
  - harness/docs/ADR-0015-directional-benchmark-outcomes.md
  - harness/src/execution/metrics.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0015 - Resultados direcionais de benchmark

> [!tldr] Em linguagem comum
> Para cada recurso medido, o relatório diz se o harness melhorou, piorou, manteve ou se não há dado — sem inventar uma nota única de produtividade.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

Para tarefas comparáveis, duração, tentativas e revisão humana ganham uma taxa `(baseline − harness) / baseline`. Positivo é `improved`, negativo `regressed`, zero `unchanged`; valor ausente, baseline zero ou tarefa não comparável é `unavailable`. São sinais por recurso, não um índice composto.

## Contexto

Um delta negativo de duração é fácil de ler ao contrário e tarefas não comparáveis podem ser confundidas com dado faltando.

## Consequências

- Direção calculada em `harness/src/execution/metrics.ts:147` (`improvementDirection`); campos `improvement.*` em `harness/src/execution/metrics.ts:360`.
- Os trade-offs ficam visíveis em vez de escondidos em um único número; ainda é preciso baseline real com evidência completa.

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum. Estendido por [[harness ADR-0024 - Entrega incompleta escapada como métrica]].

## Fonte

`harness/docs/ADR-0015-directional-benchmark-outcomes.md`.
