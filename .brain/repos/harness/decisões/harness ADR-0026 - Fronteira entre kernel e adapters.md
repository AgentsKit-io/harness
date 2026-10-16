---
tipo: adr
repo: harness
camada: ferramenta
visibilidade: publico
status: aceito
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; ADR lido e conferido contra o código e o script de fronteira; nada foi executado"
fontes:
  - harness/docs/ADR-0026-kernel-adapters-boundary.md
  - harness/docs/MODULE-BOUNDARIES.md
  - harness/scripts/verify-dependency-directions.mjs
  - harness/test/boundaries.test.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0026 - Fronteira entre kernel e adapters

> [!tldr] Em linguagem comum
> O núcleo decide e não conhece fornecedor; adapters e plugins falam com o mundo; um script confere as direções de import.

← [[00 Decisões - harness]]

## Status e datas

Aceito, aprovado pelo dono em 2026-09-10 (`harness/docs/ADR-0026-kernel-adapters-boundary.md:5`).

## A decisão em linguagem comum

Quatro classes: **kernel** (contratos e decisões determinísticas), **execução** (filesystem, git, processos, logs, evidência, CLI), **adapters/plugins** (Doc Bridge, Orca, Linear/GitHub, LLM, memória, MCP) e **composição** (`src/index.ts` e `src/cli.ts`). Consumidores não podem usar caminhos privados. Falha de provedor, evidência ausente, fonte velha ou ambiguidade de produto nunca viram "passou" por obra de um adapter.

## Contexto

O objetivo da versão 0.4.0 era um motor modular que aceitasse orquestradores, documentação, trackers, memória, modelos, MCP e pontes de evento sem tornar o núcleo específico de provedor.

## Consequências

- A regra é verificada por `findDependencyViolations`: kernel não importa `adapters` (nem, em import de valor, `execution`/`context`/`delivery`/`profiles`); `adapters` não importam `execution` e vice-versa (`harness/scripts/verify-dependency-directions.mjs:40-42`); o teste está em `harness/test/boundaries.test.ts:7`.
- `src/loop` e `src/ui` caem na área "root" do script (`harness/scripts/verify-dependency-directions.mjs:23`), ou seja, o script não restringe quem eles importam.
- O ADR lista decisões deixadas ao dono (classificação de módulos, binding do piloto, limiares de eval, coorte sem harness, onde moram MCP e pontes futuras).
- Texto do inventário (`MODULE-BOUNDARIES.md`) diz que o kernel só usa stdlib; hoje alguns módulos do kernel importam `@agentskit/core` (`harness/src/kernel/hash.ts:1`, `harness/src/kernel/tokens.ts:1`) e `@agentskit/cross-platform` (`harness/src/kernel/process-tree.ts:2`), justificado por [[harness ADR-0042 - Hash canônico compartilhado]]. Ver [[Auditoria - harness]].

## Pacotes afetados

[[harness-kernel]], [[harness-adapters]], [[harness-loop]]

## Substitui / substituído por

Nenhum. Reafirmado por [[harness ADR-0028 - MCP só como adapter]] e [[harness ADR-0043 - Fronteira do módulo de estado de entrega]].

## Fonte

`harness/docs/ADR-0026-kernel-adapters-boundary.md`.
