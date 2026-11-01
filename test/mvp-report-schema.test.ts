import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { evaluateMvp, evidenceFromJson, loadMvp, mvpDigest } from '../src/mvp.js'

const schema = z.fromJSONSchema(JSON.parse(readFileSync(new URL('../docs/schemas/mvp-report.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>)
const text = readFileSync(new URL('../docs/fixtures/mvp/exemplo-mvp.yaml', import.meta.url), 'utf8')

describe('mvp report --json schema (docs/schemas/mvp-report.schema.json)', () => {
  const doc = loadMvp(text)
  const approved = { ...doc, approval: { by: 'dono', digest: mvpDigest(doc) }, launch: [{ date: '2026-12-01', label: 'piloto' }] }

  it('accepts real reports: no evidence, approved, with evidence', () => {
    const some = evidenceFromJson({ prs: { 1: true }, ci: { ci: false } })
    for (const report of [evaluateMvp(doc, evidenceFromJson({})), evaluateMvp(approved, some), evaluateMvp(approved, evidenceFromJson({}))]) {
      expect(schema.safeParse(JSON.parse(JSON.stringify(report))).success).toBe(true)
      expect(report.schemaVersion).toBe(1)
    }
  })

  it('rejects drift: wrong version, extra or missing field', () => {
    const report = JSON.parse(JSON.stringify(evaluateMvp(doc, evidenceFromJson({})))) as Record<string, unknown>
    expect(schema.safeParse({ ...report, schemaVersion: 2 }).success).toBe(false)
    expect(schema.safeParse({ ...report, extra: 1 }).success).toBe(false)
    const { pct: _pct, ...missing } = report
    expect(schema.safeParse(missing).success).toBe(false)
  })
})
