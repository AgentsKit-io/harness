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
  - harness/docs/ADR-0001-extensible-kernel.md
  - harness/src/kernel/plugins.ts
  - harness/src/kernel/events.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0001 - Núcleo extensível com eventos append-only

> [!tldr] Em linguagem comum
> As garantias de "terminei de verdade" ficam no núcleo; tudo opcional entra por plugins tipados, e cada execução deixa um diário que só cresce.

← [[00 Decisões - harness]]

## Status e datas

Aceito. Data no próprio ADR: 2026-08-29 (`harness/docs/ADR-0001-extensible-kernel.md:4`).

## A decisão em linguagem comum

Contrato, transições de estado, validação de evidência, vínculo com a revisão do código, regras de "evidência velha" e aprovações ficam no núcleo. Integrações opcionais (Doc Bridge, trackers, navegadores) entram por um registro de plugins em memória, com versão de API e dependências declaradas. Os fatos do ciclo de vida são gravados em NDJSON append-only por execução; `run.json` continua como projeção compatível.

## Contexto

O harness precisa funcionar com agentes, repositórios e trackers diferentes sem mover a garantia de conclusão para integrações opcionais. Um resumo mutável sozinho não explica retentativas nem evidência velha.

## Consequências

- O registro de plugins vive em `harness/src/kernel/plugins.ts:57` (`createPluginRegistry`); o log vive em `harness/src/kernel/events.ts:229` (`FileEventStore`), com os tipos de evento em `harness/src/kernel/events.ts:13` (`HARNESS_EVENT_TYPES`).
- Um plugin não aprova execução nem contorna a validação de evidência (restrição do ADR).
- Sem instalação remota de plugins, hot reload ou marketplace; o barramento do loop (`loop/event-bus.ts`) é outra coisa: ver [[harness ADR-0030 - Barramento de eventos e hooks de orquestração]].

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0001-extensible-kernel.md`.
