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
  - harness/docs/ADR-0034-connectors-tracker-scm-runner.md
  - harness/src/loop/connectors.ts
  - harness/src/loop/runner-connector.ts
  - harness/src/loop/config.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0034 - Conectores de tracker, SCM e runner

> [!tldr] Em linguagem comum
> O loop fala com o tracker, o GitHub e o executor por três interfaces estreitas; só se confia numa interface depois de existir uma segunda implementação.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-21).

## A decisão em linguagem comum

Três costuras: **tracker** (fila, detalhe, transições, comentários), **SCM** (PRs, checks, comentários, labels, merge) e **runner** (onde o trabalho roda). `resolveConnectors` escolhe tracker e SCM em `connectors.*`; `createRunnerConnector` escolhe o runner. "Uma costura só é provada por uma segunda implementação": na época, só o runner tinha duas (`orca` e `local`), e tracker/SCM eram risco aberto. Valor desconhecido falha fechado nomeando a interface a implementar.

## Contexto

O loop foi escrito contra Linear, GitHub e Orca; chamar esses CLIs direto de `tick`, `deliver` e `release` fazia cada arquivo conhecer um fornecedor.

## Consequências

- Interfaces em `harness/src/loop/connectors.ts:26` (`TrackerConnector`) e `:48` (`ScmConnector`); seleção em `:277`; runner em `harness/src/loop/runner-connector.ts:24` e `:141`.
- **Estado atual difere do texto do ADR:** o tracker agora aceita `linear` e `github` (`harness/src/loop/config.ts:698`, fábrica `createGitHubTracker` em `harness/src/loop/connectors.ts:147`), então a costura de tracker já tem duas implementações; o SCM segue só com `github` (`harness/src/loop/config.ts:699`).
- **O runner `local` não está ligado**: o esquema ainda lista `'local'` (`harness/src/loop/config.ts:701`), mas a validação o rejeita (`harness/src/loop/config.ts:1093`); veja [[harness ADR-0039 - Piso de auto-merge e runner local não ligado]].
- Estágios testáveis com fakes simples; custo: uma indireção entre o estágio e o CLI.

## Pacotes afetados

[[harness-loop]], [[harness-adapters]]

## Substitui / substituído por

Parcialmente atualizado pelo ADR-0039 (runner local). O trecho "tracker só `linear`" ficou desatualizado pelo código (ver [[Auditoria - harness]]).

## Fonte

`harness/docs/ADR-0034-connectors-tracker-scm-runner.md`.
