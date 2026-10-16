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
  - harness/docs/ADR-0013-honest-benchmark-comparability.md
  - harness/src/execution/metrics.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0013 - Comparabilidade honesta de benchmark

> [!tldr] Em linguagem comum
> Uma tarefa só entra na comparação se tiver baseline de verdade e a última execução do harness estiver `COMPLETE`; todo outro caso ganha um motivo tipado.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

`benchmarkRuns` marca uma tarefa como comparável apenas com baseline diferente de `not-run` e com a última execução vinculada em `COMPLETE`. Os demais casos recebem razão: baseline ausente, `not-run`, harness não executado ou não concluído. O relatório expõe checagens, resultados, evidência, duração, tentativas e revisão humana (derivada só quando há aprovação).

## Contexto

Uma execução bloqueada ou em andamento não pode ser apresentada como resultado alcançado.

## Consequências

- Lógica de comparabilidade em `harness/src/execution/metrics.ts:355`; união de razões em `harness/src/execution/metrics.ts:70`.
- Execução bloqueada ou parcial não infla o conjunto comparável; quem lê distingue evidência ausente de execução falha.
- O relatório segue descritivo, sem alegar causalidade.

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum. Refinado por [[harness ADR-0014 - Evidência de benchmark por critério]].

## Fonte

`harness/docs/ADR-0013-honest-benchmark-comparability.md`.
