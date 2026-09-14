import { describe, expect, it, vi } from 'vitest'
import { createPluginRegistry, createPluginSlot } from '../src/index.js'
import type { HarnessPlugin } from '../src/index.js'

const plugin = (id: string, overrides: Partial<HarnessPlugin> = {}): HarnessPlugin => ({ id, version: '1.0.0', apiVersion: 1, apply: () => {}, ...overrides })

describe('plugin registry: registration guards', () => {
  it('rejects registering after mount, and after dispose', () => {
    const registry = createPluginRegistry()
    registry.register(plugin('a'))
    registry.mount()
    expect(() => registry.register(plugin('b'))).toThrow(/cannot be registered after mount/)
    registry.dispose()
    expect(() => registry.register(plugin('c'))).toThrow(/has been disposed/)
  })

  it('rejects an unsupported apiVersion and a non-array requires field', () => {
    const registry = createPluginRegistry()
    expect(() => registry.register(plugin('a', { apiVersion: 2 as never }))).toThrow(/Unsupported plugin API version/)
    expect(() => registry.register(plugin('b', { requires: 'not-an-array' as never }))).toThrow(/requires must be an array/)
  })

  it('rejects re-registering the same plugin id', () => {
    const registry = createPluginRegistry()
    registry.register(plugin('a'))
    expect(() => registry.register(plugin('a'))).toThrow(/already registered: a/)
  })

  it('rejects a missing/blank id or version', () => {
    const registry = createPluginRegistry()
    expect(() => registry.register(plugin('', {}))).toThrow(/Plugin id is required/)
    expect(() => registry.register(plugin('a', { version: '' }))).toThrow(/Plugin version is required/)
  })
})

describe('plugin registry: mount lifecycle', () => {
  it('is idempotent — a second mount() call is a no-op', () => {
    const apply = vi.fn()
    const registry = createPluginRegistry()
    registry.register(plugin('a', { apply }))
    registry.mount()
    registry.mount()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('disposes and rethrows when a plugin throws during apply()', () => {
    const cleaned: string[] = []
    const registry = createPluginRegistry()
    registry.register(plugin('a', { apply: (context) => { context.effect(() => cleaned.push('a')); throw new Error('boom') } }))
    expect(() => registry.mount()).toThrow('boom')
    expect(cleaned).toEqual(['a']) // the already-registered effect still ran during the failure-path dispose
  })

  it('rejects an effect() disposer that is not a function', () => {
    const registry = createPluginRegistry()
    registry.register(plugin('a', { apply: (context) => { context.effect('not-a-function' as never) } }))
    expect(() => registry.mount()).toThrow(/disposer must be a function/)
  })

  it('rejects a contribution registered against a malformed slot object', () => {
    const registry = createPluginRegistry()
    registry.register(plugin('a', { apply: (context) => { context.register({} as never, 'x', 1) } }))
    expect(() => registry.mount()).toThrow(/Plugin slot id is required/)
  })
})

describe('plugin registry: events', () => {
  it('delivers emitted events only to listeners of the matching type, in both on() and the mount-time context.on()', () => {
    const seen: string[] = []
    const registry = createPluginRegistry()
    registry.register(plugin('a', { apply: (context) => { context.on('run.created', (event) => seen.push(`plugin:${event.type}`)) } }))
    registry.mount()
    const disposeExternal = registry.on('run.created', (event) => seen.push(`external:${event.type}`))
    registry.emit({ type: 'run.created' } as never)
    registry.emit({ type: 'session.ended' } as never) // no listener registered for this type — silently ignored
    expect(seen).toEqual(['plugin:run.created', 'external:run.created'])
    disposeExternal()
    seen.length = 0
    registry.emit({ type: 'run.created' } as never)
    expect(seen).toEqual(['plugin:run.created']) // the external listener was removed by its disposer
  })

  it('rejects an invalid event type and a non-function listener, from both on() and context.on()', () => {
    const registry = createPluginRegistry()
    expect(() => registry.on('not.a.real.event' as never, () => {})).toThrow(/event type is invalid/)
    expect(() => registry.on('run.created', 'nope' as never)).toThrow(/event listener must be a function/)
    registry.register(plugin('a', { apply: (context) => { context.on('not.a.real.event' as never, () => {}) } }))
    expect(() => registry.mount()).toThrow(/event type is invalid/)
  })

  it('rejects emit()/on() after dispose', () => {
    const registry = createPluginRegistry()
    registry.dispose()
    expect(() => registry.emit({ type: 'run.created' } as never)).toThrow(/has been disposed/)
    expect(() => registry.on('run.created', () => {})).toThrow(/has been disposed/)
  })
})

describe('plugin registry: dispose', () => {
  it('is idempotent, and reports only the first cleanup error while still running the rest', () => {
    const ran: string[] = []
    const registry = createPluginRegistry()
    registry.register(plugin('a', { apply: (context) => { context.effect(() => { ran.push('a'); throw new Error('a failed') }) } }))
    registry.register(plugin('b', { requires: ['a'], apply: (context) => { context.effect(() => { ran.push('b'); throw new Error('b failed') }) } }))
    registry.mount()
    expect(() => registry.dispose()).toThrow('b failed') // cleanups run in reverse mount order (b before a); its error is the first one raised
    expect(ran).toEqual(['b', 'a']) // both cleanups still ran despite b's throwing
    expect(() => registry.dispose()).not.toThrow() // a second dispose() is a no-op
  })

  it('contributions() on an untouched slot returns an empty array', () => {
    const registry = createPluginRegistry()
    const slot = createPluginSlot<string>('unused.slot')
    expect(registry.contributions(slot)).toEqual([])
  })

  it('rejects a contribution registered under a duplicate id even across different plugins', () => {
    const slot = createPluginSlot<string>('shared.slot')
    const registry = createPluginRegistry()
    registry.register(plugin('a', { apply: (context) => { context.register(slot, 'x', 'first') } }))
    registry.register(plugin('b', { requires: ['a'], apply: (context) => { context.register(slot, 'x', 'second') } }))
    expect(() => registry.mount()).toThrow(/contribution already exists: shared.slot\/x/)
  })
})
