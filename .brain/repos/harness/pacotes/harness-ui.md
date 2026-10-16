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
  - harness/src/ui/api/server.ts
  - harness/src/ui/api/actions.ts
  - harness/src/ui/api/store.ts
  - harness/src/ui/api/jobs.ts
  - harness/package.json
tags: [pacote, repo/harness]
---

# harness-ui

> [!tldr] Em linguagem comum
> É o painel local para escolher uma issue, acompanhar trabalho e responder às decisões que pedem uma pessoa.

← [[00 Hub - harness]]

## Papel e contrato

Aplicação Vite/React incluída no pacote raiz, servida por API Node local; projeta estado do loop e cria jobs tipados. Não exige banco ou daemon separado.

| Relação | Quem / como |
|---|---|
| Quem usa e dependências | Operador usa [[harness-loop]]; API chama ações e stores do próprio Harness. É separada do site [[harness-docs]]. |
| Dados lidos e gravados | Lê arquivos/eventos e board do tracker; grava projeções e jobs em .ak-loop/. Servidor usa loopback, sessão e verificações de origem. |

> [!info]- Detalhe técnico
> - `harness/src/ui/api/server.ts:37`.
> - `harness/src/ui/api/actions.ts:1`.
> - `harness/src/ui/api/store.ts:1`.
> - `harness/src/ui/api/jobs.ts:1`.
> - `harness/package.json:1`.
