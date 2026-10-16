---
tipo: app
repo: harness
camada: ferramenta
visibilidade: privado
npm: "@agentskit/harness-docs"
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; nada foi executado (o site não foi construído nem aberto). doc-bridge: .doc-bridge/index.json e doc-bridge.config.json lidos; a CLI ak-docs não foi rodada."
fontes:
  - harness/apps/docs/package.json
  - harness/apps/docs/next.config.mjs
  - harness/apps/docs/source.config.ts
  - harness/apps/docs/lib/site.ts
  - harness/apps/docs/app/api/search/route.ts
  - harness/apps/docs/app/for-agents/page.tsx
  - harness/pnpm-workspace.yaml
  - harness/wrangler.toml
  - harness/vercel.json
  - harness/package.json
  - harness/scripts/build-docs-artifacts.mjs
  - harness/scripts/gen-docs-reference.mjs
  - harness/scripts/cloudflare-headers.mjs
  - harness/scripts/lib/stats.mjs
  - harness/doc-bridge.config.json
  - harness/.doc-bridge/llms.txt
  - harness/.github/workflows/release-harness.yml
tags: [app, repo/harness, camada/ferramenta]
---

# harness-docs

> [!tldr] Em linguagem comum
> É o site público (harness.agentskit.io) que ensina a instalar, configurar e operar o Harness. As páginas de referência (comandos, configuração, eventos) são geradas do próprio código, então não envelhecem sozinhas sem a CI reclamar.

← [[00 Hub - harness]]

## O que faz e por que existe

Workspace pnpm **privado** `@agentskit/harness-docs` em `apps/docs` (`harness/apps/docs/package.json:2-4`; v1 marcava esta nota como pública — corrigido), com Next.js 16, React 19 e Fumadocs. Fica num pacote separado de propósito: "Next/React 19 nunca chega ao runtime do harness, que renderiza seu TUI com ink" (`harness/apps/docs/package.json:6`; `harness/pnpm-workspace.yaml:1-5`). O site é a superfície pública de documentação; o conteúdo vem da própria árvore `apps/docs/content/docs/` (concepts, configuration, examples, get-started, guides, reference), sem allowlist (`harness/apps/docs/source.config.ts:3-14`).

Também serve entradas para máquinas: `/for-agents/` (`harness/apps/docs/app/for-agents/page.tsx:5-15`), `llms.txt`, `llms-full.txt`, Markdown cru em `/raw/` e `api/stats.json`, tudo escrito por `scripts/build-docs-artifacts.mjs` (`harness/scripts/build-docs-artifacts.mjs:5-8`, `:127-134`).

## API e contratos

Não exporta API de código; os contratos são **superfícies públicas**:

| Superfície | O que é | Onde |
|---|---|---|
| `/docs/**` | Páginas MDX (Fumadocs); três de referência são **geradas** e não devem ser editadas à mão | `harness/apps/docs/content/docs/reference/cli.mdx:6`; geradores em `harness/scripts/gen-docs-reference.mjs:15` |
| `/for-agents/` | Página "como operar o loop sem adivinhar" | `harness/apps/docs/app/for-agents/page.tsx:17` |
| `/api/search` | Busca estática (`force-static`, `staticGET`) | `harness/apps/docs/app/api/search/route.ts:6-7` |
| `/llms.txt`, `/llms-full.txt`, `/raw/**`, `/api/stats.json` | Artefatos para agentes e contagens "que o site tem direito de afirmar", lidas do repositório (comandos do commander, eventos, caminhos de configuração, ADRs, arquivos de teste) | `harness/scripts/build-docs-artifacts.mjs:99-134`; `harness/scripts/lib/stats.mjs:1-14` |
| Gate de doc-bridge | `documentation-standard-v1` sobre `README.md` e `apps/docs/content/docs/index.mdx`, com o quickstart `first-loop` ligado ao teste `test/loop-presets-init.test.ts` | `harness/doc-bridge.config.json:86-173` |

