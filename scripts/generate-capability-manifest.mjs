#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const entryPoint = 'src/index.ts'
const source = readFileSync(entryPoint, 'utf8')
const sourceDigest = createHash('sha256').update(source).digest('hex')
const groups = new Map()

const kindFor = (modulePath) => modulePath.includes('/adapters/') ? 'adapter' : modulePath.startsWith('./execution/') || modulePath === './cli.js' ? 'execution' : modulePath === './index.js' ? 'composition' : 'kernel'
const add = (modulePath, names) => {
  const current = groups.get(modulePath) ?? { modulePath, names: new Set() }
  names.forEach((name) => current.names.add(name))
  groups.set(modulePath, current)
}

for (const match of source.matchAll(/^export (?:type )?\{([^}]+)\} from '([^']+)'/gm)) {
  const names = match[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean)
  add(match[2], names)
}
for (const match of source.matchAll(/^export type \* from '([^']+)'/gm)) add(match[1], ['*'])

const capabilities = [...groups.values()].sort((left, right) => left.modulePath.localeCompare(right.modulePath)).map((group) => ({
  id: `public-surface:${group.modulePath.replace(/^\.\//, '').replace(/\.js$/, '')}`,
  version: packageJson.version,
  kind: kindFor(group.modulePath),
  entryPoint,
  exports: [...group.names].sort(),
}))
const body = {
  type: 'agentskit-harness-capability-manifest',
  schemaVersion: 1,
  package: packageJson.name,
  packageVersion: packageJson.version,
  entryPoint,
  sourceDigest,
  capabilities,
}
const manifest = { ...body, digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') }

if (process.argv.includes('--write')) {
  const path = process.argv[process.argv.indexOf('--write') + 1] ?? 'capabilities/public-surface.json'
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ status: 'passed', criteria: ['capability-manifest-generated'], path, capabilities: capabilities.length, sourceDigest }))
} else if (process.argv.includes('--check')) {
  const path = process.argv[process.argv.indexOf('--check') + 1]
  if (!path) throw new Error('--check requires a manifest path')
  const expected = JSON.parse(readFileSync(path, 'utf8'))
  if (JSON.stringify(expected) !== JSON.stringify(manifest)) throw new Error(`Capability manifest is stale: ${path}`)
  console.log(JSON.stringify({ status: 'passed', criteria: ['capability-manifest'], capabilities: capabilities.length, sourceDigest }))
} else {
  console.log(JSON.stringify(manifest, null, 2))
}
