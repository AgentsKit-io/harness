---
tipo: guia
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; comandos copiados de AGENTS.md, CONTRIBUTING.md, package.json e do workflow de CI; nada foi executado"
fontes:
  - harness/AGENTS.md
  - harness/CONTRIBUTING.md
  - harness/package.json
  - harness/.github/workflows/release-harness.yml
  - harness/.github/pull_request_template.md
  - harness/vitest.config.ts
tags: [guia, repo/harness, camada/ferramenta]
---

# Validar uma mudança no Harness

> [!tldr] Em linguagem comum
> Como provar que uma mudança está pronta: rode o teste estreito do que você tocou o tempo todo e o portão completo só uma vez, no PR que fecha a issue.

← [[00 Hub - harness]]

## Quando usar

Toda mudança em `src/`, `scripts/`, `test/`, `docs/` ou `apps/docs`. A regra de escopo do repositório: "uma tarefa tem escopo explícito; rode o check de que ela precisa, não o portão inteiro" (`harness/AGENTS.md:73-84`). Rodar o contrato completo a cada iteração é "a maior fonte de tempo e tokens desperdiçados" do repositório (`harness/AGENTS.md:91-94`).

## Pré-requisitos

- Node ≥ 22 e pnpm 10 (`harness/package.json:34-36`, `:143`); `pnpm install --frozen-lockfile`.
- `git` no PATH (o protocolo de verificação liga evidência ao `HEAD`).
- Opcional: [rtk](https://github.com/rtk-ai/rtk), que comprime a saída dos comandos (`harness/AGENTS.md:42-48`).

## Passos

1. **Durante o trabalho — o teste estreito** (cada um roda `pnpm typecheck` antes):
   ```bash
   pnpm vitest run test/loop-deliver.test.ts     # um arquivo
   pnpm test:boundaries                          # direção de imports + limites de JSON
   pnpm test:loop                                # a suíte do loop
   pnpm test:ui                                  # painel local
   pnpm test:adapters                            # adapters
   pnpm test:contract                            # protocolo de verificação
   ```
   A lista completa dos scripts `test:*` e dos critérios que cada um prova está em `harness/package.json` (a ligação script↔critério é "julgamento, não tabela", `harness/AGENTS.md:79-84`).
2. **Antes de abrir o PR — o portão local** (`harness/CONTRIBUTING.md:26-34`):
   ```bash
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm pack --pack-destination /tmp/agentskit-harness-pack
   ```
3. **Só no PR que fecha a issue — o contrato completo:**
   ```bash
   ak-verify run --config .ak-harness/verification.json --json
   ```
   Anote o run ID e a evidência por critério no relatório do PR (`harness/AGENTS.md:86-94`; checklist em `harness/.github/pull_request_template.md:20-33`).
4. **Cobertura:** `pnpm test:coverage` impõe 89 % instruções, 79 % ramos, 88 % funções e 93 % linhas em `src/**` (exceto `src/ui/app/**`) (`harness/vitest.config.ts:22-31`).
5. **O que a CI repete em cada PR** (`harness/.github/workflows/release-harness.yml:24-104`): `typecheck`, `test:coverage`, `build`, `check:public-api`, `pack`, encenação de `plan/start/run` do contrato; job de docs (doc-bridge, `docs:generate --check`, `test:capabilities`, `verify-release-evidence`, `docs:build`); matriz Ubuntu/macOS/Windows do loop.

## Como validar

A saída de todo `test:*` termina com uma linha JSON `{"status":"passed","criteria":[…]}`; falha = exit ≠ 0. "Uma execução falha, velha, bloqueada ou aguardando aprovação não está completa" (`harness/AGENTS.md:90-91`).

## Erros comuns

- Rodar `pnpm test` inteiro a cada edição: use o teste estreito.
- Mudou `src/index.ts` e `check:public-api` falhou: ver [[Mudar a API pública do Harness]].
- `docs:generate --check` falhou: o código mudou o CLI, a configuração ou o vocabulário de eventos; rode `pnpm build && pnpm docs:generate` e commite ([[Atualizar e publicar a documentação do Harness]]).
- `test:docker-runtime` exige Docker de verdade (`HARNESS_REQUIRE_DOCKER=1`); sem ele o teste não prova nada sobre isolamento.
- Contagens de scripts/critérios em `AGENTS.md` (47 scripts, 18 resultados, 22 checks) estão desatualizadas em relação a `verification.json` (19 e 23).

## Notas relacionadas

[[harness-kernel]] · [[harness-loop]] · [[harness-ui]] · [[Escrever commits e PRs no padrão do Harness]] · [[Harness - Verificar e aprovar uma execução]]
