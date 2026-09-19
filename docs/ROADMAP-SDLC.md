# Loop Engineer — o SDLC autônomo do `@agentskit/harness` (roadmap)

**Fonte de verdade do desenho deste pacote.** Decidido em grilling de 2026-09-19, uma pergunta por
rodada, com a **0.14.0** como ponto de partida medido: 26 forks, 7 assunções declaradas, 12 passos de
construção. Tudo aqui foi resposta direta, não inferência.

Escopo: **este repositório**. Onde o texto cita um projeto consumidor, é exemplo — o primeiro consumidor
é o `agentskit-os`, que carrega o `loop.config.yaml`, as labels de camada no tracker e as issues de
processo. Nada aqui é trabalho no repositório do consumidor.

Este documento é a base da seção *Concepts* do site (ver §7e) e o critério de "harness pronto".

## 0. A frase

**Um objetivo vago entra; um humano é grelhado até a ideia estar completa; o plano aprovado vira issues;
cada issue passa por planner com votação, team lead com subagentes, verificação, code review e prova de
DoD; a PR merge na integração sozinha; a promoção e o deploy esperam um humano; o retro aprende e ajusta
o próprio loop dentro de limites; tudo configurável por usuário, projeto e team, e plugável por
conector.**

## 1. As stages (cada uma é uma máquina de estados; transição é decisão da máquina, não do modelo)

```
intake[produção → issue] ─┐
                          ▼
plan[interview → review → architect → decompose] ──► tick ──► [worker: planner → vote → lead+subagentes → verify → review → DoD] ──► deliver[+CI babysitting, por perfil] ──► release[notes → promote → deploy → smoke → rollback]
                          ▲                                                                                                                                      │
maintain[deps · segurança · licenças, agendada] ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  ▲                                                                                               │
  └──────────────────────────────── retro (aprende e ajusta knobs) ◄──────────────────────────────┘
```

### 1.1 `plan` — NOVA. Requisitos → PRD → issues
| Fase | Quem age | Sai quando |
|---|---|---|
| **interview** | agente grelha o humano: uma pergunta por vez, sempre com alternativas e recomendação | a máquina não tem mais lacuna aberta (lista de lacunas zerada, não "o modelo acha que acabou") |
| **review** | agente mostra o plano; humano ajusta quantas vezes quiser | humano aprova explicitamente |
| **architect** | modelo forte produz o **desenho técnico de sistema** do PRD inteiro — fronteiras de módulo, contratos/schemas, decisões (ADRs), sequência, riscos; **3 agentes votam**, 2 de 3, máx. 3 ciclos (mesma regra do planner por issue) | consenso **e** aprovação humana do desenho |
| **decompose** | agente quebra o plano em issues com camada, prioridade e critério de aceite verificável, **cada issue apontando para a parte do desenho que implementa** — o planner por issue planeja dentro de uma arquitetura, não inventa uma por ticket | todas as issues criadas em `Todo` no tracker |
| — | `Todo → Ready` | **gesto humano**, o gate único de entrada da fila (decisão de 18/09, mantida) |

- **Driver padrão: terminal** (`ak-harness loop plan "<objetivo>"`). O mesmo motor guia a entrevista
  dentro do app desktop do Claude/Codex quando pedido.
- **Saídas por conector**: o PRD aprovado e as issues vão para onde o projeto/pessoa configurar
  (Linear, GitHub, …). O motor é neutro.
- Estado persistido em `.ak-loop/plans/<id>/state.json`; cada rodada é um evento no `events.ndjson`.

### 1.2 `tick` — EXISTE. Fila → contrato → despacho
Como hoje: fila = `Ready` + sem assignee + `anyLabels` da máquina + projeto; orquestrador congela o
contrato (intent, escopo, outcomes com check); despacho em worktree do Orca; assignee como
reivindicação transitória.

