import { fail } from './errors.js'
import { HARNESS_EVENT_TYPES } from './events.js'
import type { HarnessEvent, HarnessEventListener, HarnessEventType } from './events.js'

export const HARNESS_PLUGIN_API_VERSION = 1 as const
export type Disposer = () => void

export interface PluginSlot<T> { readonly id: string }
export const createPluginSlot = <T>(id: string): PluginSlot<T> => {
  if (typeof id !== 'string' || !id.trim()) fail('Plugin slot id is required.', 'INVALID_INPUT')
  return { id: id.trim() }
}

export interface HarnessPluginContext {
  readonly apiVersion: typeof HARNESS_PLUGIN_API_VERSION
  register<T>(slot: PluginSlot<T>, id: string, value: T): Disposer
  effect(disposer: Disposer): void
  on<K extends HarnessEventType>(type: K, listener: HarnessEventListener<K>): Disposer
}

export interface HarnessPlugin {
  readonly id: string
  readonly version: string
  readonly apiVersion: typeof HARNESS_PLUGIN_API_VERSION
  readonly requires?: readonly string[]
  readonly apply: (context: HarnessPluginContext) => void | Disposer
}

export interface PluginContribution<T> { readonly pluginId: string; readonly id: string; readonly value: T }

export interface PluginRegistry {
  register(plugin: HarnessPlugin): void
  mount(): void
  emit<K extends HarnessEventType>(event: HarnessEvent<K>): void
  on<K extends HarnessEventType>(type: K, listener: HarnessEventListener<K>): Disposer
  contributions<T>(slot: PluginSlot<T>): readonly PluginContribution<T>[]
  dispose(): void
}

