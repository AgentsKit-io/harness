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
  - harness/docs/ADR-0037-cost-policy-ceilings-and-levers.md
  - harness/src/loop/budget.ts
  - harness/src/loop/deliver.ts
  - harness/src/loop/config.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0037 - Custo: política, tetos e alavancas

> [!tldr] Em linguagem comum
> O harness não consegue contar o que o CLI de um worker gasta; controla o que decide — quem chama, quantas vezes e com quanto contexto — e escala para humano quando um teto estoura, em vez de repetir com menos folga.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-21).

## A decisão em linguagem comum

- **Política** (`models.routing.policy`): `quality-first` (padrão), `usage-balanced`, `cost-first`; escolhe entre candidatos que o papel já permite, nunca amplia o conjunto.
- **Tetos, todos recusas e não degradações:** `budget.perProvider`, `budget.perIssueTokens`, `delivery.maxDispatchMinutes`, `resilience.maxUsageDeltaPercent` e `delivery.review.maxCalls` com prazo do review.
- **Alavancas:** verificação barata antes da cara (`delivery.verify.argv`, `layers[].verify`); modelo conforme a mudança (`modelForChange`); prefixo cacheável do brief e do contrato; delta por digest (handoff referencia skill pelo hash; se não bate, reenvia tudo); o fluxo decide o que roda (`flows.profiles.<name>.stages` e `.roles`).
- **O que não alega:** não há contagem de tokens dentro da sessão do worker; cache de prompt é uma ordenação que o provedor pode ou não honrar; o backend de memória ainda é o adapter de arquivo, cujo recall é varredura de substring com relevância fixa.

## Contexto

Cada worker é uma sessão opaca; chamadas de modelo e de ferramenta dele nunca chegam ao harness. Todo controle de custo é sobre o que o harness pode decidir mais disjuntores sobre sinais observáveis.

## Consequências

- Política e tetos em `harness/src/loop/budget.ts:36` (`applyRoutingPolicy`), `:64` (`issueSpend`), `:86` (`issueBudget`), `:106` (`modelForChange`); no deliver: teto de duração e de custo em `harness/src/loop/deliver.ts:1353-1383` e escolha do modelo de revisão em `:995-1001`.
- Config: `delivery.maxDispatchMinutes` opcional (`harness/src/loop/config.ts:432`), `resilience.maxUsageDeltaPercent` com padrão 40 (`harness/src/loop/config.ts:623`), `budget.perIssueTokens` padrão 0 (`:650`), `delivery.review.smallChangeLines` padrão 0 (`:394`).
- Toda recusa é ruidosa: escalação com motivo, nunca queda silenciosa para um modelo mais barato num caminho crítico.

## Pacotes afetados

[[harness-loop]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0037-cost-policy-ceilings-and-levers.md`.
