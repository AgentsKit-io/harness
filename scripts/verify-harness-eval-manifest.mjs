import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateEvalManifest } from '../dist/index.js'

const root = resolve(new URL('..', import.meta.url).pathname)
const path = resolve(root, 'evals/manifest.json')
const manifest = validateEvalManifest(JSON.parse(readFileSync(path, 'utf8')))
console.log(JSON.stringify({ status: 'passed', criteria: ['eval-manifest', 'eval-coverage'], suiteId: manifest.suiteId, cases: manifest.cases.length, repetitions: manifest.repetitions }))
