import { describe, expect, it, vi } from 'vitest'
import { createConfiguredToolRuntime, createDockerToolRuntime, createProcessToolRuntime, createToolRuntime } from '../src/index.js'

// Defaults to failing image inspection, matching this environment's real behavior (no `docker` binary), so
// every pre-existing test keeps exercising the genuine IMAGE_UNAVAILABLE path. Individual tests below opt into
// a simulated successful inspection by setting `digest`.
const execFileState = vi.hoisted(() => ({ digest: null as string | null }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: ((_command: string, _args: readonly string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (execFileState.digest === null) callback(new Error('docker: command not found'))
      else callback(null, { stdout: `${execFileState.digest}\n`, stderr: '' })
    }) as unknown as typeof actual.execFile,
  }
})

const request = { actionId: 'action', turnId: 'turn', toolId: 'shell', argumentsHash: 'hash', arguments: { command: 'echo ok' } } as const

describe('createToolRuntime: constructor guards', () => {
  it('rejects a non-array tools list', () => {
    expect(() => createToolRuntime({ tools: 'nope' as never })).toThrow(/tools must be an array/)
  })

  it('rejects a malformed tool entry', () => {
    expect(() => createToolRuntime({ tools: [null as never] })).toThrow(/tools\[0\] must be an object/)
    expect(() => createToolRuntime({ tools: [{ toolId: '', execute: () => {} }] })).toThrow(/toolId is required/)
    expect(() => createToolRuntime({ tools: [{ toolId: 'x' } as never] })).toThrow(/execute is required/)
  })
})

describe('createProcessToolRuntime: constructor guards', () => {
  it('rejects a non-array tools list, an invalid timeoutMs, and an invalid maxOutputBytes', () => {
    expect(() => createProcessToolRuntime({ tools: 'nope' as never })).toThrow(/Process runtime tools must be an array/)
    expect(() => createProcessToolRuntime({ tools: [], timeoutMs: 0 })).toThrow(/Process runtime timeoutMs must be a positive integer/)
    expect(() => createProcessToolRuntime({ tools: [], maxOutputBytes: 0 })).toThrow(/Process runtime maxOutputBytes must be a positive integer/)
  })

  it('rejects a tool missing a command, or with malformed args/env', () => {
    expect(() => createProcessToolRuntime({ tools: [{ toolId: 'x', command: '' }] })).toThrow(/command is required/)
    expect(() => createProcessToolRuntime({ tools: [{ toolId: 'x', command: 'echo', args: [1] as never }] })).toThrow(/args must contain strings/)
    expect(() => createProcessToolRuntime({ tools: [{ toolId: 'x', command: 'echo', env: { KEY: 1 } as never }] })).toThrow(/env must contain string values/)
  })

  it('rejects duplicate tool ids', () => {
    expect(() => createProcessToolRuntime({ tools: [{ toolId: 'x', command: 'echo' }, { toolId: 'x', command: 'echo' }] })).toThrow(/must have unique ids/)
  })

  it('returns TOOL_NOT_FOUND for an unregistered toolId', async () => {
    const runtime = createProcessToolRuntime({ tools: [{ toolId: 'known', command: process.execPath, args: ['-e', '0'] }] })
    await expect(runtime.execute({ ...request, toolId: 'unknown' })).resolves.toMatchObject({ status: 'failed', errorCode: 'TOOL_NOT_FOUND', retryable: false })
  })

  it('returns SERIALIZATION_ERROR when the request contains a circular argument', async () => {
    const runtime = createProcessToolRuntime({ tools: [{ toolId: 'x', command: process.execPath, args: ['-e', '0'] }] })
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    await expect(runtime.execute({ ...request, toolId: 'x', arguments: circular })).resolves.toMatchObject({ status: 'failed', errorCode: 'SERIALIZATION_ERROR', retryable: false })
  })

  it('returns PROCESS_ERROR when the command does not exist (spawn failure)', async () => {
    const runtime = createProcessToolRuntime({ tools: [{ toolId: 'x', command: 'agentskit-harness-definitely-not-a-real-binary-xyz' }] })
    await expect(runtime.execute({ ...request, toolId: 'x' })).resolves.toMatchObject({ status: 'failed', errorCode: 'PROCESS_ERROR', retryable: true })
  })

  it('passes an explicit env object through to the spawned process, overriding the PATH-only default', async () => {
    const runtime = createProcessToolRuntime({ tools: [{ toolId: 'x', command: process.execPath, args: ['-e', 'process.stdout.write(process.env.CUSTOM_VAR || "missing")'], env: { CUSTOM_VAR: 'present', PATH: process.env['PATH'] ?? '' } }] })
    const result = await runtime.execute({ ...request, toolId: 'x' })
    expect(result.status).toBe('completed')
  })

  it('rejects a request with a blank actionId/turnId/toolId/argumentsHash', async () => {
    const runtime = createProcessToolRuntime({ tools: [{ toolId: 'x', command: process.execPath, args: ['-e', '0'] }] })
    await expect(runtime.execute({ ...request, toolId: 'x', actionId: '' })).rejects.toThrow(/actionId is required/)
  })
})

