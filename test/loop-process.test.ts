import { describe, expect, it } from 'vitest'
import { createProcessRunner } from '../src/index.js'

const node = (script: string): readonly string[] => [process.execPath, '-e', script]

describe('createProcessRunner', () => {
  it('captures stdout, exit code, and duration for a successful command', async () => {
    const runner = createProcessRunner()
    const result = await runner.run(node('process.stdout.write("hello")'))
    expect(result).toMatchObject({ code: 0, stdout: 'hello', stderr: '', timedOut: false })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('captures stderr and a non-zero exit code', async () => {
    const runner = createProcessRunner()
    const result = await runner.run(node('process.stderr.write("boom"); process.exit(3)'))
    expect(result).toMatchObject({ code: 3, stdout: '', stderr: 'boom', timedOut: false })
  })

  it('resolves with a null code and no spawn when argv is empty', async () => {
    const runner = createProcessRunner()
    const result = await runner.run([])
    expect(result).toEqual({ code: null, stdout: '', stderr: 'empty argv', timedOut: false, durationMs: 0 })
  })

  it('surfaces spawn errors for a command that does not exist', async () => {
    const runner = createProcessRunner()
    const result = await runner.run(['agentskit-harness-definitely-not-a-real-binary-xyz'])
    expect(result.code).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.stderr).toMatch(/ENOENT|spawn/i)
  })

  it('kills a hung process and reports timedOut once the timeout elapses', async () => {
    const runner = createProcessRunner({ timeoutMs: 50 })
    const result = await runner.run(node('setTimeout(() => {}, 60000)'))
    expect(result.timedOut).toBe(true)
    expect(result.code).not.toBe(0)
  }, 10_000)

  it('lets a per-call timeoutMs override the constructor default', async () => {
    const runner = createProcessRunner({ timeoutMs: 60_000 })
    const result = await runner.run(node('setTimeout(() => {}, 60000)'), { timeoutMs: 50 })
    expect(result.timedOut).toBe(true)
  }, 10_000)

  it('stops accumulating output once a chunk boundary crosses maxOutputBytes', async () => {
    const runner = createProcessRunner({ maxOutputBytes: 8 })
    const script = 'let i = 0; const tick = () => { if (i++ >= 50) return; process.stdout.write("chunk" + i + "\\n"); setImmediate(tick) }; tick()'
    const result = await runner.run(node(script))
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(400)
  })

  it('passes cwd and env through to the spawned process', async () => {
    const runner = createProcessRunner()
    const result = await runner.run(node('process.stdout.write(process.env.AK_HARNESS_TEST_VAR || "missing")'), { env: { ...process.env, AK_HARNESS_TEST_VAR: 'present' }, cwd: process.cwd() })
    expect(result.stdout).toBe('present')
  })
})
