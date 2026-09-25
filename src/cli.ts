#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import { approveRun, ARTIFACT_SCHEMA_VERSION, assessAcceptance, assessBlock, assessDiscovery, assessImprovementCycle, assessIntegration, assessPilot, assessPreflight, assessProduction, assessWip, assessWorktreeCleanup, authorizeRun, benchmarkRuns, cancelRun, cleanTaskArtifacts, composePullRequest, createDispatchLedger, createDocBridgeContextProvider, createStatusSnapshot, exportEvidenceBundle, FileArtifactStore, loadBenchmarkManifest, loadConfig, loadLatestRun, parseRetro, planFilePreflight, planRun, readArtifactFile, readContextSnapshots, readEvidenceTrustStore, reconcileRun, recordBenchmarkObservation, renderArtifactMarkdown, retryRun, selectRuntime, startRun, validateBlockManifest, validateStatusSnapshot, verifyEvidenceBundle, verifyRun } from './index.js'
import type { BenchmarkObservationEvidence } from './execution/metrics.js'
import { fail } from './kernel/errors.js'
import { appendLoopEvent, approveHeldDelivery, ensureBaseView, attachNotifier, buildDebriefReport, buildRetroReport, createLoopEventBus, createProcessRunner, createRichIO, formatWatchEvent, generateContract, installLoopAutomations, loadLoopConfig, loadLoopPlugins, openLoopMemory, promoteLearningsToMemory, requireWritableTracker, resolveConnectors, runGuidedInstall, runLoopInit, loopStatus, renderDebriefMarkdown, renderObservabilityMarkdown, renderRetroMarkdown, retroLearnings, runRetroStage, precheckDeliver, precheckTick, rankModels, promoteLearnings, writePrdDocument, writeDesignDocument, documentRoot, readCheckoutState, readLearningsLedger, startPlan, interviewRound, answerRound, approvePlan, architectRound, approveDesign, decomposeRound, createPlannedIssues, designApproved, listPlans, prdGaps, readPlanState, writePlanState, renderPlanMarkdown, readStoredContract, writeLearningsLedger, runDeliver, runLoopDoctor, runIntakeStage, runMaintainStage, readReleaseBatch, readReleaseState, approveRelease, renderReleaseMarkdown, runReleaseStage, runObservability, runObserveStage, runTick, uninstallLoopAutomations, watchDeliveries, writeStoredContract, isStagePaused, recordStageRunResult, resumeIssue, resumeStage, readIssueFailures, stageEntry, listPausedIssues, readLastConfigHash, writeLastConfigHash, buildIssueTimeline, renderIssueTimelineMarkdown, runWorkerGuard, type LoopStageName } from './index.js'
import { FileEventStore, inspectEventLogLock, recoverEventLogLock } from './kernel/events.js'
import { acquireStageLock } from './loop/stage-lock.js'
import { startUiServer } from './ui/server.js'

