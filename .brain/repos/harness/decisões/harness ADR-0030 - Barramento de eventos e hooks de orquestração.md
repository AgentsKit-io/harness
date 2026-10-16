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
  - harness/docs/ADR-0030-loop-event-bus-orchestration-hooks.md
  - harness/src/loop/event-bus.ts
  - harness/src/loop/tick.ts
  - harness/src/loop/deliver.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0030 - Barramento de eventos e hooks de orquestração

> [!tldr] Em linguagem comum
> Plugins locais podem reagir aos eventos do loop em tempo real e vetar despacho, revisão ou merge — mas não conseguem interferir dentro da sessão do worker, que é opaca.

← [[00 Decisões - harness]]

## Status e datas

Aceito, 2026-09-12 (`harness/docs/ADR-0030-loop-event-bus-orchestration-hooks.md:3-4`).

## A decisão em linguagem comum

`src/loop/event-bus.ts` é um pub/sub local sobre o vocabulário de eventos do loop mais oito hooks de ciclo de vida: `beforeDispatch`, `afterDispatch`, `beforeReview`, `afterReview`, `beforeMerge`, `afterMerge`, `onPause`, `onEscalate`. Um hook `before*` pode devolver `{ block: true, reason }` para impedir a ação; os demais só notificam. Um listener que lança erro é engolido; `plugins.modules` lista arquivos `.mjs` locais, relativos a `project.root`, carregados no início de tick/deliver; `appendLoopEvent` ganhou um terceiro parâmetro `bus`; `loop doctor` checa os módulos.

## Contexto

O harness orquestra CLIs de agente como processos opacos; não há laço modelo↔ferramenta para "middleware" estilo LangChain. O que se controla de ponta a ponta é a orquestração em volta (despachar, agir sobre a revisão, mergear).

## Consequências

- Barramento em `harness/src/loop/event-bus.ts:44`, `runHook` em `:65-77`, carga de plugins em `:90`. Diferente do código original do ADR, um hook `before*` que **lança** passa a **bloquear** (falha fechada): `harness/src/loop/event-bus.ts:73` e comentário em `:21-22` — o ADR diz que erros são só engolidos. Ver [[Auditoria - harness]].
- `appendLoopEvent` aceita `bus` em `harness/src/loop/tick.ts:395`; uso nos hooks em `harness/src/loop/tick.ts:951` e `harness/src/loop/deliver.ts:1035,1175`.
- Habilita o gate de aprovação humana (`delivery.merge.requireHumanApproval`) e o scanner de PII como consumidores do barramento, sem mecanismo próprio.
- Não entregue: gancho no laço do worker, barramento distribuído (webhook/broker) e carga de módulos de fora do repositório local.
- Não usa o registro de plugins do kernel ([[harness ADR-0001 - Núcleo extensível com eventos append-only]]) de propósito: o vocabulário do loop é um conjunto aberto de strings da composição.

## Pacotes afetados

[[harness-loop]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0030-loop-event-bus-orchestration-hooks.md`.
