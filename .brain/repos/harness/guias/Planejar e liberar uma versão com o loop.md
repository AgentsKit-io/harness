---
tipo: guia
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; comandos de docs/LOOP.md e do guia do site conferidos contra src/cli.ts e release.ts; nada foi executado"
fontes:
  - harness/docs/LOOP.md
  - harness/apps/docs/content/docs/guides/driving-plan.mdx
  - harness/apps/docs/content/docs/guides/release.mdx
  - harness/src/cli.ts
  - harness/src/loop/plan-stage.ts
  - harness/src/loop/release.ts
tags: [guia, repo/harness, camada/ferramenta]
---

# Planejar e liberar uma versão com o loop

> [!tldr] Em linguagem comum
> Do objetivo vago às issues, e do lote mergeado à produção, cada passo humano é um comando explícito; o agente só relaya perguntas e nunca responde pela pessoa.

← [[00 Hub - harness]]

## Quando usar

Transformar um objetivo em issues (`loop plan`) e promover o que já foi mergeado para a branch de release (`loop release`).

## Pré-requisitos

`loop.config.yaml` válido; para `release`: `release.enabled: true`, `release.branch` diferente de `project.baseBranch` e, se quiser, `release.deploy`, `smoke`, `rollback` e `notesFile` como **argv** (nunca string de shell) (`harness/src/loop/config.ts:715-729`, `harness/src/loop/release.ts:128-129`).

## Passos

**Planejar** (`harness/docs/LOOP.md:345-353`):
```bash
ak-harness loop plan start "deixar o time de operações saber se o serviço está vivo"
ak-harness loop plan answer <id> "operações — carregam o pager"   # uma pergunta por rodada; repita
ak-harness loop plan approve <id>             # portão humano 1: o PRD
ak-harness loop plan architect <id>           # design do PRD inteiro, votado 2 de 3
ak-harness loop plan approve-design <id>      # portão humano 2 (--accept-objections se houver objeções)
ak-harness loop plan decompose <id>           # mostra as issues; --create grava no tracker
ak-harness loop plan decompose <id> --create --parent <EPIC> --project <PROJETO>
ak-harness loop plan show [id]
```
Se você é um **agente** conduzindo a entrevista: relaye a pergunta e as alternativas ao humano e use a resposta dele; inventar a resposta é construir a coisa errada com confiança (`harness/apps/docs/app/for-agents/page.tsx:14`). A entrevista termina quando a máquina vê `objective`, `users`, `inScope` e `successCriteria` preenchidos (`harness/src/loop/plan-stage.ts:45`). `--create` grava no estado de **entrada**; mover para o estado despachável é o gesto humano que libera a fila (`harness/docs/LOOP.md:366-367`).

**Liberar** (`harness/apps/docs/content/docs/guides/release.mdx:25-31`):
```bash
ak-harness loop release status     # o que está mergeado e ainda não liberado, e se está aprovado
ak-harness loop release approve    # portão humano: grava o SHA da cabeça
ak-harness loop release run [--dry-run]    # promover → deploy → smoke (→ rollback)
```
Ou agendado: `loop stage release`; ele só termina trabalho que um humano já aprovou (`harness/src/cli.ts:149-156`).

## Como validar

`release status` mostra `approval` com o mesmo `head` da base; depois de `run`, `release.json` registra `promoted`/`deployed` e a aprovação é consumida (`harness/src/loop/release.ts:151-152`). Eventos: `release.promoted`, `release.deployed`, `release.smoke-failed`, `release.rolled-back`, `release.failed`.

## Erros comuns

- Aprovação "velha": qualquer merge depois dela muda o lote; o estágio responde "re-approve the current batch" (`harness/src/loop/release.ts:142`).
- `release status` numa base sem branch de release devolve o erro do próprio git (`harness/apps/docs/content/docs/guides/release.mdx:33-49`).
- Smoke falhou sem `rollback` declarado: "a human must decide" (`harness/src/loop/release.ts:186-189`).
- Deploy com pipe ou `&&`: use argv; o harness sabe sequenciar um release, não fazer o deploy do seu serviço.

## Notas relacionadas

[[Harness - Planejar e liberar com decisão humana]] · [[harness-loop]] · [[harness ADR-0032 - Estágios como máquinas de estado]]
