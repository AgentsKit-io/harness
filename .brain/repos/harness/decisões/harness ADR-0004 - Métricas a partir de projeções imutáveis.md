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
  - harness/docs/ADR-0004-run-metrics.md
  - harness/src/execution/metrics.ts
  - harness/src/cli.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0004 - Métricas a partir de projeções imutáveis

> [!tldr] Em linguagem comum
> As métricas de benchmark são calculadas lendo o histórico de execuções já gravado, sem banco de dados nem serviço de telemetria.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; o arquivo entra no histórico git em 2026-09-09).

## A decisão em linguagem comum

`benchmarkRuns(stateDir)` e o comando `ak-harness benchmark` leem os `run.json` históricos, ordenam por ID e emitem um relatório JSON versionado com fatos por execução e taxas agregadas (checagens, resultados, evidência, aprovações, retentativas, execuções velhas, duração).

## Contexto

Medir melhora entre execuções repetidas sem introduzir banco de dados ou telemetria remota; cada execução já guarda fonte, contrato, checagens, evidência, estado, aprovação e duração.

## Consequências

- Implementação: `harness/src/execution/metrics.ts:363` (`benchmarkRuns`); CLI em `harness/src/cli.ts:584`.
- O relatório mede atrito de execução e revisão; não afirma produtividade nem causalidade.
- Um armazém remoto futuro pode consumir o relatório versionado sem mudar o núcleo de verificação.

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum. Estendido por [[harness ADR-0005 - Manifesto de benchmark e vínculo com a tarefa]] e seguintes (0012–0016, 0024).

## Fonte

`harness/docs/ADR-0004-run-metrics.md`.
