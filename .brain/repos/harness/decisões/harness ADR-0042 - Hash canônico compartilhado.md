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
  - harness/docs/ADR-0042-shared-canonical-hashing.md
  - harness/src/kernel/hash.ts
  - harness/package.json
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0042 - Hash canônico compartilhado

> [!tldr] Em linguagem comum
> Impressões digitais de objetos passam a usar o JSON canônico (RFC 8785) do `@agentskit/core`, para que a ordem das chaves não mude o hash; os hashes antigos continuam sendo aceitos.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-29).

## A decisão em linguagem comum

SHA-256 e JSON canônico vêm de `@agentskit/core/hash`. Fingerprints novos de artefatos, eventos, status, manifestos e pacotes de evidência usam JSON canônico; leitores aceitam tanto o hash canônico quanto o antigo (`JSON.stringify`). Chaves de identidade persistidas e o `artifactDigest` existente mantêm o algoritmo antigo até haver uma migração versionada de estado.

## Contexto

O harness duplicava SHA-256 e hash de JSON, e `JSON.stringify` preserva a ordem de inserção das chaves — objetos equivalentes davam fingerprints diferentes — enquanto estado e pacotes assinados já continham hashes de versões antigas.

## Consequências

- `harness/src/kernel/hash.ts:1` importa `canonicalJson` e `sha256Hex` de `@agentskit/core/hash`; `hashCanonicalJson` em `:15` e `hashJsonMatches` (aceita os dois formatos) em `:18`; `hashJson` legado em `:8`.
- `@agentskit/core` vira dependência de runtime (`harness/package.json`, `dependencies`).
- O caminho legado de hash deve sair depois da migração de estado.
- Origem do upstream: ver [[00 Hub - agentskit]] (`agentskit-core`).

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0042-shared-canonical-hashing.md`.
