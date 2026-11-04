# Playbook da fábrica — AgentsKit-io/harness

Pacote `@agentskit/harness` (TypeScript, ESM, pnpm). Repo **público**: nada de conteúdo de repos privados.

## 1. Instalar
- Node >= 22 (CI usa 22; `engine-strict=true`), pnpm 10.34.7 (`packageManager` no package.json).
- `pnpm install --frozen-lockfile` (igual ao CI).
- Lockfile desatualizado: rode `pnpm install` (sem `--frozen-lockfile`) e commite `pnpm-lock.yaml` junto. Não edite à mão.
- Variáveis: nenhuma é necessária para instalar, testar ou buildar. `AK_HARNESS_CLI_INTROSPECT=1` só é usada pelos geradores de docs.

## 2. Rodar localmente
- Não há serviço nem banco. CLI: `pnpm build && node dist/cli.js --help` (bins `ak-harness`/`ak-verify`).
- UI: `pnpm ui:dev` (vite). Site de docs: `pnpm docs:dev`.
- Diagnóstico: `node dist/cli.js doctor --json` (após build).

## 3. Verificação rápida (diff pequeno)
- `pnpm typecheck` (cross-platform check + tsc do pacote + tsc da UI).
- Um teste só: `pnpm vitest run test/<arquivo>.test.ts` (ou `-t "<nome>"`).
- Scripts `node --test` ficam em `scripts/*.test.mjs` (`pnpm test:docs-artifacts`), fora do vitest.
- Não há lint/prettier: `typecheck` é o lint. Não rode o contrato inteiro (`ak-verify run ...`) a cada edição.
- Mexeu em CLI/schema/eventos/README/docs? Faça também a seção 5 (docs gerados).

## 4. Verificação completa (CI: `.github/workflows/release-harness.yml`, "Verify harness")
- **verify**: install, `pnpm typecheck`, `pnpm test:coverage`, `pnpm build`, `pnpm check:public-api`, `pnpm pack --pack-destination /tmp/agentskit-harness-pack`, depois `node dist/cli.js plan approved --by human|start|run --config .ak-harness/verification.json --json` (contrato do próprio repo). Lento: coverage e o `run`.
- **docs** (nome do check: "Docs (generated reference + site)"): `docs:bridge:config:check`, `ak-docs validate-config`, `verify-ecosystem-public-outputs.mjs`, `ak-docs gate run index-freshness`, `docs:bridge:gate`, `docs:bridge:conformance`, `pnpm build`, `docs:generate --check`, `test:capabilities`, `verify-release-evidence.mjs`, `verify-json-boundaries.mjs`, `docs:build` (build Next, o mais lento), `test:docs-artifacts`. É o job que mais fica vermelho.
- **loop-cross-platform** (ubuntu/macos/windows): typecheck, subconjunto de `test/loop*.test.ts`, build, `loop validate`. Windows/macOS são lentos e sensíveis a timing (git/worktrees).
- **publish**: só em push na main; depende dos três acima. Não mexa em `release-harness.yml` (o nome do arquivo é usado pelo npm Trusted Publishing).
- `.github/factory.json` `verify` = subconjunto rápido e determinístico do CI (sem `docs:build` e sem a matriz).

## 5. Regras que mais derrubam PR
- **Docs gerados**: mudou `src/cli.ts`, schema de config ou vocabulário de eventos → `pnpm build && pnpm docs:generate` e commite o resultado (CI roda `docs:generate --check`).
- **Manifesto de capabilities**: mudou superfície pública → `node scripts/generate-capability-manifest.mjs --write capabilities/public-surface.json` (CI roda `pnpm test:capabilities`).
- **Índice Doc Bridge**: mudou README, `apps/docs/content/docs/**` ou qualquer `.md`/`.json` rastreado (inclusive este playbook e `factory.json`) → `pnpm docs:bridge:index` e commite `.doc-bridge/`; confira com `pnpm exec ak-docs gate run index-freshness`. Config: `pnpm docs:bridge:config` se `scripts/generate-doc-bridge-config.mjs` mudou.
- **API pública**: mudança intencional em `src/index.ts` → `pnpm check:public-api:update` e commite `docs/stability/public-api-v1.json`.
- **Cobertura** (`vitest.config.ts`): piso 89% stmts / 79% branches / 88% funcs / 93% lines em `src/**`; todo código novo precisa de teste.
- **Commits**: Angular Conventional (`feat|fix|docs|refactor|test|build|ci|perf|chore|revert(scope): ...`), curtos.
- **Changelog**: não edite `CHANGELOG.md` nem a versão; crie `changelog.d/<ticket>.md` (1ª linha `fix: ...`/`feat: ...`).
- Arquivos TS pequenos e por capacidade (AGENTS.md); sem dependência direta de Linear/GitHub/provedor no kernel (`scripts/verify-dependency-directions.mjs`).

## 6. Arquivos de registro compartilhados
- `changelog.d/`: um arquivo por ticket (`<n>.md`) — nunca conflita; é a única forma de registrar mudança.
- `.doc-bridge/index.json`, `capabilities/public-surface.json`, `docs/stability/public-api-v1.json`, referência gerada: **regenere** com o comando (seção 5), nunca resolva conflito à mão. Em conflito: faça `git merge` da base, rode o gerador de novo e commite.
- `pnpm-lock.yaml`: mesma regra — regenere com `pnpm install`.

## 7. Armadilhas conhecidas (falhas reais da fábrica)
- **"CI red: Docs (generated reference + site)"** (3×, inspect): quase sempre artefato gerado defasado (`docs:generate --check`, `index-freshness`, `test:capabilities`) ou main já vermelha. Prevenção: antes de terminar, rode `pnpm build && pnpm docs:generate --check && pnpm exec ak-docs gate run index-freshness && pnpm test:capabilities`; se falhar, regenere e commite. Se falhar também sem o seu diff, é main vermelha: registre no resumo, não "conserte" fora do escopo.
- **"pending: verify"** junto do Docs vermelho: o check `verify` ainda rodava; só vale o resultado final de todos. Não dê o ticket por verde enquanto houver check pendente.
- **"branch factory/agentskit-io-harness-N is not on AgentsKit-io/harness"** (verify, falhou em todas as tentativas): a estação checa a branch no remoto; ela só existe lá depois que a linha de fábrica faz o push. Não faça push, não troque de branch nem reescreva histórico (sem rebase/reset); deixe tudo commitado na branch atual e a linha publica. Se acontecer, não é defeito do código: não altere código para "resolver".
- Nome de arquivo `release-harness.yml` é load-bearing (npm Trusted Publishing): não renomear.
- Testes nunca usam o HOME real; use diretórios temporários.
