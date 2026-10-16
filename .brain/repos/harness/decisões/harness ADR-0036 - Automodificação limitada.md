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
  - harness/docs/ADR-0036-bounded-self-modification.md
  - harness/src/kernel/learning.ts
  - harness/src/loop/tuning.ts
  - harness/src/loop/agent-improvement.ts
  - harness/src/loop/retro.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0036 - Automodificação limitada

> [!tldr] Em linguagem comum
> O loop pode mudar exatamente três coisas sobre si mesmo — promover lições, ajustar botões e melhorar um agente instalado — cada uma dentro de limites, medida e reversível, e todas desligadas por padrão.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-21).

## A decisão em linguagem comum

1. **Promover um aprendizado (`memory.autoPromote`)**: lição proposta `recurrence.minSightings` vezes é promovida pelo retro, atribuída a `loop-auto` e nunca a `human`, no máximo `recurrence.maxPerRun` por vez; sempre listável e revogável.
2. **Mover um botão (`tuning`)**: só é auto-ajustável o botão que declara a **métrica** que o justifica — e a mesma métrica o reverte no ciclo seguinte; no máximo `maxChangesPerRetro` botões se movem por retro, dentro da faixa declarada. Nunca ajustáveis: modelos, provedores, gates e branches.
3. **Melhorar um agente instalado (`agents.autoImprove`)**: o retro pode anexar uma nota datada às instruções de um agente em `agents/<id>/` e **só se o eval ainda passar**; sem `agents.evalCommand` nada é adotado; eval falhando restaura o arquivo byte a byte; nunca toca papéis críticos (`architect`, `reviewer`), nunca escreve mais que `agents.maxAutoLines` linhas e nunca publica no registry.

## Contexto

Um loop que roda semanas acumula evidência sobre si; ignorá-la desperdiça, agir livremente sobre ela é como um sistema autônomo se afasta do que os donos combinaram.

## Consequências

- Ator: `harness/src/kernel/learning.ts:58`; promoção no retro: `harness/src/loop/retro.ts:324-333`; plano e aplicação de tuning em `harness/src/loop/tuning.ts:95` e `:144`; papéis críticos em `harness/src/loop/agent-improvement.ts:13`; `improveAgent` em `:157`.
- Tudo desligado por padrão; ligar é decisão do projeto, num arquivo revisável. O custo: o loop melhora devagar e só onde há métrica.

## Pacotes afetados

[[harness-loop]], [[harness-kernel]] (regra de atores de `promoteLearnings`)

## Substitui / substituído por

Nenhum. Depende da emenda de [[harness ADR-0019 - Decisão humana atestada]].

## Fonte

`harness/docs/ADR-0036-bounded-self-modification.md`.
