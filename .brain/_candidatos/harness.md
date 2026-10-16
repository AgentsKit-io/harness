# Candidatos para as notas globais — harness

Material bruto do repositório `harness` (commit `40d033b`, verificado em 2026-10-16) para o integrador consolidar em `conceitos/`, [[Glossário]], [[Mapa de dependências]], [[Infra e deploy]], [[Onde ficam os dados]], [[Dúvidas abertas]] e [[Capacidades não usadas]]. Todas as evidências usam o prefixo `harness/` (raiz do repositório). Método: análise estática; nada executado.

## Conceitos

- **Contrato congelado** — Descrição verificável de "pronto" produzida antes do trabalho: intenção, escopo, resultados com a checagem que prova cada um e ambiguidades. Existe em duas formas: o contrato de verificação (`.ak-harness/verification.json`) e o contrato por issue gerado pelo orquestrador (`contract.json`). Só é despachável com ≥ 1 resultado executável e nenhuma ambiguidade bloqueante. Notas: [[harness-kernel]], [[harness-loop]]. Evidência: `harness/src/loop/contract.ts:118`, `:155-162`; `harness/src/execution/config.ts:123`.
- **Portão humano (human gate)** — Ponto em que o sistema para e espera uma pessoa antes de agir sobre o mundo ou sobre si mesmo: PRD, design, entrada na fila, merge com aprovação, release (preso ao SHA), issue bloqueada, escalação, pausa. O kernel só aceita o ator `human`. Notas: [[Harness - Planejar e liberar com decisão humana]], [[harness-kernel]]. Evidência: `harness/src/kernel/state-machine.ts:12`; `harness/apps/docs/content/docs/concepts/human-gates.mdx:9-19`.
- **Evidência presa à revisão (STALE)** — Resultado de verificação ligado a um `HEAD` commitado e ao hash do contrato; qualquer mudança de código, configuração ou contrato leva a execução a `STALE`. Notas: [[Harness - Verificar e aprovar uma execução]]. Evidência: `harness/src/execution/verification.ts:66-75`; `harness/README.md:201-203`.
- **Log de eventos encadeado por hash** — NDJSON append-only por execução em que cada evento carrega `previousHash`/`eventHash`; adulteração é detectada; logs antigos ficam `legacy`. Notas: [[harness ADR-0017 - Log de eventos encadeado por hash]]. Evidência: `harness/src/kernel/events.ts:216-227`.
- **Atestação** — Hash/evento que prova qual resultado e qual decisão humana foram aceitos (digest de verificação, `approval.recorded`, `authorization.recorded`); não é assinatura. Notas: [[harness ADR-0018 - Atestação da projeção de verificação]], [[harness ADR-0019 - Decisão humana atestada]]. Evidência: `harness/src/execution/verification.ts:176-199`.
- **Pacote de evidência assinado** — Exportação de uma execução `COMPLETE` com SHA-256 por arquivo e assinatura Ed25519, verificável fora da origem, com trust store para rotação/revogação. Evidência: `harness/src/execution/bundle.ts:75-135`.
- **Loop keep-pushing** — Composição que drena a fila de uma pessoa (tick → deliver) sobre o Orca, com roteamento de modelos por papel e portões de custo. Notas: [[harness-loop]], [[harness ADR-0027 - Loop keep-pushing sobre o Orca]]. Evidência: `harness/src/loop/tick.ts:523`; `harness/src/loop/deliver.ts:1300`.
- **Estágio como máquina de estado** — Cada passo do loop (`tick`, `deliver`, `plan`, `observe`, `release`, `intake`, `maintain`, `retro`) é uma máquina: o modelo produz conteúdo, a máquina decide a transição e emite evento declarado. Notas: [[harness ADR-0032 - Estágios como máquinas de estado]]. Evidência: `harness/src/loop/event-vocabulary.ts:11`; `harness/src/cli.ts:113-247`.
- **Artefatos de fase do worker** — Contrato por arquivos entre o worker (sessão opaca) e o harness: `.ak-loop/plan.md`, `verify.json`, `dod.json`; ausentes voltam como fix round nomeando o arquivo. Evidência: `harness/src/loop/artifacts.ts:9-14`, `:78-82`; `harness/src/loop/deliver.ts:1094-1097`.
- **Definição de pronto em duas listas** — Lista do projeto (`dod.items`) + lista da issue (resultados do contrato); item sem prova é `missing`, prova falhando é `failed`; não existe item "manual". Evidência: `harness/src/loop/dod.ts:87-120`; [[harness ADR-0035 - Definição de pronto em duas listas]].
- **Piso do auto-merge** — Mesmo com todos os interruptores desligados, o auto-merge exige que ao menos um portão (CI, revisão, verify, DoD) tenha examinado o diff. Evidência: `harness/src/loop/deliver.ts:1150-1156`; [[harness ADR-0039 - Piso de auto-merge e runner local não ligado]].
- **Fix round** — Mensagem enviada ao worker quando CI, revisão ou conflito exigem correção; conflito não conta, "descoberta" não conta contra `maxFixRounds` (teto 2×). Evidência: `harness/src/loop/deliver.ts:798-835`.
- **Perfil de fluxo (flow profile)** — Conjunto de rigor (votos, severidade, `requireChecks`, gates humanos, `maxFixRounds`, papéis) escolhido por issue, com precedência rótulo `flow:<nome>` → regra de label → projeto → prioridade → padrão. Evidência: `harness/src/loop/flows.ts:31-76`.
- **Configuração em quatro camadas** — `~/.agentskit/harness.yaml` < `loop.config.yaml` < `loop.config.team.<key>.yaml` < `loop.config.local.yaml`; projeto pesa mais que o global; listas de gate acumulam. Evidência: `harness/src/loop/config.ts:1183-1225`; [[harness ADR-0033 - Quatro camadas de configuração e presets]].
- **Preset** — Defaults por tipo de projeto (`web-app`, `library`, `monorepo`, `data-pipeline`, `mobile`) mesclados sob todas as camadas. Evidência: `harness/src/loop/presets.ts:11`.
- **Worker guard** — Hook de pré-uso de ferramenta instalado no worktree que bloqueia edição de `selfEditPaths`/`secretFilePatterns` em tempo real (claude, grok; opencode por regra estática; codex não coberto). Evidência: `harness/src/loop/worker-guard.ts:139-171`; [[harness ADR-0038 - Worker guard em tempo real]].
- **Handoff** — Troca de builder no mesmo worktree/branch quando o provedor do worker está indisponível. Evidência: `harness/src/loop/deliver.ts:514`; `harness/docs/LOOP.md:140-157`.
- **HITL estruturado** — Pergunta humana com 3–4 opções e recomendação, vinda de contrato, plano, revisão ou worker, respondida pela Caixa de entrada da UI. Evidência: `harness/src/loop/hitl.ts:86-203`; `harness/src/loop/contract.ts:124`.
- **Run de agente** — Diretório por issue/tentativa com entradas, saídas, handoffs e evidência por hash; não é fonte de verdade. Evidência: `harness/src/loop/agent-runs.ts:81-82`; [[harness ADR-0041 - Runs de agente e specs renderizadas]].
- **Plano de controle (UI local)** — Painel loopback com fila de atenção, conciliação com tracker e Orca e ações que chamam as funções do CLI. Evidência: `harness/src/ui/api/server.ts:304`; [[harness ADR-0040 - Plano de controle v2]].
- **Precheck como estágio** — Automação do Orca cujo comando de precheck **é** o estágio e sai com 1 para o Orca não abrir sessão de agente (exceto `observe`, que sai com 0 quando um humano precisa olhar). Evidência: `harness/src/cli.ts:113-165`.
- **Piso de recuperação humana (lock/ação ambígua)** — Lock órfão e ação "possivelmente iniciada" só são liberados/retentados por humano. Evidência: `harness/src/kernel/events.ts:283-296`; `harness/src/execution/agent.ts:30`.

