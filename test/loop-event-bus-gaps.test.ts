import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLoopEventBus, loadLoopPlugins } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempRoot = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-event-bus-gaps-')); cleanups.push(dir); return dir }

describe('createLoopEventBus hooks', () => {
  it('unsubscribes a hook via its disposer', async () => {
    const bus = createLoopEventBus()
    const calls: string[] = []
    const off = bus.hook('onPause', () => { calls.push('seen') })
    off()
    await bus.runHook('onPause', {})
    expect(calls).toEqual([])
  })

  it('treats a listener returning void as a non-blocking result', async () => {
    const bus = createLoopEventBus()
    bus.hook('onEscalate', () => undefined)
    expect(await bus.runHook('onEscalate', {})).toEqual({ block: false, errors: [] })
  })
})

describe('loadLoopPlugins module shapes', () => {
  it('accepts a module using named exports instead of a default export', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'named.mjs'), `export const id = 'named-plugin'\nexport function apply() {}\n`, 'utf8')
    const bus = createLoopEventBus()
    const result = await loadLoopPlugins(root, ['named.mjs'], bus)
    expect(result).toEqual({ loaded: ['named-plugin'], errors: [] })
  })

  it('falls back to the relative path as the loaded id when the plugin has none', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'anonymous.mjs'), `export default { apply() {} }`, 'utf8')
    const bus = createLoopEventBus()
    const result = await loadLoopPlugins(root, ['anonymous.mjs'], bus)
    expect(result).toEqual({ loaded: ['anonymous.mjs'], errors: [] })
  })

  it('stringifies a non-Error thrown value from a broken apply()', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'throws.mjs'), `export default { id: 'throws', apply() { throw 'plain string failure' } }`, 'utf8')
    const bus = createLoopEventBus()
    const result = await loadLoopPlugins(root, ['throws.mjs'], bus)
    expect(result.loaded).toEqual([])
    expect(result.errors[0]).toMatchObject({ path: 'throws.mjs', error: 'plain string failure' })
  })
})
