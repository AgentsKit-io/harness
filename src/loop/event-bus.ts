/**
 * A local, in-process pub/sub bus over the loop's own event vocabulary (the same free-form `type` strings
 * `appendLoopEvent` writes to `<stateDir>/events.ndjson`: `contract.failed`, `worker.dispatched`, `pr.reviewed`,
 * `provider.cooldown`, `issue.paused`, etc.). It exists so a project can react to loop activity in real time
 * (tick/deliver run) instead of only reading the ndjson after the fact — the ndjson stays the durable log; this is
 * only a live fan-out on top of it, scoped to the current process.
 *
 * Deliberately not `kernel/plugins.ts`: that registry ties into `HARNESS_EVENT_TYPES` (the harness's own
 * lifecycle events) and requires plugin ids/versions/dependency ordering. The loop's event vocabulary is an open
 * set of strings owned by composition, not the kernel, so this is a plain listener map with the same "who's
 * listening" ergonomics, not a copy of the kernel's contract.
 */

export type LoopEventPayload = Readonly<Record<string, unknown>> & { readonly type: string }
export type LoopEventListener = (event: LoopEventPayload) => void

/**
 * Fired around a loop-orchestration decision (not a model/tool call inside the worker's own CLI session — that
 * loop is opaque to us). A `before*` hook can return `{ block: true, reason }` to stop the action outright; any
 * other return value (including a thrown error, which is treated as `{ block: true }`) does not block.
 */
export type LoopHookName = 'beforeDispatch' | 'afterDispatch' | 'beforeReview' | 'afterReview' | 'beforeMerge' | 'afterMerge' | 'onPause' | 'onEscalate'
export type LoopHookPayload = Readonly<Record<string, unknown>>
export type LoopHookResult = void | { readonly block: true; readonly reason: string }
export type LoopHookListener = (payload: LoopHookPayload) => LoopHookResult | Promise<LoopHookResult>

export interface LoopEventBus {
  /** Emit a loop event to every subscriber of its `type`. Never throws: a listener error is swallowed (composition must not fail because a plugin misbehaves). */
  emit(event: LoopEventPayload): void
  /** Subscribe to one event type (or `'*'` for every event). Returns an unsubscribe function. */
  on(type: string | '*', listener: LoopEventListener): () => void
  /** Register a lifecycle hook. Multiple listeners on the same hook all run; the first `{ block: true }` wins. */
  hook(name: LoopHookName, listener: LoopHookListener): () => void
  /**
   * Run every listener registered for `name` in registration order and return the first block decision, or
   * `{ block: false }` when none blocked. A listener that throws is treated as a non-blocking no-op (a broken
   * plugin must not take down the loop) and its error is appended to `errors`.
   */
  runHook(name: LoopHookName, payload: LoopHookPayload): Promise<{ readonly block: boolean; readonly reason?: string; readonly errors: readonly string[] }>
}

export const createLoopEventBus = (): LoopEventBus => {
  const listeners = new Map<string, Set<LoopEventListener>>()
  const hooks = new Map<LoopHookName, Set<LoopHookListener>>()

  return {
    emit(event) {
      for (const listener of listeners.get(event.type) ?? []) { try { listener(event) } catch { /* a subscriber's own failure must not affect the loop */ } }
      for (const listener of listeners.get('*') ?? []) { try { listener(event) } catch { /* same */ } }
    },
    on(type, listener) {
      const set = listeners.get(type) ?? new Set<LoopEventListener>()
      set.add(listener)
      listeners.set(type, set)
      return () => { set.delete(listener) }
    },
    hook(name, listener) {
      const set = hooks.get(name) ?? new Set<LoopHookListener>()
      set.add(listener)
      hooks.set(name, set)
      return () => { set.delete(listener) }
    },
    async runHook(name, payload) {
      const errors: string[] = []
      for (const listener of hooks.get(name) ?? []) {
        try {
          const result = await listener(payload)
          if (result?.block) return { block: true, reason: result.reason, errors }
        } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
      }
      return { block: false, errors }
    },
  }
}

/**
 * Load `plugins.modules` (local `.mjs` files, the same trust level as `agents.registry.yaml`: files the project
 * owner put in their own repo, never fetched over the network) and give each one the bus to subscribe to. A
 * module that fails to load or whose `apply` throws is reported, not fatal — one broken plugin must not stop tick
 * or deliver from running.
 */
export interface LoopPluginModule { readonly id: string; readonly apply: (bus: LoopEventBus) => void | Promise<void> }

export const loadLoopPlugins = async (root: string, modulePaths: readonly string[], bus: LoopEventBus): Promise<{ readonly loaded: readonly string[]; readonly errors: readonly { readonly path: string; readonly error: string }[] }> => {
  const { resolve } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const loaded: string[] = []
  const errors: { readonly path: string; readonly error: string }[] = []
  for (const relativePath of modulePaths) {
    const absolute = resolve(root, relativePath)
    try {
      const mod = (await import(pathToFileURL(absolute).href)) as { readonly default?: LoopPluginModule } & Partial<LoopPluginModule>
      const plugin = mod.default ?? (mod as unknown as LoopPluginModule)
      if (!plugin || typeof plugin.apply !== 'function') throw new Error(`module does not export { id, apply(bus) }`)
      await plugin.apply(bus)
      loaded.push(plugin.id ?? relativePath)
    } catch (error) { errors.push({ path: relativePath, error: error instanceof Error ? error.message : String(error) }) }
  }
  return { loaded, errors }
}