### 1.3 Dentro do worker — NOVO. Pipeline de papéis por issue
| Papel | O que faz | Sai quando |
|---|---|---|
| **planner** | modelo forte escreve o plano técnico (o que muda, testes a escrever, riscos) | plano proposto |
| **vote** | **3 agentes votam**; voto contrário traz objeção concreta; planner incorpora e repropõe | **2 de 3 aprovam**. Máx. **3 ciclos** (configurável). Esgotado → `needs-info` com as objeções não resolvidas — três modelos discordando três vezes é requisito ambíguo, problema de humano |
| **lead** | team lead despacha **subagentes** para desenvolver, verificando qualidade a cada entrega | todo item do plano entregue |
| **verify** | mesmo padrão: lead + subagentes rodam e provam | outcomes do contrato verificados |
| **review** | `@agentskit/code-review` (o gate quando não há CI); rigor por label via `reviewOverrides` | limpo ou findings endereçados |
| **dod** | levanta **prova** de cada item da DoD e escreve no corpo da PR | as duas listas provadas |
| — | abre a PR contra a branch de integração | |

**Restrição de implementação (verificada 13/09):** o Orca não expõe orquestração de terminais sem pane
vivo. Logo o lead e os subagentes vivem **dentro da sessão do worker** (o recurso nativo de subagente do
Claude/Codex); o harness orquestra as **fases** e lê os artefatos de cada uma. Papéis e ordem são config
por projeto/camada; default = `builder → review` (o de hoje), para quem não opta.

### 1.4 DoD — as duas listas, ambas obrigatórias
- **Projeto**: fixa em `loop.config.yaml` (verifyCommand passa, teste novo para código novo, doc tocada,
  sem TODO/FIXME, …), igual para toda issue.
- **Issue**: os `outcomes` do contrato congelado, cada um com seu `check`.
- A PR só abre com as duas provadas; o corpo carrega a evidência de cada item (saída do comando, arquivo,
  diff). O reviewer lê prova, não promessa.

### 1.5 `deliver` — EXISTE. Revisão → merge → escalação → CI babysitting
Como hoje, mais o `blocker` (item escalado fica visível **e** na fila, até `loop:paused` na 3ª falha) e
`knownFailures` (o worker sabe o que já estava vermelho na base).

**CI babysitting** (a caixa "CI" da imagem): com a PR aberta, os checks remotos rodam; check vermelho →
fix round → o worker conserta e empurra → até `CLEAN` → merge. **Já existe** (`assessChecks`,
`requireChecks`, "CI red → fixRound"). É um interruptor de **perfil**: um projeto que não quer gastar
runner deixa **desligado** e a revisão é o gate; outro liga e o loop faz a babá até o check ficar verde.

### 1.6 `release` — NOVA. Promoção e deploy com gate humano
O loop fecha a issue no merge em `project.baseBranch` (a branch de integração). `release` promove
`baseBranch → project.releaseBranch` e dispara o deploy declarado pelo projeto, **só quando o humano
aprova o lote** (`loop release approve`). O que age no mundo continua tendo humano.

### 1.7 `retro` — EXISTE, cresce. Melhoria contínua com limites
- **Memória**: lição vista ≥ 2× promove sozinha (ator `loop-auto`, ADR-0019 emendada), teto por retro,
  só categorias configuradas, revogável.
- **Config**: o retro aplica **só knobs declarados auto-ajustáveis**, dentro do intervalo declarado
  (ex.: `minSeverity` entre `med` e `nit`; `workerIdleTimeoutMin` entre 15 e 45). Cada ajuste é commit
  em `loop.config.yaml` com motivo + evidência, e **desfaz sozinho** se a métrica piorar no ciclo
  seguinte. **Nunca** auto-ajustáveis: modelos, provedores, gates, branch base.

## 2. Configuração — quatro camadas, a mais específica vence, cada uma com dono
| # | Arquivo | Dono | Conteúdo |
|---|---|---|---|
| 1 | `~/.agentskit/harness.yaml` (**global, NOVO**) | usuário | identidade (pessoa/ids), modelos e provedores, esforço, capacidade da máquina, **canal de notificação** |
| 2 | `loop.config.yaml` (repo) | projeto | tracker, estados, gates, revisão, camadas, DoD de projeto, `knownFailures`, conectores, papéis do worker, knobs auto-ajustáveis |
| 3 | `loop.config.team.<key>.yaml` (repo, **NOVO**) | team | o que diverge entre teams no mesmo repo |
| 4 | `loop.config.local.yaml` (fora do git, existe) | máquina | override pontual |

