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
  - harness/docs/ADR-0028-mcp-adapter-boundary.md
  - harness/src/adapters/mcp.ts
  - harness/src/loop/doctor.ts
  - harness/src/loop/config.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0028 - MCP só como adapter

> [!tldr] Em linguagem comum
> O harness tem uma ponte para ferramentas MCP que nega tudo por padrão e só chama o que está na lista permitida e aprovado pela política; o loop não a usa para trabalhar.

← [[00 Decisões - harness]]

## Status e datas

Aceito, 2026-09-11 (`harness/docs/ADR-0028-mcp-adapter-boundary.md:5`).

## A decisão em linguagem comum

MCP fica em `src/adapters/mcp.ts`; o kernel não importa clientes, hosts ou transportes MCP. Toda chamada passa por uma allowlist (`allowTools`) e por um `PolicyGate`; faltando entrada ou decisão diferente de `allow`, o retorno é `{ status: 'blocked' }` sem tocar a chamada. A primeira superfície é de leitura/inspeção; ferramentas que mutam exigem ADR futuro. O padrão do loop é `mcp.enabled: false`, e nada inicia MCP em install, tick ou deliver.

## Contexto

MCP é uma superfície útil de integração, mas kernel e loop precisam funcionar sem host, SDK ou rede.

## Consequências

- Ponte: `harness/src/adapters/mcp.ts:40` (`createMcpToolBridge`); bloqueio por allowlist em `harness/src/adapters/mcp.ts:52-54`; política em `:59-65`.
- Único uso dentro do pacote: o `doctor` constrói a ponte com `call: async () => null` só para autoteste da fiação (`harness/src/loop/doctor.ts:205-219`); não é teste de conectividade real.
- Bloco de config `mcp` em `harness/src/loop/config.ts:555`.
- Alternativas rejeitadas: host MCP no kernel e ligar MCP em tick/deliver já na 0.6.0.

## Pacotes afetados

[[harness-adapters]], [[harness-loop]] (doctor)

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0028-mcp-adapter-boundary.md`.