interface CliOptions { readonly config: string; readonly json: boolean }
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { readonly version: string }
const program = new Command()
program.name('ak-harness').description('Portable, evidence-backed development harness for coding agents.').version(packageJson.version).option('-c, --config <path>', 'verification contract path (default: .ak-harness/verification.json, falling back to a legacy .codex/verification.json)').option('--json', 'emit machine-readable output')
const options = (): CliOptions => program.opts<CliOptions>()
const print = (value: unknown): void => { if (options().json) console.log(JSON.stringify(value)); else console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) }
let activeUiShutdown: (() => Promise<void>) | null = null
const readBenchmarkEvidence = (path: string): { readonly evidence: readonly BenchmarkObservationEvidence[]; readonly digest: string } => {
  try {
    const content = readFileSync(path, 'utf8')
    const raw = JSON.parse(content) as unknown
    const evidence = Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null ? (raw as { readonly evidence?: unknown }).evidence : undefined
    if (Array.isArray(evidence)) return { evidence: evidence as BenchmarkObservationEvidence[], digest: createHash('sha256').update(content).digest('hex') }
  } catch (error) {
    fail(`Invalid benchmark evidence JSON: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_INPUT')
  }
  return fail('benchmark evidence file must contain an array or an object with an evidence array.', 'INVALID_INPUT')
}
const decisionArgs = (first: string, second: string | undefined): { readonly decision: string; readonly runId?: string } => {
  const decisions = new Set(['approved', 'approve', 'yes', 'ok', 'rejected', 'reject', 'no'])
  return decisions.has(first) ? { decision: first, ...(second ? { runId: second } : {}) } : { decision: second ?? '', runId: first }
}
const readJsonInput = (path: string, label: string): unknown => {
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown } catch (error) { return fail(`Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_INPUT') }
}
program.command('doctor').description('Validate the contract without starting a run.').action(() => print({ status: 'passed', criteria: ['package'], config: loadConfig(options().config).config }))
program.command('ui').description('Start the local Harness operational UI.').option('--loop-config <path>', 'loop configuration path', 'loop.config.yaml').option('--host <host>', 'loopback host to bind', '127.0.0.1').option('--port <port>', 'TCP port (0 selects a free port)', (value: string) => Number(value), 4321).option('--window-hours <hours>', 'event window shown in the UI', (value: string) => Number(value), 24).action(async (command: { readonly loopConfig: string; readonly host: string; readonly port: number; readonly windowHours: number }) => {
  const server = await startUiServer({ configPath: command.loopConfig, host: command.host, port: command.port, windowHours: command.windowHours })
  activeUiShutdown = server.close
  print({ status: 'listening', url: server.url, message: 'Press Ctrl-C to stop the Harness UI.' })
})
program.command('plan <decision>').description('Approve the frozen task contract and create a planned run.').option('--by <actor>', 'approval actor', 'human').option('--allow-dirty', 'allow a human-authorized dirty worktree').option('--context-file <path>', 'attach a context snapshot JSON file').action(async (decision: string, command: { readonly by: string; readonly allowDirty?: boolean; readonly contextFile?: string }) => print(await planRun({ configPath: options().config, decision, actor: command.by, allowDirty: command.allowDirty ?? false, contextSnapshots: command.contextFile ? readContextSnapshots(command.contextFile) : [] })))
const context = program.command('context').description('Resolve portable, provenance-bearing context snapshots.')
context.command('resolve <query>').description('Resolve a Doc Bridge snapshot from the local index.').option('--provider <provider>', 'context provider', 'doc-bridge').option('--scope <scope...>', 'optional search scopes').option('--index <path>', 'Doc Bridge index path', '.doc-bridge/index.json').action(async (query: string, command: { readonly provider: string; readonly scope?: readonly string[]; readonly index: string }) => {
  if (command.provider !== 'doc-bridge') fail(`Unsupported context provider: ${command.provider}`, 'INVALID_INPUT')
  const loaded = loadConfig(options().config)
  print(await createDocBridgeContextProvider({ root: loaded.root, indexPath: command.index }).resolve({ query, ...(command.scope?.length ? { scope: command.scope } : {}) }))
})
const discovery = program.command('discovery').description('Assess a structured discovery result before implementation.')
discovery.command('assess <input>').description('Emit Ready or a human decision packet from a discovery JSON file.').action((input: string) => print(assessDiscovery(readJsonInput(input, 'discovery input') as Parameters<typeof assessDiscovery>[0])))
const wip = program.command('wip').description('Assess deterministic WIP admission before starting work.')
wip.command('assess <input>').description('Emit an admission decision from WIP ledger JSON.').action((input: string) => print(assessWip(readJsonInput(input, 'WIP input') as Parameters<typeof assessWip>[0])))
const experiment = program.command('experiment').description('Select a runtime only from a controlled, comparable experiment.')
experiment.command('select <input>').description('Select the eligible runtime from experiment JSON.').action((input: string) => print(selectRuntime(readJsonInput(input, 'experiment input') as Parameters<typeof selectRuntime>[0])))
const delivery = program.command('delivery').description('Assess deterministic G2–G5 gates and prepare idempotent PR handoff.')
delivery.command('preflight <input>').action((input: string) => print(assessPreflight(readJsonInput(input, 'preflight input') as Parameters<typeof assessPreflight>[0])))
delivery.command('pr <input>').action((input: string) => print(composePullRequest(readJsonInput(input, 'PR input') as Parameters<typeof composePullRequest>[0])))
delivery.command('integration <input>').action((input: string) => print(assessIntegration(readJsonInput(input, 'integration input') as Parameters<typeof assessIntegration>[0])))
delivery.command('production <input>').action((input: string) => print(assessProduction(readJsonInput(input, 'production input') as Parameters<typeof assessProduction>[0])))
delivery.command('acceptance <input>').action((input: string) => print(assessAcceptance(readJsonInput(input, 'acceptance input') as Parameters<typeof assessAcceptance>[0])))
delivery.command('cleanup <input>').action((input: string) => print(assessWorktreeCleanup(readJsonInput(input, 'cleanup input') as Parameters<typeof assessWorktreeCleanup>[0])))
program.command('pilot <input>').description('Freeze and assess a ten-issue pilot cohort.').action((input: string) => print(assessPilot(readJsonInput(input, 'pilot input') as Parameters<typeof assessPilot>[0])))
const cycle = program.command('cycle').description('Run the five-step improvement cycle with explicit adjustment and bounded repetition.')
cycle.command('assess <input>').description('Assess run → verify → adjust → repeat from a cycle JSON file.').action((input: string) => print(assessImprovementCycle(readJsonInput(input, 'cycle input') as Parameters<typeof assessImprovementCycle>[0])))
const block = program.command('block').description('Validate and assess a portable execution block manifest.')
block.command('validate <input>').action((input: string) => print(validateBlockManifest(readJsonInput(input, 'block manifest') as unknown)))
block.command('assess <input>').option('--completed <ids...>', 'completed dependency IDs').action((input: string, command: { readonly completed?: readonly string[] }) => print(assessBlock(readJsonInput(input, 'block manifest') as Parameters<typeof assessBlock>[0], command.completed ?? [])))
const preflight = program.command('preflight').description('Plan safe, file-scoped validation before commit.')
preflight.command('files <input>').action((input: string) => print(planFilePreflight(readJsonInput(input, 'changed files') as Parameters<typeof planFilePreflight>[0])))
const status = program.command('snapshot <input>').description('Create or validate a deterministic status snapshot.')
status.action((input: string) => print(createStatusSnapshot(readJsonInput(input, 'status input') as Parameters<typeof createStatusSnapshot>[0])))
status.command('validate <input>').action((input: string) => print(validateStatusSnapshot(readJsonInput(input, 'status snapshot') as unknown)))
const learning = program.command('learning').description('Parse retrospectives into proposed learnings.')
learning.command('parse <input>').requiredOption('--source <source>').action((input: string, command: { readonly source: string }) => print(parseRetro(readFileSync(input, 'utf8'), command.source)))
const coordination = program.command('coordination').description('Manage idempotent issue/worktree claims and dispatch records.')
coordination.command('claim <input>').action((input: string) => { const loaded = loadConfig(options().config); print(createDispatchLedger(loaded.stateDir).claim(readJsonInput(input, 'coordination identity') as Parameters<ReturnType<typeof createDispatchLedger>['claim']>[0])) })
const artifacts = program.command('artifacts').description('Inspect versioned, provenance-bound run artifacts.')
artifacts.command('inspect <path>').description('Validate and print one artifact as JSON or Markdown.').action((path: string) => { const artifact = readArtifactFile(path); print(options().json ? artifact : renderArtifactMarkdown(artifact)) })
artifacts.command('list [run-id]').description('List artifacts for the latest or selected run.').action((runId?: string) => { const loaded = loadConfig(options().config); const run = runId ? { runId } : loadLatestRun(loaded.stateDir); print(new FileArtifactStore(loaded.stateDir).list(run?.runId ?? fail('No verification run exists.', 'NO_RUN'))) })
artifacts.command('schema').description('Print the artifact schema version.').action(() => print({ schemaVersion: ARTIFACT_SCHEMA_VERSION, types: ['plan', 'finding', 'decision', 'repair', 'blocker', 'approval', 'phase'] }))
const loop = program.command('loop').description('Keep-pushing SDLC loop: drain the configured issue tracker through worktrees with role-based model routing.').option('-f, --file <path>', 'loop config path', 'loop.config.yaml')
const loopFile = (command: Command): string => (command.parent?.opts<{ readonly file?: string }>().file ?? command.opts<{ readonly file?: string }>().file ?? 'loop.config.yaml')
loop.command('validate').description('Validate loop.config.yaml and print the effective configuration. Reports keys the schema does not know — almost always a typo, which zod otherwise strips in silence.').action(function (this: Command) {
  const loaded = loadLoopConfig(loopFile(this))
  if (loaded.unknownKeys.length) console.error(`loop.config.yaml declares ${loaded.unknownKeys.length} key(s) this version does not know, and they were ignored: ${loaded.unknownKeys.join(', ')}`)
  print({ status: 'passed', criteria: ['loop-config'], path: loaded.path, configHash: loaded.configHash, unknownKeys: loaded.unknownKeys, config: loaded.config })
})
loop.command('doctor').description('Check Orca, providers, usage, machine slots, routing, and the selected tracker board without dispatching.').option('--no-probe', 'skip provider probe commands').action(async function (this: Command, command: { readonly probe: boolean }) { const report = await runLoopDoctor({ configPath: loopFile(this), runner: createProcessRunner(), probe: command.probe }); print(report); if (report.status === 'failed') process.exitCode = 1 })
loop.command('precheck <stage>').description('Read-only Orca precheck: exit 0 when the stage (tick | deliver) has work.').action(async function (this: Command, stage: string) { if (stage !== 'tick' && stage !== 'deliver') fail(`Unknown precheck stage: ${stage}`, 'INVALID_INPUT'); const result = stage === 'tick' ? await precheckTick({ configPath: loopFile(this), runner: createProcessRunner() }) : precheckDeliver(loadLoopConfig(loopFile(this)).stateDir); print(result); process.exitCode = result.work ? 0 : 1 })
loop.command('deliver').description('Drive dispatched workers to merge: PR detection, CI, review, fix rounds, squash-merge, tracker Done, cleanup.').option('--dry-run', 'decide only; no terminal input, no review, no merge, no tracker write').option('--issue <identifier>', 'restrict to one issue').action(async function (this: Command, command: { readonly dryRun?: boolean; readonly issue?: string }) { print(await runDeliver({ configPath: loopFile(this), runner: createProcessRunner(), dryRun: command.dryRun ?? false, onlyIssue: command.issue })) })
loop.command('stage <stage>').description('Run one stage (tick | deliver | retro | observe | release | intake | maintain) as an Orca precheck: prints the JSON report and exits 1 so Orca records the run without launching an agent — except `observe`, which exits 0 when a human has to look.').action(async function (this: Command, stage: string) {
  if (stage !== 'tick' && stage !== 'deliver' && stage !== 'retro' && stage !== 'observe' && stage !== 'release' && stage !== 'intake' && stage !== 'maintain') fail(`Unknown stage: ${stage}`, 'INVALID_INPUT')
  const runner = createProcessRunner(); const file = loopFile(this)
  const loaded = loadLoopConfig(file)
  // `loop stage` is the one entrypoint every scheduler (cron, Orca) calls, so it is the one place that can notice
  // the config changed since the last scheduled run without diffing YAML — the digest is already computed once
  // per load, this only remembers it — and the one place that can log a stage's wall-clock cost regardless of
  // what the stage itself did or how it ended.
  const lastConfigHash = readLastConfigHash(loaded.stateDir)
  if (lastConfigHash !== null && lastConfigHash !== loaded.configHash) appendLoopEvent(loaded.stateDir, { at: new Date().toISOString(), type: 'config.changed', from: lastConfigHash, to: loaded.configHash })
  if (lastConfigHash !== loaded.configHash) writeLastConfigHash(loaded.stateDir, loaded.configHash)
  const startedAt = Date.now()
  // One bus for the whole invocation, loaded/attached exactly once here and handed to whichever stage function
  // runs below: every event this process emits — the stage's own, and the three below (`config.changed`,
  // `stage.completed`, `stage.paused`) alike — reaches the same plugin/notifier path, unified instead of each
  // stage (or this handler) wiring its own.
  const bus = createLoopEventBus()
  if (loaded.config.plugins.modules.length) await loadLoopPlugins(loaded.root, loaded.config.plugins.modules, bus)
  const flushNotifications = attachNotifier(bus, { config: loaded.config, runner })
  const completed = (status: string, count: number): void => appendLoopEvent(loaded.stateDir, { at: new Date().toISOString(), type: 'stage.completed', stage, durationMs: Date.now() - startedAt, status, count }, bus)
  try {
    if (stage === 'intake' || stage === 'maintain') {
      // Both create issues and nothing else; like every scheduled stage they exit 1 so Orca records the run.
      const report = stage === 'intake' ? await runIntakeStage({ loaded, runner, bus }) : await runMaintainStage({ loaded, runner, bus })
      completed(report.status, report.results.length)
      console.log(JSON.stringify(report, null, 2))
      process.exitCode = 1
      return
    }
    if (stage === 'release') {
      // Promotion and deploy act on the world, so this stage only ever finishes work a human already approved.
      const report = await runReleaseStage({ loaded, runner, bus })
      completed(report.status, report.batch.issues.length)
      console.log(JSON.stringify(report, null, 2))
      process.exitCode = 1
      return
    }
    if (stage === 'observe') {
      // The one stage whose exit code is a decision, not a convention: 0 asks Orca to launch the observer agent.
      // Read-only: it emits nothing of its own, so no bus to pass.
      const report = await runObserveStage({ loaded, runner })
      completed(report.observability.status, report.observability.anomalies.length)
      console.log(JSON.stringify({ ...report, observability: { status: report.observability.status, anomalies: report.observability.anomalies, metrics: report.observability.metrics } }, null, 2))
      process.exitCode = report.notify ? 0 : 1
      return
    }
    const trackedStage = stage as LoopStageName
    // retro has no auto-pause: it is a lower-frequency, best-effort digest, not a stage that can spin every 5-10 min.
    if (stage !== 'retro' && isStagePaused(loaded.stateDir, trackedStage)) {
      const entry = stageEntry(loaded.stateDir, trackedStage)
      console.log(JSON.stringify({ status: 'paused', stage, pausedAt: entry.pausedAt, pausedReason: entry.pausedReason, consecutiveFailures: entry.consecutiveFailures, resume: `ak-harness loop resume --stage ${stage} -f ${JSON.stringify(file)}` }, null, 2))
      process.exitCode = 1
      return
    }
    const stageLock = acquireStageLock(loaded.stateDir, stage)
    if (!stageLock) {
      console.log(JSON.stringify({ status: 'locked', stage, reason: 'another stage run is still active' }, null, 2))
      process.exitCode = 1
      return
    }
    const budgetMs = Math.max(60_000, loaded.config.schedule.stageTimeoutSec * 1000 - 60_000)
    const threshold = loaded.config.resilience.stagePauseAfterRuns
    try {
      const report = stage === 'tick' ? await runTick({ loaded, runner, budgetMs, bus }) : stage === 'deliver' ? await runDeliver({ loaded, runner, budgetMs, bus }) : await runRetroStage({ loaded, runner, bus })
      if (stage !== 'retro') recordStageRunResult(loaded.stateDir, trackedStage, { succeeded: true }, threshold)
      completed(report.status, 'results' in report ? report.results.length : 'learningsProposed' in report ? report.learningsProposed : 0)
      console.log(JSON.stringify(report, null, 2))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const entry = stage !== 'retro' ? recordStageRunResult(loaded.stateDir, trackedStage, { succeeded: false, reason }, threshold) : null
      completed('error', 0)
      // A stage that just auto-paused is the loop stopping on its own: it gets an event on the same bus as
      // everything else, and `stage.paused` is in `notifications.events`' default list, so the configured
      // channel hears about it exactly the way any other notified event does — no more separate direct call.
      if (entry?.pausedAt) appendLoopEvent(loaded.stateDir, { at: new Date().toISOString(), type: 'stage.paused', stage, reason, consecutiveFailures: entry.consecutiveFailures }, bus)
      console.log(JSON.stringify({ status: 'error', stage, error: reason, ...(entry ? { consecutiveFailures: entry.consecutiveFailures, paused: entry.pausedAt !== null } : {}) }, null, 2))
    } finally {
      stageLock()
    }
    process.exitCode = 1
  } finally {
    await flushNotifications()
  }
})
loop.command('tick').description('One keep-pushing tick: intake → admit → contract → dispatch workers into worktrees.').option('--dry-run', 'plan only; no worktree, no tracker write, no contract cached').option('--max <n>', 'max dispatches this tick', (value: string) => Number(value)).option('--issue <identifier>', 'restrict to one issue').option('--skip-contract', 'do not call the orchestrator when no contract is cached').action(async function (this: Command, command: { readonly dryRun?: boolean; readonly max?: number; readonly issue?: string; readonly skipContract?: boolean }) { const report = await runTick({ configPath: loopFile(this), runner: createProcessRunner(), dryRun: command.dryRun ?? false, maxDispatch: command.max, onlyIssue: command.issue, skipContractGeneration: command.skipContract ?? false }); print(report); if (report.status === 'blocked') process.exitCode = 1 })
loop.command('contract <identifier>').description('Freeze (or show) the orchestrator contract for one configured-tracker issue.').option('--refresh', 'regenerate even when a cached contract exists').option('--dry-run', 'generate but do not cache').action(async function (this: Command, identifier: string, command: { readonly refresh?: boolean; readonly dryRun?: boolean }) {
  const loaded = loadLoopConfig(loopFile(this)); const runner = createProcessRunner(); const cached = command.refresh ? null : readStoredContract(loaded.stateDir, identifier)
  if (cached) return print(cached)
  const doctor = await runLoopDoctor({ loaded, runner, probe: false }); const candidates = rankModels(loaded.config, 'orchestrator', doctor.providers)
  requireWritableTracker(loaded.config)
  const issue = await resolveConnectors({ runner, config: loaded.config }).tracker.issue(identifier)
  const stored = await generateContract({ runner, config: loaded.config, root: (await ensureBaseView(runner, loaded)).path, issue, candidates })
  if (!command.dryRun) writeStoredContract(loaded.stateDir, stored)
  print(stored)
})
loop.command('init').description('Grill the essentials and write loop.config.yaml from a preset (web-app | library | monorepo | data-pipeline | mobile). Everything the preset already says is left unsaid.').option('--preset <name>', 'skip the question and use this preset').option('--repo <owner/name>', 'GitHub repository').option('--name <name>', 'project name').option('--team <key>', 'Linear team key').option('--workspace <id>', 'Linear workspace id').option('--person <name>', 'whose queue this machine drains').option('--global', 'also write ~/.agentskit/harness.yaml when it does not exist').option('--force', 'replace an existing file').option('--dry-run', 'print what it would write').action(async function (this: Command, command: { readonly preset?: string; readonly repo?: string; readonly name?: string; readonly team?: string; readonly workspace?: string; readonly person?: string; readonly global?: boolean; readonly force?: boolean; readonly dryRun?: boolean }) {
  const io = createRichIO()
  const result = await runLoopInit({
    directory: process.cwd(),
    io,
    answers: { ...(command.preset ? { preset: command.preset as never } : {}), ...(command.repo ? { repo: command.repo } : {}), ...(command.name ? { name: command.name } : {}), ...(command.team ? { teamKey: command.team } : {}), ...(command.workspace ? { workspaceId: command.workspace } : {}), ...(command.person ? { person: command.person } : {}) },
    writeGlobal: command.global ?? false,
    force: command.force ?? false,
    dryRun: command.dryRun ?? false,
  })
  print({ status: result.wrote.length ? 'ok' : 'skipped', wrote: result.wrote, skipped: result.skipped, preset: result.answers.preset, next: `ak-harness loop doctor -f ${JSON.stringify(result.configPath)}` })
  if (!result.wrote.length) process.exitCode = 1
})
loop.command('install').description('Guided install: doctor + environment checks, optional dry-run tick, then create/update the Orca automations after confirmation (idempotent by name).').option('--yes', 'accept every prompt (non-interactive)').option('--force', 'continue past failed checks').option('--skip-rehearsal', 'do not run the dry-run tick').option('--skip-local-config', 'do not offer to create loop.config.local.yaml').option('--dry-run', 'show checks and the exact orca argv; create nothing').option('--provider <agent>', 'Orca agent id that runs the automation prompt').option('--plain', 'legacy behaviour: no checks, no prompts, install immediately').action(async function (this: Command, command: { readonly yes?: boolean; readonly force?: boolean; readonly skipRehearsal?: boolean; readonly skipLocalConfig?: boolean; readonly dryRun?: boolean; readonly provider?: string; readonly plain?: boolean }) {
  if (command.plain) { const report = await installLoopAutomations({ configPath: loopFile(this), runner: createProcessRunner(), dryRun: command.dryRun ?? false, provider: command.provider }); print(report); if (report.status === 'failed') process.exitCode = 1; return }
  const io = createRichIO()
  if (!io.interactive && !command.yes && !command.dryRun) { console.log('stdin is not a terminal: pass --yes to install non-interactively, or --dry-run to only validate.'); process.exitCode = 2; return }
  const report = await runGuidedInstall({ configPath: loopFile(this), runner: createProcessRunner(), io, yes: command.yes ?? false, force: command.force ?? false, skipRehearsal: command.skipRehearsal ?? false, skipLocalConfig: command.skipLocalConfig ?? false, dryRun: command.dryRun ?? false, provider: command.provider })
  if (options().json) print(report)
  if (report.status === 'blocked') process.exitCode = 1
  if (report.status === 'aborted') process.exitCode = 3
})
loop.command('uninstall').description('Remove the loop automations from Orca.').option('--dry-run', 'print what would be removed').action(async function (this: Command, command: { readonly dryRun?: boolean }) { const report = await uninstallLoopAutomations({ configPath: loopFile(this), runner: createProcessRunner(), dryRun: command.dryRun ?? false }); print(report); if (report.status === 'failed') process.exitCode = 1 })
loop.command('status').description('Show the loop automations Orca knows about and their latest runs.').action(async function (this: Command) { print(await loopStatus({ configPath: loopFile(this), runner: createProcessRunner() })) })
loop.command('approve <issue>').description('Attest that you reviewed a PR the loop held for protected paths, for one exact head; the loop then reviews and merges it as usual. A new push needs a new approval.').requiredOption('--head <sha>', 'the head commit you reviewed (at least 7 characters)').requiredOption('--by <actor>', 'who approves — recorded in the event log').action(function (this: Command, issue: string, command: { readonly head: string; readonly by: string }) {
  const loaded = loadLoopConfig(loopFile(this))
  const state = approveHeldDelivery(loaded, issue, { head: command.head, by: command.by })
  print({ status: 'approved', issue, head: state.humanApproval?.head, by: state.humanApproval?.by, next: `ak-harness loop deliver --issue ${issue}` })
})
loop.command('resume [issue]').description('Resume a paused issue (clears its failure counter and removes the pause label) or, with --stage, a paused tick/deliver stage.').option('--stage <stage>', 'resume a paused stage (tick | deliver) instead of an issue').action(async function (this: Command, issue: string | undefined, command: { readonly stage?: string }) {
  const loaded = loadLoopConfig(loopFile(this))
  if (command.stage) {
    if (command.stage !== 'tick' && command.stage !== 'deliver') fail(`--stage must be tick or deliver, got ${command.stage}`, 'INVALID_INPUT')
    resumeStage(loaded.stateDir, command.stage as LoopStageName)
    return print({ status: 'resumed', stage: command.stage })
  }
  if (!issue) fail('Provide an issue identifier, or --stage <tick|deliver> to resume a paused stage.', 'INVALID_INPUT')
  requireWritableTracker(loaded.config)
  const issueId = issue as string
  const before = readIssueFailures(loaded.stateDir, issueId)
  resumeIssue(loaded.stateDir, issueId)
  try { await resolveConnectors({ runner: createProcessRunner(), config: loaded.config }).tracker.removeLabels(issueId, [loaded.config.resilience.pausedLabel]) } catch { /* best-effort: the CLI resume already cleared the local pause even if the tracker is unreachable */ }
  print({ status: 'resumed', issue: issueId, wasPaused: before.pausedAt !== null, previousConsecutiveFailures: before.consecutive })
})
loop.command('paused').description('List issues the loop has paused after repeated failures (local state, no network calls).').action(function (this: Command) { print(listPausedIssues(loadLoopConfig(loopFile(this)).stateDir)) })

loop.command('hook').description('Status-only line for a SessionStart hook: never installs or changes anything; always exits 0 within a few seconds.').action(async function (this: Command) { try { const status = await loopStatus({ configPath: loopFile(this), runner: createProcessRunner({ timeoutMs: 4_000 }) }); console.log(status.summary) } catch (error) { console.log(`loop: status unavailable (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`) } })
loop.command('debrief').description('Human-facing explanation of what the loop is working on right now (in-flight issues, holds, escalations, cooldowns). Read-only; Markdown by default.').option('--issue <identifier>', 'restrict to one issue').option('--since <window>', 'how far back to look for escalations/events', '24h').action(function (this: Command, command: { readonly issue?: string; readonly since: string }) {
  const report = buildDebriefReport({ configPath: loopFile(this), issue: command.issue, since: command.since })
  if (options().json) return print(report)
  console.log(renderDebriefMarkdown(report))
})
loop.command('issue-timeline <identifier>').description('Every logged step for one issue, oldest first: what ran, how long since the previous step, how many tokens, and which steps were friction (fix rounds, cooldowns, circuit breakers). Read-only.').option('--since <window>', 'how far back to read the event log; an issue older than this window reports nothing', '30d').action(function (this: Command, identifier: string, command: { readonly since: string }) {
  const loaded = loadLoopConfig(loopFile(this))
  const report = buildIssueTimeline(loaded.stateDir, identifier, { since: command.since })
  if (options().json) return print(report)
  console.log(renderIssueTimelineMarkdown(report))
})
loop.command('worker-guard').description('PreToolUse hook entrypoint (Claude Code / Grok Build CLI-compatible): reads a hook event on stdin and exits 2 to block a Write/Edit that would touch a path matching delivery.selfEditPaths or delivery.secretFilePatterns. Installed automatically into a dispatched worktree; not meant to be run by a human.').action(async function (this: Command) {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const stdin = Buffer.concat(chunks).toString('utf8')
  const cwd = process.cwd()
  let config
  try { config = loadLoopConfig(loopFile(this)).config } catch (error) { console.error(`worker-guard: could not load config, allowing (${error instanceof Error ? error.message : String(error)})`); process.exitCode = 0; return }
  const result = runWorkerGuard(stdin, config, cwd)
  if (result.message) console.error(result.message)
  process.exitCode = result.exitCode
})
loop.command('observe').description('Read-only anomaly scan and operating metrics for the loop (queue, workers, delivery, machine, memory, cache, tokens).').option('--since <window>', 'window such as 24h, 7d or an ISO date', '24h').option('--precheck', 'exit 0 when an action is required, 1 when healthy (for schedulers)').action(async function (this: Command, command: { readonly since: string; readonly precheck?: boolean }) {
  const report = await runObservability({ configPath: loopFile(this), runner: createProcessRunner(), since: command.since })
  if (options().json) print(report)
  else console.log(renderObservabilityMarkdown(report))
  if (command.precheck) process.exitCode = report.status === 'action_required' ? 0 : 1
  else if (report.status === 'action_required') process.exitCode = 2
})
loop.command('watch').description('Watch delivery.json (+ optional live PR) for in-flight issues; prints DONE / FAILED / ACTION_REQUIRED / PROGRESS. Read-only.').option('--issue <identifier>', 'restrict to one issue').option('--interval <seconds>', 'poll interval', (value: string) => Number(value), 30).option('--once', 'single snapshot then exit').option('--timeout <seconds>', 'stop after N seconds (0 = until terminal)', (value: string) => Number(value), 0).option('--no-live-pr', 'do not call gh; filesystem state only').action(async function (this: Command, command: { readonly issue?: string; readonly interval: number; readonly once?: boolean; readonly timeout: number; readonly livePr: boolean }) {
  const report = await watchDeliveries({
    configPath: loopFile(this),
    runner: createProcessRunner(),
    issue: command.issue,
    intervalMs: Math.max(1, command.interval) * 1000,
    once: command.once ?? false,
    timeoutMs: command.timeout > 0 ? command.timeout * 1000 : undefined,
    livePr: command.livePr,
    onEvent: (event) => { if (!options().json) console.log(formatWatchEvent(event)) },
  })
  if (options().json) print(report)
  else if (command.once && report.events.length === 0) {
    for (const target of report.targets) console.log(formatWatchEvent({ kind: target.phase === 'merged' ? 'DONE' : target.phase === 'held' || target.phase === 'held-incomplete-review' || target.phase === 'fix-round' ? 'ACTION_REQUIRED' : target.phase === 'failed' || target.phase === 'stuck' || target.phase === 'abandoned' || target.phase === 'closed' ? 'FAILED' : 'PROGRESS', issue: target.issue, message: `Phase ${target.phase}`, phase: target.phase, pr: target.delivery.prNumber, finalOutcome: target.delivery.finalOutcome, at: report.generatedAt }))
  }
  if (report.status === 'failed') process.exitCode = 1
  else if (report.status === 'action-required') process.exitCode = 2
})
loop.command('retro').description('Digest of the loop over a window: escalations, dispatches, reviews, merges, cooldowns, Orca runs, and calibration suggestions. Markdown by default, --json for the report.').option('--since <window>', 'window such as 7d, 12h, 30m or an ISO date', '7d').option('--learnings', 'print harness learning records (proposed) instead of the digest').option('--no-orca', 'skip the Orca run summary').option('--target <target>', 'only suggestions for one side: project | harness').action(async function (this: Command, command: { readonly since: string; readonly learnings?: boolean; readonly orca: boolean; readonly target?: string }) {
  if (command.target && command.target !== 'project' && command.target !== 'harness') fail(`--target must be project or harness, got ${command.target}`, 'INVALID_INPUT')
  const full = await buildRetroReport({ configPath: loopFile(this), runner: createProcessRunner(), since: command.since, skipOrca: !command.orca })
  const report = command.target ? { ...full, suggestions: full.suggestions.filter((item) => item.target === command.target) } : full
  const markdown = renderRetroMarkdown(report)
  if (command.learnings) return print(retroLearnings(report, markdown))
  if (options().json) return print(report)
  console.log(markdown)
})
const loopPlan = loop.command('plan').description('Requirements → PRD → technical design → issues. One question per round, two human gates, and the queue entry stays a human gesture.')
const planDeps = async (command: Command) => {
  const loaded = loadLoopConfig(loopFile(command))
  const runner = createProcessRunner()
  const doctor = await runLoopDoctor({ loaded, runner, probe: false })
  const view = await ensureBaseView(runner, loaded)
  return { loaded, runner, readRoot: view.path, candidates: rankModels(loaded.config, 'orchestrator', doctor.providers), voters: rankModels(loaded.config, 'reviewer', doctor.providers) }
}
const planOrFail = (loaded: ReturnType<typeof loadLoopConfig>, id: string) => readPlanState(loaded.stateDir, id) ?? fail(`No plan "${id}" under ${loaded.stateDir}/plans.`, 'INVALID_INPUT')

loopPlan.command('start <objective...>').description('Start a plan from a vague objective and ask the first question.').action(async function (this: Command, objective: readonly string[]) {
  const deps = await planDeps(this)
  const started = startPlan(objective.join(' '), new Date())
  const next = await interviewRound(deps, started)
  writePlanState(deps.loaded.stateDir, next)
  print({ id: next.id, phase: next.phase, pending: next.pending, answer: `ak-harness loop plan answer ${next.id} "<your answer>"` })
})
loopPlan.command('answer <id> <answer...>').description('Answer the open question and ask the next one. The interview ends when the PRD has no gap left — the machine decides that, not the model.').action(async function (this: Command, id: string, answer: readonly string[]) {
  const deps = await planDeps(this)
  const answered = answerRound(planOrFail(deps.loaded, id), answer.join(' '), new Date())
  const next = await interviewRound(deps, answered)
  writePlanState(deps.loaded.stateDir, next)
  print({ id: next.id, phase: next.phase, pending: next.pending, gaps: prdGaps(next.prd), ...(next.phase === 'review' ? { approve: `ak-harness loop plan approve ${next.id}` } : {}) })
})
loopPlan.command('show [id]').description('Show a plan (Markdown by default), or list every plan when no id is given.').action(function (this: Command, id: string | undefined) {
  const loaded = loadLoopConfig(loopFile(this))
  if (!id) return print(listPlans(loaded.stateDir).map((plan) => ({ id: plan.id, phase: plan.phase, objective: plan.objective, issues: plan.issues.length, updatedAt: plan.updatedAt })))
  const state = planOrFail(loaded, id)
  if (options().json) return print(state)
  console.log(renderPlanMarkdown(state))
})
loopPlan.command('approve <id>').description('Human gate: approve the PRD, which starts the architect.').option('--by <actor>', 'who approves', 'human').action(async function (this: Command, id: string, command: { readonly by: string }) {
  const loaded = loadLoopConfig(loopFile(this))
  const next = approvePlan(planOrFail(loaded, id), command.by, new Date())
  writePlanState(loaded.stateDir, next)
  // Approval is what makes the PRD a document people read, so it lands in the repository here and not before —
  // unless the checkout is not the clean base branch, where it would ride along with someone else's work.
  const document = writePrdDocument(loaded, next, documentRoot(loaded, await readCheckoutState(createProcessRunner(), loaded.root)))
  print({ id, phase: next.phase, ...(document ? { wrote: document.path, ...(document.note ? { note: document.note } : {}) } : {}), next: `ak-harness loop plan architect ${id}` })
})
loopPlan.command('architect <id>').description('Produce the technical design for the whole PRD and put it to a vote (2 of 3 by default).').action(async function (this: Command, id: string) {
  const deps = await planDeps(this)
  const next = await architectRound(deps, planOrFail(deps.loaded, id))
  writePlanState(deps.loaded.stateDir, next)
  const consensus = designApproved(next, deps.loaded.config)
  print({ id, consensus, cycles: next.designCycles, votes: next.designVotes, ...(consensus ? { next: `ak-harness loop plan approve-design ${id}` } : { objections: next.designVotes.flatMap((vote) => vote.objections) }) })
  if (!consensus) process.exitCode = 1
})
loopPlan.command('approve-design <id>').description('Human gate: approve the design after it reached consensus. Everything built afterwards inherits it.').option('--by <actor>', 'who approves', 'human').option('--accept-objections', 'approve although votes still carry objections; decompose must settle each one in an issue').action(async function (this: Command, id: string, command: { readonly by: string; readonly acceptObjections?: boolean }) {
  const loaded = loadLoopConfig(loopFile(this))
  const next = approveDesign(planOrFail(loaded, id), command.by, new Date(), loaded.config, { acceptObjections: command.acceptObjections === true })
  writePlanState(loaded.stateDir, next)
  const document = writeDesignDocument(loaded, next, documentRoot(loaded, await readCheckoutState(createProcessRunner(), loaded.root)))
  print({ id, phase: next.phase, ...(document ? { wrote: document.path, ...(document.note ? { note: document.note } : {}) } : {}), next: `ak-harness loop plan decompose ${id}` })
})
loopPlan.command('decompose <id>').description('Break the approved design into issues. Without --create nothing is written to the tracker; --create writes the list already shown, not a new one.').option('--create', 'create the issues already decomposed (and reviewed) in the configured tracker, outside the dispatch queue').option('--refresh', 'decompose again even when a list already exists').option('--parent <issue>', 'the epic these issues break down (tracker identifier)').option('--project <name>', 'tracker project; default: the one project the queue drains, when there is exactly one').action(async function (this: Command, id: string, command: { readonly create?: boolean; readonly refresh?: boolean; readonly parent?: string; readonly project?: string }) {
  const deps = await planDeps(this)
  const current = planOrFail(deps.loaded, id)
  // `--create` files the list a human already read. Decomposing again here would put a list nobody reviewed into
  // the tracker — the model does not return the same issues twice.
  const reuse = command.create === true && command.refresh !== true && current.phase === 'decompose' && current.issues.length > 0
  const decomposed = reuse ? current : await decomposeRound(deps, current)
  if (!reuse) writePlanState(deps.loaded.stateDir, decomposed)
  if (!command.create) return print({ id, issues: decomposed.issues, create: `ak-harness loop plan decompose ${id} --create` })
  requireWritableTracker(deps.loaded.config)
  const created = await createPlannedIssues(deps, decomposed, { ...(command.parent ? { parent: command.parent } : {}), ...(command.project ? { project: command.project } : {}) })
  writePlanState(deps.loaded.stateDir, created)
  print({ id, phase: created.phase, issues: created.issues.map((issue) => ({ identifier: issue.identifier ?? null, title: issue.title, layer: issue.layer, designRef: issue.designRef })), note: `created in "${deps.loaded.config.linear.entryState}" — moving them to ${deps.loaded.config.linear.states.map((name) => `"${name}"`).join(' or ')} is the human gate into the queue` })
})
const loopRelease = loop.command('release').description('Promote the integration branch to the release branch and run the project deploy — only for a batch a human approved.')
loopRelease.command('status').description('What is merged on the integration branch and not yet released, and whether it is approved.').action(async function (this: Command) {
  const loaded = loadLoopConfig(loopFile(this))
  const batch = await readReleaseBatch({ loaded, runner: createProcessRunner() })
  const approval = readReleaseState(loaded.stateDir).approval
  print({ ...batch, approval, approve: approval ? null : `ak-harness loop release approve` })
})
loopRelease.command('approve').description('Human gate: approve exactly the batch currently on the integration branch. Anything merged afterwards needs its own approval.').option('--by <actor>', 'who approves', 'human').action(async function (this: Command, command: { readonly by: string }) {
  const loaded = loadLoopConfig(loopFile(this))
  const batch = await readReleaseBatch({ loaded, runner: createProcessRunner() })
  const approval = approveRelease({ loaded, batch, actor: command.by })
  print({ status: 'approved', ...approval, next: `ak-harness loop stage release -f ${JSON.stringify(loaded.path)}` })
})
loopRelease.command('run').description('Promote and deploy the approved batch (same work as `loop stage release`, but with a human-readable report).').option('--dry-run', 'show what would happen; touch nothing').action(async function (this: Command, command: { readonly dryRun?: boolean }) {
  const report = await runReleaseStage({ loaded: loadLoopConfig(loopFile(this)), runner: createProcessRunner(), dryRun: command.dryRun ?? false })
  if (options().json) print(report)
  else console.log(renderReleaseMarkdown(report))
  if (report.status === 'failed' || report.status === 'rolled-back') process.exitCode = 1
})
const loopLearning = loop.command('learning').description('Continuous-improvement learnings ledger and approved memory writes.')
loopLearning.command('list').description('Show the learnings ledger under stateDir (proposed/promoted/rejected).').action(function (this: Command) {
  const loaded = loadLoopConfig(loopFile(this))
  print(readLearningsLedger(loaded.stateDir))
})
loopLearning.command('promote').description('Human-only: promote learning IDs into approved loop memory (token-reducing context for later tickets).').requiredOption('--ids <ids>', 'comma-separated learning ids').option('--by <actor>', 'must be human', 'human').option('--revision <rev>', 'sourceRevision stamped on memory records (default: unknown)').action(async function (this: Command, command: { readonly ids: string; readonly by: string; readonly revision?: string }) {
  const loaded = loadLoopConfig(loopFile(this))
  const ids = command.ids.split(',').map((id) => id.trim()).filter(Boolean)
  if (!ids.length) fail('--ids must list at least one learning id', 'INVALID_INPUT')
  const result = await promoteLearningsToMemory({
    stateDir: loaded.stateDir,
    config: loaded.config,
    adapter: openLoopMemory(loaded),
    ids,
    actor: command.by,
    sourceRevision: command.revision ?? 'unknown',
  })
  print({ status: 'ok', remembered: result.remembered, ledger: result.ledger })
})
loopLearning.command('reject').description('Revoke learnings — including any the loop promoted by itself as `loop-auto`. The record stays in the ledger, marked rejected, and stops reaching worker briefs.').requiredOption('--ids <ids>', 'comma-separated learning ids').option('--by <actor>', 'who revokes', 'human').action(function (this: Command, command: { readonly ids: string; readonly by: string }) {
  const loaded = loadLoopConfig(loopFile(this))
  const ids = command.ids.split(',').map((id) => id.trim()).filter(Boolean)
  if (!ids.length) fail('--ids must list at least one learning id', 'INVALID_INPUT')
  const ledger = readLearningsLedger(loaded.stateDir)
  const records = promoteLearnings(ledger.records, { actor: command.by, ids, status: 'rejected' })
  writeLearningsLedger(loaded.stateDir, { records })
  print({ status: 'ok', rejected: ids, ledger: { records } })
})
loopLearning.command('promoted').description('List the learnings currently promoted, and which of them the loop promoted by itself.').action(function (this: Command) {
  const loaded = loadLoopConfig(loopFile(this))
  const promoted = readLearningsLedger(loaded.stateDir).records.filter((record) => record.status === 'promoted')
  print({ total: promoted.length, records: promoted.map((record) => ({ id: record.id, category: record.category, sightings: record.sightings ?? 1, text: record.text })) })
})
program.command('start').description('Move a planned run into implementation.').action(() => print(startRun(loadConfig(options().config))))
program.command('verify').description('Execute every configured check and record evidence.').action(async () => print(await verifyRun({ configPath: options().config })))
program.command('run').description('Alias for verify, compatible with the common protocol.').action(async () => print(await verifyRun({ configPath: options().config })))
program.command('approve <run-id-or-decision> [decision-or-run-id]').description('Record human approval or rejection. Use only <decision> to apply it to the latest pending run; run IDs remain an audit detail.').option('--by <actor>', 'approval actor', 'human').action(async (first: string, second: string | undefined, command: { readonly by: string }) => { const args = decisionArgs(first, second); print(await approveRun({ configPath: options().config, ...args, actor: command.by })) })
program.command('authorize <run-id-or-decision> [decision-or-run-id]').description('Authorize or reject declared external tracking. Use only <decision> to apply it to the latest pending run; run IDs remain an audit detail.').option('--by <actor>', 'approval actor', 'human').action(async (first: string, second: string | undefined, command: { readonly by: string }) => { const args = decisionArgs(first, second); print(await authorizeRun({ configPath: options().config, ...args, actor: command.by })) })
program.command('retry').description('Create a new implementation attempt after a blocked or stale run.').action(async () => print(await retryRun({ configPath: options().config })))
program.command('cancel [run-id]').description('Cancel an active run.').option('--by <actor>', 'cancellation actor', 'human').option('--reason <reason>', 'cancellation reason', 'Run cancelled by a human.').action(async (runId: string | undefined, command: { readonly by: string; readonly reason: string }) => print(await cancelRun({ configPath: options().config, runId, reason: command.reason, actor: command.by })))
program.command('status').description('Show the latest run after reconciling its audit evidence.').action(async () => { const loaded = loadConfig(options().config); print(loadLatestRun(loaded.stateDir) ? await reconcileRun({ configPath: options().config }) : { state: 'CLARIFYING', message: 'No run exists.' }) })
program.command('audit [run-id]').description('Reconcile a run projection with its verified lifecycle decisions.').action(async (runId?: string) => print(await reconcileRun({ configPath: options().config, runId })))
const events = program.command('events').description('Inspect the lifecycle audit log.')
events.command('verify [run-id]').description('Verify the latest or selected event log hash chain.').action((runId?: string) => { const loaded = loadConfig(options().config); const run = runId ? { runId } : loadLatestRun(loaded.stateDir); const selectedRunId = run?.runId ?? fail('No verification run exists.', 'NO_RUN'); print(new FileEventStore(loaded.stateDir).verify(selectedRunId)) })
events.command('lock [run-id]').description('Inspect the latest or selected event-log lock.').action((runId?: string) => { const loaded = loadConfig(options().config); const run = runId ? { runId } : loadLatestRun(loaded.stateDir); const selectedRunId = run?.runId ?? fail('No verification run exists.', 'NO_RUN'); print(inspectEventLogLock(loaded.stateDir, selectedRunId)) })
events.command('unlock [run-id]').description('Recover an old event-log lock after confirming its owner is dead.').option('--by <actor>', 'recovery actor', 'human').option('--max-age-ms <milliseconds>', 'minimum lock age', (value) => Number(value), 300_000).action((runId: string | undefined, command: { readonly by: string; readonly maxAgeMs: number }) => { const loaded = loadConfig(options().config); const run = runId ? { runId } : loadLatestRun(loaded.stateDir); const selectedRunId = run?.runId ?? fail('No verification run exists.', 'NO_RUN'); print(recoverEventLogLock({ stateDir: loaded.stateDir, runId: selectedRunId, actor: command.by, maxAgeMs: command.maxAgeMs })) })
events.command('export [run-id]').description('Export a reconciled COMPLETE run as a signed evidence bundle.').requiredOption('--output <path>', 'bundle output path').requiredOption('--private-key <path>', 'Ed25519 private key path').requiredOption('--key-id <id>', 'stable signing key identity').action(async (runId: string | undefined, command: { readonly output: string; readonly privateKey: string; readonly keyId: string }) => print(await exportEvidenceBundle({ configPath: options().config, runId, outputPath: command.output, privateKeyPath: command.privateKey, keyId: command.keyId })))
events.command('verify-bundle <path>').description('Verify an exported signed evidence bundle independently.').option('--trusted-key-store <path>', 'JSON trust store with active or revoked public keys').action((path: string, command: { readonly trustedKeyStore?: string }) => print(verifyEvidenceBundle(path, { trustedKeys: command.trustedKeyStore ? readEvidenceTrustStore(command.trustedKeyStore) : [] })))
const benchmark = program.command('benchmark').description('Aggregate reproducible metrics from historical runs.').option('--manifest <path>', 'benchmark manifest for baseline comparison').action((command: { readonly manifest?: string }) => { const loaded = loadConfig(options().config); print(benchmarkRuns(loaded.stateDir, command.manifest ? loadBenchmarkManifest(command.manifest) : undefined)) })
benchmark.command('baseline <taskId>').description('Record one controlled baseline observation in a benchmark manifest.').option('--manifest <path>', 'benchmark manifest path').requiredOption('--status <status>', 'passed, failed, blocked, or not-run').requiredOption('--source <source>', 'baseline source or run reference').option('--evidence-file <path>', 'JSON file with criterion-level baseline evidence').option('--recorded-at <timestamp>', 'ISO-8601 timestamp').option('--attempts <count>', 'attempt count', (value) => Number(value)).option('--duration-ms <milliseconds>', 'duration in milliseconds', (value) => Number(value)).option('--review-minutes <minutes>', 'human review time in minutes', (value) => Number(value)).option('--escaped-incomplete <count>', 'incomplete deliveries discovered after handoff', (value) => Number(value)).action((taskId: string, command: { readonly manifest?: string; readonly status: string; readonly source: string; readonly evidenceFile?: string; readonly recordedAt?: string; readonly attempts?: number; readonly durationMs?: number; readonly reviewMinutes?: number; readonly escapedIncomplete?: number }, cliCommand: Command) => {
  const manifest = command.manifest ?? cliCommand.parent?.opts<{ readonly manifest?: string }>().manifest
  const manifestPath = manifest ?? fail('baseline requires --manifest <path>.', 'INVALID_INPUT')
  const status = ['passed', 'failed', 'blocked', 'not-run'].includes(command.status) ? command.status as 'passed' | 'failed' | 'blocked' | 'not-run' : fail('status must be passed, failed, blocked, or not-run.', 'INVALID_INPUT')
  const evidence = command.evidenceFile ? readBenchmarkEvidence(command.evidenceFile) : undefined
  print(recordBenchmarkObservation(manifestPath, { taskId, status, source: command.source, ...(evidence ? { evidence: evidence.evidence, evidenceDigest: evidence.digest } : {}), ...(command.recordedAt ? { recordedAt: command.recordedAt } : {}), ...(command.attempts === undefined ? {} : { attempts: command.attempts }), ...(command.durationMs === undefined ? {} : { durationMs: command.durationMs }), ...(command.reviewMinutes === undefined ? {} : { reviewMinutes: command.reviewMinutes }), ...(command.escapedIncomplete === undefined ? {} : { escapedIncomplete: command.escapedIncomplete }) }))
})
program.command('clean').description('Remove only configured task-owned temporary artifacts.').action(() => print(cleanTaskArtifacts(options().config)))
// `process.exitCode` alone does not terminate the process while an event-loop timer is still pending — `loop
// watch` without `--once`/`--timeout` sits in a live `setTimeout` poll loop, so setting only the exit code let
// Ctrl-C print "Cancelled." while the polling (and its `gh`/`orca` shell-outs) kept running in the background.
process.on('SIGINT', () => {
  if (activeUiShutdown) {
    const shutdown = activeUiShutdown
    activeUiShutdown = null
    void shutdown().catch((error: unknown) => { process.stderr.write(`UI shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`) }).finally(() => process.exit(130))
    return
  }
  process.stderr.write('Cancelled.\n')
  process.exit(130)
})
/**
 * The command tree, exported so `pnpm docs:generate` can walk it instead of parsing `--help` output.
 *
 * The reference is generated from the program itself; anything else drifts the moment a flag is renamed.
 */
export const cliProgram = program

// Under introspection the module is imported for its tree, not run: parsing `process.argv` there would try to
// execute whatever command the generator itself was invoked with.
if (process.env['AK_HARNESS_CLI_INTROSPECT'] !== '1') try { await program.parseAsync(process.argv) } catch (error) { const value = error instanceof Error ? error : new Error(String(error)); process.stderr.write(`${'code' in value ? String(value.code) : 'HARNESS_ERROR'}: ${value.message}\n`); process.exitCode = 'code' in value && value.code === 'INVALID_INPUT' ? 2 : 1 }
