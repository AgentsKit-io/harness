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
  - harness/docs/ADR-0035-definition-of-done-two-lists.md
  - harness/src/loop/dod.ts
  - harness/src/loop/artifacts.ts
  - harness/src/loop/deliver.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0035 - Definição de pronto em duas listas

> [!tldr] Em linguagem comum
> Para mergear, duas listas precisam estar provadas: a do projeto (igual para toda issue) e a da issue (os resultados do contrato). Não existe item "manual".

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-21).

## A decisão em linguagem comum

Duas listas obrigatórias antes do merge: **do projeto** (`dod.items`: um comando que sai com 0, um arquivo que o PR deve tocar, um padrão que nenhum arquivo alterado pode conter) e **da issue** (os `outcomes` do contrato congelado, cada um com seu check). O worker roda as checagens no seu worktree e grava as provas em `.ak-loop/dod.json` (e o que executou em `.ak-loop/verify.json`). `assessDod` julga as duas listas e a tabela item/veredito/evidência vai para o PR. Item sem prova é **missing** ("prove"), item provado e falhando é **failed** ("conserte"). Algumas checagens o harness decide sozinho pelos arquivos do PR (`file-changed`, `pattern-absent`); `command` nunca, porque o harness não roda comandos do projeto. **Não há tipo `manual`**: o que exige olho humano é `delivery.merge.requireHumanApproval`.

## Contexto

Em loop sem humano na sala, uma lista única obriga a repetir as regras do projeto em cada issue ou a perder os critérios da issue.

## Consequências

- `assessDod` em `harness/src/loop/dod.ts:87`; veredito do harness em `harness/src/loop/dod.ts:61-78`; schema de `verify.json` em `harness/src/loop/artifacts.ts:19`; uso no merge em `harness/src/loop/deliver.ts:1123-1141`.
- Nuance: o termo "manual" ainda existe como tipo de check de um resultado do contrato (`ContractOutcomeSchema`, `harness/src/loop/contract.ts:115`), mas um resultado manual não conta como executável para despachar (`harness/src/loop/contract.ts:157`); a ausência de `manual` vale para `dod.items`.
- Quem adota o loop sem `dod.items` ainda tem a lista da issue aplicada.

## Pacotes afetados

[[harness-loop]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0035-definition-of-done-two-lists.md`.
