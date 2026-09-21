# Objetivo: fechar a 0.15.0 e o site do `@agentskit/harness`

Este ficheiro é auto-suficiente. Um agente que nunca viu a conversa que o originou consegue executá-lo do
início ao fim lendo só isto e o código. Quando tudo aqui estiver feito, o objetivo está cumprido.

> **Como usar:** `/goal /Users/rebecabraun/workspace/EmersonBraun/agentskit-harness/PLAN-0.15.0.md`

---

## 1. Estado atual

| | |
|---|---|
| Repositório | `/Users/rebecabraun/workspace/EmersonBraun/agentskit-harness` |
| Branch | `feat/loop-sdlc` (criada a partir de `main`, **nunca empurrada**) |
| Commits acima de `main` | 16 |
| Working tree | limpo |
| Suíte | 136 ficheiros, 1338 testes verdes |

**Já feito e commitado:** os doze passos do `docs/ROADMAP-SDLC.md` §7, o wire-up da superfície pública/CLI/docs,
e os itens A1 (`layers:`) e A2 (`documents:`) deste plano.

**Onde pegar:** `src/loop/artifacts.ts` está commitado mas **ainda não ligado a nada** — não é exportado, não é
usado pelo `deliver` nem pelo `brief`, e não tem testes. É deliberado: é o ponto de partida da fatia 1, e está lá
para ser lido antes de ser ligado.

**Contexto longo:** `~/.claude/plans/steady-baking-ullman.md` tem o plano completo com a justificação de cada
decisão. Este ficheiro é a versão executável; em caso de conflito entre os dois, **este manda**.

---

## 2. Regras invioláveis

1. **Não publicar no npm.** Nem `npm publish`, nem `pnpm publish`, nem alterar o `release-harness.yml` para o fazer.
2. **Não empurrar nada.** Sem `git push`, sem abrir PR. Commits locais, só.
3. **Não escrever em sistemas externos.** Nada de criar issues no Linear, comentar em PRs, reconciliar automações
   no Orca ou fazer merge. As únicas chamadas externas permitidas são **de leitura** (fatia 10).
4. **A home do site (`/`) está fora deste objetivo.** O humano está a desenhá-la à parte. Construir apenas um
   `app/(home)/page.tsx` mínimo para a rota não dar 404.
5. **Não inventar números.** Nenhuma métrica, estatística ou claim que não se possa provar a partir do
   repositório. Se o dado não existe, a secção não existe.
6. **Não integrar o `ai-memory`** — decisão tomada e fundamentada; não reabrir.
7. **Se uma pergunta da secção 8 bloquear o trabalho**, deixar a parte afetada de fora e dizê-lo, em vez de
   assumir uma resposta.

---

## 3. Convenções de trabalho

**Commits:** Angular Conventional (`feat(loop):`, `fix(loop):`, `docs:`, `chore(loop):`). Corpo a explicar *por
que*, não *o quê* — o diff já diz o quê. Um commit por item.

**Depois de cada item, obrigatoriamente:**

```bash
cd /Users/rebecabraun/workspace/EmersonBraun/agentskit-harness
npx tsc --noEmit -p tsconfig.json
npx vitest run
node scripts/generate-capability-manifest.mjs --write capabilities/public-surface.json
```

Se a superfície pública mudou (exports novos em `src/index.ts` ou `src/loop/index.ts`), o manifesto **tem** de ser
regenerado no mesmo commit, senão o gate `test:capabilities` falha.

**Testes novos** entram também no script `test:loop` do `package.json`, na lista de ficheiros e na lista de
critérios.

**Estilo do código:** sem `any`, exports nomeados, Zod em toda a fronteira, erros por `fail(...)` com código.
Comentários só onde explicam uma decisão não óbvia — a densidade atual do repositório é a referência.

---

## 4. As fatias, em ordem

### Fatia 1 — terminar o A3 (artefatos por fase)

`src/loop/artifacts.ts` já está escrito e commitado, mas solto. Falta:

