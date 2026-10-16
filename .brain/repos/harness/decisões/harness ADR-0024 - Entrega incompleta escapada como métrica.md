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
  - harness/docs/ADR-0024-controlled-completion-metrics.md
  - harness/src/execution/metrics.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0024 - Entrega incompleta escapada como métrica

> [!tldr] Em linguagem comum
> Para provar que o harness reduz entregas "completas" sem prova, mede-se quantas escaparam incompletas contra um baseline controlado.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

Uma observação de baseline pode registrar `escapedIncomplete`. Uma execução `COMPLETE` do harness é projetada como zero apenas quando toda checagem, resultado e slot de evidência passa. Relatórios comparáveis expõem `escapedIncompleteRate`, direção e delta ao lado de duração, tentativas e revisão. Um fixture controlado precisa trazer evidência por critério; baselines ausentes continuam `unavailable`.

## Contexto

Taxa de aprovação e duração não provam redução de entregas incompletas.

## Consequências

- Projeção por execução em `harness/src/execution/metrics.ts:168`; campo da observação em `harness/src/execution/metrics.ts:28`; taxa e direção em `harness/src/execution/metrics.ts:81-82` e `:359`.
- Um fixture sintético valida o pipeline de métrica, mas não é evidência de causalidade em produção; ainda é preciso coorte real.

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0024-controlled-completion-metrics.md`.