Repo pesa mais que o global; o global fica intacto. Deep-merge, camada posterior vence.

## 3. Escalação ao humano — canal configurável, Linear como piso
O comentário no tracker **sempre** acontece (é o registro). O hook `onEscalate` (existe) despacha
também para o canal declarado no global do usuário — Slack, Telegram, e-mail, notificação do sistema, ou
o Orca se expuser algo. Gatilhos: `needs-info`, `blocker`, plano sem consenso, `loop:paused`, lote
esperando `release`.

## 4. Conectores — Linear + GitHub agora, interface aberta
`TrackerConnector` (issues, estados, comentários, labels) e `ScmConnector` (PR, merge, checks) são
interfaces do motor; Linear e GitHub são as duas implementações da primeira versão. Jira, GitLab, Notion,
GitHub Issues entram como implementação nova contra a interface, sem tocar no motor. O
`adapters/tracking.ts` de hoje é o embrião.

## 4b. Perfis de fluxo — enterprise, POC, incidente P0, no mesmo motor
`flows:` no config declara perfis nomeados; cada perfil liga/desliga **stages, papéis, votação, votos de
review, DoD, CI babysitting e gates humanos**. Uma **regra de seleção por issue** escolhe o perfil: label
(`flow:incident`), prioridade (`Urgent → incident`), projeto, ou default. O global do usuário pode
redefinir perfis; o repo escolhe qual vale.

| Perfil | O que liga |
|---|---|
| `enterprise` | tudo: plan completo com architect votado, papéis com votação, DoD dupla, CI babysitting, release com gate |
| `poc` | plan curto (sem architect votado), `builder → review`, DoD de issue só, sem CI, merge direto na integração |
| `incident` | **pula** plan/architect/votação: contrato mínimo → lead → verify → review → merge; escalação em tempo real; release imediato com gate humano |

## 4c. Automações — declaradas no config, reconciliadas pelo harness, shim no Orca
- `schedule:` no `loop.config.yaml` é a **fonte de verdade de todas** as automações (tick, deliver, retro,
  observer). `loop install` passa a ser **idempotente**: compara o que o runner tem com o que o config
  declara e cria/edita/desliga até casar — caminho do config, precheck, horário, workspace. `loop doctor`
  acusa drift.
- A automação dentro do Orca é um **shim**: só chama `ak-harness loop stage <x> -f <config>`. Horário,
  comportamento e precheck moram no config e no harness — **nunca dentro do Orca**. Ajustar a hora é
  editar o YAML e rodar `loop install`.
- Consequência: o precheck da observer (`scripts/ops/loop-observer-precheck.mjs`, hoje **não versionado**)
  vira subcomando `loop stage observe`. Nenhuma automação depende de arquivo fora do repositório.
- É a correção da raiz do defeito de 2026-09-19: as quatro automações apontavam para um config de 14/09
  porque foram editadas à mão e nunca reconciliadas.

## 4d. Runner — `RunnerConnector`, Orca primeiro, local segundo
O motor passa a falar com `RunnerConnector`: `createWorkspace · launchAgent · send · waitIdle ·
readScreen · schedule · memory`. **Orca** é a primeira implementação; a segunda é **`local`**: worktree
nativa + tmux + cron do sistema. É o runner mais barato de construir, roda em qualquer máquina sem Orca,
e prova que nada no motor depende do Orca — uma interface só nasce honesta com duas implementações.
Nuvem (sandbox remoto) fica como terceira, depois.

## 5. Gates humanos — o mapa completo
| Ponto | Humano? |
|---|---|
| Entrevista terminar | não — a máquina decide, sem lacuna aberta |
| Plano aprovado | **sim** |
| Desenho técnico (architect) | **sim**, depois do consenso 2/3 |
| Issues entrarem na fila (`Todo → Ready`) | **sim** |
| Plano técnico da issue (votação) | não; **sim** se 3 ciclos sem consenso |
| Merge na integração | não |
| Promoção para `main` + deploy | **sim** |
| Memória promovida | não (ADR-0019 emendada) |
| Knob de config ajustado | não, dentro do intervalo; **sim** fora dele |
| Item travado / pausado | **sim**, pelo canal configurado |