- Exportar de `src/loop/index.ts` e `src/index.ts`.
- `src/loop/brief.ts`: incluir `renderArtifactsForBrief(config)` no briefing do worker, junto do bloco da DoD.
- `src/loop/deliver.ts`: antes do gate de merge, ler os artefatos com `readPhaseArtifacts(record.worktreePath,
  config)`; as provas de `verify.json` (`verifyProofs`) entram como evidência dos outcomes na `assessDod`; um
  artefato em falta vira fix round **nomeando o ficheiro** que faltou.
- Teste `test/loop-artifacts.test.ts`: presença, ficheiro inválido (que é pior do que ausente), `missingArtifacts`,
  e o texto do briefing.

**Commit:** `feat(loop): phase artifacts as the contract between worker and harness`

### Fatia 2 — A4, A5, A6

**A4 — override por papel dentro do perfil.** Em `src/loop/config.ts`, `flows.profiles.<nome>.roles.<papel>` com
`model`, `provider`, `effort`, `timeoutMs`, e `flows.profiles.<nome>.stages.<stage>` como booleano. Em
`src/loop/flows.ts`, `resolveRoleSettings(config, flow, role)`. Aplicar em `contract.ts` (orchestrator),
`plan-vote.ts` (planner e voters) e `deliver.ts` (reviewer). Precedência: papel no perfil > projeto > global.

**A5 — papéis do worker.** `worker.roles` como lista ordenada, default `['builder', 'review']` (o comportamento
de hoje, para quem não opta). Valores: `planner`, `vote`, `builder`, `verify`, `review`, `dod`. O papel `verify`
é o verificador barato já existente, promovido a fase nomeada, com `verify.json` como saída.

**A6 — `release.waiting`.** `src/loop/release.ts` emite o evento quando existe lote sem aprovação, **uma vez por
head** (dedupe pelo sha em `release.json`, senão vira spam a cada tick). Acrescentar `release.waiting` ao default
de `notifications.events`.

**Commits:** um por item.

### Fatia 3 — A7, A8, A9 (as alavancas de custo e o lead)

**A7 — prefixo estável para cache.** Reordenar `renderWorkerBrief` e `renderContractPrompt` para o invariante
primeiro (skills, regras, DoD, camadas, memória) e o variável por último (issue, contrato, plano). **O teste é o
que dá valor a isto:** dois briefings de issues diferentes partilham um prefixo byte a byte, e o teste assere um
tamanho mínimo para esse prefixo. Sem essa asserção, a otimização é decorativa.

**A8 — contexto pinado por digest.** Em `renderHandoffBrief` e nas mensagens de fix round, substituir os blocos de
skills/memória já entregues por uma referência ao digest, enviando só o delta. O `DispatchRecordFile` já guarda
`briefDigest` e `skills[]`. **Regra de segurança:** se o digest não bate com o que o registro diz ter sido
entregue, mandar o bloco inteiro — um worker sem contexto é pior do que um worker caro.

**A9 — lead com subagentes.** `models.providers.<id>.subagents: boolean`. Quando o perfil pede lead e o provedor
tem subagentes, o briefing instrui o worker a delegar por item do plano; quando não tem, o briefing diz que ele
trabalha sozinho **e o registro de despacho grava isso**. Nunca silencioso.

### Fatia 4 — A12, depois A10 e A11

**A12 primeiro, porque a fatia 8 depende dele.** `src/loop/event-vocabulary.ts` com `LOOP_EVENT_TYPES` como objeto
`as const`, um JSDoc por evento e os campos que carrega; `LoopEventType = keyof typeof LOOP_EVENT_TYPES`. Estreitar
`appendLoopEvent` e `LoopEventPayload['type']` para esse tipo — o compilador encontra os ~20 pontos de emissão.
Teste que varre `src/loop/**` por literais `type: '<pontilhado>'` e exige igualdade de conjunto com as chaves.

