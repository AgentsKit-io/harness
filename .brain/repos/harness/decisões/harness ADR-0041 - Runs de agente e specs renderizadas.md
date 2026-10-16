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
  - harness/docs/ADR-0041-agent-runs-and-rendered-specs.md
  - harness/src/loop/agent-runs.ts
  - harness/src/loop/spec.ts
  - harness/src/loop/deliver.ts
  - harness/src/loop/tick.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0041 - Runs de agente e specs renderizadas

> [!tldr] Em linguagem comum
> Cada issue ganha um diretório de run com o que cada passo recebeu e produziu, e o PR carrega uma especificação renderizada a partir do contrato — sem modelo escrevendo nenhum dos dois.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-26).

## A decisão em linguagem comum

**Uma issue, uma run:** `<stateDir>/runs/<issue>-<n>/` com `state.json` (projeção dos eventos da issue), `inputs/`, `outputs/`, `handoffs/` (escritos pela máquina a cada mudança de estágio) e `evidence/index.json` (arquivos de prova ligados por sha256). Nada ali é fonte de verdade: `issues/<id>/` e `events.ndjson` seguem mandando; gravar é best-effort e nunca derruba o estágio. Tudo que o harness vê passa por `scanForPii` antes; conteúdo idêntico é guardado uma vez por run; `runs.keep` (3) e `runs.maxAgeDays` (30) limitam o diretório, podado no início de cada tick, e a run aberta nunca é podada.

**Specs são renderizadas, não escritas:** com `spec.enabled`, o despacho renderiza `requirements.md`, `design.md` e `tasks.md` (layout Spec Kit/Kiro) a partir do contrato congelado e do plano aprovado; ids de requisito são os ids de resultado do contrato. O worker comita os arquivos sem mudança e o `deliver` manda um fix round se faltarem, não forem commitados ou divergirem.

**O PR carrega a run:** com `runs.prSummary` o `deliver` mantém um comentário no PR, achado por marcador e editado no lugar.

## Contexto

O caminho de uma issue podia ser reconstruído do log de eventos (ADR-0032), mas o *conteúdo* — prompt do orquestrador, plano, brief, artefatos — estava espalhado ou perdido quando o worktree sumia; e o revisor via diff e DoD, não a especificação contra a qual o código foi feito.

## Consequências

- Gravação por evento em `harness/src/loop/agent-runs.ts:295` (`recordRunEvent`), E/S em `:326`, poda em `:380`, classificação em `:171`; chamada a cada evento em `harness/src/loop/tick.ts:418`; poda no tick em `harness/src/loop/tick.ts:577`.
- Specs: `renderSpec` em `harness/src/loop/spec.ts:37`, `checkSpec` em `:117`; conferência no merge em `harness/src/loop/deliver.ts:1099-1119`; comentário vivo em `harness/src/loop/deliver.ts:1493-1507`.
- CLI: `loop run list|show` (`harness/src/cli.ts:387`).
- Specs ficam desligadas por padrão: acrescentam arquivos a todo PR e um novo motivo de fix round.

## Pacotes afetados

[[harness-loop]], [[harness-ui]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0041-agent-runs-and-rendered-specs.md`.
