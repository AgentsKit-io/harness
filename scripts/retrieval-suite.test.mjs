import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const suite = JSON.parse(readFileSync('docs/bench/retrieval-suite-v1.json', 'utf8'))

test('retrieval suite has 20-40 uniquely named cases', () => {
  assert.ok(suite.cases.length >= 20 && suite.cases.length <= 40)
  assert.equal(new Set(suite.cases.map((c) => c.id)).size, suite.cases.length)
})

test('every expected target is a file in the repository', () => {
  for (const c of suite.cases) {
    assert.ok(c.metadata.expectedTargets.length > 0, c.id)
    for (const target of c.metadata.expectedTargets) assert.ok(existsSync(target), `${c.id}: ${target}`)
  }
})
