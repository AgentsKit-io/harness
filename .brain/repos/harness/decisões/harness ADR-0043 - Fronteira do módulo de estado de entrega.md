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
  - harness/docs/ADR-0043-delivery-state-module-boundary.md
  - harness/src/loop/deliver-state.ts
  - harness/src/loop/deliver.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0043 - Fronteira do módulo de estado de entrega

> [!tldr] Em linguagem comum
> Os tipos e funções que leem e gravam o estado de entrega saíram de `deliver.ts` para um módulo próprio, com as mesmas exportações e sem mudar nenhum formato em disco.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-10-03).

## A decisão em linguagem comum

Tipos de estado de entrega, helpers de leitura/escrita, inventário de despachos e contabilidade de reinícios foram movidos para `src/loop/deliver-state.ts`. `src/loop/deliver.ts` reexporta o que já exportava, então chamadores e a API pública não mudam.

## Contexto

`deliver.ts` misturava a máquina de estado da entrega com a persistência e o inventário que o loop e a UI usam, e essa persistência tem fan-in maior que a máquina em si.

## Consequências

- Funções como `approveHeldDelivery` (`harness/src/loop/deliver-state.ts:79`) e `listDispatched` (`harness/src/loop/deliver-state.ts:93`) vivem no módulo novo; as reexportações estão em `harness/src/loop/deliver.ts:45-46`.
- Formatos serializados e comportamento de execução não mudam; mudanças futuras em qualquer dos módulos ainda exigem as checagens do loop e do pacote.

## Pacotes afetados

[[harness-loop]], [[harness-ui]] (consome `listDispatched`/`readDeliveryState`)

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0043-delivery-state-module-boundary.md`.