**Exemplo real** — a configuração do Next que produz a exportação estática (`harness/apps/docs/next.config.mjs:9-19`):

```js
const config = {
  output: 'export',
  reactStrictMode: true,
  trailingSlash: true,
  images: { unoptimized: true },
  basePath,
  assetPrefix: basePath ? `${basePath}/` : undefined,
```

## Quem usa e do que depende

| Relação | Nota / evidência |
|---|---|
| Consumidor | Pessoas e agentes que abrem harness.agentskit.io; o repositório irmão [[00 Hub - doc-bridge]] usa o mesmo padrão de documentação (gate `documentation-standard-v1`) |
| Documenta | [[harness-loop]] (conceitos, configuração, guias) e [[harness-kernel]] (protocolo de verificação, ADRs) |
| Dependência interna | O build do pacote raiz (`dist/index.js`, `dist/cli.js`) para gerar referência e estatísticas (`harness/scripts/lib/stats.mjs:53-57`); `ecosystem.json` copiado do repositório [[00 Hub - agentskit]] para o rodapé "ecossistema" (`harness/scripts/build-docs-artifacts.mjs:78-97`) |
| Dependências externas | `fumadocs-core/mdx/ui` 16.15.4/15.4.0, `next` 16.3.3, `mermaid`, `motion`, Tailwind 4 (`harness/apps/docs/package.json:12-30`) |
| Hospedagem | Cloudflare Workers com assets estáticos (`harness/wrangler.toml:1-11`); `vercel.json` ainda existe e é a fonte dos cabeçalhos copiados para o Cloudflare (`harness/scripts/cloudflare-headers.mjs:2-4`) |

## Dados e efeitos

- **Lê:** `apps/docs/content/docs/**`, `ecosystem.json`, `package.json`, o `dist/` do pacote raiz e o esquema de configuração.
- **Grava:** `apps/docs/public/` (apagado e refeito a cada execução do gerador, `harness/scripts/build-docs-artifacts.mjs:60-61`) e `apps/docs/out/` (exportação estática). `meta.json` da seção de referência é reescrito por `docs:generate` (`harness/scripts/gen-docs-reference.mjs:17-37`). `scripts/cloudflare-headers.mjs` grava `_headers` na saída (`harness/scripts/cloudflare-headers.mjs:15`).
- **Variáveis de ambiente (só nomes):** `NEXT_PUBLIC_SITE_URL`, `DOCS_BASE_PATH`/`NEXT_PUBLIC_BASE_PATH` (`harness/apps/docs/next.config.mjs:6`, `:16-19`; `harness/apps/docs/lib/site.ts:2-5`); `AK_HARNESS_CLI_INTROSPECT` (liga a introspecção da CLI, `harness/scripts/lib/stats.mjs:55`); para publicar: `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` (`harness/wrangler.toml:3`).
- **Rede:** a build não chama serviços; o deploy usa `wrangler` (baixado com `npx -y wrangler@4`, `harness/package.json:107`).
- **Não há prova nesta análise de que o domínio esteja efetivamente publicado.** Ver [[Infra e deploy]].

## Como mexer (para agentes)

**Comece por** `apps/docs/content/docs/index.mdx` (também a "startHere" do doc-bridge, `harness/doc-bridge.config.json:69-75`) e, para o que não é conteúdo, `apps/docs/app/` e `apps/docs/components/`.

