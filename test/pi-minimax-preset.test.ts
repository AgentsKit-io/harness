import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectProviders, parseLoopConfigText, providerIdentity, selectModel } from '../src/index.js'

const preset = () => parseLoopConfigText(readFileSync(join(process.cwd(), 'examples/loop.pi-minimax.yaml'), 'utf8'))
const account = (usedPercent = 10): unknown => ({ rateLimits: { minimax: { status: 'ok', weekly: { usedPercent, windowMinutes: 10_080, resetsAt: null } } } })
const piSpec = (config = preset()) => ({ id: 'pi-minimax', bin: 'pi', auth: 'api-key' as const, envKeys: ['MINIMAX_API_KEY'], orcaUsageKey: providerIdentity(config, 'pi-minimax').orcaUsageKey, probe: ['pi', '--version'] })
const cleanups: string[] = []
afterEach(() => { for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true }) })
const piPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-minimax-preset-')); cleanups.push(dir)
  writeFileSync(join(dir, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return dir
}

describe('Pi + MiniMax M3 preset', () => {
  it('pins only builder and watcher to Pi/M3 and renders the Pi TUI argv', () => {
    const config = preset()
    expect(config.schedule.runner).toBe('precheck')
    expect(config.models.builder).toEqual([['pi-minimax/M3']])
    expect(config.models.watcher).toEqual([['pi-minimax/M3']])
    expect(config.models.orchestrator).not.toContain('pi-minimax/M3')
    expect(config.models.reviewer).not.toContain('pi-minimax/M3')
    expect(providerIdentity(config, 'pi-minimax').orcaUsageKey).toBe('minimax')
    const available = [{ id: 'pi-minimax', binary: '/bin/pi', hookState: 'unknown' as const, auth: 'ok' as const, usage: { status: 'ok' as const, error: null, windows: [], exhausted: false, resetsAt: null, hasAuth: true }, probe: 'passed' as const, coolingDownUntil: null, available: true, reasons: [] }]
    for (const role of ['builder', 'watcher'] as const) expect(selectModel(config, role, available).selected).toMatchObject({ provider: 'pi-minimax', model: 'M3', tui: 'pi --provider minimax --model M3' })
  })

  it.each([
    ['missing binary', false, {}, {}],
    ['missing credential', false, {}, {}],
    ['exhausted quota', true, { MINIMAX_API_KEY: 'key' }, account(100)],
    ['active cooldown', true, { MINIMAX_API_KEY: 'key' }, account(10)],
  ])('does not route builder or watcher when Pi/M3 has %s', async (label, withPi, credentials, accountList) => {
    const config = preset()
    const cooldowns = label === 'active cooldown' ? { 'pi-minimax': '2030-01-01T00:00:00.000Z' } : {}
    const env = { PATH: withPi ? piPath() : '', ...credentials }
    const providers = await detectProviders({ providers: [piSpec(config)], accountList, agentHooks: {}, env, platform: process.platform, cooldowns, now: () => new Date('2029-01-01T00:00:00.000Z') })
    expect(providers[0]?.available).toBe(false)
    for (const role of ['builder', 'watcher'] as const) {
      const decision = selectModel(config, role, providers)
      expect(decision.selected).toBeNull()
      expect(decision.skipped[0]?.reasons.join(' ')).not.toEqual('')
    }
  })
})
