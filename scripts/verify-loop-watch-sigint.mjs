// Regression check for a real bug found in the harness health audit: `ak-harness loop watch` (the one CLI command
// meant to run long, polling until --timeout or a terminal state) printed "Cancelled." on Ctrl-C but kept polling
// forever, because its SIGINT handler only set `process.exitCode` without ever calling `process.exit()` — with a
// live `setTimeout` still pending, the event loop never empties on its own.
//
// Node's SIGINT/child.kill('SIGINT') semantics are POSIX-only; Windows has no equivalent signal delivery to an
// arbitrary child process, so this check is skipped there (matches the Docker-gated skip pattern already used in
// test/runtime.test.ts). Not wired into `pnpm test`/CI for the same reason `test:artifacts`/`test:context-cli`
// aren't — those also spawn `dist/cli.js` directly and are local-only conveniences.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

if (process.platform === 'win32') {
  console.log(JSON.stringify({ status: 'passed', criteria: ['loop-watch-sigint'], skipped: 'POSIX signals only' }))
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-watch-sigint-'))
try {
  const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: test-person')
  writeFileSync(join(root, 'loop.config.yaml'), exampleYaml)
  mkdirSync(join(root, '.codex', 'loop', 'issues', 'ENG-1'), { recursive: true })
  writeFileSync(join(root, '.codex', 'loop', 'issues', 'ENG-1', 'dispatch.json'), JSON.stringify({ issue: 'ENG-1', worktreeId: 'w', worktree: 'w', branch: 'b', terminal: null, provider: 'claude', model: 'opus', contractDigest: 'd', leaseKey: 'k', leaseId: 'l', dispatchedAt: '2026-01-01T00:00:00.000Z', url: 'https://example.com', briefDigest: 'd', skills: [], setup: null, effort: 'medium', initialRemainingPercent: null, worktreePath: root }))

  const cli = join(process.cwd(), 'dist', 'cli.js')
  const child = spawn(process.execPath, [cli, 'loop', 'watch', '--issue', 'ENG-1', '--interval', '1', '--no-live-pr', '-f', join(root, 'loop.config.yaml')], { stdio: 'ignore' })

  await new Promise((resolve) => setTimeout(resolve, 1500)) // let it start polling (a caught adapter failure per iteration keeps it alive)
  if (child.exitCode !== null) throw new Error(`loop watch exited on its own (code ${child.exitCode}) before SIGINT could even be tested`)

  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGINT')
  const result = await Promise.race([exited.then(() => 'exited'), new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000))])
  if (result === 'timeout') { child.kill('SIGKILL'); throw new Error('loop watch did not exit within 3s of SIGINT — the Ctrl-C bug is back') }

  console.log(JSON.stringify({ status: 'passed', criteria: ['loop-watch-sigint'] }))
} finally {
  rmSync(root, { recursive: true, force: true })
}
