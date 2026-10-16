---
tipo: pacote
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 724aa82
npm: "@agentskit/harness"
metodo: análise estática; nada foi executado
fontes:
  - harness/src/index.ts
  - harness/src/kernel/state-machine.ts
  - harness/src/kernel/constants.ts
  - harness/package.json
tags: [pacote, repo/harness]
---

# harness-kernel

> [!tldr] Em linguagem comum
> É o fiscal do contrato: registra o que foi pedido, as provas e a decisão humana antes de considerar o trabalho encerrado.

← [[00 Hub - harness]]

## Papel e contrato

Biblioteca exportada pela raiz @agentskit/harness: contratos tipados, transições legais, políticas, eventos, artefatos, capacidades e runtimes. Aprovação exige ator humano; evidência não equivale a aprovação.

| Relação | Quem / como |
|---|---|
| Quem usa e dependências | CLI ak-harness/ak-verify e [[harness-loop]]; usa [[agentskit-core]], Zod e adaptadores do próprio repo. |
| Dados lidos e gravados | Lê contrato/configuração; persiste execuções, eventos e artefatos locais. Runtimes de processo e Docker são opções, não prova de que estão ativos em um consumidor. |

> [!info]- Detalhe técnico
> - `harness/src/index.ts:1`.
> - `harness/src/kernel/state-machine.ts:1`.
> - `harness/src/kernel/constants.ts:1`.
> - `harness/package.json:1`.
