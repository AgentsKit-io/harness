import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { validateCompatibilityManifest } from '../dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = validateCompatibilityManifest(JSON.parse(readFileSync(resolve(root, 'compatibility/manifest.json'), 'utf8')))
console.log(JSON.stringify({ status: 'passed', criteria: ['compatibility-contract', 'compatibility-manifest', 'pinned-revisions', 'real-adapter-boundary'], components: manifest.components.length }))
