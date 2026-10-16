---
tipo: pacote
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 724aa82
metodo: análise estática; nada foi executado
fontes:
  - harness/src/loop/index.ts
  - harness/src/loop/runner-connector.ts
  - harness/src/loop/deliver.ts
  - harness/src/loop/artifacts.ts
  - harness/src/loop/connectors.ts
tags: [pacote, repo/harness]
---

# harness-loop

> [!tldr] Em linguagem comum
> É a esteira que transforma uma issue em trabalho de agente, revisão e entrega, guardando provas em cada passagem.

← [[00 Hub - harness]]

## Papel e contrato

Expõe tick, deliver, plan, release, doctor, debrief e observação. Congela contrato, limita capacidade e orçamento, cria worktree e exige plano, verificação e definição de pronto antes do merge.

| Relação | Quem / como |
|---|---|
| Quem usa e dependências | Usa [[harness-kernel]], [[00 Hub - code-review]], [[00 Hub - doc-bridge]], GitHub/Linear e runners Orca ou local (git/tmux/crontab). A integração direta com fleet não está demonstrada pelos conectores lidos. |
| Dados lidos e gravados | Lê loop.config.yaml e camadas de configuração; grava .ak-loop/ com contratos, dispatches, eventos, estados de entrega e provas. Pode alterar tracker, PR e merge conforme política. |

> [!info]- Detalhe técnico
> - `harness/src/loop/index.ts:1`.
> - `harness/src/loop/runner-connector.ts:19`.
> - `harness/src/loop/deliver.ts:1300`.
> - `harness/src/loop/artifacts.ts:1`.
> - `harness/src/loop/connectors.ts:1`.
