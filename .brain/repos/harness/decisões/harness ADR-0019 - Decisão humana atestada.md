---
tipo: adr
repo: harness
camada: ferramenta
visibilidade: publico
status: aceito
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; ADR (com emenda de 2026-09-19) lido e conferido contra o código citado; nada foi executado"
fontes:
  - harness/docs/ADR-0019-human-decision-attestation.md
  - harness/src/execution/verification.ts
  - harness/src/kernel/learning.ts
  - harness/src/loop/retro.ts
  - harness/src/loop/config.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0019 - Decisão humana atestada

> [!tldr] Em linguagem comum
> Toda aprovação ou rejeição humana vira um evento no log encadeado; a emenda de 2026-09-19 permite que o loop promova lições recorrentes por conta própria, sempre rotuladas `loop-auto` e nunca como `human`.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09). Emenda de 2026-09-19 sobre promoção automática de aprendizados (`harness/docs/ADR-0019-human-decision-attestation.md:25`).

## A decisão em linguagem comum

`approval.recorded` e `authorization.recorded` entram no log encadeado com decisão, estado resultante, digest da verificação, revisão de fonte, hash do contrato e ator humano; a autorização de tracking carrega também o alvo. Rejeições também são gravadas. O modo padrão é "escopo do objetivo": uma aprovação cobre o efeito de tracking declarado e emite os dois eventos; `tracking.authorization: "separate"` exige decisão independente. As checagens de frescor e de atestação rodam antes de qualquer decisão.

**Emenda (2026-09-19):** `promoteLearnings` recusava qualquer ator que não fosse `human`. Agora, com `memory.autoPromote.enabled`, a promoção automática é permitida sob três limites — recorrência mínima (`memory.recurrence.minSightings`), teto por execução (`maxPerRun`) e categorias configuradas — e o ator é gravado como `loop-auto`. Aprovar um resultado de verificação e autorizar efeito externo de tracking continuam só humanos.

## Contexto

O resultado da verificação já era atestado, mas a aprovação e a autorização existiam só na projeção mutável `run.json`.

## Consequências

- Eventos em `harness/src/execution/verification.ts:197-199` (`recordDecision`); fluxos de aprovação em `harness/src/execution/verification.ts:232-258`.
- Aprovar exige `assertHuman` (`harness/src/kernel/state-machine.ts:12`).
- Emenda: `LOOP_AUTO_ACTOR` em `harness/src/kernel/learning.ts:58`, regra de atores em `harness/src/kernel/learning.ts:64`, uso no retro em `harness/src/loop/retro.ts:328-333`, bloco de config em `harness/src/loop/config.ts:525`.
- Revogar: `ak-harness loop learning reject --ids … --by human` (mensagem do retro em `harness/src/loop/retro.ts:336`).
- É atestação de auditoria, não assinatura.

## Pacotes afetados

[[harness-kernel]], [[harness-loop]]

## Substitui / substituído por

Nenhum. Base de [[harness ADR-0036 - Automodificação limitada]].

## Fonte

`harness/docs/ADR-0019-human-decision-attestation.md`.
