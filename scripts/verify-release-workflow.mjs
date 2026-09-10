#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const workflow = readFileSync('.github/workflows/release-harness.yml', 'utf8')
const failures = []
for (const text of ['branches: [main]', 'id-token: write', 'npm publish --provenance', 'npm view']) if (!workflow.includes(text)) failures.push(`workflow missing ${text}`)
if (workflow.includes('NPM_TOKEN')) failures.push('workflow must not use NPM_TOKEN')
if (!workflow.includes("github.repository == 'AgentsKit-io/harness'")) failures.push('workflow repository guard is incorrect')
console.log(JSON.stringify(failures.length ? { status: 'failed', criteria: ['workflow'], failures } : { status: 'passed', criteria: ['workflow'] }))
process.exitCode = failures.length ? 1 : 0
