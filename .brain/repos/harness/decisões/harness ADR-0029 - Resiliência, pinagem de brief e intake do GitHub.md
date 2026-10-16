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
  - harness/docs/ADR-0029-loop-resilience-pinning-intake.md
  - harness/src/loop/contract.ts
  - harness/src/loop/resilience-state.ts
  - harness/src/loop/skills.ts
  - harness/src/loop/tick.ts
  - harness/src/loop/github-intake.ts
  - harness/src/loop/config.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0029 - Resiliência, pinagem de brief e intake do GitHub

> [!tldr] Em linguagem comum
> Depois de um piloto de 7 horas, seis correções: reconhecer limites de uso, pausar itens e estágios que falham sem parar, fixar skills no brief, rodar um comando de preparo no worktree, escolher esforço por papel e revisar PRs de fora via label.

← [[00 Decisões - harness]]

## Status e datas

Aceito, 2026-09-12 (`harness/docs/ADR-0029-loop-resilience-pinning-intake.md:3-4`).

## A decisão em linguagem comum

1. **Classificação de falha:** `classifyProviderFailure` reconhece frases reais de limite de uso (Claude, Codex, Grok) e `extractResetsAt` lê o horário de reset; a revisão incompleta marca em cooldown o ID do **revisor** (`ctx.reviewer.provider`), não o ID de transporte do CLI de review.
2. **Auto-pausa:** `resilience.maxConsecutiveFailures` (padrão 3) pausa a issue, com comentário deduplicado e o label `resilience.pausedLabel`; `resilience.stagePauseAfterRuns` pausa um estágio que lança erro repetidamente.
3. **Skills pinadas:** `brief.skills` lê arquivos Markdown uma vez no despacho, calcula sha256, trunca em `brief.maxSkillChars` e falha fechado se o arquivo faltar.
4. **Comando de preparo:** `project.setup.command` (argv, sem shell) roda uma vez no worktree novo antes do terminal; `required` (padrão `true`) faz a falha virar falha de despacho.
5. **Esforço por papel:** `models.effort.<role>` só se aplica a provedor que declara `effortFlag`.
6. **Intake por label:** `github.intakeLabel` manda o loop revisar um PR que ele não despachou (`pr-<n>`); todo "cutucão" vira comentário e `github.reviewOnly` é fixo em `true` — o loop nunca mergeia esse PR.

## Contexto

O piloto de 11–12/09 expôs 19 retentativas de `contract.failed` sem classificação em 4 issues e 12 revisões incompletas em 7 h, sem teto algum; uma comparação com um clone open-source de um sistema de agentes de background sugeriu ideias transferíveis.

## Consequências

- Classificação em `harness/src/loop/contract.ts:337` e `:350`; contadores e pausa em `harness/src/loop/resilience-state.ts:56`, `:77`, `:159`; skills em `harness/src/loop/skills.ts:25`; preparo do worktree em `harness/src/loop/tick.ts:971-984`; intake em `harness/src/loop/github-intake.ts:48` e `harness/src/loop/deliver.ts:1509-1537`; `reviewOnly: z.literal(true)` em `harness/src/loop/config.ts:576`.
- Nova superfície de CLI: `loop resume` e `loop paused`; `loop doctor` ganhou a checagem `brief.skills`.
- Fora de escopo: plano de controle remoto, worktrees remotos, snapshots e bots de Slack/GitHub App.

## Pacotes afetados

[[harness-loop]], [[harness-adapters]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0029-loop-resilience-pinning-intake.md`.
