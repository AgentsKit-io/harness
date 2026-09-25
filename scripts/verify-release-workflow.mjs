#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const path = '.github/workflows/release-harness.yml'
const text = readFileSync(path, 'utf8')
const workflow = parse(text)
const failures = []

for (const needle of ['id-token: write', 'npm publish --provenance', 'npm view']) if (!text.includes(needle)) failures.push(`${path} missing ${needle}`)
if (text.includes('NPM_TOKEN')) failures.push('workflow must not use NPM_TOKEN')

const jobs = workflow?.jobs ?? {}
const publish = jobs['publish']
if (!publish) failures.push('no `publish` job')
else {
  // The invariant this file exists for: publishing cannot outrun the gate. A separate release workflow ran in
  // parallel with CI, so a commit could fail `ak-verify`, the docs check or the Windows matrix and ship anyway.
  const gates = Object.keys(jobs).filter((name) => name !== 'publish')
  const needs = Array.isArray(publish.needs) ? publish.needs : publish.needs ? [publish.needs] : []
  const ungated = gates.filter((name) => !needs.includes(name))
  if (ungated.length) failures.push(`publish does not depend on: ${ungated.join(', ')}`)
  if (!String(publish.if ?? '').includes("github.repository == 'AgentsKit-io/harness'")) failures.push('publish repository guard is incorrect')
  if (!String(publish.if ?? '').includes("github.ref == 'refs/heads/main'")) failures.push('publish must be restricted to main')
  if (publish.concurrency?.group !== 'release-harness') failures.push('publish must serialize on the release-harness concurrency group')
  if (publish.concurrency?.['cancel-in-progress'] !== false) failures.push('a publish in flight must never be cancelled')
}

console.log(JSON.stringify(failures.length ? { status: 'failed', criteria: ['governance'], failures } : { status: 'passed', criteria: ['governance'] }))
process.exitCode = failures.length ? 1 : 0
