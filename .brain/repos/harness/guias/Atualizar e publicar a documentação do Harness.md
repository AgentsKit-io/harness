---
tipo: guia
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; comandos de package.json e do workflow; nenhuma build ou deploy foi executado"
fontes:
  - harness/package.json
  - harness/doc-bridge.config.json
  - harness/scripts/gen-docs-reference.mjs
  - harness/scripts/build-docs-artifacts.mjs
  - harness/scripts/cloudflare-headers.mjs
  - harness/wrangler.toml
  - harness/.github/workflows/release-harness.yml
tags: [guia, repo/harness, camada/ferramenta]
---

# Atualizar e publicar a documentação do Harness

> [!tldr] Em linguagem comum
> O site é feito de páginas escritas à mão e de três páginas geradas do código; a CI recusa a documentação que não bate com o código.

← [[00 Hub - harness]]

## Quando usar

Ao editar páginas em `apps/docs/content/docs/`, ao mudar o CLI, a configuração ou os eventos (que alimentam a referência) ou ao publicar o site.

## Pré-requisitos

`pnpm install --frozen-lockfile`; para publicar, `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` no ambiente (só os nomes; `harness/wrangler.toml:3`).

## Passos

1. **Conteúdo escrito à mão:** edite `apps/docs/content/docs/**/*.mdx` (a página inicial é `index.mdx`, também o "startHere" do doc-bridge, `harness/doc-bridge.config.json:69-75`).
2. **Referência gerada:** depois de mexer em `src/cli.ts`, `src/loop/config.ts` ou `src/loop/event-vocabulary.ts`:
   ```bash
   pnpm build
   pnpm docs:generate           # reescreve reference/{configuration,cli,events}.mdx
   ```
   Não edite essas três páginas à mão ("Do not edit by hand", `harness/apps/docs/content/docs/reference/cli.mdx:6`).
3. **Índice do doc-bridge** (cobre só o site de docs):
   ```bash
   pnpm docs:bridge:config:check    # a configuração é gerada de generate-doc-bridge-config.mjs
   pnpm docs:bridge:index           # ak-docs index → .doc-bridge/index.json e llms.txt
   pnpm docs:bridge:gate
   pnpm docs:bridge:conformance
   ```
4. **Build local do site:**
   ```bash
   pnpm docs:build              # pnpm build && docs:artifacts && next build (apps/docs/out)
   pnpm docs:typecheck
   pnpm test:docs-artifacts
   ```
5. **Publicar** (Cloudflare Workers com assets estáticos; manual, nenhum workflow publica o site):
   ```bash
   pnpm cf:deploy               # docs:build + cf:headers + npx -y wrangler@4 deploy
   ```
   `cf:headers` copia os cabeçalhos de `vercel.json` para `_headers` e acrescenta HSTS (`harness/scripts/cloudflare-headers.mjs:2-16`).

## Como validar

O job `docs` da CI repete: `docs:bridge:config:check`, `ak-docs validate-config`, `verify-ecosystem-public-outputs`, `ak-docs gate run index-freshness`, `docs:bridge:gate`, `docs:bridge:conformance`, `docs:generate --check`, `test:capabilities`, `verify-release-evidence`, `verify-json-boundaries`, `docs:build`, `test:docs-artifacts` (`harness/.github/workflows/release-harness.yml:62-82`).

## Erros comuns

- `docs:generate --check` falha porque a referência commitada ficou para trás do código.
- Re-rodar `ak-docs index` e comparar por diff nunca passa: a revisão (SHA do git em árvore limpa, hash de conteúdo em suja) muda; a CI usa `gate run index-freshness` (`harness/.github/workflows/release-harness.yml:67-69`).
- `NEXT_PUBLIC_SITE_URL`/`DOCS_BASE_PATH`: só para forks sob subcaminho; produção não usa `basePath` (`harness/apps/docs/next.config.mjs:4-6`).
- Comentários em `apps/docs/lib/site.ts` e `source.config.ts` citam um workflow "Pages" e "37 ADRs em português" — desatualizados.

## Notas relacionadas

[[harness-docs]] · [[Validar uma mudança no Harness]] · [[Infra e deploy]] · [[00 Hub - doc-bridge]]