## 6. O que existe no harness 0.14.0 vs. o que é trabalho novo
| Peça | Estado |
|---|---|
| `tick`, `deliver`, `retro`, `observe`, `watch`, `doctor`, `debrief` | existe |
| Fila sem dono, `anyLabels`, `reviewOverrides`, `knownFailures`, `blocker` | existe (0.14.0) |
| Overlay local por máquina | existe |
| 8 hooks de plugin (`onEscalate` incluso) | existe |
| Adapter de tracking (Linear) e de SCM (GitHub) acoplados | existe, **sem interface formal** |
| Memória com recorrência | existe; promoção auto = **código pendente** (ADR emendada) |
| **`plan`** (entrevista → plano → decomposição, máquina de estados, driver terminal + app) | **novo** |
| **Pipeline de papéis no worker** (planner, votação 2/3, lead+subagentes, verify, dod) | **novo** |
| **DoD de projeto** + prova no corpo da PR | **novo** |
| **`release`** com gate humano e deploy declarado | **novo** |
| **Global do usuário** (`~/.agentskit/harness.yaml`) + camada de team | **novo** |
| **Canal de escalação** via `onEscalate` lendo o global | **novo** (o hook existe; o plugin não) |
| **Knobs auto-ajustáveis** com intervalo, commit e reversão | **novo** |
| **Interfaces `TrackerConnector` / `ScmConnector`** | **novo** (extrair do que existe) |
| CI babysitting (checks vermelhos → fix round) | existe; vira interruptor de perfil |
| **`plan.architect`** (desenho de sistema votado + aprovado) | **novo** |
| **Perfis `flows:` + regra de seleção por issue** | **novo** |
| **`loop install` idempotente + shim no Orca + `loop stage observe`** | `install` existe; reconciliação, shim e observe são **novos** |
| **`RunnerConnector` + runner `local`** | **novo** (extrair do Orca, depois tmux) |
| Failover de provedor, cooldown, tiers, `maxUsageDeltaPercent`, esforço por papel | existe |
| Bateria de eval de agentes (`runEvalBattery`, `runAgentEval`) | existe; vira o gate de melhoria de agente |
| `guided-install` | existe; vira `loop init` grelhado |
| `agents.registry.yaml` (papel → provedor/modelo) | existe; passa a mapear papel → agente do registry em `agents/<id>/` |
| **Presets por tipo de projeto + override por stage/papel/perfil** | **novo** |
| **Melhoria de agente por diff + eval + reversão** | **novo** (em cima da eval existente) |
| **`routing.policy` + `budget.perProvider` / `budget.perIssue`** | **novo** |
| **Quatro alavancas de custo** | **novo** (prefixo estável, verificador barato, modelo por tamanho, contexto por digest) |
| **`intake`**, **`maintain`**, release notes + rollback em `release` | **novo** |

## 7. Ordem de construção (cada passo deixa o loop funcionando)
1. **Automações reconciliadas + shim + `loop stage observe`** — corrige a raiz do defeito de hoje e faz
   o loop atual rodar de forma reproduzível. Só motor.
2. **Global + team** na config, **perfis `flows:`** e **canal de escalação** — configurável por pessoa,
   projeto e tipo de demanda, e passa a chamar humano.
3. **Promoção de memória `loop-auto`** (ADR já emendada) e **knobs auto-ajustáveis** — o retro melhora
   o loop sozinho.
4. **DoD de projeto + prova na PR** — o deliver exige as duas listas.
5. **Pipeline de papéis no worker** — planner → votação → lead → verify, opcional por perfil; default
   `builder → review`.
6. **`plan`** com **architect** — requisitos e desenho, driver terminal primeiro, app depois.
7. **`release`** — promoção + deploy com aprovação.
8. **`RunnerConnector` + runner local** e **`TrackerConnector`/`ScmConnector`** — extrair as interfaces
   do que existe e provar cada uma com a segunda implementação.
