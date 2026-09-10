import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from './errors.js'
import { hashJson, sha256 } from './hash.js'
import { FileEventStore } from './events.js'
import type { PhaseExecution, PhaseResumeState } from './phase-executor.js'

export const ARTIFACT_SCHEMA_VERSION = 1 as const
export const ARTIFACT_TYPES = ['plan', 'finding', 'decision', 'repair', 'blocker', 'approval', 'phase'] as const
export type ArtifactType = typeof ARTIFACT_TYPES[number]

export interface ArtifactEnvelope<T = unknown> {
  readonly type: 'agentskit-harness-artifact'
  readonly schemaVersion: typeof ARTIFACT_SCHEMA_VERSION
  readonly artifactId: string
  readonly artifactType: ArtifactType
  readonly artifactVersion: number
  readonly runId: string
  readonly issueRef: string
  readonly sourceRevision: string
  readonly contractHash: string
  readonly configHash: string
  readonly contextHash: string
  readonly phase: string
  readonly createdAt: string
  readonly payload: T
  readonly payloadHash: string
  readonly artifactHash: string
}

export type ArtifactEnvelopeInput<T = unknown> = Omit<ArtifactEnvelope<T>, 'type' | 'schemaVersion' | 'artifactId' | 'createdAt' | 'payloadHash' | 'artifactHash'> & {
  readonly artifactId?: string
  readonly createdAt?: string
  readonly payloadHash?: string
  readonly artifactHash?: string
}

export interface ArtifactBinding {
  readonly runId: string
  readonly issueRef: string
  readonly sourceRevision: string
  readonly contractHash: string
  readonly configHash: string
  readonly contextHash: string
  readonly phase?: string
}

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) return fail(`${label} is required.`, 'INVALID_INPUT')
  return value.trim()
}
const digest = (value: unknown, label: string): string => {
  const result = text(value, label)
  if (!/^[a-f0-9]{64}$/.test(result)) fail(`${label} must be a lowercase SHA-256 digest.`, 'INVALID_INPUT')
  return result
}
const artifactId = (value: unknown): string => {
  const result = text(value, 'Artifact artifactId')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) fail('Artifact artifactId is invalid.', 'INVALID_INPUT')
  return result
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const artifactBody = (artifact: Omit<ArtifactEnvelope, 'artifactHash'>): Record<string, unknown> => ({
  type: artifact.type,
  schemaVersion: artifact.schemaVersion,
  artifactId: artifact.artifactId,
  artifactType: artifact.artifactType,
  artifactVersion: artifact.artifactVersion,
  runId: artifact.runId,
  issueRef: artifact.issueRef,
  sourceRevision: artifact.sourceRevision,
  contractHash: artifact.contractHash,
  configHash: artifact.configHash,
  contextHash: artifact.contextHash,
  phase: artifact.phase,
  payload: artifact.payload,
  payloadHash: artifact.payloadHash,
})

const expectedArtifactHash = (artifact: Omit<ArtifactEnvelope, 'artifactHash'>): string => hashJson(artifactBody(artifact))

