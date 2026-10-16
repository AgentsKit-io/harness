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
  - harness/docs/ADR-0008-runtime-executor.md
  - harness/src/execution/runtime.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0008 - Executor de ações em runtime limitado

> [!tldr] Em linguagem comum
> Depois que a política permite, uma ação roda num executor com tempo limite, e só o hash do resultado vai para o registro.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

Todo `SessionRecorder` recebe um `ToolRuntime`. O executor embutido despacha para handlers registrados, propaga um `AbortSignal`, aplica timeout, calcula o hash do resultado e devolve falhas estruturadas para ferramenta ausente, exceção e timeout. É um limite de execução, não um sandbox de segurança.

## Contexto

O gate decide se uma ação é permitida, mas faltava um modo portátil de executá-la e fechá-la com evidência reproduzível, sem depender de shell, host MCP, SDK de modelo ou runtime de contêiner.

## Consequências

- Implementação em `harness/src/execution/runtime.ts:146` (`createToolRuntime`).
- Argumentos e resultados ficam só em memória; o log guarda hashes.
- Um handler que ignora o abort não pode ser morto por um runtime em processo — motivo de [[harness ADR-0009 - Runtime de processo sem shell]].

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0008-runtime-executor.md`.
