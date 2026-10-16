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
  - harness/docs/ADR-0033-four-config-layers-and-presets.md
  - harness/src/loop/config.ts
  - harness/src/loop/presets.ts
  - harness/src/loop/init.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0033 - Quatro camadas de configuração e presets

> [!tldr] Em linguagem comum
> A configuração vem de quatro arquivos com donos diferentes, mesclados e validados uma vez; o projeto pesa mais que o arquivo pessoal.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-21).

## A decisão em linguagem comum

Quatro camadas mescladas em ordem e validadas como uma só por `composeLoopConfig`: (1) `~/.agentskit/harness.yaml` — pessoa e máquina; (2) `loop.config.yaml` — o projeto, versionado e igual para todos; (3) `loop.config.team.<key>.yaml` — o que diverge por time; (4) `loop.config.local.yaml` — esta máquina, ignorado pelo git. **O projeto pesa mais que a camada global**: uma decisão revisada no repositório não pode ser sobrescrita em silêncio por um padrão pessoal. `loop init` escreve a camada de projeto a partir de cinco presets (`web-app`, `library`, `monorepo`, `data-pipeline`, `mobile`); um preset é só padrão, o que ele já diz não é repetido no arquivo.

## Contexto

Uma pessoa roda o loop em vários repositórios; um repositório é rodado por várias pessoas em máquinas diferentes. Um arquivo só obriga a escolher entre detalhes de máquina no repositório ou decisões de projeto num arquivo pessoal invisível.

## Consequências

- `composeLoopConfig` em `harness/src/loop/config.ts:1183` (o preset entra como camada mais baixa, `:1189-1195`); `loadLoopConfig` em `:1201`; listas de gate que **acumulam** entre camadas e só encolhem com `!entrada` em `:1124-1131`.
- Variáveis: `AK_HARNESS_CONFIG`/`AK_HARNESS_HOME` movem a camada global (`harness/src/loop/config.ts:26-29`), `AK_HARNESS_NO_GLOBAL=1` a desliga (`:32`), `AK_LOOP_TEAM` escolhe o time (`:1173`).
- Presets em `harness/src/loop/presets.ts:11`; `loop validate` imprime a configuração efetiva e as chaves desconhecidas (`harness/src/loop/config.ts:1106`).

## Pacotes afetados

[[harness-loop]], [[harness-ui]] (escreve só a camada pessoal, ver [[harness ADR-0040 - Plano de controle v2]])

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0033-four-config-layers-and-presets.md`.
