import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLoopEventBus, loadLoopPlugins } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempRoot = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-event-bus-')); cleanups.push(dir); return dir }

describe('createLoopEventBus', () => {
  it('delivers an event only to listeners of that type, plus wildcard listeners', () => {
    const bus = createLoopEventBus()
    const seenA: string[] = []
    const seenAll: string[] = []
    bus.on('contract.failed', (event) => seenA.push(event.type))
    bus.on('*', (event) => seenAll.push(event.type))
    bus.emit({ type: 'contract.failed', issue: 'ENG-1' })
    bus.emit({ type: 'worker.dispatched', issue: 'ENG-2' })
    expect(seenA).toEqual(['contract.failed'])
    expect(seenAll).toEqual(['contract.failed', 'worker.dispatched'])
  })

  it('unsubscribes via the returned disposer and never lets one listener error affect another', () => {
    const bus = createLoopEventBus()
    const seen: string[] = []
    const off = bus.on('x', () => { throw new Error('boom') })
    bus.on('x', (event) => seen.push(event.type))
    expect(() => bus.emit({ type: 'x' })).not.toThrow()
    expect(seen).toEqual(['x'])
    off()
    seen.length = 0
    bus.emit({ type: 'x' })
    expect(seen).toEqual(['x']) // the second listener is still registered; only the throwing one was removed
  })

  it('runs hooks in registration order and stops at the first block', async () => {
    const bus = createLoopEventBus()
    const calls: string[] = []
    bus.hook('beforeDispatch', () => { calls.push('first'); return undefined })
    bus.hook('beforeDispatch', () => { calls.push('second'); return { block: true, reason: 'nope' } })
    bus.hook('beforeDispatch', () => { calls.push('third'); return undefined })
    const result = await bus.runHook('beforeDispatch', { issue: 'ENG-1' })
    expect(result).toMatchObject({ block: true, reason: 'nope' })
    expect(calls).toEqual(['first', 'second']) // third never runs once blocked
  })

  it('reports a throwing hook as a non-blocking error instead of failing the run', async () => {
    const bus = createLoopEventBus()
    bus.hook('beforeMerge', () => { throw new Error('plugin bug') })
    const result = await bus.runHook('beforeMerge', {})
    expect(result.block).toBe(false)
    expect(result.errors).toEqual(['plugin bug'])
  })

  it('returns block: false with no errors when nothing is registered', async () => {
    const bus = createLoopEventBus()
    expect(await bus.runHook('afterDispatch', {})).toEqual({ block: false, errors: [] })
  })
})

describe('loadLoopPlugins', () => {
  it('loads a local module, calls apply with the bus, and lets it subscribe', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'plugin.mjs'), `
      export default {
        id: 'test-plugin',
        apply(bus) {
          bus.on('worker.dispatched', (event) => { globalThis.__pluginSaw = event.issue })
        },
      }
    `, 'utf8')
    const bus = createLoopEventBus()
    const result = await loadLoopPlugins(root, ['plugin.mjs'], bus)
    expect(result).toEqual({ loaded: ['test-plugin'], errors: [] })
    bus.emit({ type: 'worker.dispatched', issue: 'ENG-9' })
    expect((globalThis as { __pluginSaw?: string }).__pluginSaw).toBe('ENG-9')
  })

  it('reports a missing module as an error without throwing', async () => {
    const root = tempRoot()
    const bus = createLoopEventBus()
    const result = await loadLoopPlugins(root, ['nope.mjs'], bus)
    expect(result.loaded).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.path).toBe('nope.mjs')
  })

  it('reports a module with no apply export as an error without throwing', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'broken.mjs'), `export default { id: 'broken' }`, 'utf8')
    const bus = createLoopEventBus()
    const result = await loadLoopPlugins(root, ['broken.mjs'], bus)
    expect(result.loaded).toEqual([])
    expect(result.errors[0]).toMatchObject({ path: 'broken.mjs' })
  })

  it('keeps loading remaining modules after one fails', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'good.mjs'), `export default { id: 'good', apply() {} }`, 'utf8')
    const bus = createLoopEventBus()
    const result = await loadLoopPlugins(root, ['missing.mjs', 'good.mjs'], bus)
    expect(result.loaded).toEqual(['good'])
    expect(result.errors).toHaveLength(1)
  })
})
