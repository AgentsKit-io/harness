import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const required = ['docs/GETTING-STARTED.md', 'docs/TROUBLESHOOTING.md', 'examples/minimum-profile.mjs', 'compatibility/migration.md', 'compatibility/rollback.md']
const failures = required.filter((file) => !existsSync(resolve(file))).map((file) => `missing ${file}`)
const readme = readFileSync('README.md', 'utf8')
for (const link of ['examples/minimum-profile.mjs', 'docs/GETTING-STARTED.md', 'docs/TROUBLESHOOTING.md']) if (!readme.includes(`](${link})`)) failures.push(`README.md missing link ${link}`)
console.log(JSON.stringify(failures.length ? { status: 'failed', criteria: ['adoption-docs'], failures } : { status: 'passed', criteria: ['adoption-docs'], files: required.length }))
process.exitCode = failures.length ? 1 : 0
