import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { composeLoopConfig, GATE_LISTS, GLOBAL_CONFIG_FILE, LOOP_LOCAL_CONFIG_FILE, type LoadedLoopConfig, type LoopConfig } from '../../loop/config.js'
import { editYaml, localConfigPath, writeLocalConfigText, type YamlEdit } from '../../loop/local-config.js'
import { readTuningState, type TuningRecord } from '../../loop/tuning.js'
import { fieldMeta, isWeaker } from './config-fields.js'
import { recordOf } from './http.js'
import type { ConfigChange, ConfigField, ConfigLayer, ConfigProposal, ConfigWriteRequest, EffectiveConfig } from './contract.js'

/** A write the Settings screen may not make; `status` is the HTTP answer (409 = needs `confirmWeakening`). */
export class ConfigRefused extends Error {
  constructor(message: string, readonly status: 400 | 409, readonly paths: readonly string[] = []) { super(message) }
}

interface LayerTexts { readonly global?: string; readonly project: string; readonly team?: string; readonly local?: string }

const readIfPresent = (path: string | undefined): string | undefined => path && existsSync(path) ? readFileSync(path, 'utf8') : undefined
const readLayers = (loaded: LoadedLoopConfig): LayerTexts => {
  const global = readIfPresent(loaded.globalPath)
  const team = readIfPresent(loaded.teamPath)
  const local = readIfPresent(localConfigPath(loaded))
  return { project: readFileSync(loaded.path, 'utf8'), ...(global === undefined ? {} : { global }), ...(team === undefined ? {} : { team }), ...(local === undefined ? {} : { local }) }
}
const compose = (texts: LayerTexts): LoopConfig => composeLoopConfig({
  text: texts.project,
  ...(texts.global === undefined ? {} : { globalText: texts.global }),
  ...(texts.team === undefined ? {} : { teamText: texts.team }),
  ...(texts.local === undefined ? {} : { localText: texts.local }),
})
/** Everything but this machine's overlay: the baseline a personal gate value is judged against. */
const withoutLocal = ({ local: _local, ...rest }: LayerTexts): LayerTexts => rest

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const segments = (path: string): readonly string[] => path.split('.')
const readIn = (value: unknown, path: string): unknown => segments(path).reduce<unknown>((node, key) => isRecord(node) ? node[key] : undefined, value)

// ponytail: paths are dot-joined, so a record key containing a dot (a `models.cost` model name) reads as nesting; such keys are team-only anyway.
const leaves = (value: unknown, prefix = ''): readonly (readonly [string, unknown])[] =>
  isRecord(value) && Object.keys(value).length
    ? Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key))
    : prefix ? [[prefix, value]] : []

/** Gate paths where `effective` is weaker than `baseline`. */
const weakenedBetween = (baseline: LoopConfig, effective: LoopConfig): readonly string[] => {
  const paths = new Set([...leaves(baseline), ...leaves(effective)].map(([path]) => path))
  return [...paths].filter((path) => { const meta = fieldMeta(path); return meta.classification === 'gate' && meta.weaker !== undefined && isWeaker(meta.weaker, readIn(baseline, path), readIn(effective, path)) }).sort()
}

/** Gate paths this machine's `loop.config.local.yaml` sets weaker than the team value. What a run records at enqueue. */
export const weakenedGates = (loaded: LoadedLoopConfig): readonly string[] => {
  if (!loaded.localPath) return []
  return weakenedBetween(compose(withoutLocal(readLayers(loaded))), loaded.config)
}

const LAYER_ORDER: readonly ConfigLayer[] = ['personal', 'team-overlay', 'team', 'global']

export const effectiveConfig = (loaded: LoadedLoopConfig): EffectiveConfig => {
  const texts = readLayers(loaded)
  const raw: Readonly<Record<ConfigLayer, unknown>> = {
    default: undefined, global: texts.global === undefined ? undefined : parseYaml(texts.global), team: parseYaml(texts.project),
    'team-overlay': texts.team === undefined ? undefined : parseYaml(texts.team), personal: texts.local === undefined ? undefined : parseYaml(texts.local),
  }
  const tuning = readTuningState(loaded.stateDir)
  const frozen = new Set(tuning.frozen)
  const lastTuned = new Map<string, TuningRecord>(tuning.history.map((record) => [record.path, record]))
  const fields: ConfigField[] = leaves(loaded.config).map(([path, value]) => {
    const { weaker: _weaker, ...meta } = fieldMeta(path)
    const record = lastTuned.get(path)
    return {
      path, value, ...meta,
      layer: LAYER_ORDER.find((layer) => readIn(raw[layer], path) !== undefined) ?? 'default',
      tuning: record ? { from: record.from, to: record.to, at: record.at, metric: record.metric, frozen: frozen.has(path) } : null,
    }
  })
  return {
    hash: loaded.configHash,
    layers: [
      { layer: 'default', file: null },
      { layer: 'global', file: texts.global === undefined ? null : GLOBAL_CONFIG_FILE },
      { layer: 'team', file: basename(loaded.path) },
      { layer: 'team-overlay', file: loaded.teamPath && texts.team !== undefined ? basename(loaded.teamPath) : null },
      { layer: 'personal', file: texts.local === undefined ? null : LOOP_LOCAL_CONFIG_FILE },
    ],
    fields,
    weakenedGates: texts.local === undefined ? [] : weakenedBetween(compose(withoutLocal(texts)), loaded.config),
  }
}