export const validateArtifactEnvelope = <T = unknown>(value: unknown): ArtifactEnvelope<T> => {
  if (!isRecord(value)) return fail('Artifact envelope must be an object.', 'INVALID_INPUT')
  if (value['type'] !== 'agentskit-harness-artifact' || value['schemaVersion'] !== ARTIFACT_SCHEMA_VERSION) fail('Artifact envelope type or schemaVersion is invalid.', 'INVALID_INPUT')
  if (!ARTIFACT_TYPES.includes(value['artifactType'] as ArtifactType)) fail('Artifact artifactType is invalid.', 'INVALID_INPUT')
  if (!Number.isInteger(value['artifactVersion']) || (value['artifactVersion'] as number) < 1) fail('Artifact artifactVersion must be a positive integer.', 'INVALID_INPUT')
  const createdAt = text(value['createdAt'], 'Artifact createdAt')
  if (!Number.isFinite(Date.parse(createdAt))) fail('Artifact createdAt must be a valid timestamp.', 'INVALID_INPUT')
  const payloadHash = digest(value['payloadHash'], 'Artifact payloadHash')
  if (hashJson(value['payload']) !== payloadHash) fail('Artifact payloadHash does not match payload.', 'INVALID_INPUT')
  const artifact = {
    type: 'agentskit-harness-artifact' as const,
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    artifactId: artifactId(value['artifactId']),
    artifactType: value['artifactType'] as ArtifactType,
    artifactVersion: value['artifactVersion'] as number,
    runId: text(value['runId'], 'Artifact runId'),
    issueRef: text(value['issueRef'], 'Artifact issueRef'),
    sourceRevision: text(value['sourceRevision'], 'Artifact sourceRevision'),
    contractHash: digest(value['contractHash'], 'Artifact contractHash'),
    configHash: digest(value['configHash'], 'Artifact configHash'),
    contextHash: digest(value['contextHash'], 'Artifact contextHash'),
    phase: text(value['phase'], 'Artifact phase'),
    createdAt,
    payload: value['payload'] as T,
    payloadHash,
  }
  if (digest(value['artifactHash'], 'Artifact artifactHash') !== expectedArtifactHash(artifact)) fail('Artifact artifactHash does not match envelope.', 'INVALID_INPUT')
  return { ...artifact, artifactHash: value['artifactHash'] as string }
}

export const createArtifactEnvelope = <T>(input: ArtifactEnvelopeInput<T>): ArtifactEnvelope<T> => {
  if (!ARTIFACT_TYPES.includes(input.artifactType)) fail('Artifact artifactType is invalid.', 'INVALID_INPUT')
  const payloadHash = input.payloadHash ?? hashJson(input.payload)
  if (payloadHash !== hashJson(input.payload)) fail('Artifact payloadHash does not match payload.', 'INVALID_INPUT')
  const identity = {
    type: 'agentskit-harness-artifact' as const,
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    artifactType: input.artifactType,
    artifactVersion: input.artifactVersion,
    runId: input.runId,
    issueRef: input.issueRef,
    sourceRevision: input.sourceRevision,
    contractHash: input.contractHash,
    configHash: input.configHash,
    contextHash: input.contextHash,
    phase: input.phase,
    payload: input.payload,
    payloadHash,
  }
  const id = input.artifactId ?? hashJson(identity)
  const artifact = {
    ...identity,
    artifactId: id,
    createdAt: input.createdAt ?? new Date().toISOString(),
  }
  const artifactHash = input.artifactHash ?? expectedArtifactHash(artifact)
  return validateArtifactEnvelope({ ...artifact, artifactHash })
}

export const renderArtifactMarkdown = (artifact: ArtifactEnvelope): string => [
  `# ${artifact.artifactType} artifact ${artifact.artifactId}`,
  '',
  `- Schema: ${artifact.schemaVersion}`,
  `- Version: ${artifact.artifactVersion}`,
  `- Run: ${artifact.runId}`,
  `- Issue: ${artifact.issueRef}`,
  `- Phase: ${artifact.phase}`,
  `- Source revision: ${artifact.sourceRevision}`,
  `- Contract hash: ${artifact.contractHash}`,
  `- Configuration hash: ${artifact.configHash}`,
  `- Context hash: ${artifact.contextHash}`,
  `- Artifact hash: ${artifact.artifactHash}`,
  '',
  '## Payload',
  '',
  '```json',
  JSON.stringify(artifact.payload, null, 2),
  '```',
  '',
].join('\n')

export const artifactFilePath = (stateDir: string, runId: string, id: string): string => join(stateDir, 'runs', runId, 'artifacts', `${id}.json`)
export const artifactMarkdownPath = (stateDir: string, runId: string, id: string): string => join(stateDir, 'runs', runId, 'artifacts', `${id}.md`)