9. **Custo e uso**: as quatro alavancas, `routing.policy` e os dois tetos — cada uma mede antes/depois no
   retro. Entram cedo se o gasto do passo 5 (votação) exigir.
10. **Presets por tipo + `loop init` grelhado** — quando houver o segundo projeto usando o motor.
11. **Papéis como agentes do registry + melhoria por diff/eval** — depois de os papéis existirem (5).
12. **`intake`**, **`maintain`**, notes e rollback em `release` — fecham o ciclo; dependem de 7.

## 7b. Cobertura do fluxo da imagem (PRD → ARCHITECT → DECOMPOSER → IMPLEMENTERS → TEST+REVIEW → CI)
| Caixa | Onde vive no desenho |
|---|---|
| PRD | `plan.interview` + `plan.review` |
| ARCHITECT | `plan.architect` — **era o buraco**, fechado em 2026-09-19 |
| DECOMPOSER | `plan.decompose` |
| IMPLEMENTERS | lead + subagentes dentro do worker |
| TEST + REVIEW | verify + `@agentskit/code-review` + prova de DoD |
| CI | `deliver` com CI babysitting, ligado/desligado por perfil |

Nenhuma caixa descoberta.

## 7c. Ambiguidades fechadas na passada crítica (2026-09-19)

Três forks decididos:

| Fork | Decisão |
|---|---|
| **Onde o planner e a votação rodam** | **No harness, headless, antes do despacho** — igual ao congelamento de contrato de hoje. O harness chama o planner, chama os 3 votantes, conta os votos e controla os ciclos. O modelo produz plano e voto; **a máquina decide**. O lead só nasce com o plano aprovado no briefing. |
| **Casa canônica de PRD, desenho e ADRs** | **Configurável**: `documents:` no config escolhe o backend — arquivo no repo (`docs/prd/`, `docs/design/`, `docs/adr/`, caminhos configuráveis) **ou** um conector (Linear Document, GitHub Discussion, …). Seja qual for, o briefing do worker recebe o **conteúdo** (por caminho no repo, ou buscado pelo conector e pinado por digest), nunca só um link. |
| **Canais de escalação na v1** | **Dois genéricos**: `webhook` (POST com payload JSON — cobre Slack, Discord, Telegram via bot, n8n) e `command` (executável local com o mesmo JSON — cobre notificação do sistema, e-mail por CLI). Zero código por fornecedor; o global do usuário declara um ou os dois. |

Sete pontos que ficaram como assunção declarada (sem veto):

1. **"Sem lacuna" na entrevista** = todo campo obrigatório do **schema de PRD** preenchido (objetivo,
   usuários, escopo in/out, não-objetivos, restrições, critérios de sucesso, riscos) e nenhuma pergunta
   aberta. Schema base no harness; o perfil pode exigir mais ou menos campos.
2. **`layers:` no `loop.config.yaml`** — label, fronteira de arquivo e teste que fecha. O decomposer lê
   daí; as descrições no Linear viram reflexo, não fonte.
3. **Contrato de artefatos worker ↔ harness**: diretório `.ak-loop/` na worktree, um arquivo por fase
   (`plan.md`, `verify.json`, `dod.json`) validado por schema. A máquina avança por presença + validação.
   Estende o `progress.json` existente.
4. **Provedor sem subagente**: perfil que exige lead + subagentes só roteia para provedor que os tem;
   senão o lead trabalha sozinho e o registro diz isso explicitamente. Nunca silencioso.
5. **Item de DoD de projeto** declara `kind`: `command` (sai 0) · `file-changed` (glob) ·
   `pattern-absent` (ex.: sem `TODO`). A evidência é extraída pelo tipo. **Sem item "manual"** — o que não
   se prova não é DoD.
6. **Knob auto-ajustável declara a métrica que o justifica** (`minSeverity` ↔ proporção de reviews com
   findings; `workerIdleTimeoutMin` ↔ contagem de stuck). Sem métrica, não é auto-ajustável — e é ela que
   dispara a reversão.