const validId = (value: unknown, label: string): string => {
  if (typeof value !== 'string') fail(`${label} is required.`, 'INVALID_INPUT')
  const result = (value as string).trim()
  if (!result) fail(`${label} is required.`, 'INVALID_INPUT')
  return result
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const validEventType = (value: unknown): HarnessEventType => {
  if (typeof value !== 'string' || !(HARNESS_EVENT_TYPES as readonly string[]).includes(value)) fail('Plugin event type is invalid.', 'INVALID_INPUT')
  return value as HarnessEventType
}
const validSlot = <T>(value: PluginSlot<T>): PluginSlot<T> => {
  if (!isRecord(value)) fail('Plugin slot must be an object.', 'INVALID_INPUT')
  return { id: validId(value['id'], 'Plugin slot id') }
}

export const createPluginRegistry = (): PluginRegistry => {
  const plugins = new Map<string, HarnessPlugin>()
  const contributions = new Map<string, Map<string, PluginContribution<unknown>>>()
  const listeners = new Map<HarnessEventType, Set<HarnessEventListener<HarnessEventType>>>()
  const cleanups: Disposer[] = []
  let mounted = false
  let disposed = false

  const ensureOpen = (): void => { if (disposed) fail('Plugin registry has been disposed.', 'HARNESS_ERROR') }
  const removeContribution = (slot: PluginSlot<unknown>, id: string, pluginId: string): void => {
    const entries = contributions.get(slot.id)
    if (entries?.get(id)?.pluginId === pluginId) entries.delete(id)
  }
  const registerContribution = <T>(pluginId: string, slot: PluginSlot<T>, id: string, value: T): Disposer => {
    const entries = contributions.get(slot.id) ?? new Map<string, PluginContribution<unknown>>()
    if (entries.has(id)) fail(`Plugin contribution already exists: ${slot.id}/${id}.`, 'INVALID_INPUT')
    entries.set(id, { pluginId, id, value })
    contributions.set(slot.id, entries)
    const disposer = (): void => removeContribution(slot as PluginSlot<unknown>, id, pluginId)
    cleanups.push(disposer)
    return disposer
  }
  const order = (): HarnessPlugin[] => {
    const result: HarnessPlugin[] = []
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string): void => {
      if (visited.has(id)) return
      if (visiting.has(id)) fail(`Plugin dependency cycle includes ${id}.`, 'INVALID_INPUT')
      const candidate = plugins.get(id)
      if (!candidate) fail(`Plugin dependency is missing: ${id}.`, 'INVALID_INPUT')
      const plugin = candidate as HarnessPlugin
      visiting.add(id)
      for (const dependency of plugin.requires ?? []) visit(dependency)
      visiting.delete(id); visited.add(id); result.push(plugin)
    }
    for (const id of plugins.keys()) visit(id)
    return result
  }
  const registry: PluginRegistry = {
    register(plugin) {
      ensureOpen()
      if (mounted) fail('Plugins cannot be registered after mount.', 'HARNESS_ERROR')
      if (!isRecord(plugin)) fail('Plugin must be an object.', 'INVALID_INPUT')
      const candidate = plugin as unknown as HarnessPlugin
      const id = validId(candidate.id, 'Plugin id')
      validId(candidate.version, 'Plugin version')
      if (candidate.apiVersion !== HARNESS_PLUGIN_API_VERSION) fail(`Unsupported plugin API version: ${String(candidate.apiVersion)}.`, 'INVALID_INPUT')
      if (typeof candidate.apply !== 'function') fail('Plugin apply must be a function.', 'INVALID_INPUT')
      let requires: readonly string[] | undefined
      if (candidate.requires !== undefined) {
        if (!Array.isArray(candidate.requires)) fail('Plugin requires must be an array.', 'INVALID_INPUT')
        requires = candidate.requires.map((dependency, index) => validId(dependency, `Plugin dependency[${index}]`))
        if (new Set(requires).size !== requires.length) fail('Plugin dependencies must be unique.', 'INVALID_INPUT')
      }
      if (plugins.has(id)) fail(`Plugin already registered: ${id}.`, 'INVALID_INPUT')
      plugins.set(id, { ...candidate, id, ...(requires === undefined ? {} : { requires }) })
    },
    mount() {
      ensureOpen()
      if (mounted) return
      try {
        for (const plugin of order()) {
          const context: HarnessPluginContext = {
            apiVersion: HARNESS_PLUGIN_API_VERSION,
            register: (slot, id, value) => registerContribution(plugin.id, validSlot(slot), validId(id, 'Plugin contribution id'), value),
            effect: (disposer) => { if (typeof disposer !== 'function') fail('Plugin disposer must be a function.', 'INVALID_INPUT'); cleanups.push(disposer) },
            on: (type, listener) => {
              const eventType = validEventType(type)
              if (typeof listener !== 'function') fail('Plugin event listener must be a function.', 'INVALID_INPUT')
              const handlers = listeners.get(eventType) ?? new Set<HarnessEventListener<HarnessEventType>>()
              handlers.add(listener as HarnessEventListener<HarnessEventType>); listeners.set(eventType, handlers)
              const disposer = (): void => { handlers.delete(listener as HarnessEventListener<HarnessEventType>) }
              cleanups.push(disposer); return disposer
            },
          }
          const cleanup = plugin.apply(context)
          if (cleanup) cleanups.push(cleanup)
        }
        mounted = true
      } catch (error) { registry.dispose(); throw error }
    },
    emit(event) {
      ensureOpen()
      for (const listener of listeners.get(event.type) ?? []) listener(event as HarnessEvent<HarnessEventType>)
    },
    on(type, listener) {
      ensureOpen()
      const eventType = validEventType(type)
      if (typeof listener !== 'function') fail('Plugin event listener must be a function.', 'INVALID_INPUT')
      const handlers = listeners.get(eventType) ?? new Set<HarnessEventListener<HarnessEventType>>()
      handlers.add(listener as HarnessEventListener<HarnessEventType>); listeners.set(eventType, handlers)
      return (): void => { handlers.delete(listener as HarnessEventListener<HarnessEventType>) }
    },
    contributions: <T>(slot: PluginSlot<T>): readonly PluginContribution<T>[] => [...(contributions.get(validSlot(slot).id)?.values() ?? [])] as readonly PluginContribution<T>[],
    dispose() {
      if (disposed) return
      let firstError: unknown
      for (const cleanup of cleanups.splice(0).reverse()) { try { cleanup() } catch (error) { firstError ??= error } }
      contributions.clear(); listeners.clear(); disposed = true; mounted = false
      if (firstError) throw firstError
    },
  }
  return registry
}
