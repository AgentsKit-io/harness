/**
 * Defaults by kind of project, so a new repository declares what differs instead of everything.
 *
 * A preset is the **lowest** layer — below the user's global file and far below the project's own config — so
 * anything a project states wins, and a preset can never quietly change a decision somebody made on purpose.
 * What lives here is only what genuinely varies by project type: how it is verified, what a layer means, what
 * the Definition of Done can prove, and how strict the default review is.
 */
export type PresetName = 'web-app' | 'library' | 'monorepo' | 'data-pipeline' | 'mobile'

export const PRESET_NAMES: readonly PresetName[] = ['web-app', 'library', 'monorepo', 'data-pipeline', 'mobile']

const dodItem = (id: string, description: string, extra: Record<string, unknown>): Record<string, unknown> => ({ id, description, ...extra })

const TEST_FOR_NEW_CODE = dodItem('test-for-new-code', 'new behaviour ships with a test', { kind: 'file-changed', glob: '**/*.{test,spec}.*' })
const NO_TODO = dodItem('no-todo', 'nothing left marked TODO or FIXME', { kind: 'pattern-absent', pattern: 'TODO|FIXME', paths: ['src/**'] })

export const LOOP_PRESETS: Readonly<Record<PresetName, Record<string, unknown>>> = {
  'web-app': {
    delivery: {
      verifyCommand: 'npm run lint && npm run test && npm run build',
      review: { smallChangeLines: 40, criticalPaths: ['src/api/', 'src/auth/'] },
      merge: { requireChecks: true },
    },
    dod: { items: [dodItem('verify', 'lint, tests and build pass', { kind: 'command', command: ['npm', 'run', 'verify'] }), TEST_FOR_NEW_CODE, NO_TODO] },
    linear: { anyLabels: ['layer:ui', 'layer:api', 'layer:data'] },
  },
  library: {
    delivery: {
      verifyCommand: 'npm run lint && npm run test && npm run build',
      // A library's contract is its public surface, so the review is strict by default and never skips CI.
      review: { minSeverity: 'nit', smallChangeLines: 0, criticalPaths: ['src/index.ts'] },
      merge: { requireChecks: true },
    },
    dod: {
      items: [
        dodItem('verify', 'lint, tests and build pass', { kind: 'command', command: ['npm', 'run', 'verify'] }),
        TEST_FOR_NEW_CODE,
        dodItem('changelog', 'the change is described in the changelog', { kind: 'file-changed', glob: 'CHANGELOG.md' }),
      ],
    },
  },
  monorepo: {
    delivery: {
      verifyCommand: 'pnpm lint && pnpm test',
      review: { smallChangeLines: 40, criticalPaths: ['packages/'] },
      merge: { requireChecks: true },
    },
    dod: { items: [dodItem('verify', 'lint and tests pass for the touched packages', { kind: 'command', command: ['pnpm', 'verify'] }), TEST_FOR_NEW_CODE, NO_TODO] },
    linear: { anyLabels: ['layer:L1', 'layer:L2', 'layer:L3'] },
  },
  'data-pipeline': {
    delivery: {
      verifyCommand: 'make lint && make test',
      // Data is hard to un-ship: a human approves the merge, and the smoke gate is the project's own.
      merge: { requireChecks: true, requireHumanApproval: true },
      review: { criticalPaths: ['migrations/', 'schemas/'] },
    },
    dod: {
      items: [
        dodItem('verify', 'lint and tests pass', { kind: 'command', command: ['make', 'verify'] }),
        dodItem('migration-reversible', 'every migration has a down step', { kind: 'pattern-absent', pattern: 'irreversible', paths: ['migrations/**'] }),
      ],
    },
  },
  mobile: {
    delivery: {
      verifyCommand: 'npm run lint && npm run test',
      review: { smallChangeLines: 40 },
      // A store release is slow to undo, so nothing merges on the loop's word alone.
      merge: { requireChecks: true, requireHumanApproval: true },
    },
    dod: { items: [dodItem('verify', 'lint and tests pass', { kind: 'command', command: ['npm', 'run', 'verify'] }), TEST_FOR_NEW_CODE] },
  },
}

export const isPresetName = (value: unknown): value is PresetName => typeof value === 'string' && (PRESET_NAMES as readonly string[]).includes(value)

/** The preset a config extends, or `null`. An unknown name is reported by the caller, never silently ignored. */
export const presetFor = (name: string): Record<string, unknown> | null => isPresetName(name) ? LOOP_PRESETS[name] : null

export const describePreset = (name: PresetName): string => {
  const preset = LOOP_PRESETS[name]
  const delivery = preset['delivery'] as { verifyCommand?: string } | undefined
  const dod = preset['dod'] as { items?: readonly { id: string }[] } | undefined
  return `${name}: verify \`${delivery?.verifyCommand ?? 'n/a'}\` · DoD ${(dod?.items ?? []).map((item) => item.id).join(', ') || 'none'}`
}