**Invariantes**
- Páginas em `reference/` são geradas: editar `src/cli.ts`, `src/loop/config.ts` ou `src/loop/event-vocabulary.ts` e rodar `pnpm docs:generate`; a CI roda `pnpm docs:generate --check` e falha se o commitado divergir do código (`harness/.github/workflows/release-harness.yml:72-75`).
- O índice doc-bridge commitado deve estar fresco: o job `docs` roda `ak-docs gate run index-freshness`, `docs:bridge:gate` e `docs:bridge:conformance` (`harness/.github/workflows/release-harness.yml:62-71`). A configuração é gerada: `pnpm docs:bridge:config:check` (`:64`).
- Números do site vêm do repositório, nunca digitados (`harness/scripts/lib/stats.mjs:1-13`); `generatedAt` foi omitido de propósito.
- Nenhum `basePath` em produção: o domínio é próprio (`harness/apps/docs/next.config.mjs:4-6`).

**Testes:** `harness/scripts/docs-artifacts-contract.test.mjs` e `harness/scripts/frontmatter.test.mjs` (`node --test`, via `pnpm test:docs-artifacts`, `harness/package.json:50`); `apps/**` é excluído do Vitest da raiz (`harness/vitest.config.ts:14-21`).

**Comando de validação:** `pnpm docs:build` (build do pacote + artefatos + `next build`, `harness/package.json:49`) e `pnpm docs:typecheck`; no CI: `pnpm docs:bridge:config:check`, `pnpm docs:generate --check`, `pnpm test:docs-artifacts`. Receita: [[Atualizar e publicar a documentação do Harness]].

**Armadilhas**
- Há `README.md` e `docs/*.md` em inglês que **não** entram no site; só o que está em `apps/docs/content/docs/` é público.
- `apps/docs/lib/site.ts:4` e `source.config.ts:6-8` ainda falam de um workflow "Pages" e de "37 ADRs em português"; o repositório hoje tem 43 ADRs em inglês e publica por Cloudflare — comentário desatualizado, não comportamento.
- `vercel.json` e `wrangler.toml` coexistem; trocar de host exige mexer nos dois (os cabeçalhos são espelhados).
- `.doc-bridge/index.json` precisa ser regenerado com `pnpm docs:bridge:index` quando o conteúdo muda.

**Quem revisa:** dono do repositório; mudanças de conteúdo não exigem revisão de mantenedor de API.

## Decisões e história

Sem ADR próprio; as decisões de produto que o site descreve estão nos ADRs 0027–0043 ([[00 Decisões - harness]]).

Mudanças recentes (`git log -- apps/docs`):
- 2026-10-02 · `61b2e45` · docs servidos por Cloudflare Workers static assets (deploy fora da Vercel).
- 2026-09-27 · `fcd12f4` abort/restart de run; `ce35a49` `deliver` também vira worker destacado; `0a2eb1e` "16 falhas escondidas".
- 2026-09-26 · `a3068f0` rodapé compartilhado do AgentsKit; `2c053ac` adoção do AgentsKit shell v1; `9e726ff` ADR-0041 documentado.
- 2026-09-24 · `00c4b44` home alinhada ao desenho do AgentsKit; `807e0f0` remove notas internas de planejamento.

> [!info]- Detalhe técnico
> - Scripts do site em `harness/package.json:44-51`, `:101-107` (`docs:dev`, `docs:generate`, `docs:artifacts`, `docs:build`, `docs:bridge:*`, `cf:headers`, `cf:deploy`).
> - Índice `llms.txt` do doc-bridge (conteúdo do site em 38 páginas): `harness/.doc-bridge/llms.txt:1-42`.
> - Rotas do doc-bridge: `harness-site` (checagem `pnpm docs:build`) e `ecosystem-manifest` (checagem `node scripts/verify-ecosystem-public-outputs.mjs`) em `harness/doc-bridge.config.json:41-58`.
> - A página inicial usa `home.css` e componentes `components/home/*` (`harness/apps/docs/components/home/harness-home.tsx`).

> [!question] Dúvida
> O domínio harness.agentskit.io está efetivamente publicado e qual é o procedimento de deploy usado em produção (`cf:deploy` manual ou CI)? O repositório só tem o script; nenhum workflow publica o site. Ver [[Dúvidas abertas]].