7. **Precedência de perfil**: `label > projeto > prioridade > default`. Label é intenção explícita;
   prioridade é sinal.

## 7d. Segunda rodada (2026-09-19): tipos de projeto, agentes, uso, custo, etapas descobertas

### Tipos de projeto e setup guiado
- O harness **embarca presets** por tipo (`web-app`, `library`, `monorepo`, `data-pipeline`, `mobile`)
  que preenchem DoD, `layers:`, `verifyCommand`, gates e papéis com defaults; o projeto declara
  `extends: <preset>` e sobrescreve só o que difere.
- **Override por stage e por papel** (`plan`, `tick`, `deliver`, `release`, `retro`, `maintain`,
  `intake` × `interviewer`, `architect`, `planner`, `voter`, `lead`, `verifier`, `reviewer`): modelo,
  esforço, timeout, provedor — **por perfil**.
- **Setup guiado**: `ak-harness loop init` grelha o usuário no terminal com sugestões (mesmo padrão da
  entrevista) e escreve global + projeto; dentro do chat do Claude/Codex faz as mesmas perguntas. O
  `guided-install` existente é o embrião.

### Os papéis são agentes do registry (registry.agentskit.io)
- `npx agentskit add <id>` copia o agente para `agents/<id>/` — **o código é seu**, a cópia no repo é a
  versão, git é o histórico. O `agents.registry.yaml` do harness passa a mapear papel → agente instalado
  (hoje só mapeia papel → provedor/modelo/comando).
- **Melhoria**: o retro correlaciona resultado (findings, fix rounds, escalações, votos contrários) com o
  papel e propõe um **diff em `agents/<id>/`**; a **bateria de eval** existente (`runEvalBattery`) roda o
  agente novo contra casos gravados e só adota se a pontuação não cair e o custo não subir — commit com
  evidência, reversão automática se piorar. Acima de N linhas ou em papel crítico (architect, reviewer)
  pede humano. **Publicar de volta** no registry é sempre gesto humano.

### Distribuição de uso e tetos
- `routing.policy` por papel e por perfil: `quality-first` (melhor até esgotar, failover — o de hoje),
  `usage-balanced` (espalha por uso restante), `cost-first` (mais barato que passa na eval do papel).
  Enterprise: quality-first em architect e reviewer; poc: cost-first; incident: quality-first e **ignora
  teto**.
- `budget.perProvider`: percentual da janela que o loop pode consumir, deixando margem para o humano usar
  o mesmo plano. `budget.perIssue`: tokens/USD por item; estourou → **escala, não insiste**.
- O que já existe e permanece: cooldown ao esgotar, tiers como fallback, `maxUsageDeltaPercent`.

### Redução de custo — as quatro alavancas da v1
1. **Prefixo estável para cache de prompt**: todo briefing/contrato ordena o invariante primeiro (skills,
   regras, DoD de projeto, memória) e o variável por último.
2. **Verificador barato antes do modelo**: testes/lint/typecheck locais antes de qualquer chamada de
   review ou fix round; build quebrado não merece revisão de 2 votos.
3. **Modelo por tamanho da mudança**: diff pequeno ou só docs/testes → modelo barato; diff grande ou em
   fronteira crítica (contratos, segurança) → forte. Regra por perfil, em linhas e caminhos.
4. **Contexto pinado por digest**: skills, regras e memória já enviados não são reenviados; o briefing
   referencia o digest e o worker recebe só o que mudou.
- E a regra: **votos, subagentes e tipo de modelo são knobs de custo por perfil** — poc paga 1 voto e um
  modelo médio; enterprise paga 3 e o forte.

### Etapas que estavam descobertas — todas entram
| Stage | O que faz |
|---|---|
| **`intake`** (nova) | alerta (Sentry/PostHog/webhook), erro de log ou feedback de usuário → deduplica → cria a issue com evidência → aplica o perfil (`incident` se P0). É o que **fecha o ciclo** e o único disparo do perfil incident sem humano digitando. |
| **`release`** ganha | **release notes + CHANGELOG** a partir das PRs mergeadas (título, issue, evidência de DoD) antes de promover; **rollback declarado** por deploy, com smoke pós-deploy que reverte sozinho e escala. |
| **`maintain`** (nova, agendada) | atualiza dependências, roda auditoria de segurança e licenças, abre issue só quando há decisão a tomar — o que o dependabot faz de fora, dentro do loop e com a mesma DoD. |

