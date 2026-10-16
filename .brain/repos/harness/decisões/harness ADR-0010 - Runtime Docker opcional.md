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
  - harness/docs/ADR-0010-docker-sandbox-runtime.md
  - harness/src/execution/runtime.ts
  - harness/package.json
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0010 - Runtime Docker opcional

> [!tldr] Em linguagem comum
> Quando um processo comum não basta, uma ferramenta pode rodar num contêiner Docker sem rede, com sistema de arquivos só de leitura e privilégios cortados.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

`createDockerToolRuntime` é um provedor opcional construído sobre o runtime de processo. Cada ferramenta declara imagem e argv fixos; nunca há shell. Por padrão usa só imagem já em cache, sem rede, raiz somente leitura, sem capabilities Linux, `no-new-privileges`, UID sem privilégio e limites de PIDs, memória, CPU, tempo e saída. Montagens do host só existem se declaradas e são somente leitura por padrão.

## Contexto

O runtime de processo limita a execução mas não isola do host; o núcleo não pode exigir Docker.

## Consequências

- Implementação: `harness/src/execution/runtime.ts:243`; `pull = 'never'` por padrão em `harness/src/execution/runtime.ts:252`; flags de isolamento no `docker run` em `harness/src/execution/runtime.ts:295`.
- Teste que exige Docker de verdade: `pnpm test:docker-runtime` com `HARNESS_REQUIRE_DOCKER=1` (`harness/package.json`, script `test:docker-runtime`).
- Não é VM nem garantia contra daemon comprometido; provedores mais fortes podem implementar a mesma interface `ToolRuntime`.
- Seleção por configuração: `createConfiguredToolRuntime` (`harness/src/execution/runtime.ts:69`). Não há chamador no loop.

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum. Complementado por [[harness ADR-0011 - Atestação de runtime na evidência]].

## Fonte

`harness/docs/ADR-0010-docker-sandbox-runtime.md`.
