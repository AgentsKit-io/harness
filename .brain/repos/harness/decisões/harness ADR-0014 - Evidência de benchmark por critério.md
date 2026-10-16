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
  - harness/docs/ADR-0014-criterion-level-benchmark-evidence.md
  - harness/src/execution/metrics.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0014 - Evidência de benchmark por critério

> [!tldr] Em linguagem comum
> Números escalares de baseline não provam que a tarefa exercitou seus critérios; o baseline agora traz evidência critério a critério.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

Observações de baseline podem incluir um array `evidence`; cada entrada nomeia exatamente um critério de aceite, seu status e uma fonte. O validador rejeita critério desconhecido ou duplicado. A comparação só é `comparable` quando todo critério está coberto, o baseline não é `not-run` e a última execução está `COMPLETE`; a cobertura aparece em `baselineEvidenceCoverageRate` e a falta vira `baseline-evidence-missing`.

## Contexto

Tratar números escalares como comparáveis faz uma entrega incompleta parecer melhora.

## Consequências

- Cobertura calculada em `harness/src/execution/metrics.ts:352`; razão `baseline-evidence-missing` em `harness/src/execution/metrics.ts:355`.
- A coleta de baseline exige um insumo a mais; a fonte da evidência continua sendo só uma referência.

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0014-criterion-level-benchmark-evidence.md`.