## 7e. Documentação do harness (decidido 2026-09-19)

Estado medido: o harness tem README + docs com ~3,1 mil linhas, **30 ADRs**, MANIFESTO, SKILL, `capabilities/`,
`examples/` — e **nenhum** site, `llms.txt` ou índice do doc-bridge; não aparece no ecossistema. Cada produto
irmão tem site próprio com o mesmo header e o footer de ecossistema (Doc Bridge: `apps/docs/`, Next.js +
fumadocs, export estático publicado no **GitHub Pages** por `pages.yml`, `components/ecosystem.tsx` lendo
`ecosystem.json`, rota `/for-agents`).

| Decisão | Valor |
|---|---|
| **Casa** | site próprio **no repo do harness** (`apps/docs/`), copiando o padrão do Doc Bridge: Next.js + fumadocs, export estático, GitHub Pages; domínio `harness.agentskit.io` |
| **Nome e hero** | **AgentsKit Harness — "The keep-pushing loop for your SDLC."** Sub: do objetivo vago à produção, sem babá de agente — entrevista, plano, votos, worker, review, merge, release, determinístico, humano só onde age no mundo. CTAs: **Start a loop** (`npx @agentskit/harness loop init`) · **Add to a project** · **See a run** |
| **Header compartilhado** | `Docs · CLI · For agents · GitHub` + footer de ecossistema lendo `ecosystem.json`. Entrar no header/footer de todos = **PR no repo `agentskit/`** adicionando a entrada (`id: harness`, `barLabel`, `domain`, `repo`, `tagline`, `kind: tool`, `accent`, `llms`, `stats`) — cada repo irmão carrega uma cópia do arquivo |
| **IA** | por intenção: Get started · Concepts (o ciclo, stages, máquinas de estado, gates humanos) · Guides por perfil (enterprise/poc/incident) e por papel (operador, worker, agente leitor) · Configuration (4 camadas, presets) · Reference · For agents |
| **Referência** | **gerada do código no build**: config a partir do schema Zod (tipo, default, doc de cada campo), CLI a partir do commander, eventos a partir do bus. Não diverge por construção |
| **ADRs** | **não** vão para a doc pública — ficam em `docs/` do repo, uso interno |
| **Exemplos humanos** | os quatro, com saída real gravada: *Seu primeiro loop em 10 minutos* · *Um caminho por perfil* (mesmo objetivo em enterprise, poc, incident) · *O dia em que o loop escalou* (needs-info, blocker, sem consenso, paused) · *Plugar* (webhook de escalação, runner local, `TrackerConnector` mínimo) |
| **Visual** | **muito Mermaid** — diagramas simples e bem desenhados em todo conceito: o ciclo, cada máquina de estados, o pipeline do worker, as 4 camadas de config, o mapa de gates |
| **For agents** | `/llms.txt` gerado no build, no formato do site principal (`[título](url): descrição`, seções por intenção); tudo público — o harness é open source, sem fronteira de privacidade como o AKOS |
| **doc-bridge** | `ak-docs index` no build + `ak-docs gate` gate-ando a doc escrita contra a fonte; a referência gerada não precisa de gate |
| **Idioma** | inglês, como os irmãos |

## 8. Regras que atravessam tudo
- Toda transição de fase é **decisão da máquina** sobre um estado explícito; o modelo produz artefatos,
  não decide avançar.
- Toda escalação tem **registro no tracker** e nome de quem (ou o quê) decidiu.
- Nada que age no mundo (branch de release, deploy) sem humano. Nada que age no próximo briefing
  (memória, knob) sem limite e sem reversão.
- Toda mudança neste pacote aponta para uma linha deste documento. Se não aponta, é escopo novo e pede
  decisão — não implementação.
