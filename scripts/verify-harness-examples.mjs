import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const result = spawnSync(process.execPath, [resolve(root, 'examples/minimum-profile.mjs')], { cwd: root, encoding: 'utf8' })
if (result.status !== 0) throw new Error(result.stderr || 'minimum profile example failed')
const output = JSON.parse(result.stdout.trim())
if (output.status !== 'passed' || output.profile !== 'passed' || output.review !== 'approved' || output.tracking !== 'qa' || output.contextReferences !== 1) throw new Error(`unexpected example output: ${result.stdout}`)
console.log(JSON.stringify({ status: 'passed', criteria: ['consumer-example', 'minimum-profile', 'adapter-example'] }))
