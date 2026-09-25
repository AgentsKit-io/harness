import type { ContextSnapshot } from '../context/index.js'

export const SURFACE_NAMES = ['logic', 'endpoint', 'database', 'cli', 'mcp', 'ui', 'docs'] as const
export type SurfaceName = typeof SURFACE_NAMES[number]

export const CHECK_CATEGORIES = ['build', 'test', 'lint', ...SURFACE_NAMES, 'custom'] as const
export type CheckCategory = typeof CHECK_CATEGORIES[number]

export const RUN_STATES = [
  'CLARIFYING', 'PLANNED', 'IMPLEMENTING', 'VERIFYING',
  'AWAITING_HUMAN_APPROVAL', 'AWAITING_AUTHORIZATION', 'COMPLETE',
  'BLOCKED', 'STALE', 'CANCELLED', 'SUPERSEDED',
] as const
export type RunState = typeof RUN_STATES[number]

export interface SurfaceRequirement {
  readonly required: boolean
  readonly reason?: string
}

export interface ContractScope {
  readonly inScope: readonly string[]
  readonly outOfScope: readonly string[]
}

export interface ContractOutcome {
  readonly id: string
  readonly statement: string
  readonly checks: readonly string[]
}

export interface TaskContract {
  readonly intent: string
  readonly scope: ContractScope
  readonly ambiguities: readonly string[]
  readonly outcomes: readonly ContractOutcome[]
}

export interface VerificationCheck {
  readonly id: string
  readonly category: CheckCategory
  readonly command: string
  readonly required: boolean
  readonly reason?: string
  readonly timeoutMs: number
  readonly dependsOn?: readonly string[]
  readonly execution?: 'real'
  readonly capabilities?: readonly string[]
  readonly evidence: 'structured'
}

export interface TrackingConfig {
  readonly required: boolean
  readonly target?: string
  readonly reason?: string
  /** Goal approval covers tracking unless a project explicitly opts out. */
  readonly authorization?: 'goal' | 'separate'
}

export interface BenchmarkBinding {
  readonly suiteId: string
  readonly taskId: string
  readonly mode: 'harness'
}

export interface RuntimeConfig {
  readonly kind: 'process' | 'docker'
}

export type AutonomyMode = 'controlled' | 'yolo'

export interface VerificationConfig {
  readonly schemaVersion: 1
  readonly project: string
  readonly root?: string
  readonly stateDir?: string
  readonly profile: string
  readonly autonomy: AutonomyMode
  readonly runtime: RuntimeConfig
  readonly contract: TaskContract
  readonly surfaces: Readonly<Record<SurfaceName, SurfaceRequirement>>
  readonly checks: readonly VerificationCheck[]
  readonly tracking: TrackingConfig
  readonly verification?: { readonly maxConcurrency?: number }
  readonly budget?: { readonly maxDurationMs?: number }
  readonly cleanup?: { readonly roots?: readonly string[] }
  readonly benchmark?: BenchmarkBinding
}

export interface LoadedConfig {
  readonly absolute: string
  readonly root: string
  readonly stateDir: string
  readonly config: VerificationConfig
  readonly configHash: string
}

export interface SourceSnapshot {
  readonly revision: string
  readonly status: string
  readonly statusHash: string
}

export interface EvidenceArtifact {
  readonly type?: string
  readonly path: string
  readonly sha256: string
  readonly viewport?: { readonly width: number; readonly height: number } | string
}

export interface StructuredEvidence {
  readonly status: string
  readonly criteria: readonly string[]
  readonly capability?: string
  readonly artifacts?: readonly EvidenceArtifact[]
  readonly [key: string]: unknown
}

export interface CheckResult {
  readonly id: string
  readonly category: CheckCategory
  readonly status: 'pending' | 'passed' | 'failed' | 'not-applicable'
  readonly exitCode?: number
  readonly durationMs?: number
  readonly evidence?: StructuredEvidence
  readonly failures?: readonly string[]
}

export interface RunOutcome extends ContractOutcome {
  readonly status: 'pending' | 'passed' | 'failed' | 'not-applicable'
}

export interface EvidenceReference {
  readonly checkId: string
  readonly stdout: string
  readonly stderr: string
}

export interface VerificationRun {
  readonly type: 'agentskit-harness-run'
  readonly schemaVersion: 1
  readonly runId: string
  readonly project: string
  readonly state: RunState
  readonly configHash: string
  readonly contractHash: string
  readonly sourceRevision: string
  readonly sourceStatusHash: string
  readonly baseline: SourceSnapshot
  readonly contractApproval: { readonly actor: 'human'; readonly at: string; readonly contractHash: string }
  readonly checks: readonly CheckResult[]
  readonly outcomes: readonly RunOutcome[]
  readonly transitions: readonly StateTransition[]
  readonly evidenceReferences: readonly EvidenceReference[]
  readonly contextSnapshots: readonly ContextSnapshot[]
  readonly contextHash?: string
  readonly verificationDigest?: string
  readonly benchmark?: BenchmarkBinding
  readonly supersedes?: string
  readonly dirtyBaselineAuthorized?: boolean
  readonly autonomy: AutonomyMode
  readonly metrics?: { readonly totalDurationMs: number; readonly wallDurationMs?: number; readonly peakConcurrency?: number; readonly budgetExceeded: boolean; readonly machine?: MachineMetrics }
  readonly humanApproval?: { readonly actor: 'human'; readonly at: string; readonly sourceRevision: string; readonly contractHash: string; readonly verificationDigest?: string }
  readonly authorization?: { readonly actor: 'human'; readonly at: string; readonly target: string; readonly sourceRevision: string; readonly contractHash: string; readonly verificationDigest?: string }
}

export interface MachineSample {
  readonly at: string
  readonly cpus: number
  readonly load1: number
  readonly load1PerCpuPercent: number
  /**
   * False where the platform has no load average. Windows' `os.loadavg()` always returns zeros, and a reported
   * 0% load there is a machine that looks idle rather than one nobody measured.
   */
  readonly loadAvailable?: boolean
  /**
   * Share of CPU time actually spent busy over a short window, where it was measured. On macOS the load average
   * also counts runnable-but-idle and I/O-blocked threads: observed at 60-80% "load" with the CPU 80% idle (agent
   * TUIs redrawing), which capped concurrency for nothing. When present, pressure decisions use this instead.
   */
  readonly cpuBusyPercent?: number
  readonly memoryUsedPercent: number
  readonly rssBytes: number
  readonly swapUsedPercent?: number
  readonly memoryPressure?: 'normal' | 'warning' | 'critical'
  readonly interferingProcesses?: readonly string[]
}

export interface MachineMetrics {
  readonly sampleIntervalMs: number
  readonly samples: readonly MachineSample[]
  readonly peakLoad1PerCpuPercent: number
  readonly peakMemoryUsedPercent: number
  readonly peakRssBytes: number
  readonly pressureEvents: number
  readonly throttleEvents: number
  readonly minimumEffectiveConcurrency: number
}

export interface RunReconciliation {
  readonly status: 'verified'
  readonly runId: string
  readonly state: RunState
  readonly eventCount: number
  readonly headHash?: string
  readonly verificationDigest?: string
}

export interface StateTransition {
  readonly from: RunState | null
  readonly to: RunState
  readonly at: string
  readonly actor?: string
  readonly reason?: string
}
