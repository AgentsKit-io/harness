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
  - harness/docs/ADR-0003-doc-bridge-context-binding.md
  - harness/src/adapters/doc-bridge.ts
  - harness/src/context/index.ts
  - harness/src/execution/verification.ts
  - harness/src/cli.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0003 - Contexto do Doc Bridge ligado à execução

> [!tldr] Em linguagem comum
> O harness lê o índice local do [[00 Hub - doc-bridge]], escolhe até oito referências de forma determinística e congela esse contexto, com hash, dentro da execução.

← [[00 Decisões - harness]]

## Status e datas

Aceito. Data no ADR: 2026-08-29 (`harness/docs/ADR-0003-doc-bridge-context-binding.md`).

## A decisão em linguagem comum

`createDocBridgeContextProvider` lê `.doc-bridge/index.json`, busca no corpus de conhecimento e nos registros de `lookup.ownership`, deduplica por caminho (empate resolvido a favor de "ownership"), devolve no máximo oito referências e usa o `contentHash` do índice como procedência. Com `contract.docBridgeMaxAgeHours` > 0, um índice mais velho que o orçamento é rejeitado. `planRun` congela os snapshots em `run.json` com `contextHash` e registra um evento `context.attached` por snapshot. Agentes de shell usam `context resolve` e `plan --context-file`.

## Contexto

Contexto de documentação precisa ser reproduzível e à prova de adulteração sem que o harness importe o Doc Bridge.

## Consequências

- Provedor: `harness/src/adapters/doc-bridge.ts:82`; guarda de idade em `harness/src/adapters/doc-bridge.ts:88-92`; corte de oito em `harness/src/adapters/doc-bridge.ts:109`.
- `planRun` valida os snapshots antes de planejar (`harness/src/execution/verification.ts:82`, `validateContextSnapshots`); o arquivo de contexto passa por `readContextSnapshots` (`harness/src/context/index.ts:85`), que confere o hash.
- CLI: `context resolve` em `harness/src/cli.ts:49` e `plan --context-file` em `harness/src/cli.ts:47`.
- A guarda de idade não prova o conteúdo; a prova exata é o gate de hash do Doc Bridge no CI (`index-freshness`, `harness/.github/workflows/release-harness.yml:69`).

## Pacotes afetados

[[harness-adapters]], [[harness-kernel]]. Relacionado ao repositório [[00 Hub - doc-bridge]].

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0003-doc-bridge-context-binding.md`.