## Glossário

- **`ak-harness` / `ak-verify`** — dois nomes do mesmo binário (`harness/package.json:6-9`).
- **stateDir (`.ak-loop`)** — pasta de estado do loop, fora do git (`harness/src/loop/config.ts:122`).
- **`.ak-harness/`** — contrato de verificação e execuções do protocolo (`harness/.ak-harness/verification.json`).
- **tick / deliver / stage** — passagens do loop; `stage` é o ponto de entrada agendado.
- **brief** — instruções entregues ao worker; hoje vão como arquivo `.ak-loop/brief.md` e uma linha no terminal (`harness/src/loop/tick.ts:160`).
- **contract digest / brief digest** — hash do contrato/brief gravado em `dispatch.json`.
- **lease / claim** — reserva atômica de issue+worktree+branch (`harness/src/execution/coordination.ts:69`).
- **yolo / safe / dry-run** — modos de autonomia/perfil de fase (`harness/src/kernel/phase-executor.ts:4`); `yolo` no contrato permite `COMPLETE` automático (`harness/src/execution/verification.ts:180`).
- **base-view** — worktree destacado de `origin/<base>` que o orquestrador lê, nunca o checkout do operador (`harness/src/loop/base-view.ts:8`).
- **loop-auto** — ator que o loop usa para promover aprendizados sozinho; nunca `human` (`harness/src/kernel/learning.ts:58`).
- **selfEditPaths** — globs que o loop nunca revisa nem mergeia sem aprovação humana do head (`harness/src/loop/config.ts:443`).
- **ponytail / caveman / rtk** — convenções de estilo e ferramenta citadas em `harness/AGENTS.md:16-48`.
- **Doc Bridge `ak-docs`** — CLI do repositório [[00 Hub - doc-bridge]] usada nos gates de documentação (`harness/package.json:103-105`).

