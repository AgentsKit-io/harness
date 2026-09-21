import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('ends a timeout even when the command left a grandchild holding the pipes', async () => {
    // A worker CLI is usually a wrapper: a `.cmd` shim on Windows, a launcher elsewhere. Killing only the direct
    // child leaves the grandchild alive with the inherited stdout, so `close` never fires and the call used to
    // hang forever instead of timing out. This spawns exactly that shape: a child that outlives its parent.
    const script = `
      const { spawn } = require('node:child_process')
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
      setTimeout(() => {}, 60000)
    `
    const runner = createProcessRunner({ timeoutMs: 150 })
    const started = Date.now()
    const result = await runner.run(node(script))
    expect(result.timedOut).toBe(true)
    // The grace period is the ceiling; hanging would blow the test's own timeout instead.
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 15_000)

  // Every provider/review CLI a loop config points at (claude, agentskit-review, codex, ...) is a
  // globally npm-installed Node CLI, which on Windows means its only spawnable-by-name artifact is
  // a `.cmd` shim -- CreateProcess cannot execute one without a shell, so a plain
  // spawn(cmd, args, { shell: false }) always failed here (ENOENT for a bare name, EINVAL for an
  // absolute .cmd path) regardless of the path given. This is what motivated switching to
  // cross-spawn; only meaningful on the platform where the bug reproduces.
  it.runIf(process.platform === 'win32')('runs a Windows .cmd file directly, with shell: false semantics preserved for the caller', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ak-harness-cmd-test-'))
    const cmdPath = join(dir, 'greet.cmd')
    // A metacharacter-bearing arg (&) proves cross-spawn's cmd.exe re-quoting keeps this argv
    // element intact end to end, the same way shell: false would for a real executable.
    writeFileSync(cmdPath, '@echo off\r\necho hello %1\r\nexit /b 7\r\n')
    const runner = createProcessRunner()
    const result = await runner.run([cmdPath, 'a & b'])
    expect(result.code).toBe(7)
    // %1 in the .cmd reflects the raw argv token cmd.exe received, quotes included -- the quotes
    // are the evidence: cross-spawn passed `a & b` through as one argument. Had it (or a naive
    // shell: true) left `&` unescaped, cmd.exe would have split this into two commands instead.
    expect(result.stdout).toContain('hello "a & b"')
    expect(result.timedOut).toBe(false)
  })
})
