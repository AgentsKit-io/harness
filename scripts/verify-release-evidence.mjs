#!/usr/bin/env node
import { readFileSync } from 'node:fs'

// Release evidence ships inside the tarball (`files` includes `release/`), so evidence describing an older
// version is not merely untidy — it is a false statement about the artifact a user installed. Nothing checked
// it: `release/qualification.json` said 0.4.0 and `release/notes.md` said "0.13.0 release candidate" while
// 0.16.0 was on the registry. package.json is the one source; everything else is compared against it.
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const failures = []

const qualification = JSON.parse(readFileSync('release/qualification.json', 'utf8'))
if (qualification.version !== version) failures.push(`release/qualification.json is for ${qualification.version}, package.json is ${version}`)

const notes = readFileSync('release/notes.md', 'utf8')
if (!notes.includes(version)) failures.push(`release/notes.md never mentions ${version}`)

const manifest = JSON.parse(readFileSync('release/manifest.json', 'utf8'))
if (manifest.version !== version) failures.push(`release/manifest.json is for ${manifest.version}, package.json is ${version}`)

console.log(JSON.stringify(failures.length ? { status: 'failed', criteria: ['release-evidence'], failures } : { status: 'passed', criteria: ['release-evidence'], version }))
process.exitCode = failures.length ? 1 : 0
