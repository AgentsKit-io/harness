import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assessBoundary, composeLoopConfig, layerById, layerFor, renderLayersForPrompt, verifyCommandFor } from '../src/index.js'
import type { LoopConfig } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')

const LAYERS = `layers:
  - id: L1
    label: layer:L1
    description: contracts and schemas
    paths: ["packages/os-core/**"]
    verify: "pnpm --filter os-core test"
  - id: L2
    label: layer:L2
    paths: ["packages/os-runtime/**", "packages/os-storage/**"]
    enforce: true
  - id: L3
    label: layer:L3
`

const config = (overlay = LAYERS): LoopConfig => composeLoopConfig({ text: exampleYaml, ...(overlay ? { localText: overlay } : {}) })

describe('placing an issue in a layer', () => {
  it('finds the layer from the labels frozen at dispatch, and nothing without a label', () => {
    expect(layerFor(config(), ['layer:L2', 'area:api'])?.id).toBe('L2')
    expect(layerFor(config(), ['area:api'])).toBeNull()
    expect(layerFor(config(), [])).toBeNull()
    expect(layerFor(config(''), ['layer:L1'])).toBeNull()
    expect(layerById(config(), 'L1')?.label).toBe('layer:L1')
    expect(layerById(config(), 'nope')).toBeNull()
  })

  it('uses the first matching layer when an issue carries two', () => {
    expect(layerFor(config(), ['layer:L2', 'layer:L1'])?.id).toBe('L1')
  })
})

describe('the command that closes a layer', () => {
  it('prefers the layer\'s own test over the whole project suite', () => {
    expect(verifyCommandFor(config(), ['layer:L1'])).toEqual({ command: 'pnpm --filter os-core test', source: 'layer', layer: 'L1' })
  })

  it('falls back to the project command for a layer that declares none, and for no layer at all', () => {
    const project = config().delivery.verifyCommand
    expect(verifyCommandFor(config(), ['layer:L3'])).toEqual({ command: project, source: 'project', layer: 'L3' })
    expect(verifyCommandFor(config(), [])).toEqual({ command: project, source: 'project', layer: null })
  })
})

describe('the layer boundary', () => {
  it('reports files the layer does not own, without holding by default', () => {
    const verdict = assessBoundary(config(), ['layer:L1'], ['packages/os-core/src/a.ts', 'apps/web/src/b.tsx'])
    expect(verdict.layer).toBe('L1')
    expect(verdict.outside).toEqual(['apps/web/src/b.tsx'])
    expect(verdict.enforced).toBe(false)
    expect(verdict.detail).toContain('1 file(s) outside layer L1')
  })

  it('holds only where the project said the boundary is real', () => {
    const verdict = assessBoundary(config(), ['layer:L2'], ['packages/os-runtime/a.ts', 'src/elsewhere.ts'])
    expect(verdict.enforced).toBe(true)
  })

  it('says nothing when the layer owns everything it touched', () => {
    expect(assessBoundary(config(), ['layer:L2'], ['packages/os-storage/a.ts', 'packages/os-runtime/b.ts']).detail).toBeNull()
  })

  it('cannot be crossed when nobody drew it: no layer, no paths, or no files', () => {
    // A layer without `paths` owns everything by construction.
    expect(assessBoundary(config(), ['layer:L3'], ['anything.ts']).detail).toBeNull()
    expect(assessBoundary(config(), ['area:api'], ['anything.ts']).layer).toBeNull()
    expect(assessBoundary(config(), ['layer:L1'], []).detail).toBeNull()
  })
})

describe('what the prompts show', () => {
  it('lists each slice with what it owns and what closes it', () => {
    const rendered = renderLayersForPrompt(config())
    expect(rendered).toContain('`layer:L1` (L1) — contracts and schemas')
    expect(rendered).toContain('owns packages/os-core/**')
    expect(rendered).toContain('closes with `pnpm --filter os-core test`')
    expect(rendered).toContain('`layer:L3` (L3)')
  })

  it('renders nothing for a project that never drew layers', () => {
    expect(renderLayersForPrompt(config(''))).toBe('')
  })
})
