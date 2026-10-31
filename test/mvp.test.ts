import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { evaluateMvp, evidenceFromJson, loadMvp, mvpDigest, parseMvpYaml, validateMvp } from '../src/mvp.js'

const receipts = readFileSync(new URL('../docs/fixtures/mvp/exemplo-mvp.yaml', import.meta.url), 'utf8')
const base = (extra = ''): string => `version: 1\nrequirements:\n- id: RF-01\n  title: A\n  done_when: x\n${extra}`

describe('mvp manifest (golden: docs/fixtures/mvp)', () => {
  it('digest matches the factory script on the synthetic example manifest', () => {
    const doc = loadMvp(receipts)
    expect(mvpDigest(doc)).toBe('a5d6dbc14e5f9a24')
    expect((doc['approval'] as { digest: string }).digest).toBe('a5d6dbc14e5f9a24')
  })

  it('digest matches mvp_manifest.py on block scalars, floats, unicode (digest taken from the script)', () => {
    const text = 'version: 1\nrequirements:\n- id: RF-01\n  title: "Olá ação — x"\n  done_when: |\n    linha um\n    linha  dois\n  weight: 1.5\n- id: RF-02\n  title: B\n  done_when: >\n    a\n    b\n  weight: 2.0\n  prs: [1, 2]\n'
    expect(mvpDigest(loadMvp(text))).toBe('da5541a3a53daef5')
  })

  it('digest ignores evidence links and whitespace in done_when, tracks weight', () => {
    const a = mvpDigest(loadMvp(base()))
    expect(mvpDigest(loadMvp(base('  prs: [3]\n').replace('done_when: x', 'done_when: "  x  "')))).toBe(a)
    expect(mvpDigest(loadMvp(base('  weight: 2\n')))).not.toBe(a)
    expect(mvpDigest(loadMvp(base('  weight: 1.0\n')))).not.toBe(a)
  })

  it('rejects what the script rejects', () => {
    expect(validateMvp(parseMvpYaml('version: 2\nrequirements: []\n'))).toEqual(['version: deve ser 1', 'requirements: lista vazia ou ausente'])
    expect(validateMvp(parseMvpYaml(base().replace('RF-01', 'rf1')))).toEqual(['requirements[1]: id "rf1" fora do formato (ex.: RF-01)'])
    expect(validateMvp(parseMvpYaml(base('  acceptance:\n  - url: https://x\n')))).toEqual(['RF-01: acceptance[1]: url não vale como evidência de aceite'])
    expect(validateMvp(parseMvpYaml(base('launch:\n  date: 2026-13-40\n')))).toEqual(['launch.date: data no formato AAAA-MM-DD'])
    expect(() => parseMvpYaml('a: &x 1\n')).toThrow(/não é aceito/)
    expect(() => parseMvpYaml('a: 1\na: 2\n')).toThrow(/chave repetida/)
  })
})

describe('mvp report', () => {
  const doc = loadMvp(`version: 1
requirements:
- id: RF-01
  title: Pronto
  done_when: x
  prs: [1]
  acceptance:
  - ci: acc
  homolog:
  - ci: hom
- id: RF-02
  title: QA
  done_when: x
  prs: [2]
- id: RF-03
  title: Bloqueado
  done_when: x
  prs: [3]
- id: RF-04
  title: Sem começar
  done_when: x
`)
  const evidence = evidenceFromJson({ prs: { 1: true, 2: true, 3: false }, ci: { acc: true, hom: true } })

  it('counts levels and states per requirement; % is null until approved', () => {
    const r = evaluateMvp(doc, evidence)
    expect(r.levels).toEqual({ merged: { count: 2, pct: 50 }, accepted: { count: 1, pct: 25 }, proven: { count: 1, pct: 25 } })
    expect(r.states).toEqual({ pronto: 1, qa: 1, bloqueado: 1, 'sem-comecar': 1 })
    expect(r.requirements.map((q) => q.state)).toEqual(['pronto', 'qa', 'bloqueado', 'sem-comecar'])
    expect(r.pct).toBeNull()
  })

  it('missing evidence is not success; an approved list reports the proven %', () => {
    expect(evaluateMvp(doc, evidenceFromJson({})).states).toEqual({ pronto: 0, qa: 0, bloqueado: 0, 'sem-comecar': 4 })
    const approved = { ...doc, approval: { by: 'dono', digest: mvpDigest(doc) } }
    expect(evaluateMvp(approved, evidence).pct).toBe(25)
    expect(evaluateMvp(approved, evidence, ['outro']).approved).toBe(false)
  })
})
