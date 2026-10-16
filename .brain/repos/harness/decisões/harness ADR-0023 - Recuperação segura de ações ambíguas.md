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
  - harness/docs/ADR-0023-safe-action-recovery.md
  - harness/src/execution/agent.ts
  - harness/src/kernel/events.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0023 - Recuperação segura de ações ambíguas

> [!tldr] Em linguagem comum
> Se o processo caiu depois de iniciar uma ação mas antes de registrar o fim, o harness não repete sozinho: um humano decide retentar ou abandonar.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

`tool.execution.started` é gravado imediatamente antes de entrar no runtime. Na recuperação, ações com esse marcador ficam pendentes e falham fechadas. A API pública expõe `recoverTool` com `retry` e `abandon`, só para humano: retentar limpa o marcador e registra a decisão; abandonar registra e bloqueia. Ações sem início de execução retomam normalmente e ações terminais nunca são reexecutadas.

## Contexto

Reexecutar automaticamente uma ação que pode já ter produzido efeito externo duplicaria o efeito.

## Consequências

- `recoverTool` em `harness/src/execution/agent.ts:30`; os tipos de evento `tool.execution.started` e `tool.recovery.recorded` estão em `harness/src/kernel/events.ts:13`.
- A revisão humana só é exigida quando o log não prova que a execução nunca começou; idempotência e semântica transacional externa são do provedor.

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum. Estende [[harness ADR-0006 - Protocolo de sessão de agente]].

## Fonte

`harness/docs/ADR-0023-safe-action-recovery.md`.