**A10 — o agente instalado é código, não markdown.** `npx agentskit add <id>` copia `agents/<id>/agent.ts`. Em
`src/loop/agent-improvement.ts`, só anexar nota a ficheiro markdown de instruções; quando o agente é código,
registar a proposta como `needs-human` com o motivo. Check novo no `loop doctor` confirmando que cada `path` do
`agents.registry.yaml` existe e dizendo que ficheiro de instruções encontrou.

**A11 — o `plan` conduzido de dentro do app.** Secção nova em `skills/ak-harness-loop/SKILL.md`: como começar
(`loop plan start`), como relatar a pergunta pendente **uma por vez, com alternativas e recomendação**, como
registar a resposta (`loop plan answer`), e onde estão os dois gates humanos. Regra explícita: o agente do app
**não** responde no lugar do humano. Acrescentar verificação mínima de que todo comando citado na skill existe no
`src/cli.ts`.

### Fatia 5 — ADRs, porta de entrada e a 0.15.0

**B1 — seis ADRs**, no formato dos 31 existentes (`docs/ADR-00NN-<slug>.md`, contexto → decisão → consequências):

| ADR | Assunto |
|---|---|
| 0032 | Stages como máquinas de estado (`plan`, `observe`, `release`, `intake`, `maintain`) e a regra de que a máquina decide a transição |
| 0033 | Configuração em quatro camadas + presets, e por que o projeto pesa mais que o global |
| 0034 | Connectors: tracker, SCM e runner, e a regra das duas implementações |
| 0035 | Definição de pronto em duas listas, e por que não existe item `manual` |
| 0036 | Auto-modificação limitada: promoção `loop-auto`, knobs auto-ajustáveis, melhoria de agente com eval como gate |
| 0037 | Custo: política de roteamento, tetos e as alavancas — **incluindo dizer quais não foram feitas** |

**B2 — README e GETTING-STARTED.** O `README.md` §"Keep-pushing loop (Orca)" (linha 11) descreve o loop de 0.14;
passa a descrever o ciclo inteiro. O parágrafo "Where this is going", que chama o roadmap de trabalho futuro, vira
"o que existe". O `docs/GETTING-STARTED.md` ganha o caminho feliz: `loop init` → `loop doctor` → `loop install` →
primeiro tick.

**Fechar a 0.15.0:**
1. `CHANGELOG.md`: `[Unreleased]` → `[0.15.0] - <data>`, incorporando os itens A1–A12.
2. `package.json`: versão `0.15.0`.
3. `docs/ROADMAP-SDLC.md`: §6 e §7 atualizados com o que esta trilha fechou.
4. Bateria completa:
   ```bash
   pnpm typecheck && npx vitest run && npm run test:boundaries && npm run test:capabilities \
     && npm run test:examples && npm run test:compatibility && npm run build && npm run test:loop
   ```
5. **Parar aí.** Tag, push e publicação são gestos do humano.

### Fatia 6 — esqueleto do site

- `pnpm-workspace.yaml` novo na raiz: `packages: ['.', 'apps/*']`.
- `apps/docs/package.json` **próprio** — as dependências do Next/React 19 **não** podem ir para a raiz, senão o
  pnpm pode entregar React 19 ao `ink`, que o harness usa em runtime.
- Copiar de `/Users/rebecabraun/workspace/EmersonBraun/doc-bridge/apps/docs`: `next.config.mjs`,
  `postcss.config.mjs`, `tsconfig.json`, `mdx-components.tsx`, `global.d.ts`, `app/layout.tsx`,
  `app/globals.css`, `app/docs/layout.tsx`, `app/docs/[[...slug]]/page.tsx`, `app/api/search/route.ts`,
  `lib/site.ts`, `components/mermaid.tsx`, `components/copy-button.tsx`.
- **Desvio deliberado:** o site é dono do conteúdo em `apps/docs/content/docs/`; `source.config.ts` usa
  `dir: './content/docs'`. Não replicar o `public-docs.json` do Doc Bridge — a `docs/` do harness são 31 ADRs
  privados e dois documentos em português, e filtrar por allowlist seria enumerar exclusões que crescem sozinhas.
