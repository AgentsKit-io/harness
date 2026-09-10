import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createArtifactEnvelope } from '../dist/index.js'

const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-artifact-cli-'))
const artifact = createArtifactEnvelope({
  artifactType: 'plan', artifactVersion: 1, artifactId: 'cli-fixture', runId: 'cli-run', issueRef: 'fixture#12',
  sourceRevision: 'revision-1', contractHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  configHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  contextHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', phase: 'discover', payload: { status: 'ready' },
})
const path = join(root, 'artifact.json')
writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`)
const cli = join(process.cwd(), 'dist', 'cli.js')
const structured = spawnSync(process.execPath, [cli, '--json', 'artifacts', 'inspect', path], { encoding: 'utf8' })
if (structured.status !== 0 || JSON.parse(structured.stdout).artifactId !== 'cli-fixture') throw new Error(`structured artifact inspection failed: ${structured.stderr}`)
const readable = spawnSync(process.execPath, [cli, 'artifacts', 'inspect', path], { encoding: 'utf8' })
if (readable.status !== 0 || !readable.stdout.includes('# plan artifact cli-fixture')) throw new Error(`readable artifact inspection failed: ${readable.stderr}`)
console.log(JSON.stringify({ status: 'passed', criteria: ['artifacts', 'artifact-cli'] }))