const parseChanges = (value: unknown): readonly ConfigChange[] => {
  if (!Array.isArray(value) || !value.length) throw new ConfigRefused('changes must be a non-empty list.', 400)
  return value.map((change: unknown) => {
    if (!isRecord(change) || typeof change['path'] !== 'string' || !/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_/-]+)*$/.test(change['path'])) throw new ConfigRefused('each change needs a dotted config path.', 400)
    return { path: change['path'], value: change['value'], ...(change['reset'] === true ? { reset: true } : {}) }
  })
}

const LOCAL_HEADER = '# Per-machine overlay for the keep-pushing loop (gitignored). Merged over loop.config.yaml.\n# Everything not set here comes from the versioned config shared by the team.\n'

/**
 * Write personal values to `loop.config.local.yaml`. Every change is merged into the overlay and the composed
 * config is validated before anything touches disk. A change that weakens a `gate` below the team value needs
 * `confirmWeakening`; team-only paths are refused (they go through {@link proposeTeamChange}).
 */
export const writePersonalConfig = (loaded: LoadedLoopConfig, body: unknown): LoadedLoopConfig => {
  const request = body as Partial<ConfigWriteRequest>
  const changes = parseChanges(request.changes)
  const locked = changes.filter((change) => fieldMeta(change.path).editable !== 'personal').map((change) => change.path)
  if (locked.length) throw new ConfigRefused(`not editable in the personal layer (propose a team change instead): ${locked.join(', ')}`, 400, locked)
  const texts = readLayers(loaded)
  const team = compose(withoutLocal(texts))
  const edits: YamlEdit[] = changes.map((change) => {
    if (change.reset) return { path: segments(change.path), remove: true }
    // Gate lists accumulate across layers: express the desired list as additions plus `!entry` removals.
    if (GATE_LISTS.includes(change.path) && Array.isArray(change.value)) {
      const base = (readIn(team, change.path) as unknown[] | undefined) ?? []
      return { path: segments(change.path), value: [...change.value.filter((item) => !base.includes(item)), ...base.filter((item) => !(change.value as unknown[]).includes(item)).map((item) => `!${String(item)}`)] }
    }
    return { path: segments(change.path), value: change.value }
  })
  const local = editYaml(texts.local ?? LOCAL_HEADER, edits)
  let next: LoopConfig
  try { next = compose({ ...texts, local }) } catch (error) { throw new ConfigRefused(error instanceof Error ? error.message : String(error), 400) }
  const touched = new Set(changes.map((change) => change.path))
  const weakening = weakenedBetween(team, next).filter((path) => touched.has(path))
  if (weakening.length && request.confirmWeakening !== true) throw new ConfigRefused(`these changes weaken a delivery guarantee and need confirmWeakening: ${weakening.join(', ')}`, 409, weakening)
  return writeLocalConfigText(loaded, local).loaded
}

/** A team change never touches disk: it comes back as a unified diff of `loop.config.yaml` to copy or open as a PR. */
export const proposeTeamChange = (loaded: LoadedLoopConfig, body: unknown): ConfigProposal => {
  const changes = parseChanges(recordOf(body)['changes'])
  const locked = changes.filter((change) => fieldMeta(change.path).editable === 'readonly').map((change) => change.path)
  if (locked.length) throw new ConfigRefused(`read-only: ${locked.join(', ')}`, 400, locked)
  const texts = readLayers(loaded)
  const project = editYaml(texts.project, changes.map((change) => change.reset ? { path: segments(change.path), remove: true } : { path: segments(change.path), value: change.value }))
  try { compose({ ...texts, project }) } catch (error) { throw new ConfigRefused(error instanceof Error ? error.message : String(error), 400) }
  const file = basename(loaded.path)
  return { file, diff: unifiedDiff(file, texts.project, project) }
}

/** Minimal line-level unified diff (LCS), enough for `git apply` on a config file. */
export const unifiedDiff = (file: string, before: string, after: string, context = 3): string => {
  if (before === after) return ''
  const a = before.split('\n'); const b = after.split('\n')
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const ops: { readonly kind: ' ' | '-' | '+'; readonly line: string; readonly i: number; readonly j: number }[] = []
  let i = 0; let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({ kind: ' ', line: a[i]!, i, j }); i++; j++ }
    else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { ops.push({ kind: '-', line: a[i]!, i, j }); i++ }
    else { ops.push({ kind: '+', line: b[j]!, i, j }); j++ }
  }
  const out = [`--- a/${file}`, `+++ b/${file}`]
  const changed = ops.flatMap((op, index) => op.kind === ' ' ? [] : [index])
  for (let k = 0; k < changed.length;) {
    let end = k
    while (end + 1 < changed.length && changed[end + 1]! - changed[end]! <= context * 2) end++
    const from = Math.max(0, changed[k]! - context); const to = Math.min(ops.length, changed[end]! + context + 1)
    const hunk = ops.slice(from, to)
    const oldLen = hunk.filter((op) => op.kind !== '+').length; const newLen = hunk.filter((op) => op.kind !== '-').length
    out.push(`@@ -${oldLen ? hunk[0]!.i + 1 : hunk[0]!.i},${oldLen} +${newLen ? hunk[0]!.j + 1 : hunk[0]!.j},${newLen} @@`, ...hunk.map((op) => `${op.kind}${op.line}`))
    k = end + 1
  }
  return `${out.join('\n')}\n`
}
