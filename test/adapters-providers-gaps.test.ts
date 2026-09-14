import { describe, expect, it } from 'vitest'
import { authStatusFor, cooldownUntil, detectProviders, parseProviderUsage, parseUsageWindows, undeclaredOrcaProviders } from '../src/index.js'
import { listOrcaIntegratedProviderKeys } from '../src/adapters/providers.js'
import type { CommandResult, CommandRunner, ProviderSpec, ProviderUsage } from '../src/index.js'

describe('parseUsageWindows', () => {
  it('returns an empty list for a non-record entry', () => {
    expect(parseUsageWindows(null)).toEqual([])
    expect(parseUsageWindows('nope')).toEqual([])
    expect(parseUsageWindows([])).toEqual([])
  })

  it('skips a window entry that is not a record or has no numeric usedPercent', () => {
    expect(parseUsageWindows({ session: 'not-a-record', weekly: { usedPercent: 'not-a-number' } })).toEqual([])
  })

  it('reads resetsAt from a numeric epoch or an ISO string, and null for an invalid one', () => {
    const windows = parseUsageWindows({ session: { usedPercent: 10, resetsAt: 1_800_000_000_000 }, weekly: { usedPercent: 20, resetsAt: '2026-01-01T00:00:00Z' }, monthly: { usedPercent: 30, resetsAt: 'not-a-date' } })
    expect(windows.find((w) => w.kind === 'session')?.resetsAt).toBe(new Date(1_800_000_000_000).toISOString())
    expect(windows.find((w) => w.kind === 'weekly')?.resetsAt).toBe('2026-01-01T00:00:00.000Z')
    expect(windows.find((w) => w.kind === 'monthly')?.resetsAt).toBeNull()
  })

  it('defaults windowMinutes to null when absent or non-numeric', () => {
    expect(parseUsageWindows({ session: { usedPercent: 10 } })[0]?.windowMinutes).toBeNull()
  })
})

