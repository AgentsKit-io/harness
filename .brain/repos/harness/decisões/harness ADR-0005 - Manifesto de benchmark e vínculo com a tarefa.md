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
  - harness/docs/ADR-0005-benchmark-manifest.md
  - harness/src/execution/metrics.ts
  - harness/benchmarks/harness-0.4.0-baseline.json
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0005 - Manifesto de benchmark e vínculo com a tarefa

> [!tldr] Em linguagem comum
> Para comparar o harness com um "antes", é preciso uma lista fixa de tarefas e uma linha de base honesta; o que faltar é "não comparável", nunca inferido.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

Um manifesto versionado lista tarefas (ID, título, critérios de aceite) e observações opcionais de baseline. O contrato de verificação pode ligar uma execução a uma suíte e a uma tarefa. O relatório só compara execuções ligadas que tenham baseline explícito e diferente de `not-run`; o resto sai como não comparável.

## Contexto

Run IDs identificam execuções, não a tarefa medida. Sem corpus estável e baseline real, a comparação vira ficção.

## Consequências

- Schema versionado em `harness/src/execution/metrics.ts:8` (`BENCHMARK_SCHEMA_VERSION`); validação em `harness/src/execution/metrics.ts:264` (`validateBenchmarkManifest`); razões de não comparabilidade tipadas em `harness/src/execution/metrics.ts:70`.
- Corpus real no repositório: `harness/benchmarks/harness-0.4.0-baseline.json`, `harness-0.4.0-eval.json`, `harness-phase-22.json`.
- Coleta controlada de baseline é fase posterior (ver [[harness ADR-0012 - Baselines controlados pela interface pública]]).

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0005-benchmark-manifest.md`.