- `lib/source.ts` encolhe para ~10 linhas (`loader({ baseUrl: '/docs', source: docs.toFumadocsSource() })`).
- Quatro páginas MDX + `content/docs/meta.json`, e o `app/(home)/page.tsx` mínimo.
- Versões conhecidas-boas (as do Doc Bridge): `next@16.3.3`, `react@19.2.8`, `fumadocs-{core,ui}@16.15.4`,
  `fumadocs-mdx@15.4.0`, `tailwindcss@4.3.3`, `mermaid@^11.17.2`, `motion@^12`.
- `.gitignore`: `apps/docs/{.next,out,.source,public}/`.

**Verificação:** `pnpm docs:dev` serve um site navegável e pesquisável, com um diagrama a renderizar.

### Fatia 7 — artefatos do site e publicação

- `scripts/build-docs-artifacts.mjs`, fork do Doc Bridge **sem** a parte de `@agentskit/chat`
  (`deterministic/*.json`, `LocalKnowledgeArtifactSchema`): fica Node puro. Gera `public/raw/**`, `llms.txt`,
  `llms-full.txt` e `CNAME`.
- `origin` = `https://harness.agentskit.io`, `currentProductId: 'harness'`.
- `/for-agents` como rota estática.
- `.github/workflows/pages.yml`, copiado do Doc Bridge com três edições: branch `main`, a string do CNAME, e o
  guard de basePath invertido. **`DOCS_BASE_PATH` nunca é definido** — o domínio é próprio, basePath vazio.
- `scripts/docs-artifacts-contract.test.mjs`.

O DNS e o botão do Pages são do humano; deixar tudo pronto e dizer o que falta.

### Fatia 8 — os três geradores de referência

Todos escrevem MDX **commitado** em `apps/docs/content/docs/reference/` e todos suportam `--check`.

| Gerador | Método |
|---|---|
| `scripts/gen-config-reference.mjs` | **Híbrido**: `z.toJSONSchema(LoopConfigSchema, { io: 'input', unrepresentable: 'any' })` para tipo/default/enum, mais uma passagem com a API do compilador TypeScript para os JSDoc, unidos pelo caminho pontilhado. Motivo: `src/loop/config.ts` tem **0 `.describe()` e 178 blocos JSDoc** — nenhuma fonte sozinha basta. Um caminho no schema sem descrição é tolerado e contado; um caminho no JSDoc sem correspondência no schema é **erro duro**. |
| `scripts/gen-cli-reference.mjs` | Importa `dist/cli.js` e percorre a árvore do commander. Exige **duas linhas** em `src/cli.ts`: `export const cliProgram = program` e só chamar `parseAsync` quando `process.env['AK_HARNESS_CLI_INTROSPECT'] !== '1'`. Testar que `node dist/cli.js --help` continua a funcionar. |
| `scripts/gen-events-reference.mjs` | Importa `HARNESS_EVENT_TYPES` e `LOOP_EVENT_TYPES` (da fatia 4) e reaproveita o extrator de JSDoc, fatorado em `scripts/lib/jsdoc-paths.mjs`. |

`scripts/gen-docs-reference.mjs` orquestra os três. Gate de deriva: job `docs` no `.github/workflows/ci.yml` a
correr `pnpm docs:generate --check` depois de `pnpm build`.

### Fatia 9 — conteúdo e diagramas

- ~45 rotas em seis secções (Get started · Concepts · Guides por perfil e por papel · Examples · Configuration ·
  Reference), levantadas à mão de `docs/LOOP.md` (862 linhas, já em inglês). **Não traduzir o
  `ROADMAP-SDLC.md` nem o `PRD-0.4.0.md`** — ficam internos e em português.
