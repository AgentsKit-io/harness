# Inventário: comandos e módulos

Gerado em 2026-10-30 (ticket #253). Os módulos abaixo vêm de `src/`; a coluna de testes é por referência estática
(`test/` importa o arquivo ou usa um símbolo exportado dele). **"Verde" não foi medido aqui**: o CI roda `pnpm test`
a cada PR e só merge com tudo verde, então um módulo com testes referenciados está verde enquanto `main` está verde.

## Consumidores

Fonte: este repositório (`README.md`, `ecosystem.json`, `docs/LOOP.md`). Consumo fora daqui (repos de produto, doc-bridge,
playbook) não é visível a partir deste repo e precisa ser confirmado pelo dono antes de remover algo.

| Consumidor | Usa |
|---|---|
| factory-line | `ak-harness loop` (stage/tick/deliver/plan/release), `ak-verify run`, adapters `github-cli`, `orca` |
| produtos (ex.: link-pay) | `loop.config.yaml` + `loop tick/deliver` (**legado**, ver abaixo), `ak-verify run` |
| doc-bridge | `context resolve`, adapter `doc-bridge`, `context/` |
| playbook | contratos/gates (`delivery *`, `discovery`, `wip`, `cycle`, `block`, `snapshot`) como referência documental |

## Comandos (98 declarados em `src/cli.ts`)

| Grupo | Comandos | Consumidor | Teste |
|---|---|---|---|
| núcleo de execução | `start verify run approve authorize retry cancel status audit clean`, `events *`, `benchmark baseline` | factory-line, produtos (`ak-verify`) | sim (`harness`, `agent`, `lock`, `bundle`, `metrics`) |
| contrato/diagnóstico | `doctor plan context resolve artifacts *` | factory-line, doc-bridge | sim |
| avaliações do playbook | `discovery wip experiment delivery * pilot cycle block * preflight snapshot learning coordination` | playbook (referência) | sim (um arquivo por capacidade) |
| UI | `ui` | operadores | sim (`ui-*`) |
| loop moderno | `loop stage <stage>`, `plan *`, `release *`, `learning *`, `observe`, `watch`, `retro`, `run *`, `status`, `approve`, `resume`, `paused`, `worker-guard`, `doctor`, `validate`, `init`, `install`, `uninstall`, `precheck`, `contract`, `debrief`, `issue-timeline`, `hook` | factory-line | sim (`loop-*`) |
| **loop legado tick/deliver** | `loop tick`, `loop deliver`, `loop tick-worker`, `loop deliver-worker` | produtos com `loop.config.yaml` | sim (`loop-tick`, `loop-deliver`) |

## Módulos

| Módulo | Linhas | Exportado em `index.ts` | Testes |
|---|---|---|---|
| `kernel/adapter-contract.ts` | 45 | sí | 2 arquivo(s) |
| `kernel/artifacts.ts` | 230 | sí | 1 arquivo(s) |
| `kernel/block.ts` | 67 | sí | 2 arquivo(s) |
| `kernel/cache.ts` | 65 | sí | 4 arquivo(s) |
| `kernel/capabilities.ts` | 102 | sí | 2 arquivo(s) |
| `kernel/compatibility.ts` | 127 | sí | 2 arquivo(s) |
| `kernel/constants.ts` | 25 | sí | 1 arquivo(s) |
| `kernel/cycle.ts` | 111 | sí | 2 arquivo(s) |
| `kernel/discovery.ts` | 149 | sí | 3 arquivo(s) |
| `kernel/error-policy.ts` | 51 | sí | 2 arquivo(s) |
| `kernel/errors.ts` | 17 | sí | 27 arquivo(s) |
| `kernel/eval.ts` | 223 | sí | 4 arquivo(s) |
| `kernel/events.ts` | 298 | sí | 9 arquivo(s) |
| `kernel/experiment.ts` | 50 | sí | 1 arquivo(s) |
| `kernel/hash.ts` | 20 | no | 19 arquivo(s) |
| `kernel/json-file.ts` | 32 | no | **nenhum** |
| `kernel/learning.ts` | 107 | sí | 5 arquivo(s) |
| `kernel/memory.ts` | 131 | sí | 9 arquivo(s) |
| `kernel/model-policy.ts` | 37 | sí | 2 arquivo(s) |
| `kernel/optimization.ts` | 122 | sí | 2 arquivo(s) |
| `kernel/phase-executor.ts` | 338 | sí | 3 arquivo(s) |
| `kernel/pii.ts` | 68 | sí | 1 arquivo(s) |
| `kernel/pilot.ts` | 51 | sí | 2 arquivo(s) |
| `kernel/plugins.ts` | 162 | sí | 4 arquivo(s) |
| `kernel/policy.ts` | 54 | sí | 4 arquivo(s) |
| `kernel/preflight.ts` | 57 | sí | 2 arquivo(s) |
| `kernel/process-tree.ts` | 28 | no | **nenhum** |
| `kernel/quality.ts` | 138 | sí | 2 arquivo(s) |
| `kernel/resilience.ts` | 99 | sí | 1 arquivo(s) |
| `kernel/state-machine.ts` | 20 | sí | 8 arquivo(s) |
| `kernel/status.ts` | 55 | sí | 2 arquivo(s) |
| `kernel/tokens.ts` | 14 | no | 1 arquivo(s) |
| `kernel/types.ts` | 217 | sí | 1 arquivo(s) |
| `kernel/wip.ts` | 55 | sí | 2 arquivo(s) |
| `kernel/workflow.ts` | 66 | sí | 3 arquivo(s) |
| `execution/agent.ts` | 122 | sí | 2 arquivo(s) |
| `execution/bundle.ts` | 143 | sí | 2 arquivo(s) |
| `execution/config.ts` | 154 | sí | 22 arquivo(s) |
| `execution/coordination.ts` | 163 | sí | 9 arquivo(s) |
| `execution/evidence.ts` | 42 | sí | 2 arquivo(s) |
| `execution/files.ts` | 45 | sí | 3 arquivo(s) |
| `execution/machine.ts` | 115 | sí | 3 arquivo(s) |
| `execution/metrics.ts` | 368 | sí | 3 arquivo(s) |
| `execution/runs.ts` | 41 | no | 1 arquivo(s) |
| `execution/runtime.ts` | 330 | sí | 6 arquivo(s) |
| `execution/source.ts` | 43 | no | 1 arquivo(s) |
| `execution/verification.ts` | 273 | sí | 7 arquivo(s) |
| `adapters/agent.ts` | 95 | sí | 2 arquivo(s) |
| `adapters/code-review.ts` | 209 | sí | 2 arquivo(s) |
| `adapters/command.ts` | 73 | sí | 10 arquivo(s) |
| `adapters/doc-bridge.ts` | 116 | sí | 3 arquivo(s) |
| `adapters/github-cli.ts` | 389 | sí | 6 arquivo(s) |
| `adapters/linear-orca.ts` | 222 | sí | 7 arquivo(s) |
| `adapters/mcp.ts` | 71 | sí | 1 arquivo(s) |
| `adapters/orca-cli.ts` | 421 | sí | 4 arquivo(s) |
| `adapters/orca.ts` | 103 | sí | 4 arquivo(s) |
| `adapters/providers.ts` | 201 | sí | 6 arquivo(s) |
| `adapters/rag-context.ts` | 120 | sí | 1 arquivo(s) |
| `adapters/tracking.ts` | 49 | sí | 3 arquivo(s) |
| `delivery/index.ts` | 168 | sí | 154 arquivo(s) |
| `delivery/review.ts` | 55 | sí | 1 arquivo(s) |
| `context/index.ts` | 93 | sí | 154 arquivo(s) |
| `profiles/index.ts` | 58 | sí | 154 arquivo(s) |
| `loop/agent-improvement.ts` | 196 | sí | 1 arquivo(s) |
| `loop/agent-registry.ts` | 83 | sí | 2 arquivo(s) |
| `loop/agent-runs.ts` | 475 | sí | 3 arquivo(s) |
| `loop/artifacts.ts` | 124 | sí | 2 arquivo(s) |
| `loop/automations.ts` | 232 | sí | 6 arquivo(s) |
| `loop/base-view.ts` | 68 | sí | 2 arquivo(s) |
| `loop/brief.ts` | 191 | sí | 5 arquivo(s) |
| `loop/budget.ts` | 124 | sí | 1 arquivo(s) |
| `loop/comment-format.ts` | 118 | sí | 1 arquivo(s) |
| `loop/config.ts` | 1499 | sí | 68 arquivo(s) |
| `loop/connectors.ts` | 335 | sí | 3 arquivo(s) |
| `loop/contract.ts` | 466 | sí | 19 arquivo(s) |
| `loop/cooldown.ts` | 45 | sí | 4 arquivo(s) |
| `loop/debrief.ts` | 325 | sí | 3 arquivo(s) |
| `loop/deliver-state.ts` | 130 | no | 11 arquivo(s) |
| `loop/deliver.ts` | 1970 | sí | 7 arquivo(s) |
| `loop/detached-worker.ts` | 51 | no | 2 arquivo(s) |
| `loop/detect.ts` | 275 | no | 2 arquivo(s) |
| `loop/doctor.ts` | 329 | sí | 4 arquivo(s) |
| `loop/documents.ts` | 136 | sí | 1 arquivo(s) |
| `loop/dod.ts` | 188 | sí | 4 arquivo(s) |
| `loop/event-bus.ts` | 107 | sí | 7 arquivo(s) |
| `loop/event-vocabulary.ts` | 263 | sí | 1 arquivo(s) |
| `loop/evidence.ts` | 327 | sí | 2 arquivo(s) |
| `loop/fleet-dod.ts` | 211 | no | 2 arquivo(s) |
| `loop/fleet-fix.ts` | 88 | no | **nenhum** |
| `loop/fleet-handoff.ts` | 62 | no | 1 arquivo(s) |
| `loop/fleet-runner.ts` | 232 | no | 1 arquivo(s) |
| `loop/flows.ts` | 159 | sí | 1 arquivo(s) |
| `loop/fs-atomic.ts` | 74 | no | 5 arquivo(s) |
| `loop/github-intake.ts` | 63 | sí | 1 arquivo(s) |
| `loop/guided-install.ts` | 157 | sí | 2 arquivo(s) |
| `loop/hitl.ts` | 204 | sí | 5 arquivo(s) |
| `loop/index.ts` | 122 | sí | 154 arquivo(s) |
| `loop/init.ts` | 160 | sí | 1 arquivo(s) |
| `loop/install.ts` | 127 | sí | 5 arquivo(s) |
| `loop/intake.ts` | 206 | sí | 1 arquivo(s) |
| `loop/issue-timeline.ts` | 123 | sí | 1 arquivo(s) |
| `loop/layers.ts` | 57 | sí | 1 arquivo(s) |
| `loop/lesson-checks.ts` | 66 | no | 1 arquivo(s) |
| `loop/lifecycle.ts` | 183 | sí | 1 arquivo(s) |
| `loop/local-config.ts` | 101 | sí | 3 arquivo(s) |
| `loop/memory.ts` | 286 | sí | 6 arquivo(s) |
| `loop/merge-policy.ts` | 85 | no | 1 arquivo(s) |
| `loop/notify.ts` | 107 | sí | 2 arquivo(s) |
| `loop/observability.ts` | 210 | sí | 2 arquivo(s) |
| `loop/observe-stage.ts` | 143 | sí | 2 arquivo(s) |
| `loop/output-block.ts` | 74 | sí | 1 arquivo(s) |
| `loop/plan-stage.ts` | 440 | sí | 4 arquivo(s) |
| `loop/plan-vote.ts` | 321 | sí | 2 arquivo(s) |
| `loop/presets.ts` | 88 | sí | 2 arquivo(s) |
| `loop/process.ts` | 100 | sí | 6 arquivo(s) |
| `loop/progress.ts` | 27 | sí | 1 arquivo(s) |
| `loop/queue-waiting.ts` | 11 | no | 1 arquivo(s) |
| `loop/queue.ts` | 298 | sí | 8 arquivo(s) |
| `loop/refill.ts` | 84 | no | **nenhum** |
| `loop/release.ts` | 245 | sí | 3 arquivo(s) |
| `loop/resilience-state.ts` | 220 | sí | 6 arquivo(s) |
| `loop/retro.ts` | 386 | sí | 11 arquivo(s) |
| `loop/rotation.ts` | 50 | sí | 2 arquivo(s) |
| `loop/routing.ts` | 256 | sí | 5 arquivo(s) |
| `loop/runner-connector.ts` | 157 | sí | 3 arquivo(s) |
| `loop/skills.ts` | 77 | sí | 1 arquivo(s) |
| `loop/slots.ts` | 92 | sí | 2 arquivo(s) |
| `loop/spec.ts` | 145 | no | 2 arquivo(s) |
| `loop/stage-lock.ts` | 91 | no | 2 arquivo(s) |
| `loop/terminal-reaper.ts` | 191 | no | 2 arquivo(s) |
| `loop/tick.ts` | 1274 | sí | 15 arquivo(s) |
| `loop/tracker-cooldown.ts` | 79 | no | 1 arquivo(s) |
| `loop/tracker.ts` | 31 | sí | 1 arquivo(s) |
| `loop/tuning.ts` | 219 | sí | 2 arquivo(s) |
| `loop/verdict.ts` | 100 | no | 1 arquivo(s) |
| `loop/verifier.ts` | 190 | no | 1 arquivo(s) |
| `loop/watch.ts` | 191 | sí | 1 arquivo(s) |
| `loop/worker-guard.ts` | 173 | sí | 1 arquivo(s) |

## Sem teste direto

`kernel/json-file`, `kernel/process-tree`, `loop/fleet-fix` e `loop/refill` não têm teste que os referencie, mas todos
têm consumidor interno (`loop/*`, `ui/api/*`, `execution/verification`), cobertos indiretamente pelos testes dos chamadores.
**Nenhum módulo ficou ao mesmo tempo sem consumidor e sem teste**, então nada foi removido nem movido para
`experimental/` neste PR.

## Pacote publicado: antes e depois

Medido em bytes sobre os arquivos de `files` fora de `dist` (o build não roda sem dependências instaladas neste ambiente).

| | Antes | Depois |
|---|---|---|
| `docs/` publicado | 418 382 B (ADRs, PRD, bench, stability, for-agents, …) | 84 933 B (`GETTING-STARTED`, `TROUBLESHOOTING`, `LOOP`, `INVENTARIO`) |
| comandos CLI | 98 | 98 (nenhum sem consumidor/teste; ver acima) |

ADRs e demais docs continuam no repositório, só deixam de ir no tarball.

## Loop tick/deliver: legado

`loop tick` / `loop deliver` (e os workers) são o caminho antigo de despacho via Orca. A direção do dono (docs/DIRECAO-2026-10-29.md,
**ausente deste repo**) é a factory-line; o loop é mantido sem novas features. Repos que ainda o usam, conforme conhecido:

- link-pay (`loop.config.yaml`)

Lista a completar pelo dono: este repo não enxerga os demais.
