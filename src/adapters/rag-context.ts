import { fail } from '../kernel/errors.js'
import { hashContextSnapshot } from '../context/index.js'
import type { AdapterTelemetry } from '../kernel/adapter-contract.js'
import type { ContextProvider, ContextQuery, ContextReference, ContextSnapshot } from '../context/index.js'
import type { CommandRunner } from './command.js'

export interface RagQueryResult {
  readonly references: readonly ContextReference[]
  readonly sourceHash: string
}

export interface RagContextProviderOptions {
  /** Injected query function — callers wire `@agentskit/rag` (or any store) here; this package never imports it. */
  readonly query: (query: ContextQuery) => Promise<RagQueryResult>
}

export interface ArgvRagContextProviderOptions {
  readonly runner: CommandRunner
  /** Argv template; `{query}` and `{scope}` (JSON array) are substituted per element. */
  readonly argv: readonly string[]
  readonly timeoutMs?: number
  readonly cwd?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) return fail(`${label} must be a non-empty string.`, 'INVALID_INPUT')
  return value
}

const parseReference = (value: unknown, index: number): ContextReference => {
  if (!isRecord(value)) return fail(`RAG references[${index}] must be an object.`, 'INVALID_INPUT')
  const relevance = value['relevance']
  if (relevance !== undefined && (typeof relevance !== 'number' || relevance < 0 || relevance > 1)) return fail(`RAG references[${index}].relevance must be between 0 and 1.`, 'INVALID_INPUT')
  return {
    id: requiredString(value['id'], `RAG references[${index}].id`),
    uri: requiredString(value['uri'], `RAG references[${index}].uri`),
    ...(typeof value['title'] === 'string' ? { title: value['title'] } : {}),
    ...(typeof value['version'] === 'string' ? { version: value['version'] } : {}),
    ...(typeof value['contentHash'] === 'string' ? { contentHash: value['contentHash'] } : {}),
    ...(typeof relevance === 'number' ? { relevance } : {}),
  }
}

/** Accept either a ContextSnapshot-shaped object or `{ references, sourceHash }`. Fail closed on anything else. */
export const parseRagQueryOutput = (value: unknown): RagQueryResult => {
  if (!isRecord(value)) return fail('RAG query output must be a JSON object.', 'INVALID_INPUT')
  const rawReferences = value['references']
  if (!Array.isArray(rawReferences)) return fail('RAG query output.references must be an array.', 'INVALID_INPUT')
  const references = rawReferences.map((entry: unknown, index: number) => parseReference(entry, index))
  return { references, sourceHash: requiredString(value['sourceHash'], 'RAG query output.sourceHash') }
}

const renderArgv = (argv: readonly string[], query: ContextQuery): readonly string[] => {
  const scope = JSON.stringify(query.scope ?? [])
  return argv.map((part) => part.replaceAll('{query}', query.query).replaceAll('{scope}', scope))
}

const toSnapshot = (query: ContextQuery, result: RagQueryResult, started: number): ContextSnapshot => {
  const telemetry: AdapterTelemetry = {
    status: 'measured',
    durationMs: Date.now() - started,
    contextReferences: result.references.length,
    contextCostTokens: Math.max(1, Math.ceil(JSON.stringify(result.references).length / 4)),
  }
  return {
    providerId: 'rag',
    query,
    references: result.references,
    sourceHash: result.sourceHash,
    snapshotHash: hashContextSnapshot({ providerId: 'rag', query, references: result.references, sourceHash: result.sourceHash }),
    resolvedAt: new Date().toISOString(),
    assurance: 'contract-tested',
    telemetry,
  }
}

/** ContextProvider over an injected RAG query function. No static dependency on `@agentskit/rag`. */
export const createRagContextProvider = ({ query }: RagContextProviderOptions): ContextProvider => {
  if (!query || typeof query !== 'function') return fail('RAG context provider requires a query function.', 'INVALID_INPUT')
  return {
    id: 'rag',
    version: '1.0.0',
    resolve: async (contextQuery) => {
      const started = Date.now()
      const result = await query(contextQuery)
      if (!result || !Array.isArray(result.references) || typeof result.sourceHash !== 'string' || !result.sourceHash.trim()) {
        return fail('RAG query function returned an invalid result.', 'INVALID_INPUT')
      }
      const references = result.references.map((entry, index) => parseReference(entry, index))
      return toSnapshot(contextQuery, { references, sourceHash: result.sourceHash.trim() }, started)
    },
  }
}

/** ContextProvider that runs argv and parses stdout JSON as a ContextSnapshot or `{ references, sourceHash }`. */
export const createArgvRagContextProvider = ({ runner, argv, timeoutMs = 30_000, cwd }: ArgvRagContextProviderOptions): ContextProvider => {
  if (!runner || typeof runner.run !== 'function') return fail('Argv RAG context provider requires a CommandRunner.', 'INVALID_INPUT')
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string' || !part.trim())) {
    return fail('Argv RAG context provider requires a non-empty argv of non-empty strings.', 'INVALID_INPUT')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fail('Argv RAG timeoutMs must be a positive number.', 'INVALID_INPUT')
  return {
    id: 'rag',
    version: '1.0.0',
    resolve: async (contextQuery) => {
      const started = Date.now()
      const rendered = renderArgv(argv, contextQuery)
      const outcome = await runner.run(rendered, { timeoutMs, ...(cwd ? { cwd } : {}) })
      if (outcome.timedOut) return fail(`RAG query argv timed out after ${timeoutMs}ms.`, 'HARNESS_ERROR')
      if (outcome.code !== 0) return fail(`RAG query argv exited with code ${outcome.code ?? 'null'}.`, 'HARNESS_ERROR')
      let parsed: unknown
      try { parsed = JSON.parse(outcome.stdout) as unknown } catch { return fail('RAG query argv did not print valid JSON on stdout.', 'INVALID_INPUT') }
      return toSnapshot(contextQuery, parseRagQueryOutput(parsed), started)
    },
  }
}
