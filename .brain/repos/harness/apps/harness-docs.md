---
tipo: app
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 724aa82
metodo: análise estática; nada foi executado
fontes:
  - harness/apps/docs/package.json
  - harness/pnpm-workspace.yaml
  - harness/wrangler.toml
  - harness/scripts/build-docs-artifacts.mjs
npm: "@agentskit/harness-docs"
tags: [app, repo/harness]
---

# harness-docs

> [!tldr] Em linguagem comum
> É o site público que ensina a instalar, configurar e operar o Harness.

← [[00 Hub - harness]]

## Papel e contrato

Workspace @agentskit/harness-docs em apps/docs, com Next.js, React e Fumadocs. Referências e artefatos são gerados antes do build; dependências web ficam fora do runtime CLI/Ink.

| Relação | Quem / como |
|---|---|
| Quem usa e dependências | Usuários de [[00 Hub - harness]]; documenta [[harness-loop]] e [[harness-kernel]]. |
| Dados lidos e gravados | Lê conteúdo e artefatos gerados; gera export estático apps/docs/out. Wrangler declara assets Cloudflare; vercel.json permanece como configuração coexistente. Não há prova de domínio efetivamente publicado nesta análise. |

> [!info]- Detalhe técnico
> - `harness/apps/docs/package.json:1`.
> - `harness/pnpm-workspace.yaml:1`.
> - `harness/wrangler.toml:1`.
> - `harness/scripts/build-docs-artifacts.mjs:1`.