export class FileArtifactStore {
  public constructor(private readonly stateDir: string) {}

  public write<T>(input: ArtifactEnvelope<T>): ArtifactEnvelope<T> {
    const artifact = validateArtifactEnvelope<T>(input)
    const path = artifactFilePath(this.stateDir, artifact.runId, artifact.artifactId)
    mkdirSync(join(this.stateDir, 'runs', artifact.runId, 'artifacts'), { recursive: true })
    if (existsSync(path)) {
      const existing = validateArtifactEnvelope<T>(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      if (existing.artifactHash !== artifact.artifactHash) fail(`Artifact ${artifact.artifactId} already exists with different content.`, 'HARNESS_ERROR')
      return existing
    }
    writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
    writeFileSync(artifactMarkdownPath(this.stateDir, artifact.runId, artifact.artifactId), renderArtifactMarkdown(artifact), 'utf8')
    new FileEventStore(this.stateDir).append({
      runId: artifact.runId,
      sourceRevision: artifact.sourceRevision,
      configHash: artifact.configHash,
      type: 'artifact.recorded',
      payload: { artifactId: artifact.artifactId, artifactType: artifact.artifactType, artifactVersion: artifact.artifactVersion, artifactHash: artifact.artifactHash, phase: artifact.phase, representation: 'json+markdown' },
    })
    return artifact
  }

  public read<T = unknown>(runId: string, id: string): ArtifactEnvelope<T> {
    return validateArtifactEnvelope<T>(JSON.parse(readFileSync(artifactFilePath(this.stateDir, runId, artifactId(id)), 'utf8')) as unknown)
  }

  public list(runId: string): readonly ArtifactEnvelope[] {
    const directory = join(this.stateDir, 'runs', runId, 'artifacts')
    if (!existsSync(directory)) return []
    return readdirSync(directory).filter((name) => name.endsWith('.json')).sort().map((name) => validateArtifactEnvelope(JSON.parse(readFileSync(join(directory, name), 'utf8')) as unknown))
  }
}

export const artifactIsFresh = (artifact: ArtifactEnvelope, binding: ArtifactBinding): boolean => artifact.runId === binding.runId && artifact.issueRef === binding.issueRef && artifact.sourceRevision === binding.sourceRevision && artifact.contractHash === binding.contractHash && artifact.configHash === binding.configHash && artifact.contextHash === binding.contextHash && (binding.phase === undefined || artifact.phase === binding.phase)

export const resumeStateFromArtifacts = (artifacts: readonly ArtifactEnvelope[]): PhaseResumeState => {
  const completed: Record<string, Pick<PhaseExecution, 'decision' | 'outputs'>> = {}
  const outputs: Record<string, unknown> = {}
  for (const artifact of artifacts.filter((item) => item.artifactType === 'phase').sort((left, right) => left.phase.localeCompare(right.phase) || left.artifactVersion - right.artifactVersion)) {
    if (!isRecord(artifact.payload) || artifact.payload['decision'] !== 'pass') continue
    const phaseOutputs = isRecord(artifact.payload['outputs']) ? artifact.payload['outputs'] : {}
    completed[artifact.phase] = { decision: 'pass', outputs: phaseOutputs }
    Object.assign(outputs, phaseOutputs)
  }
  return { completed, outputs }
}

export const createPhaseArtifact = (base: Omit<ArtifactEnvelopeInput, 'artifactType' | 'phase' | 'payload'>, execution: PhaseExecution): ArtifactEnvelope => createArtifactEnvelope({ ...base, artifactType: 'phase', phase: execution.id, payload: { decision: execution.decision, outputs: execution.outputs ?? {} } })

export const readArtifactFile = (path: string): ArtifactEnvelope => validateArtifactEnvelope(JSON.parse(readFileSync(path, 'utf8')) as unknown)

export const artifactDigest = (artifact: ArtifactEnvelope): string => sha256(JSON.stringify(artifact))