- Oito máquinas de estado em Mermaid (uma por stage), mais os connectors e as duas listas da DoD.
- Componentes: `<PipelineTrack/>` (planner → votação 2/3 → build → verify → review → DoD, com a aresta de
  repetição), `<RunReplay/>` (um `<pre>` conduzido por `requestAnimationFrame` sobre um array gravado, sem xterm),
  e o `<LoopFactory/>` em modo estático para as páginas de conceito.
- Técnica dos diagramas: HTML para as caixas (texto real e acessível), SVG só para os conectores, com
  `preserveAspectRatio="none"`, `pathLength={100}`, `vectorEffect="non-scaling-stroke"`. Keyframes CSS, não
  JavaScript, e tudo com `prefers-reduced-motion`.
- Os quatro exemplos do roadmap, juntos em `/docs/examples/`.

### Fatia 10 — capturas read-only

Contra o piloto `/Users/rebecabraun/workspace/EmersonBraun/agentskit-os`, **só leitura**:

```
ak-harness loop doctor --json      ak-harness loop status --json
ak-harness loop observe --since 24h   ak-harness loop debrief
ak-harness loop tick --dry-run --max 1   ak-harness loop release status
```

Cada saída vira um bloco no exemplo correspondente, com a data da captura. O que não se puder capturar sem
escrever fica **explicitamente rotulado como reconstruído** — um exemplo que finge ser real é pior do que nenhum.

### Fatia 11 — PR do ecossistema *(no repositório `agentskit/`, independente de tudo acima)*

Ordem canónica nova: `agentskit`(0) · `registry`(1) · `agentskit-chat`(2) · `doc-bridge`(3) · **`harness`(4)** ·
`playbook`(5) · `code-review`(6) · `akos`(7). No tour: `01/BUILD · 02/DISCOVER · 03/DELIVER · 04/UNDERSTAND ·
05/SHIP · 06/STANDARDIZE`.

Ordem das operações — **parcial quebra o teste de contrato, portanto é um commit só**:

1. `scripts/lib/ecosystem-contract.mjs` → `CANONICAL_PRODUCT_IDS` (linha 10). **Primeiro**, porque o
   `sync-ecosystem.mjs` valida por aí e não corre com um id desconhecido. Não tocar em `LEGACY_PRODUCT_IDS`.
2. `scripts/lib/ecosystem-documentation-quality.mjs` → `CANONICAL_PRODUCTS` (reordenar e acrescentar) e
   `ecosystem-documentation-quality-v1.json` → `productIds`, comparado verbatim.
3. `brand/tokens.json` → `accent.harness` (`#F778BA`, com `light`/`dark`/`softLight`/`softDark`). Atualizar também
   o comentário de cabeçalho do `sync-brand.mjs`, que lista as propriedades válidas.
4. `ecosystem.json`: mover `doc-bridge` para antes de `playbook`; inserir `harness`; reescrever
   `navigation.order` de **todos** para igualar o índice; reescrever `navigation.next` de **todos** (menos `akos`,
   que fica `[]`) para conter o conjunto completo de pares.
5. `node scripts/sync-brand.mjs --property harness --out <apps/docs/app/brand-tokens.css do harness>`.
6. `node scripts/sync-ecosystem.mjs` e depois `--check`.
7. `scripts/ecosystem-contract.test.mjs`, `scripts/ecosystem-readiness.test.mjs`, `ecosystem-claims.json` e
   `apps/docs-next/lib/public-resources.ts` — procurar ids fixos e contagens (`length === 7`).
8. `pnpm test:ecosystem` verde. Copiar o `ecosystem.json` final para o repositório do harness.

Dados da entrada: `shortName: "Harness"`, `kind: "tool"`, `promise: "The keep-pushing loop for your SDLC"`,
`repo: AgentsKit-io/harness`, `accent: "#F778BA"`, `surfaces.home: https://harness.agentskit.io`,
`showcase.stage: "Ship"`.

### Fatia 12 — integrar a home *(quando o desenho existir)*