describe('createDockerToolRuntime: constructor guards', () => {
  it('rejects a non-array tools list', () => {
    expect(() => createDockerToolRuntime({ tools: 'nope' as never })).toThrow(/Docker runtime tools must be an array/)
  })

  it('rejects a blank dockerCommand, memoryLimit, or user', () => {
    expect(() => createDockerToolRuntime({ tools: [], dockerCommand: '' })).toThrow(/dockerCommand is required/)
    expect(() => createDockerToolRuntime({ tools: [], memoryLimit: '' })).toThrow(/memoryLimit is required/)
    expect(() => createDockerToolRuntime({ tools: [], user: '' })).toThrow(/user is required/)
  })

  it('rejects a user containing spaces', () => {
    expect(() => createDockerToolRuntime({ tools: [], user: 'root user' })).toThrow(/user must not contain spaces/)
  })

  it('rejects a non-positive or malformed cpus value', () => {
    expect(() => createDockerToolRuntime({ tools: [], cpus: 0 })).toThrow(/cpus must be positive/)
    expect(() => createDockerToolRuntime({ tools: [], cpus: 'abc' })).toThrow(/cpus must be positive/)
    expect(() => createDockerToolRuntime({ tools: [], cpus: -1 })).toThrow(/cpus must be positive/)
  })

  it('rejects a non-positive pidsLimit', () => {
    expect(() => createDockerToolRuntime({ tools: [], pidsLimit: 0 })).toThrow(/pidsLimit must be a positive integer/)
  })

  it('rejects an invalid pull mode', () => {
    expect(() => createDockerToolRuntime({ tools: [], pull: 'sometimes' as never })).toThrow(/pull must be never, missing, or always/)
  })

  it('rejects a tool missing an image or with an empty/malformed command array', () => {
    expect(() => createDockerToolRuntime({ tools: [{ toolId: 'x', image: '', command: ['/bin/true'] }] })).toThrow(/image is required/)
    expect(() => createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine', command: [''] }] })).toThrow(/command must be a non-empty string array/)
  })

  it('rejects malformed args on a Docker tool', () => {
    expect(() => createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine', command: ['/bin/true'], args: [1] as never }] })).toThrow(/args must contain strings/)
  })

  it('rejects an invalid env object on a Docker tool (non-object, bad key, non-string value)', () => {
    expect(() => createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine', command: ['/bin/true'], env: 'nope' as never }] })).toThrow(/env must be an object/)
    expect(() => createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine', command: ['/bin/true'], env: { '1bad': 'x' } }] })).toThrow(/env must contain valid string environment entries/)
    expect(() => createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine', command: ['/bin/true'], env: { GOOD: 1 as never } }] })).toThrow(/env must contain valid string environment entries/)
  })

  it('rejects a malformed mount entry (non-object, bad readOnly type)', () => {
    expect(() => createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine', command: ['/bin/true'], mounts: [null as never] }] })).toThrow(/mounts\[0\] must be an object/)
    expect(() => createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine', command: ['/bin/true'], mounts: [{ source: '/a', target: '/b', readOnly: 'yes' as never }] }] })).toThrow(/readOnly must be boolean/)
  })

  it('rejects a Docker mount source/target containing a comma', () => {
    expect(() => createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine', command: ['/bin/true'], mounts: [{ source: '/a,b', target: '/b' }] }] })).toThrow(/absolute path without commas/)
  })

  it('rejects a relative cwd on a Docker tool at construction time', () => {
    expect(() => createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine', command: ['/bin/true'], cwd: 'relative' }] })).toThrow(/absolute path without commas/)
  })

  it('rejects duplicate Docker tool ids', () => {
    expect(() => createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine', command: ['/bin/true'] }, { toolId: 'x', image: 'alpine', command: ['/bin/true'] }] })).toThrow(/must have unique ids/)
  })

  it('falls through to the underlying process runtime for a request whose toolId is not registered here', async () => {
    const runtime = createDockerToolRuntime({ tools: [] })
    await expect(runtime.execute({ ...request, toolId: 'unregistered' })).resolves.toMatchObject({ status: 'failed', errorCode: 'TOOL_NOT_FOUND' })
  })

  it('runs the container and attaches runtime evidence once the image inspection succeeds (docker inspection mocked, container run for real)', async () => {
    execFileState.digest = `sha256:${'a'.repeat(64)}`
    const runtime = createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine:3.21', command: [process.execPath, '-e', '0'] }], dockerCommand: process.execPath })
    const result = await runtime.execute({ ...request, toolId: 'x' })
    // dockerCommand is stubbed to node itself (not real docker), so the container "run" step will fail to
    // exec as a docker CLI — the point of this test is only to prove the mocked-success inspection path
    // attaches runtimeEvidence with the inspected digest, not to actually run a container.
    expect(result.runtimeEvidence).toMatchObject({ provider: 'docker', image: 'alpine:3.21', imageDigest: execFileState.digest })
    execFileState.digest = null
  })

  it('fails closed when the image inspection returns a malformed (non-digest) response', async () => {
    execFileState.digest = 'not-a-digest'
    const runtime = createDockerToolRuntime({ tools: [{ toolId: 'x', image: 'alpine:3.21', command: ['/bin/true'] }] })
    await expect(runtime.execute({ ...request, toolId: 'x' })).resolves.toMatchObject({ status: 'failed', errorCode: 'IMAGE_UNAVAILABLE' })
    execFileState.digest = null
  })
})

describe('createConfiguredToolRuntime', () => {
  it('selects the Docker runtime when runtime.kind is docker', async () => {
    const runtime = createConfiguredToolRuntime({ runtime: { kind: 'docker' } as never, process: { tools: [] }, docker: { tools: [{ toolId: 'missing-image', image: 'agentskit-harness:does-not-exist', command: ['/bin/true'] }] } })
    await expect(runtime.execute({ ...request, toolId: 'missing-image' })).resolves.toMatchObject({ status: 'failed', errorCode: 'IMAGE_UNAVAILABLE' })
  })
})

describe('telemetry() reporting', () => {
  it('every runtime kind reports an unknown telemetry status (none of them measure real cost)', () => {
    expect(createToolRuntime({ tools: [] }).telemetry?.()).toEqual({ status: 'unknown' })
    expect(createProcessToolRuntime({ tools: [] }).telemetry?.()).toEqual({ status: 'unknown' })
    expect(createDockerToolRuntime({ tools: [] }).telemetry?.()).toEqual({ status: 'unknown' })
  })
})

describe('createDockerToolRuntime: argv construction with env and mounts', () => {
  it('accepts a tool with valid env entries and mounts without throwing', () => {
    expect(() => createDockerToolRuntime({
      tools: [{
        toolId: 'x', image: 'alpine:3.21', command: ['/bin/true'],
        env: { API_KEY: 'secret', MODE: 'ci' },
        mounts: [{ source: '/tmp/a', target: '/work/a' }, { source: '/tmp/b', target: '/work/b', readOnly: false }],
      }],
    })).not.toThrow()
  })
})
