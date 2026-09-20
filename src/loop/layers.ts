import { touchesProtectedPaths } from '../adapters/github-cli.js'
import type { LoopConfig } from './config.js'

export type Layer = LoopConfig['layers'][number]

/** The layer an issue belongs to, from the labels frozen at dispatch. First match wins; no label, no layer. */
export const layerFor = (config: LoopConfig, labels: readonly string[] = []): Layer | null =>
  config.layers.find((layer) => labels.includes(layer.label)) ?? null

export const layerById = (config: LoopConfig, id: string): Layer | null => config.layers.find((layer) => layer.id === id) ?? null

export interface BoundaryVerdict {
  readonly layer: string | null
  readonly outside: readonly string[]
  readonly enforced: boolean
  readonly detail: string | null
}

/**
 * Files a PR changed that its layer does not own.
 *
 * A layer with no `paths` owns everything, because a boundary nobody drew cannot be crossed. Reporting is the
 * default and holding is opt-in (`enforce`): a boundary that blocks before a team has drawn it properly costs
 * more than it protects.
 */
export const assessBoundary = (config: LoopConfig, labels: readonly string[], files: readonly string[]): BoundaryVerdict => {
  const layer = layerFor(config, labels)
  if (!layer || !layer.paths.length || !files.length) return { layer: layer?.id ?? null, outside: [], enforced: false, detail: null }
  const owned = new Set(touchesProtectedPaths(files, layer.paths))
  const outside = files.filter((file) => !owned.has(file))
  return {
    layer: layer.id,
    outside,
    enforced: outside.length > 0 && layer.enforce,
    detail: outside.length ? `${outside.length} file(s) outside layer ${layer.id} (${layer.paths.join(', ')}): ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ` (+${outside.length - 5})` : ''}` : null,
  }
}

/**
 * The command that closes the work for these labels: the layer's own test when it declares one, otherwise the
 * project's `verifyCommand`. Running a package's suite instead of the whole monorepo is the cheapest lever there
 * is, and the layer is what says which package.
 */
export const verifyCommandFor = (config: LoopConfig, labels: readonly string[] = []): { readonly command: string; readonly source: 'layer' | 'project'; readonly layer: string | null } => {
  const layer = layerFor(config, labels)
  return layer?.verify
    ? { command: layer.verify, source: 'layer', layer: layer.id }
    : { command: config.delivery.verifyCommand, source: 'project', layer: layer?.id ?? null }
}

/** The layers block a brief or a decompose prompt shows: what each slice owns and what closes it. */
export const renderLayersForPrompt = (config: LoopConfig): string => {
  if (!config.layers.length) return ''
  const rows = config.layers.map((layer) => `- \`${layer.label}\` (${layer.id})${layer.description ? ` — ${layer.description}` : ''}${layer.paths.length ? ` · owns ${layer.paths.join(', ')}` : ''}${layer.verify ? ` · closes with \`${layer.verify}\`` : ''}`)
  return `\n## Layers\n${rows.join('\n')}\n`
}
