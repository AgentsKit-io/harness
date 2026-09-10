import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const manifest = JSON.parse(readFileSync(resolve('release/manifest.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const { digest, ...body } = manifest
const failures = []
if (manifest.type !== 'agentskit-harness-release-manifest' || manifest.schemaVersion !== 1) failures.push('invalid release manifest type/schema')
if (manifest.package !== packageJson.name || manifest.version !== packageJson.version || manifest.version !== '0.4.0') failures.push('release/package version mismatch')
if (!manifest.publication?.trustedPublishing || manifest.publication?.usesNpmToken) failures.push('publication must use Trusted Publishing without NPM_TOKEN')
if (manifest.publication?.branch !== 'main') failures.push('publication branch must be main')
if (!Array.isArray(manifest.blockedCriteria) || manifest.blockedCriteria.length === 0) failures.push('unverified release blockers must be explicit')
if (digest !== createHash('sha256').update(JSON.stringify(body)).digest('hex')) failures.push('release manifest digest is invalid')
console.log(JSON.stringify(failures.length ? { status: 'failed', criteria: ['release-manifest'], failures } : { status: 'passed', criteria: ['release-manifest'], version: manifest.version, blockedCriteria: manifest.blockedCriteria }))
process.exitCode = failures.length ? 1 : 0
