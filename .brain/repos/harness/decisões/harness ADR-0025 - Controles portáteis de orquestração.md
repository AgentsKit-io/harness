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
  - harness/docs/ADR-0025-portable-orchestration-controls.md
  - harness/src/execution/coordination.ts
  - harness/src/kernel/resilience.ts
  - harness/src/kernel/preflight.ts
  - harness/src/kernel/block.ts
  - harness/src/kernel/status.ts
  - harness/src/kernel/model-policy.ts
  - harness/src/execution/machine.ts
  - harness/src/adapters/orca.ts
  - harness/src/adapters/tracking.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0025 - Controles portáteis de orquestração

> [!tldr] Em linguagem comum
> De um projeto de referência, só os mecanismos determinísticos foram trazidos para o núcleo; repositórios, pessoas, branches e CLIs ficaram de fora.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-10).

## A decisão em linguagem comum

Entram no núcleo apenas peças determinísticas: claims de issue/worktree e ledger de despacho idempotente, classificação de falha com recuperação limitada, planejamento de preflight por arquivo, registros portáteis de bloco/status/aprendizado, vínculos de modelo, limiares de máquina e adapters neutros de Orca e tracking. Adapters ficam com rede e credenciais; decisões humanas continuam exigidas para ambiguidade material, recuperação e promoção de aprendizado.

## Contexto

O projeto SDLC de referência tinha bons mecanismos de despacho, máquina, recuperação e retro, mas embutia repositórios, pessoas, branches, CLIs de provedor e infraestrutura de painel. O harness precisa ser reutilizável e neutro.

## Consequências

- Ledger: `harness/src/execution/coordination.ts:69` (`createDispatchLedger`); falhas: `harness/src/kernel/resilience.ts:42` (`classifyFailure`) e `:67` (`runWithRecovery`); preflight: `harness/src/kernel/preflight.ts:31` e `:41`; bloco: `harness/src/kernel/block.ts:60`; status: `harness/src/kernel/status.ts:31`; modelos: `harness/src/kernel/model-policy.ts:24`; máquina: `harness/src/execution/machine.ts:81`; Orca: `harness/src/adapters/orca.ts:63`; tracking: `harness/src/adapters/tracking.ts:31`.
- O mesmo controle serve com Orca, outro orquestrador, Linear, GitHub ou processo local. A base do loop ([[harness ADR-0027 - Loop keep-pushing sobre o Orca]]) usa o ledger em `harness/src/loop/tick.ts:529`.

## Pacotes afetados

[[harness-kernel]], [[harness-adapters]], [[harness-loop]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0025-portable-orchestration-controls.md`.
