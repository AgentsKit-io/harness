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
  - harness/docs/ADR-0031-loop-observability.md
  - harness/src/loop/observability.ts
  - harness/src/loop/observe-stage.ts
  - harness/src/cli.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0031 - Observabilidade somente leitura do loop

> [!tldr] Em linguagem comum
> Um comando lê o que o loop já registra e aponta workers parados, estado de entrega ausente ou fila ociosa — sem criar daemon nem painel novo.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-13).

## A decisão em linguagem comum

`loop observe` e a função pura `assessObservability` reutilizam doctor, debrief, log de eventos e consultas somente leitura ao Orca. Regras determinísticas apontam: terminal conectado sem saída; claim ativo sem `delivery.json`; worktree concluído com arquivos não commitados; trabalho pronto com slot livre mas sem despacho recente; fase de worker/review além de `delivery.workerIdleTimeoutMin`. `--precheck` usa a semântica de scheduler: 0 = acionável, 1 = saudável.

## Contexto

Operadores precisavam correlacionar doctor, debrief e retro à mão; um painel ou daemon adicionaria mais um runtime.

## Consequências

- `assessObservability` em `harness/src/loop/observability.ts:108`, coletor em `:157`, Markdown em `:201`; estágio agendado em `harness/src/loop/observe-stage.ts:75` (avaliação) e `:116` (execução).
- Nenhuma persistência nova além do estado do estágio observador (`observer-state.json`, `harness/src/loop/observe-stage.ts:31`); o log segue sendo a fonte de verdade.
- Um painel ou superfície MCP somente leitura futuros podem consumir o mesmo relatório.

## Pacotes afetados

[[harness-loop]], [[harness-ui]]

## Substitui / substituído por

Nenhum. Evoluído em [[harness ADR-0032 - Estágios como máquinas de estado]] (estágio `observe`).

## Fonte

`harness/docs/ADR-0031-loop-observability.md`.
