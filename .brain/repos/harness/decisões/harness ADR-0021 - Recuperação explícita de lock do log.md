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
  - harness/docs/ADR-0021-event-lock-recovery.md
  - harness/src/kernel/events.ts
  - harness/src/cli.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0021 - Recuperação explícita de lock do log

> [!tldr] Em linguagem comum
> Um lock órfão do log só é removido por um humano, e apenas se for velho e o processo dono estiver morto.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

Todo lock registra PID do dono e instante de criação. `inspectEventLogLock` mostra o estado e `recoverEventLogLock` só remove o lock quando o ator é `human`, o lock é mais velho que o limite pedido e o processo dono não existe mais. Lock malformado, jovem ou vivo continua falhando fechado. A operação nunca roda no fluxo normal de status, verificação ou append.

## Contexto

Um processo pode terminar depois de adquirir o lock; remover o arquivo automaticamente seria perigoso porque outro escritor pode ainda ser o dono.

## Consequências

- Implementação: `harness/src/kernel/events.ts:277` (`inspectEventLogLock`) e `harness/src/kernel/events.ts:283-296` (`recoverEventLogLock`: ator em `:284`, idade em `:290`, prova de morte com `process.kill(pid, 0)` em `:291-292`).
- CLI: `ak-harness events lock|unlock` em `harness/src/cli.ts:580-581` (limite padrão 300000 ms).
- O PID é evidência de processo local; escritores distribuídos exigiriam coordenação fora deste armazém de arquivos.

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0021-event-lock-recovery.md`.