## Arestas de dependência

- harness --> agentskit (`@agentskit/core`) : hash canônico e estimativa de tokens : `harness/src/kernel/hash.ts:1`, `harness/src/kernel/tokens.ts:1`.
- harness --> agentskit (`@agentskit/cross-platform`) : processos, caminhos e linhas portáveis : `harness/src/kernel/process-tree.ts:2`, `harness/src/execution/runtime.ts:2`, `harness/src/loop/process.ts:1`.
- harness --> agentskit (`@agentskit/net`) : leitura limitada de resposta do catálogo de modelos : `harness/src/loop/model-catalog/index.ts:4`.
- harness --> code-review : `agentskit-review --pr … --result …` via CLI (exit 0/1/2 + arquivo de resultado) : `harness/src/adapters/code-review.ts:151`, `:164`; instalação citada em `harness/src/loop/guided-install.ts:65`.
- harness --> doc-bridge (runtime) : lê `.doc-bridge/index.json` para contexto de contrato/brief : `harness/src/adapters/doc-bridge.ts:82`; `harness/src/loop/contract.ts:276`.
- harness --> doc-bridge (dev/CI) : `@agentskit/doc-bridge ^1.12.0` em devDependencies; `ak-docs` nos gates : `harness/package.json:103-105`, `:120`; `harness/.github/workflows/release-harness.yml:62-71`.
- harness --> orca (CLI) : worktrees, terminais, automações, uso das contas e acesso ao Linear (`orca linear …`) : `harness/src/adapters/orca-cli.ts:143`, `harness/src/adapters/linear-orca.ts:93`.
- harness --> GitHub (`gh`) : PRs, checks, comentários, labels, merge REST por SHA, GitHub Issues como tracker : `harness/src/adapters/github-cli.ts:324`, `harness/src/loop/connectors.ts:147`.
- harness --> Linear (via Orca) : fila e escritas idempotentes com `--write-id` : `harness/src/adapters/linear-orca.ts:165-213`.
- harness --> agentskit (ecossistema) : `ecosystem.json` copiado do repositório agentskit alimenta o rodapé do site e as contagens : `harness/scripts/build-docs-artifacts.mjs:78-97`.
- harness --> skills : o repositório empacota o skill `ak-harness-loop` (`harness/skills/ak-harness-loop/SKILL.md`); **não verificado** se/como [[00 Hub - skills]] o distribui.
- harness -/-> fleet : nenhuma referência a "fleet" em `src/`, `docs/`, `README.md`, `skills/` (busca `git grep -i fleet`).
- harness --> Cloudflare : site estático em Workers assets : `harness/wrangler.toml:1-11`; `harness/package.json:107`.
- harness --> npm : publicação por Trusted Publishing/OIDC com proveniência : `harness/.github/workflows/release-harness.yml:109-163`.
- harness --> .github (org) : Renovate herda `github>AgentsKit-io/.github` : `harness/renovate.json:3-5`.
- harness --> Provedores de agente (claude, codex, grok, opencode) : CLIs configuradas em `models.providers.<id>`; uso lido de `orca account list` : `harness/src/adapters/providers.ts:109-131`, `harness/docs/ADR-0027-keep-pushing-loop.md`.
- harness --> Docker (opcional) : runtime sandbox do kernel : `harness/src/execution/runtime.ts:243-295`.

