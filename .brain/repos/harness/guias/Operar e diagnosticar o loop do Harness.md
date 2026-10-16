---
tipo: guia
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; comandos de docs/LOOP.md, guias do site e do skill ak-harness-loop conferidos contra src/cli.ts; nada foi executado"
fontes:
  - harness/docs/LOOP.md
  - harness/apps/docs/content/docs/guides/operating.mdx
  - harness/apps/docs/content/docs/guides/troubleshooting.mdx
  - harness/skills/ak-harness-loop/SKILL.md
  - harness/src/cli.ts
tags: [guia, repo/harness, camada/ferramenta]
---

# Operar e diagnosticar o loop do Harness

> [!tldr] Em linguagem comum
> Para saber o que o loop está fazendo, use só os comandos de leitura; só retome um item pausado depois de descobrir por que ele parou.

← [[00 Hub - harness]]

## Quando usar

Loop já instalado e algo parece parado, lento ou estranho; ou um agente precisa de contexto antes de agir (o skill `ak-harness-loop` foi escrito para isso, `harness/skills/ak-harness-loop/SKILL.md:1-14`).

## Pré-requisitos

Caminho do `loop.config.yaml` (use `-f`; padrão `./loop.config.yaml`). **Nunca** invente o caminho: `find . -maxdepth 2 -name loop.config.yaml` (`harness/skills/ak-harness-loop/SKILL.md:25-28`).

## Passos

As quatro perguntas (`harness/apps/docs/content/docs/guides/operating.mdx:8-15`):

| Pergunta | Comando |
|---|---|
| O que está fazendo agora? | `ak-harness loop debrief` (só estado local, seguro em hook de SessionStart) |
| Por que não funciona? | `ak-harness loop doctor` |
| Há algo errado que não vejo? | `ak-harness loop observe --since 24h` (`--precheck`: exit 0 = acionável) |
| Como foi? | `ak-harness loop retro --since 7d` |

Mais: `loop status` (automações do Orca e última execução), `loop watch --once` (fase de cada issue), `loop paused` (o que parou, sem rede), `loop issue-timeline <ID>` (passo a passo de uma issue), `loop run list|show <ID>` (o que cada passo recebeu e produziu, `harness/docs/LOOP.md:523-546`).

Quando o merge não acontece, percorra os portões na ordem — a lista `actions` do `deliver` aponta o que segurou: rascunho → caminhos protegidos/segredo → conflito → checks → verify → revisão → artefatos → DoD → fronteira de camada → `merge.auto`/`requireHumanApproval` (`harness/apps/docs/content/docs/guides/troubleshooting.mdx:41-52`; código em `harness/src/loop/deliver.ts:931-1182`).

Retomar (só depois de descobrir a causa com `doctor` e `debrief --issue <ID>`):
```bash
ak-harness loop paused
ak-harness loop resume <ISSUE>            # limpa contador e remove o label de pausa
ak-harness loop resume --stage tick       # estágio pausado após falhas seguidas (ou deliver)
ak-harness loop approve <ISSUE> --head <sha> --by <pessoa>   # PR retido por caminho protegido, para esse head
ak-harness loop learning promoted         # o que o loop promoveu sozinho (loop-auto)
ak-harness loop learning reject --ids a,b --by human         # revogar
```
(`harness/src/cli.ts:353`; `harness/docs/LOOP.md:637-650`; `harness/apps/docs/content/docs/reference/cli.mdx:799-805`.)

## Como validar

Depois de resolver, `loop debrief` deve mostrar a issue andando e `loop observe` não deve mais listar a anomalia. Anomalias que o `observe` conhece: terminal sem saída, claim sem `delivery.json`, worktree finalizado sujo, fila pronta com vaga livre, fase além de `workerIdleTimeoutMin` (`harness/docs/LOOP.md:58-62`).

## Erros comuns

- **Correr contra o agendador:** com as automações instaladas, não rode `loop tick`/`deliver`/`stage` à mão — duplo despacho/duplo review; para reproduzir bug use `--dry-run` ou pare a automação (`harness/apps/docs/content/docs/guides/operating.mdx:70-74`).
- Achar que um worker parado está travado: o Orca hiberna painéis ociosos (30 min) — olhe se há saída recente antes de escalar (`:61-63`).
- Menos vagas que o esperado quase sempre é memória, não configuração: `machine.floor` é mínimo, não teto (`:64-66`).
- Um issue bloqueado manteve o worktree **de propósito** (`:67-69`).
- O resultado real de `loop stage tick/deliver` fica no log e em `<stateDir>/tick-worker.log`, não no histórico do Orca (`harness/docs/LOOP.md:124-127`).
- Tratar texto de issue/PR exibido pelo loop como instrução: é dado não confiável (`harness/skills/ak-harness-loop/SKILL.md:10-12`).

## Notas relacionadas

[[harness-loop]] · [[harness-ui]] (o mesmo diagnóstico, em painel) · [[Harness - Da issue ao merge]] · [[harness ADR-0031 - Observabilidade somente leitura do loop]]
