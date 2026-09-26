import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDockerToolRuntime, createProcessToolRuntime } from '../src/index.js'
import { hostAbsolutePath, spawnEnvironment } from '../src/execution/runtime.js'

// Captures what the runtime hands to `spawn` without starting a real process, so the child environment can be
// asserted on any host. The runtime spawns through `cross-spawn` (a `.cmd` shim is not executable by
// CreateProcess), so that is the module this has to intercept — mocking `node:child_process` alone would let
// a real process start and the assertion would read an environment nobody set.
const spawned = vi.hoisted(() => [] as NodeJS.ProcessEnv[])
const fakeSpawn = vi.hoisted(() => (_command: string, _args: readonly string[], options: { readonly env: NodeJS.ProcessEnv }) => {
  spawned.push(options.env)
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true })
  setTimeout(() => { child.stdout.end(); child.emit('close', 0) }, 0)
  return child
})
vi.mock('cross-spawn', () => ({ default: fakeSpawn }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: fakeSpawn as unknown as typeof actual.spawn }
})

describe('hostAbsolutePath: host paths on Windows', () => {
  it('accepts a drive-letter path and a UNC share, normalising separators for the docker mount argument', () => {
    expect(hostAbsolutePath('C:\\repo\\work', 'source')).toBe('C:/repo/work')
    expect(hostAbsolutePath('c:/repo/work', 'source')).toBe('c:/repo/work')
    expect(hostAbsolutePath('\\\\server\\share\\repo', 'source')).toBe('//server/share/repo')
  })

  it('still rejects relative paths, bare drive letters, and commas', () => {
    expect(() => hostAbsolutePath('repo\\work', 'source')).toThrow(/absolute path without commas/)
    expect(() => hostAbsolutePath('C:repo', 'source')).toThrow(/absolute path without commas/)
    expect(() => hostAbsolutePath('C:\\repo,work', 'source')).toThrow(/absolute path without commas/)
    expect(() => hostAbsolutePath('   ', 'source')).toThrow(/source is required/)
  })

  it('accepts a Windows mount source while keeping the container target POSIX-only', () => {
    expect(() => createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine', command: ['/bin/true'], mounts: [{ source: 'C:\\repo', target: '/work' }] }] })).not.toThrow()
    expect(() => createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine', command: ['/bin/true'], mounts: [{ source: 'C:\\repo', target: 'C:\\work' }] }] })).toThrow(/mounts\[0\]\.target must be an absolute path/)
    expect(() => createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine', command: ['/bin/true'], cwd: 'C:\\work' }] })).toThrow(/cwd must be an absolute path/)
  })
})

describe('spawnEnvironment: child process environment', () => {
  const source = { PATH: '/usr/bin', SystemRoot: 'C:\\Windows', COMSPEC: 'C:\\Windows\\system32\\cmd.exe', TEMP: 'C:\\Temp', PATHEXT: '.COM;.EXE', HOME: '/home/agent', AWS_SECRET_ACCESS_KEY: 'leak' } as const

  it('passes only PATH through on POSIX', () => {
    expect(spawnEnvironment(undefined, 'linux', source)).toEqual({ PATH: '/usr/bin' })
    expect(spawnEnvironment({ CUSTOM: 'value' }, 'darwin', source)).toEqual({ CUSTOM: 'value' })
  })

  it('adds the Windows system variables a child needs to start, and nothing else', () => {
    expect(spawnEnvironment(undefined, 'win32', source)).toEqual({ PATH: '/usr/bin', SystemRoot: 'C:\\Windows', COMSPEC: 'C:\\Windows\\system32\\cmd.exe', TEMP: 'C:\\Temp', PATHEXT: '.COM;.EXE' })
    expect(spawnEnvironment({ CUSTOM: 'value' }, 'win32', source)).toMatchObject({ CUSTOM: 'value', SystemRoot: 'C:\\Windows' })
  })

  it('never overrides a value the tool declared, whatever the case of the key', () => {
    expect(spawnEnvironment({ systemroot: 'D:\\Windows' }, 'win32', source)['SystemRoot']).toBeUndefined()
    expect(spawnEnvironment({ systemroot: 'D:\\Windows' }, 'win32', source)['systemroot']).toBe('D:\\Windows')
  })
})

describe('createProcessToolRuntime: child environment on Windows', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('passes the Windows system variables to the spawned tool', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.stubEnv('COMSPEC', 'C:\\Windows\\system32\\cmd.exe')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!platform) throw new Error('process.platform descriptor is missing.')
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      const runtime = createProcessToolRuntime({ tools: [{ toolId: 'shell', command: 'tool.exe' }] })
      await runtime.execute({ actionId: 'action', turnId: 'turn', toolId: 'shell', argumentsHash: 'hash', arguments: {} })
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
    const environment = spawned.at(-1) ?? {}
    // Case-insensitive lookup, not a literal `environment['SystemRoot']`: `vi.stubEnv` sets a real process.env
    // entry, and on a real Windows host that name almost always already exists under whatever casing that
    // machine's own OS install happens to use (`SYSTEMROOT`, `SystemRoot`, ...) — Node's win32 env handling
    // updates the existing entry's value in place but does not change its enumerated key casing, so asserting on
    // one specific casing is asserting on a host-dependent accident, not the behavior this test means to cover
    // (that the value gets forwarded at all, whatever its key happens to be cased as).
    const value = (name: string): string | undefined => Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    expect(value('SystemRoot')).toBe('C:\\Windows')
    expect(value('COMSPEC')).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(environment['PATH']).toBe(process.env['PATH'] ?? '')
  })
})