describe('parseProviderUsage', () => {
  it('derives hasAuth from a systemDefault flag when present', () => {
    const usage = parseProviderUsage({ rateLimits: { claude: { status: 'ok' } }, claude: { systemDefault: { hasAuth: true } } }, 'claude')
    expect(usage.hasAuth).toBe(true)
  })

  it('derives hasAuth true from a non-empty accounts array when there is no systemDefault', () => {
    const usage = parseProviderUsage({ rateLimits: { claude: { status: 'ok' } }, claude: { accounts: [{ id: 'a' }] } }, 'claude')
    expect(usage.hasAuth).toBe(true)
  })

  it('leaves hasAuth null when there is neither a systemDefault nor any accounts', () => {
    const usage = parseProviderUsage({ rateLimits: { claude: { status: 'ok' } }, claude: {} }, 'claude')
    expect(usage.hasAuth).toBeNull()
  })

  it('maps every entry status to its ProviderUsage status, defaulting to unknown', () => {
    const of = (status: string) => parseProviderUsage({ rateLimits: { p: { status } } }, 'p').status
    expect(of('ok')).toBe('ok')
    expect(of('unavailable')).toBe('unavailable')
    expect(of('something-else')).toBe('unknown')
  })

  it('reads a string error message when present', () => {
    expect(parseProviderUsage({ rateLimits: { p: { status: 'unavailable', error: 'quota API down' } } }, 'p').error).toBe('quota API down')
  })

  it('picks the earliest resetsAt among multiple exhausted windows', () => {
    const usage = parseProviderUsage({ rateLimits: { p: { status: 'ok', session: { usedPercent: 100, resetsAt: '2026-02-01T00:00:00Z' }, weekly: { usedPercent: 100, resetsAt: '2026-01-01T00:00:00Z' } } } }, 'p')
    expect(usage.resetsAt).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('authStatusFor: remaining branches', () => {
  const spec = (auth: ProviderSpec['auth'], envKeys: readonly string[] = []): ProviderSpec => ({ id: 'p', bin: 'p', auth, envKeys, orcaUsageKey: 'p' })
  const usage = (overrides: Partial<ProviderUsage> = {}): ProviderUsage => ({ status: 'unknown', error: null, windows: [], exhausted: false, resetsAt: null, hasAuth: null, ...overrides })

  it('a subscription provider with an env key set but unresolved Orca status is ok', () => {
    expect(authStatusFor(spec('subscription', ['SOME_KEY']), usage(), { SOME_KEY: 'x' })).toBe('ok')
  })

  it('a subscription provider with no env key and an "unavailable" (not merely unknown) Orca status is unknown', () => {
    expect(authStatusFor(spec('subscription'), usage({ status: 'unavailable' }), {})).toBe('unknown')
  })

  it('a subscription provider with no env key but a genuinely unknown Orca status is ok (Orca simply never mentioned it)', () => {
    expect(authStatusFor(spec('subscription'), usage(), {})).toBe('ok')
  })

  it('a "none"-auth provider is ok when an env key is set or Orca confirms status ok, unknown otherwise', () => {
    expect(authStatusFor(spec('none', ['ANY_KEY']), usage(), { ANY_KEY: 'x' })).toBe('ok')
    expect(authStatusFor(spec('none'), usage({ status: 'ok' }), {})).toBe('ok')
    expect(authStatusFor(spec('none'), usage(), {})).toBe('unknown')
  })
})

describe('detectProviders: probe and cooldown branches', () => {
  const baseSpec: ProviderSpec = { id: 'p', bin: 'agentskit-harness-fake-bin-xyz', auth: 'none', envKeys: [], orcaUsageKey: 'p' }

  it('skips the probe (and reports no probe-failure reason) when no probe command is configured', async () => {
    const results = await detectProviders({ providers: [{ ...baseSpec }], accountList: {}, agentHooks: {} })
    expect(results[0]).toMatchObject({ binary: null, probe: 'skipped' })
  })

  it('skips the probe when there is no runner even if a probe command is configured', async () => {
    const results = await detectProviders({ providers: [{ ...baseSpec, probe: ['p', '--version'] }], accountList: {}, agentHooks: {} })
    expect(results[0]?.probe).toBe('skipped')
  })

  it('substitutes the resolved binary path for a probe argv head that names spec.bin, but keeps a different head as-is', async () => {
    const fakeBin = process.execPath
    const calls: string[][] = []
    const trackingRunner: CommandRunner = { run: async (argv): Promise<CommandResult> => { calls.push([...argv]); return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 } } }
    await detectProviders({ providers: [{ id: 'p', bin: fakeBin, auth: 'none', envKeys: [], orcaUsageKey: 'p', probe: [fakeBin, '-e', '1'] }], accountList: {}, agentHooks: {}, runner: trackingRunner })
    expect(calls[0]?.[0]).toBe(fakeBin) // head === spec.bin was substituted with the resolved binary path (itself, here)

    calls.length = 0
    await detectProviders({ providers: [{ id: 'p', bin: fakeBin, auth: 'none', envKeys: [], orcaUsageKey: 'p', probe: ['some-other-tool', '--check'] }], accountList: {}, agentHooks: {}, runner: trackingRunner })
    expect(calls[0]?.[0]).toBe('some-other-tool') // a probe head that names a different tool is left untouched
  })

  it('marks the probe failed when the command exits non-zero or throws, adding a reason', async () => {
    const fakeBin = process.execPath // a real, resolvable binary so probing actually runs
    const failingRunner: CommandRunner = { run: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false, durationMs: 1 }) }
    const failed = await detectProviders({ providers: [{ id: 'p', bin: fakeBin, auth: 'none', envKeys: [], orcaUsageKey: 'p', probe: [fakeBin, '-e', '1'] }], accountList: {}, agentHooks: {}, runner: failingRunner })
    expect(failed[0]).toMatchObject({ probe: 'failed', available: false })
    expect(failed[0]?.reasons).toContain('probe command failed')

    const throwingRunner: CommandRunner = { run: async () => { throw new Error('spawn error') } }
    const thrown = await detectProviders({ providers: [{ id: 'p', bin: fakeBin, auth: 'none', envKeys: [], orcaUsageKey: 'p', probe: [fakeBin] }], accountList: {}, agentHooks: {}, runner: throwingRunner })
    expect(thrown[0]?.probe).toBe('failed')
  })

  it('marks a provider unavailable while its cooldown is in the future, and available once it has passed', async () => {
    const fakeBin = process.execPath
    const future = await detectProviders({ providers: [{ id: 'p', bin: fakeBin, auth: 'none', envKeys: [], orcaUsageKey: 'p' }], accountList: {}, agentHooks: {}, cooldowns: { p: '2999-01-01T00:00:00.000Z' }, now: () => new Date('2026-01-01T00:00:00.000Z') })
    expect(future[0]?.available).toBe(false)
    expect(future[0]?.reasons.some((r) => r.startsWith('cooling down until'))).toBe(true)

    const past = await detectProviders({ providers: [{ id: 'p', bin: fakeBin, auth: 'none', envKeys: [], orcaUsageKey: 'p' }], accountList: {}, agentHooks: {}, cooldowns: { p: '2020-01-01T00:00:00.000Z' }, now: () => new Date('2026-01-01T00:00:00.000Z') })
    expect(past[0]?.reasons.some((r) => r.startsWith('cooling down'))).toBe(false)
  })

  it('defaults hookState to unknown when agentHooks has no entry for the provider', async () => {
    const results = await detectProviders({ providers: [{ ...baseSpec }], accountList: {}, agentHooks: {} })
    expect(results[0]?.hookState).toBe('unknown')
  })
})

describe('cooldownUntil: invalid resetsAt', () => {
  it('falls back to pure backoff when resetsAt does not parse', () => {
    const from = new Date('2026-01-01T00:00:00.000Z')
    expect(cooldownUntil(0, 30, 240, from, 'not-a-date')).toBe(cooldownUntil(0, 30, 240, from, null))
  })

  it('uses the backoff instead of an earlier resetsAt', () => {
    const from = new Date('2026-01-01T00:00:00.000Z')
    const result = cooldownUntil(0, 30, 240, from, '2026-01-01T00:00:01.000Z') // resets almost immediately, well before the 30-min backoff
    expect(result).toBe('2026-01-01T00:30:00.000Z')
  })
})

describe('listOrcaIntegratedProviderKeys', () => {
  it('returns keys from rateLimits and top-level record entries, excluding Orca meta keys, sorted', () => {
    const keys = listOrcaIntegratedProviderKeys({
      rateLimits: { claude: { status: 'ok' }, grokAuthConfigured: true },
      codex: { accounts: [] },
      minimaxCookieConfigured: true,
      notAnObject: 'x',
    })
    expect(keys).toEqual(['claude', 'codex'])
  })

  it('returns an empty list for a non-object accountList', () => {
    expect(listOrcaIntegratedProviderKeys(null)).toEqual([])
    expect(listOrcaIntegratedProviderKeys('nope')).toEqual([])
  })
})

describe('undeclaredOrcaProviders', () => {
  it('flags an Orca-integrated provider with no matching declared provider', () => {
    const undeclared = undeclaredOrcaProviders({ rateLimits: { claude: { status: 'ok' }, mystery: { status: 'ok' } } }, { claude: { orcaUsageKey: 'claude' } })
    expect(undeclared).toEqual(['mystery'])
  })

  it('resolves a declared provider by its orcaUsageKey as well as its own id', () => {
    const undeclared = undeclaredOrcaProviders({ rateLimits: { claudeUsage: { status: 'ok' } } }, { claude: { orcaUsageKey: 'claudeUsage' } })
    expect(undeclared).toEqual([])
  })

  it('treats the opencodeGo Orca alias as satisfied by a declared "opencode" provider', () => {
    const undeclared = undeclaredOrcaProviders({ rateLimits: { opencodeGo: { status: 'ok' } } }, { opencode: {} })
    expect(undeclared).toEqual([])
  })
})
