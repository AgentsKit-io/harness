---
tipo: guia
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; comandos de package.json, cli.ts e vite.config.ts; a UI não foi aberta"
fontes:
  - harness/package.json
  - harness/README.md
  - harness/src/cli.ts
  - harness/src/ui/api/server.ts
  - harness/src/ui/app/vite.config.ts
tags: [guia, repo/harness, camada/ferramenta]
---

# Rodar e alterar a UI local do Harness

> [!tldr] Em linguagem comum
> Para ver o painel use `ak-harness ui`; para mexer no frontend rode o Vite ao lado e aponte o servidor para ele.

← [[00 Hub - harness]]

## Quando usar

Operar o painel do loop no seu computador, ou desenvolver o servidor/frontend de [[harness-ui]].

## Pré-requisitos

- Um `loop.config.yaml` válido (`ak-harness loop validate`); a UI carrega a configuração na subida (`harness/src/ui/api/server.ts:311`).
- Build do pacote para servir os estáticos (`pnpm build` gera `dist/app`, `harness/package.json:38`).

## Passos

Operar:
```bash
npx ak-harness ui                       # http://127.0.0.1:4321 (padrão)
npx ak-harness ui --loop-config path/to/loop.config.yaml --port 0
```
O servidor só aceita host de loopback (`harness/src/ui/api/server.ts:307`); o token de sessão é injetado no HTML, nunca na URL (`:129`).

Desenvolver:
```bash
pnpm ui:dev                    # vite na porta 5173 (strictPort)
ak-harness ui --dev            # proxy de tudo que não é /api/v1 para o Vite
pnpm ui:build                  # gera dist/app
pnpm typecheck                 # inclui tsc do app (src/ui/app/tsconfig.json)
```
(`harness/package.json:42-43`, `harness/src/cli.ts:42-43`, `harness/src/ui/app/vite.config.ts:13`.)

Acrescentar uma ação do operador:
1. Escreva a função no módulo do loop (ou use a existente) — **nunca** reimplemente regra no servidor.
2. Exponha-a em `src/ui/api/actions.ts` ou num módulo `routes-*.ts` (lista em `harness/src/ui/api/route-modules.ts:10-17`), com o ator em `humanActor` (`harness/src/ui/api/routes-actions.ts:40`).
3. Se mudar o reducer da projeção, incremente `PROJECTION_SCHEMA_VERSION` (`harness/src/ui/api/store.ts:27`).
4. Registre o cliente em `src/ui/app/src/lib/api.ts` e a tela em `src/ui/app/src/pages/`.

## Como validar

```bash
pnpm test:ui
```
(roda os testes `ui-*`, `github-board`, `github-tracker` e `loop-ui-components`, `harness/package.json:85`.) Para o frontend, os testes usam o alias `@/` do Vitest (`harness/vitest.config.ts:6-10`).

## Erros comuns

- `503 ui_not_built`: falta `pnpm build` (`harness/src/ui/api/server.ts:136`).
- `502 dev_server_unreachable` com `--dev`: o Vite não está rodando na 5173.
- Ação recusada com 409 "locked": a issue está travada por dado velho do tracker; clique em reconciliar ([[harness ADR-0040 - Plano de controle v2]]).
- Projeção "presa" depois de mudar o reducer: faltou incrementar a versão de schema.
- Rodar `tick`/`deliver` à mão enquanto as automações do Orca estão instaladas: corrida e duplo despacho ([[Operar e diagnosticar o loop do Harness]]).

## Notas relacionadas

[[harness-ui]] · [[harness-loop]] · [[Validar uma mudança no Harness]]
