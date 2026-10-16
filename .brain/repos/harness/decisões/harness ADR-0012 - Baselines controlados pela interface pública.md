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
  - harness/docs/ADR-0012-controlled-baseline-observations.md
  - harness/src/execution/metrics.ts
  - harness/src/cli.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0012 - Baselines controlados pela interface pública

> [!tldr] Em linguagem comum
> Há um único caminho suportado para gravar uma observação de baseline, com validação e escrita atômica; editar JSON à mão deixa de ser o método.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

`recordBenchmarkObservation` e `ak-harness benchmark baseline` são o caminho de escrita: validam manifesto e observação, rejeitam tarefa desconhecida e duplicata, escrevem em arquivo temporário seguido de rename atômico e conferem se o manifesto de origem não mudou no meio. `not-run` continua um status explícito e não comparável.

## Contexto

Uma comparação só vale com baseline real, atribuível e ligado à mesma tarefa; JSON editado à mão é fácil de errar e difícil de reproduzir.

## Consequências

- API em `harness/src/execution/metrics.ts:311`; CLI em `harness/src/cli.ts:585`.
- O relatório nunca infere baseline do histórico do harness.
- Escritas concorrentes ou velhas falham em vez de sobrescrever dados novos; uma execução controlada continua necessária — a API só registra evidência.

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0012-controlled-baseline-observations.md`.
