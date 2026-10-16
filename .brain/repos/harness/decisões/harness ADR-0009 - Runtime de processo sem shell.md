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
  - harness/docs/ADR-0009-process-runtime-boundary.md
  - harness/src/execution/runtime.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0009 - Runtime de processo sem shell

> [!tldr] Em linguagem comum
> Ferramentas que precisam de mais controle rodam como processo filho com executável, argumentos e ambiente fixos, com tempo e saída limitados.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

`createProcessToolRuntime` define cada ferramenta com executável fixo, lista de argumentos, diretório opcional e ambiente explícito. Envia um pedido JSON pela stdin, mata filhos que estouram o tempo ou a saída e devolve só o hash do stdout ou metadados de falha. Recuperar fecha a ação com falha e exige uma nova ação aprovada por política: nada é reexecutado automaticamente.

## Contexto

Um handler em processo não pode ser morto se ignorar o abort e não isola código não confiável.

## Consequências

- Implementação: `harness/src/execution/runtime.ts:186`; filho criado por `spawnNodeChild` (`harness/src/execution/runtime.ts:217`), sem string de shell; timeout mata com SIGKILL (`harness/src/execution/runtime.ts:223`) e saída acima do limite também (`harness/src/execution/runtime.ts:225`).
- O runtime se declara `isolation: 'none'` (`harness/src/execution/runtime.ts:201`): é fronteira de processo, não sandbox.
- Nuance sobre o texto do ADR: ele fala em `spawn` com `shell: false`; hoje o código usa `spawnNodeChild` de `@agentskit/cross-platform` (`harness/src/execution/runtime.ts:2`), mantendo a ausência de shell mas resolvendo shims `.cmd` no Windows (comentário em `harness/src/execution/runtime.ts:214-216`). Ver [[Auditoria - harness]].

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum. Estendido por [[harness ADR-0010 - Runtime Docker opcional]].

## Fonte

`harness/docs/ADR-0009-process-runtime-boundary.md`.