## Infra e deploy

- Pacote npm público `@agentskit/harness` 0.22.3 (`harness/package.json:2-3`), publicado do `main` por Trusted Publishing (sem `NPM_TOKEN`), job `publish` depende de `verify`, `docs` e `loop-cross-platform` (`harness/.github/workflows/release-harness.yml:109-163`); o **nome do arquivo** do workflow faz parte da autorização no npm (`:3-8`).
- CI: um único workflow `release-harness.yml` (Ubuntu para verify/docs; matriz Ubuntu/macOS/Windows para o loop) (`harness/.github/workflows/release-harness.yml:24-104`). Ações fixadas por SHA (`:27-31`).
- Site `harness.agentskit.io` (`harness/apps/docs/lib/site.ts:2`): exportação estática do Next, servida por Cloudflare Workers com assets (`harness/wrangler.toml`); deploy por `pnpm cf:deploy` (`harness/package.json:107`), variáveis `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` (nomes). `vercel.json` permanece e fornece os cabeçalhos copiados para `_headers` (`harness/scripts/cloudflare-headers.mjs:2-16`). **Nenhum workflow publica o site.**
- O loop roda no computador/servidor da equipe: automações do Orca chamam `ak-harness loop stage …`; o tick/deliver real roda em processo destacado (`harness/src/cli.ts:174-199`). A UI local escuta `127.0.0.1:4321`.
- Variáveis de ambiente (nomes): `AK_HARNESS_CONFIG`, `AK_HARNESS_HOME`, `AK_HARNESS_NO_GLOBAL`, `AK_LOOP_TEAM`, `AK_HARNESS_CLI_INTROSPECT`, `GITHUB_TOKEN`, `GH_TOKEN`, `WSL_DISTRO_NAME`, `WSL_INTEROP`, `AGENTSKIT_REVIEW_SUBPROCESS_TIMEOUT_MS`, `HARNESS_REQUIRE_DOCKER` (só teste), `NEXT_PUBLIC_SITE_URL`, `DOCS_BASE_PATH`, `NEXT_PUBLIC_BASE_PATH`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `PATH`/`PATHEXT`; webhook de notificação: variável nomeada por `notifications.webhook.urlEnv`; chaves de API por provedor: `models.providers.<id>.envKeys`.
- Dados locais: `<stateDir>` (`.ak-loop`), `.ak-harness/verification/`, `~/.agentskit/harness.yaml`, `loop.config.local.yaml`; ver tabela em [[harness-loop]].

