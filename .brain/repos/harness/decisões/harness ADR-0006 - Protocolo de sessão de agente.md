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
  - harness/docs/ADR-0006-agent-session-protocol.md
  - harness/src/execution/agent.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0006 - Protocolo de sessão de agente

> [!tldr] Em linguagem comum
> Qualquer agente de código pode ser observado por um gravador de sessão que só guarda hashes e metadados, nunca prompts, argumentos ou resultados brutos.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

Um descritor mínimo `AgentAdapter` e `createSessionRecorder` gravam eventos de sessão, turno e ferramenta no log append-only da execução, rejeitando ordem local inválida. A sessão só começa em `IMPLEMENTING`; com `resume: true` reconstrói ações não terminadas a partir do log e emite `session.resumed`. Uma ação cujo `tool.execution.started` foi persistido fica ambígua e exige decisão humana (ver [[harness ADR-0023 - Recuperação segura de ações ambíguas]]).

## Contexto

Tornar o trabalho do agente observável sem acoplar o núcleo a modelo, runtime ou provedor, e sem transformar prompts e raciocínio em dados persistidos.

## Consequências

- Tipos e fábrica: `harness/src/execution/agent.ts:9` (`AgentAdapter`) e `harness/src/execution/agent.ts:49` (`createSessionRecorder`); o estado exigido está em `harness/src/execution/agent.ts:50`; a retomada em `harness/src/execution/agent.ts:66`.
- O gravador não executa ferramentas nem decide política (ver [[harness ADR-0007 - Política de ferramentas negar por padrão]] e [[harness ADR-0008 - Executor de ações em runtime limitado]]).
- Nenhum chamador dentro do repositório além de testes e da API pública: o loop não usa o gravador de sessão (busca em `src/` só encontra a definição e a exportação).

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0006-agent-session-protocol.md`.
