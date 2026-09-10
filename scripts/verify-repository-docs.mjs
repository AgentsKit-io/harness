#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'

const required = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'MANIFESTO.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'LICENSE', 'docs/ORGANIZATION.md']
const failures = required.filter((file) => !existsSync(file)).map((file) => `missing ${file}`)
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
if (packageJson.version !== '0.3.0') failures.push(`expected version 0.3.0, got ${packageJson.version}`)
if (packageJson.repository?.url !== 'git+https://github.com/AgentsKit-io/harness.git') failures.push('repository URL is not AgentsKit-io/harness')
for (const [file, headings] of Object.entries({
  'README.md': ['# @agentskit/harness', '## Install', '## Release'],
  'CONTRIBUTING.md': ['# Contributing', 'Conventional Commits'],
  'AGENTS.md': ['# AGENTS.md', 'Verification contract'],
  'MANIFESTO.md': ['# Harness Manifesto', 'The boundary'],
})) {
  if (!existsSync(file)) continue
  const text = readFileSync(file, 'utf8')
  for (const heading of headings) if (!text.includes(heading)) failures.push(`${file} missing ${heading}`)
}
console.log(JSON.stringify(failures.length ? { status: 'failed', criteria: ['governance'], failures } : { status: 'passed', criteria: ['governance'], files: required.length }))
process.exitCode = failures.length ? 1 : 0
