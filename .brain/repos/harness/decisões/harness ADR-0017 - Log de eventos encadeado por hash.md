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
  - harness/docs/ADR-0017-event-log-integrity.md
  - harness/src/kernel/events.ts
  - harness/src/cli.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0017 - Log de eventos encadeado por hash

> [!tldr] Em linguagem comum
> Cada evento novo carrega o hash do anterior; mexer ou reordenar um registro quebra a corrente e é detectado.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

Eventos novos incluem `previousHash` e `eventHash`; o hash cobre o corpo serializado, inclusive o hash anterior. `FileEventStore.read` valida a corrente e `FileEventStore.verify` devolve `verified` ou `legacy`. Logs antigos sem os campos continuam legíveis, nunca aparecem como verificados, e acrescentar a eles preserva o status `legacy`.

## Contexto

O log já preservava ordem e vínculo com revisão e contrato, mas a edição posterior de um registro passaria despercebida. Revisão corporativa quer um sinal de integridade determinístico sem persistir prompts nem depender de serviço remoto.

## Consequências

- Corrente validada em `harness/src/kernel/events.ts:216-227` (`validateChain`); gênese em `harness/src/kernel/events.ts:12` (`EVENT_LOG_GENESIS`); acréscimo a log legado sem hash em `harness/src/kernel/events.ts:248`; mistura de legado e hash falha (`harness/src/kernel/events.ts:219`).
- CLI: `ak-harness events verify [run-id]` em `harness/src/cli.ts:579`.
- Não é assinatura nem notarização externa: quem reescreve log e consumidor recalcula a corrente. A assinatura entra no pacote de evidência ([[harness ADR-0022 - Pacote de evidência assinado]]).

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0017-event-log-integrity.md`.
