#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import { approveRun, assessAcceptance, assessBlock, assessDiscovery, assessImprovementCycle, assessIntegration, assessPilot, assessPreflight, assessProduction, assessWip, assessWorktreeCleanup, authorizeRun, benchmarkRuns, cancelRun, cleanTaskArtifacts, composePullRequest, createDispatchLedger, createDocBridgeContextProvider, createStatusSnapshot, exportEvidenceBundle, loadBenchmarkManifest, loadConfig, loadLatestRun, parseRetro, planFilePreflight, planRun, readContextSnapshots, readEvidenceTrustStore, reconcileRun, recordBenchmarkObservation, retryRun, selectRuntime, startRun, validateBlockManifest, validateStatusSnapshot, verifyEvidenceBundle, verifyRun } from './index.js'
import type { BenchmarkObservationEvidence } from './metrics.js'
import { fail } from './errors.js'
import { FileEventStore, inspectEventLogLock, recoverEventLogLock } from './events.js'

interface CliOptions { readonly config: string; readonly json: boolean }
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { readonly version: string }
const program = new Command()
program.name('ak-harness').description('Portable, evidence-backed development harness for coding agents.').version(packageJson.version).option('-c, --config <path>', 'verification contract path', '.codex/verification.json').option('--json', 'emit machine-readable output')
const options = (): CliOptions => program.opts<CliOptions>()
const print = (value: unknown): void => { if (options().json) console.log(JSON.stringify(value)); else console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) }
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
program.command('start').description('Move a planned run into implementation.').action(() => print(startRun(loadConfig(options().config))))
program.command('verify').description('Execute every configured check and record evidence.').action(async () => print(await verifyRun({ configPath: options().config })))
program.command('run').description('Alias for verify, compatible with the common protocol.').action(async () => print(await verifyRun({ configPath: options().config })))
program.command('approve <run-id-or-decision> [decision-or-run-id]').description('Record human approval or rejection. Accepts <run-id> <decision> or <decision> <run-id>.').option('--by <actor>', 'approval actor', 'human').action(async (first: string, second: string | undefined, command: { readonly by: string }) => { const args = decisionArgs(first, second); print(await approveRun({ configPath: options().config, ...args, actor: command.by })) })
program.command('authorize <run-id-or-decision> [decision-or-run-id]').description('Authorize or reject declared external tracking. Accepts <run-id> <decision> or <decision> <run-id>.').option('--by <actor>', 'approval actor', 'human').action(async (first: string, second: string | undefined, command: { readonly by: string }) => { const args = decisionArgs(first, second); print(await authorizeRun({ configPath: options().config, ...args, actor: command.by })) })
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
process.on('SIGINT', () => { process.stderr.write('Cancelled.\n'); process.exitCode = 130 })
try { await program.parseAsync(process.argv) } catch (error) { const value = error instanceof Error ? error : new Error(String(error)); process.stderr.write(`${'code' in value ? String(value.code) : 'HARNESS_ERROR'}: ${value.message}\n`); process.exitCode = 'code' in value && value.code === 'INVALID_INPUT' ? 2 : 1 }
