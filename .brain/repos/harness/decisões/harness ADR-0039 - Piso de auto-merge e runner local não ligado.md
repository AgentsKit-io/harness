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
  - harness/docs/ADR-0039-gate-floor-and-the-unwired-local-runner.md
  - harness/src/loop/deliver.ts
  - harness/src/loop/config.ts
  - harness/src/loop/runner-connector.ts
  - harness/src/ui/api/server.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0039 - Piso de auto-merge e runner local não ligado

> [!tldr] Em linguagem comum
> Mesmo com todos os interruptores desligados, o loop não faz auto-merge se nada examinou a mudança; e `connectors.runner: local` passou a ser recusado porque nunca foi ligado.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-22).

## A decisão em linguagem comum

**Piso sob o auto-merge:** pelo menos um portão precisa ter examinado o diff — CI (com `merge.requireChecks` e checks verdes), a revisão, a verificação do projeto ou a definição de pronto. Se a lista está vazia, o PR fica `held` com a razão "nothing examined this change". Nenhum interruptor foi removido; sumiu só a combinação em que nada leu o diff. Quem quer isso usa `merge.auto: false` e mergeia à mão.

**Runner local recusado:** `connectors.runner: "local"` falha no carregamento da configuração. A implementação `createLocalRunner` e seus testes ficam; ligá-la depois deve ser troca de chamador, não reescrita. A sonda `runner.local` do `doctor` foi apagada. O auto-aprovador do CI (`plan approved --by human`) continua, anotado, porque `assertHuman` não aceita máquina.

## Contexto

Uma revisão pré-publicação perguntou o que ainda impediria um merge ruim com todos os interruptores desligados; a resposta era "nada", e dois lugares afirmavam o contrário. Separadamente, `local` era aceito mas `tick`/`deliver`/`install` continuavam chamando o Orca, e o `doctor` ainda reportava `runner.local: passed`.

## Consequências

- Piso em `harness/src/loop/deliver.ts:1150-1156` (lista `vouchedBy`; `held` em `:1155`); recusa de `local` em `harness/src/loop/config.ts:1093`.
- Quem usava um fluxo que desligou tudo passa a ver PRs retidos em vez de merges sem leitura — quebra intencional.
- O piso conta portões que **rodaram**, não que foram profundos: CI de um job vazio passa o piso.
- Observação: o ADR cita `ci.yml`; o workflow real chama-se `release-harness.yml` (ver [[Auditoria - harness]]), e o cálculo da lista só soma "a revisão" quando a revisão foi executada *nesta* passagem (`harness/src/loop/deliver.ts:1150`).
- A UI ainda chama `createRunnerConnector` para observar workspaces (`harness/src/ui/api/server.ts:266`), o que sempre resolve para o runner do Orca enquanto `local` é recusado.

> [!question] Dúvida
> Quando a revisão limpa é reaproveitada de uma passagem anterior (`prior` com status limpo), `review` fica `null` e "a revisão" não entra em `vouchedBy` (`harness/src/loop/deliver.ts:983,1150`). Com CI desligado e sem verify/DoD isso seguraria o PR por "nada examinou", mesmo havendo revisão limpa registrada. Não foi executado; confirmar com o mantenedor se é intencional.

## Pacotes afetados

[[harness-loop]], [[harness-ui]]

## Substitui / substituído por

Atualiza [[harness ADR-0034 - Conectores de tracker SCM e runner]] quanto ao runner `local`.

## Fonte

`harness/docs/ADR-0039-gate-floor-and-the-unwired-local-runner.md`.
