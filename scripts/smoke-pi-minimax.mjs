import { spawnSync } from 'node:child_process'

const evidence = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

if (!process.env.MINIMAX_API_KEY?.trim()) {
  evidence({ status: 'skipped', criterion: 'pi-minimax-smoke', reason: 'MINIMAX_API_KEY is not set' })
  process.exit(0)
}

const argv = ['--provider', 'minimax', '--model', 'M3', '--print', '--no-session', '--tools', 'read,grep,find,ls', 'Reply with exactly: PI_MINIMAX_M3_OK']
const result = spawnSync('pi', argv, { encoding: 'utf8', timeout: 120_000, env: process.env })
const stdout = (result.stdout ?? '').trim()
const output = `${stdout}${result.stderr ?? ''}`.trim()

if (result.error || result.status !== 0 || !stdout) {
  evidence({
    status: 'failed', criterion: 'pi-minimax-smoke', provider: 'minimax', model: 'M3', argv: ['pi', ...argv],
    exitCode: result.status, signal: result.signal, error: result.error?.message ?? null, outputTail: output.slice(-1000),
  })
  process.exit(1)
}

evidence({ status: 'passed', criterion: 'pi-minimax-smoke', provider: 'minimax', model: 'M3', argv: ['pi', ...argv], outputChars: stdout.length, outputTail: stdout.slice(-1000) })
