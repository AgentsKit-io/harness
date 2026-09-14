import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() }
})

const originalPlatform = process.platform

const setPlatform = (platform: NodeJS.Platform): void => { Object.defineProperty(process, 'platform', { value: platform, configurable: true }) }

describe('sampleMachine: Linux swap reporting', () => {
  afterEach(() => { setPlatform(originalPlatform); vi.resetModules() })

  it('reports swapUsedPercent from /proc/meminfo on Linux when the file exists and has swap configured', async () => {
    setPlatform('linux')
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('SwapTotal:       1000 kB\nSwapFree:         250 kB\n')
    const { sampleMachine } = await import('../src/execution/machine.js')
    expect(sampleMachine().swapUsedPercent).toBe(75)
  })

  it('omits swapUsedPercent when /proc/meminfo has no SwapTotal line, or is missing, or the platform is not Linux', async () => {
    setPlatform('linux')
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('MemTotal: 1000 kB\n')
    const { sampleMachine: withNoSwapLine } = await import('../src/execution/machine.js')
    expect(withNoSwapLine().swapUsedPercent).toBeUndefined()

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.resetModules()
    const { sampleMachine: withMissingFile } = await import('../src/execution/machine.js')
    expect(withMissingFile().swapUsedPercent).toBeUndefined()

    setPlatform('darwin')
    vi.resetModules()
    const { sampleMachine: onDarwin } = await import('../src/execution/machine.js')
    expect(onDarwin().swapUsedPercent).toBeUndefined()
  })
})
