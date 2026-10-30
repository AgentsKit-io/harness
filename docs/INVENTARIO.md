# Inventário: comandos e módulos

Gerado em 2026-10-30 (ticket #253). Consumidores vêm de uma busca real em todos os repos da org AgentsKit-io
(`gh search code` + clone raso e `grep` de `ak-harness`, `ak-verify`, `@agentskit/harness`, `loop.config.yaml`,
`loop tick|deliver` e de cada subcomando). Testes: `pnpm vitest run` = **197 arquivos, todos verdes** (2 087 testes, 6 skipped).

## Consumidores (busca na org)

| Repo | O que usa |
|---|---|
| factory (factory-line) | `loop.config.yaml` com `runner: fleet`; importa/chama `@agentskit/harness` (fixado 0.22.3, mínimo checado em `setup-coordinator`/`work-source`); `policy/agents.json` |
| law-os | `loop.config.yaml` (`runner: fleet`); `ak-harness -c .ak-harness/verification.json doctor`, `plan approved`, `start`, `verify` (`law-local.mjs`); `ak-verify run`; `.ak-harness/verification.json` |
| marketing-os | `loop.config.yaml` (`runner: fleet`, `delivery`); padrão `EvalManifest` do harness |
| agents-playbook | `ak-harness doctor`, `ak-verify run` (scripts `harness:doctor`/`harness:verify`); dependência `@agentskit/harness ^0.22.3`; `.ak-harness/verification.json` |
| doc-bridge | dependência `@agentskit/harness 0.22.3`; `bin/ak-verify.js`, `scripts/verification-harness.mjs` (`ak-verify run`); `loop.config.example.yaml` e `docs/loop-workflow.md` (`loop install`, **`loop tick`**) |
| skills (plugin agentskit-pm) | `npx @agentskit/harness status --json` (`product-status`) |
| code-review, agentskit-registry | só `ak-verify` transitivo (lockfile) |
| brain | documentação (cofre), não executa |
| agentskit, agentskit-chat, ak-cloud, ak-admin, ak-desktop, broker-os, alexandria, infra, factory-sandbox, ecosystem-distribution-ops | nenhum uso do harness além de `.gitignore`/docs |

Nenhum repo chama `discovery`, `experiment`, `pilot`, `cycle`, `snapshot`, `learning parse` nem `coordination claim`
(zero ocorrências de código; só docs deste repo e do `brain`). `link-pay` não está na org AgentsKit-io: não pôde ser consultado.

## Comandos (85 declarados em `src/cli.ts`; eram 98)

| Grupo | Comandos | Consumidor | Teste |
|---|---|---|---|
| núcleo de execução | `start verify run approve authorize retry cancel status audit clean`, `events *`, `benchmark baseline` | law-os, agents-playbook, skills, doc-bridge (`ak-verify`) | `harness`, `agent`, `lock`, `bundle`, `metrics` |
| contrato/diagnóstico | `doctor plan context resolve artifacts *` | law-os, agents-playbook, factory | sim |
| gates do playbook mantidos | `wip delivery * block * preflight` | referência documental (sem chamador externo, mas pequenos e usados por `loop`) | sim |
| UI | `ui` | operadores | `ui-*` |
| loop moderno | `loop stage <stage>`, `plan *`, `release *`, `learning *`, `observe`, `watch`, `retro`, `run *`, `status`, `approve`, `resume`, `paused`, `worker-guard`, `doctor`, `validate`, `init`, `install`, `uninstall`, `precheck`, `contract`, `debrief`, `issue-timeline`, `hook` | factory, law-os, marketing-os (`runner: fleet`) | `loop-*` |
| **loop legado tick/deliver** | `loop tick`, `loop deliver`, `loop tick-worker`, `loop deliver-worker` | doc-bridge (exemplo/doc), link-pay (fora da org) | `loop-tick`, `loop-deliver` |
| **removidos (-13)** | `discovery assess`, `experiment select`, `pilot`, `cycle assess`, `snapshot` (+`validate`), `learning parse`, `coordination claim` (e os grupos pai) | nenhum | — (módulos `discovery/experiment/pilot/cycle` em `experimental/`) |

## Módulos

Cobertura de linhas medida em `pnpm vitest run --coverage` (194 → 197 arquivos de teste, **todos verdes**, 2 081+ testes passando).
"Testes diretos" são os arquivos de `test/` que importam o módulo; "só via `index`/chamadores" quer dizer que os testes
o exercitam pelo `src/index.ts` ou por quem o chama.

| Módulo | Em `index.ts` | Linhas cobertas | Testes diretos |
|---|---|---|---|
| `kernel/adapter-contract.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/artifacts.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/block.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/cache.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/capabilities.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/compatibility.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/constants.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/error-policy.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/errors.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/eval.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/events.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/hash.ts` | no | 100% | artifacts, eval-battery, execution-coordination (+6) |
| `kernel/json-file.ts` | no | 100% | kernel-json-file |
| `kernel/learning.ts` | sí | 100% | loop-lesson-checks, loop-memory-gaps, loop-memory |
| `kernel/memory.ts` | sí | 100% | loop-memory-gaps |
| `kernel/model-policy.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/optimization.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/phase-executor.ts` | sí | 97% | só via `index`/chamadores |
| `kernel/pii.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/plugins.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/policy.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/preflight.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/process-tree.ts` | no | 100% | kernel-process-tree |
| `kernel/quality.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/resilience.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/state-machine.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/status.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/tokens.ts` | no | 100% | token-estimate |
| `kernel/types.ts` | sí | 100% | execution-evidence |
| `kernel/wip.ts` | sí | 100% | só via `index`/chamadores |
| `kernel/workflow.ts` | sí | 100% | só via `index`/chamadores |
| `execution/agent.ts` | sí | 95% | só via `index`/chamadores |
| `execution/bundle.ts` | sí | 100% | só via `index`/chamadores |
| `execution/config.ts` | sí | 100% | só via `index`/chamadores |
| `execution/coordination.ts` | sí | 100% | ui-api-actions, ui-core-reconcile, ui-core-server |
| `execution/evidence.ts` | no | 100% | execution-evidence |
| `execution/files.ts` | sí | 92% | só via `index`/chamadores |
| `execution/machine.ts` | sí | 98% | execution-machine-linux-swap |
| `execution/metrics.ts` | sí | 99% | execution-metrics-windows |
| `execution/runs.ts` | no | 100% | só via `index`/chamadores |
| `execution/runtime.ts` | sí | 100% | execution-runtime-windows |
| `execution/source.ts` | no | 100% | source |
| `execution/verification.ts` | sí | 98% | só via `index`/chamadores |
| `adapters/agent.ts` | sí | 100% | só via `index`/chamadores |
| `adapters/code-review.ts` | sí | 93% | só via `index`/chamadores |
| `adapters/command.ts` | sí | 100% | loop-fleet-fix, loop-verdict, ui-actions (+6) |
| `adapters/doc-bridge.ts` | sí | 100% | só via `index`/chamadores |
| `adapters/github-cli.ts` | sí | 98% | só via `index`/chamadores |
| `adapters/linear-orca.ts` | sí | 100% | só via `index`/chamadores |
| `adapters/mcp.ts` | sí | 100% | só via `index`/chamadores |
| `adapters/orca-cli.ts` | sí | 100% | loop-terminal-reaper |
| `adapters/orca.ts` | sí | 100% | só via `index`/chamadores |
| `adapters/providers.ts` | sí | 100% | adapters-providers-gaps, loop-routing-gaps, routing-dynamic |
| `adapters/rag-context.ts` | sí | 100% | só via `index`/chamadores |
| `adapters/tracking.ts` | sí | 100% | só via `index`/chamadores |
| `delivery/index.ts` | sí | 100% | só via `index`/chamadores |
| `delivery/review.ts` | no | 91% | só via `index`/chamadores |
| `context/index.ts` | sí | 100% | context |
| `profiles/index.ts` | no | 100% | só via `index`/chamadores |
| `loop/agent-improvement.ts` | sí | 98% | só via `index`/chamadores |
| `loop/agent-registry.ts` | sí | 100% | só via `index`/chamadores |
| `loop/agent-runs.ts` | sí | 94% | loop-agent-runs, loop-deliver |
| `loop/artifacts.ts` | sí | 100% | só via `index`/chamadores |
| `loop/automations.ts` | sí | 100% | loop-doctor-gaps, ui-api-server, ui-system |
| `loop/base-view.ts` | sí | 100% | só via `index`/chamadores |
| `loop/brief.ts` | sí | 94% | loop-memory |
| `loop/budget.ts` | sí | 100% | só via `index`/chamadores |
| `loop/comment-format.ts` | sí | 100% | loop-evidence |
| `loop/config.ts` | sí | 100% | loop-memory-gaps, loop-memory, loop-model-catalog (+10) |
| `loop/connectors.ts` | sí | 88% | loop-refill |
| `loop/contract.ts` | sí | 96% | loop-contract-failure, loop-memory, ui-core-server (+1) |
| `loop/cooldown.ts` | sí | 100% | ui-system |
| `loop/debrief.ts` | sí | 100% | só via `index`/chamadores |
| `loop/deliver-state.ts` | no | 100% | loop-terminal-reaper, loop-verdict |
| `loop/deliver.ts` | sí | 88% | loop-deliver, ui-actions, ui-api-actions (+2) |
| `loop/detached-worker.ts` | no | 100% | cli-exit-codes, detached-worker |
| `loop/detect.ts` | no | 96% | loop-config-detect |
| `loop/doctor.ts` | sí | 97% | ui-system |
| `loop/documents.ts` | sí | 98% | só via `index`/chamadores |
| `loop/dod.ts` | sí | 98% | loop-verdict |
| `loop/event-bus.ts` | sí | 100% | loop-agent-runs |
| `loop/event-vocabulary.ts` | sí | 100% | só via `index`/chamadores |
| `loop/evidence.ts` | sí | 99% | loop-evidence |
| `loop/fleet-dod.ts` | no | 98% | loop-fleet-dod, loop-fleet-handoff |
| `loop/fleet-fix.ts` | no | 89% | loop-fleet-fix-direct |
| `loop/fleet-handoff.ts` | no | 100% | loop-fleet-handoff |
| `loop/fleet-runner.ts` | no | 100% | loop-fleet-runner |
| `loop/flows.ts` | sí | 100% | só via `index`/chamadores |
| `loop/fs-atomic.ts` | no | 100% | fs-atomic, loop-fs-atomic, ui-actions (+2) |
| `loop/github-intake.ts` | sí | 100% | só via `index`/chamadores |
| `loop/guided-install.ts` | sí | 100% | só via `index`/chamadores |
| `loop/hitl.ts` | sí | 84% | loop-hitl, ui-api-actions, ui-api-server (+1) |
| `loop/index.ts` | no | 100% | só via `index`/chamadores |
| `loop/init.ts` | sí | 82% | só via `index`/chamadores |
| `loop/install.ts` | sí | 96% | ui-system |
| `loop/intake.ts` | sí | 94% | só via `index`/chamadores |
| `loop/issue-timeline.ts` | sí | 100% | só via `index`/chamadores |
| `loop/layers.ts` | sí | 100% | só via `index`/chamadores |
| `loop/lesson-checks.ts` | no | 100% | loop-lesson-checks |
| `loop/lifecycle.ts` | sí | 90% | só via `index`/chamadores |
| `loop/local-config.ts` | sí | 100% | ui-config |
| `loop/memory.ts` | sí | 98% | loop-lesson-checks, loop-memory-gaps, loop-memory (+2) |
| `loop/merge-policy.ts` | no | 100% | loop-merge-policy |
| `loop/notify.ts` | sí | 100% | só via `index`/chamadores |
| `loop/observability.ts` | sí | 96% | só via `index`/chamadores |
| `loop/observe-stage.ts` | sí | 98% | só via `index`/chamadores |
| `loop/output-block.ts` | sí | 100% | só via `index`/chamadores |
| `loop/plan-stage.ts` | sí | 99% | ui-actions |
| `loop/plan-vote.ts` | sí | 97% | loop-spec |
| `loop/presets.ts` | sí | 100% | só via `index`/chamadores |
| `loop/process.ts` | sí | 89% | loop-fleet-dod, loop-fleet-handoff, loop-verdict |
| `loop/progress.ts` | sí | 100% | só via `index`/chamadores |
| `loop/queue-waiting.ts` | no | 100% | loop-queue-waiting |
| `loop/queue.ts` | sí | 89% | ui-actions, ui-api-actions, ui-config (+2) |
| `loop/refill.ts` | no | 95% | loop-refill |
| `loop/release.ts` | sí | 84% | ui-actions |
| `loop/resilience-state.ts` | sí | 99% | ui-actions, ui-api-actions, ui-system |
| `loop/retro.ts` | sí | 96% | ui-actions, ui-api-actions, ui-feed (+2) |
| `loop/rotation.ts` | sí | 100% | só via `index`/chamadores |
| `loop/routing.ts` | sí | 99% | loop-routing-gaps, routing-dynamic |
| `loop/runner-connector.ts` | sí | 88% | loop-verifier |
| `loop/skills.ts` | sí | 100% | só via `index`/chamadores |
| `loop/slots.ts` | sí | 100% | só via `index`/chamadores |
| `loop/spec.ts` | no | 100% | loop-deliver, loop-spec |
| `loop/stage-lock.ts` | no | 95% | cli-exit-codes, stage-lock |
| `loop/terminal-reaper.ts` | no | 100% | loop-terminal-reaper, loop-tick |
| `loop/tick.ts` | sí | 89% | ui-api-actions, ui-core-server, ui-store (+1) |
| `loop/tracker-cooldown.ts` | no | 100% | loop-deliver |
| `loop/tracker.ts` | sí | 100% | loop-spec |
| `loop/tuning.ts` | sí | 92% | ui-config |
| `loop/verdict.ts` | no | 100% | loop-verdict |
| `loop/verifier.ts` | no | 98% | loop-verifier |
| `loop/watch.ts` | sí | 100% | só via `index`/chamadores |
| `loop/worker-guard.ts` | sí | 100% | loop-worker-guard |

### Movidos para `experimental/` (fora de `src/`, do pacote publicado, do `index.ts` e do `cli.ts`)

`experimental/discovery.ts`, `experiment.ts`, `pilot.ts`, `cycle.ts`: avaliações do playbook sem nenhum chamador fora deste
repo (ver Consumidores). Mantêm os testes (`test/discovery`, `experiment`, `pilot`, `cycle`, `kernel-cycle`,
`kernel-pilot-gaps`), que continuam verdes; não são compilados pelo `tsup` nem tipados pelo `tsc` (`rootDir: src`).

## Sem teste direto (resolvido)

`kernel/json-file`, `kernel/process-tree`, `loop/fleet-fix` e `loop/refill` não tinham teste; agora têm
(`kernel-json-file`, `kernel-process-tree`, `loop-fleet-fix-direct`, `loop-refill`).

## Pacote publicado: antes e depois

Medido com `npm pack --dry-run --json` depois de `pnpm build` (inclui `dist`), antes = `ee0273b`, depois = este PR.

| | Antes | Depois |
|---|---|---|
| tarball | 2 588 560 B | 2 493 755 B (-94 805 B) |
| descompactado | 10 699 836 B | 10 267 975 B (-431 861 B) |
| arquivos no tarball | 86 | 33 |
| comandos CLI (`.command(` em `cli.ts`) | 98 | 85 |

ADRs e demais docs continuam no repositório, só deixam de ir no tarball.

## Loop tick/deliver: legado

`loop tick` / `loop deliver` (e os workers) são o caminho antigo de despacho via Orca. A direção do dono (docs/DIRECAO-2026-10-29.md,
**ausente deste repo**) é a factory-line; o loop é mantido sem novas features. Quem ainda o usa, pela busca na org:

- doc-bridge: `loop.config.example.yaml` e `docs/loop-workflow.md` (`ak-harness loop tick --dry-run --max 1`)
- link-pay (`loop.config.yaml`): fora da org AgentsKit-io, não verificável daqui

factory, law-os e marketing-os têm `loop.config.yaml` mas com `runner: fleet` (factory-line), sem chamar `tick`/`deliver`.