O humano está a desenhá-la no Claude design. Quando chegar: portar para os componentes reais do `apps/docs`,
ligar cada nó do diagrama à sua página de conceito, garantir `prefers-reduced-motion`, navegação por teclado e
descrição para leitores de ecrã. O briefing está em `HOME-BRIEF.md`, na raiz.

---

## 5. Decisões já tomadas (não reabrir)

| Decisão | Valor |
|---|---|
| Execução contra sistemas reais | Só leitura e dry-run |
| Git | Branch `feat/loop-sdlc`, commits por item, sem push nem PR |
| `documents:` | Ficheiros no repositório; virar ADR numerado continua gesto humano |
| Header do ecossistema | AgentsKit · Registry · Chat · Doc Bridge · Harness · Playbook |
| Estágio no tour | `05 / SHIP` |
| Accent | `#F778BA` |
| Domínio | `harness.agentskit.io`, basePath vazio |
| Conteúdo do site | Dentro de `apps/docs/content/docs/`, em inglês |
| `ai-memory` | Não integrar |
| Home | Fora deste objetivo |

---

## 6. Item opcional

**A13 — `memory.backend: 'sqlite'`.** O `recall` do adaptador de ficheiro é busca por substring com relevância
fixa sobre todos os registos desserializados: `maxRecall: 5` hoje significa "os cinco primeiros que contêm o
token". `node:sqlite` com FTS5 já vem no Node 22 que o `engines` exige. Mesma interface `AgentMemoryAdapter`,
mesmo formato de registo, mesma atestação, zero dependências novas. **Fora da 0.15.0**; fazer só se sobrar tempo
depois da fatia 11.

---

## 7. Definição de pronto

O objetivo está cumprido quando:

- [x] As fatias 1 a 5 estão commitadas e a bateria completa de gates passa.
- [x] `package.json` diz `0.15.0` e o `CHANGELOG.md` tem a secção correspondente.
- [x] `pnpm docs:build` gera `apps/docs/out/` sem erros, com `llms.txt`, `/for-agents` e o CNAME.
- [x] `pnpm docs:generate --check` passa, e o job `docs` está no CI.
- [x] Os quatro exemplos estão escritos e as capturas read-only estão nos exemplos, com o que é reconstruído
      rotulado como tal. **São 38 páginas, não ~45** — seis secções, o conteúdo todo do `LOOP.md` coberto; a
      estimativa era do plano, a contagem é a real.
- [x] O commit do ecossistema está preparado no repositório `agentskit/` com `pnpm test:ecosystem` verde.
- [x] `docs/ROADMAP-SDLC.md` reflete o estado real.
- [x] Nada foi empurrado, publicado ou escrito em sistema externo.

Feito além do plano, por pedido durante a conferência: a fatia 12 (a home desenhada, portada para componentes
reais), o README do npm reescrito, quatro correções de Windows encontradas a partir do PR #84, e a pasta própria
`.ak-harness/` a substituir `.codex/`.

Não feito, por decisão: **A13** (`memory.backend: 'sqlite'`), que o plano põe fora da 0.15.0; e as quatro
perguntas da secção 8, que ficaram sem resposta e portanto fora do site em vez de assumidas.

---

## 8. Perguntas que só o humano responde

Enquanto não houver resposta, **deixar a parte afetada de fora e dizê-lo** — não assumir.

1. **Licença e preço do harness.** Os irmãos são MIT e gratuitos; o harness ainda não está publicado. Sem
   resposta, a página não afirma nada sobre licenciamento.
2. **Existe algum número verdadeiro para uma faixa de estatísticas?** Os irmãos expõem `/api/stats.json`. Os
   únicos factos prováveis hoje são a versão, a licença e a contagem de testes. Sem mais, a faixa não existe.
3. **A subhead "The keep-pushing loop for your SDLC" é final?** Está fixada no roadmap; tratada como definitiva.
4. **Autorização para uma execução com escrita**, se quisermos que os exemplos de despacho e merge sejam reais em
   vez de reconstruídos. Por omissão: reconstruídos e rotulados.