## Perguntas em aberto (para Dúvidas abertas)

1. A revisão limpa reaproveitada de uma passagem anterior conta como portão no piso do auto-merge? `review` é `null` nesse caminho (`harness/src/loop/deliver.ts:983`, `:1150`).
2. `src/loop/index.ts` é código morto (nenhum import) ou será usado por consumidores externos? (`harness/src/loop/index.ts`.)
3. O site harness.agentskit.io está publicado e como é o deploy (manual `cf:deploy` ou outro processo)? Nenhum workflow o faz.
4. [[00 Hub - skills]] de fato distribui/consome o skill `ak-harness-loop` e lê o estado do loop para relatórios (afirmação da v1 sem evidência)?
5. Há integração com [[00 Hub - fleet]] fora do repositório (uso do loop dentro de agentes da frota)? Dentro do repositório não há.
6. Quem aprova o contrato do próprio repositório, já que a CI encena `plan approved --by human` numa máquina (`harness/.github/workflows/release-harness.yml:41-45`)?
7. `release/manifest.json` mantém `ecosystem-compatibility` e `pilot-benchmark` como critérios bloqueados e um `sourceRevision` antigo (`harness/release/manifest.json:7`, `:30-33`): o bloqueio é histórico ou atual?
8. `docs/LOOP.md` ainda apresenta o runner `local` como funcional: haverá plano de religar o runner (ADR-0039 diz "religar deve ser troca de chamador")?
9. O MCP read-only será ligado ao `doctor`/CLI como o ADR-0028 prevê?
10. A contagem "47 scripts `test:*`" de `AGENTS.md` ainda vale? (não reconferida.)

## Capacidades não usadas (sem chamador no repositório além de testes/exemplos/API pública)

- `createSessionRecorder` e o protocolo de sessão de agente (ADRs 0006, 0007, 0011, 0023): `harness/src/execution/agent.ts:49`; nenhum chamador em `src/` além da definição e da exportação.
- Runtimes de ferramenta `createToolRuntime`, `createProcessToolRuntime`, `createDockerToolRuntime`, `createConfiguredToolRuntime`: `harness/src/execution/runtime.ts:69`, `:146`, `:186`, `:243`.
- `createPluginRegistry` (kernel): `harness/src/kernel/plugins.ts:57` — o loop usa seu próprio barramento (ADR-0030).
- `createLlmCache`, `createModelPolicy`, `compareOptimization`, `runEvalBattery`, `assessCompatibility`, `createQualityMatrix`, `executePhaseProfile` (só `runWorkflow` é usado internamente, por `runAdversarialReview` e `executePhaseProfile`): `harness/src/kernel/cache.ts:42`, `model-policy.ts:24`, `optimization.ts:105`, `eval.ts:181`, `compatibility.ts:108`, `quality.ts:116`, `phase-executor.ts:241`.
- `createCodingAgentAdapter`, `createOrcaLifecycleProjection`: `harness/src/adapters/agent.ts:56`, `harness/src/adapters/orca.ts:89` — só testes/exemplo.
- `createMcpToolBridge`: só autoteste do `doctor` com `call: async () => null` (`harness/src/loop/doctor.ts:213`).
- `createLocalRunner` (git worktree + tmux + crontab): só testes (`harness/test/loop-connectors.test.ts:92`); `connectors.runner: local` é recusado (`harness/src/loop/config.ts:1093`).
- `src/loop/index.ts`: barril que ninguém importa.
- Modo `ak-harness ui --dev`: depende de `pnpm ui:dev` em paralelo na porta 5173 (`harness/src/cli.ts:43`).

Observação: a ausência de chamador vale para esta análise do repositório; consumidores externos do pacote npm não foram investigados.
