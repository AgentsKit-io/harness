import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeJsonAtomic } from '../../loop/fs-atomic.js'

export const UI_WIZARD_SCHEMA_VERSION = 1 as const
export type UiWizardStep = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface UiWizardDraft {
  readonly schemaVersion: typeof UI_WIZARD_SCHEMA_VERSION
  readonly issue: string
  readonly step: UiWizardStep
  readonly configHash: string | null
  readonly flow: string | null
  readonly builder: string | null
  readonly contractDigest: string | null
  readonly contractError: string | null
  readonly maxFixRounds: number | null
  readonly perIssueTokens: number | null
  readonly preflight: 'not-run' | 'passed' | 'blocked'
  readonly updatedAt: string
}

export type UiWizardDraftPatch = Partial<Omit<UiWizardDraft, 'schemaVersion' | 'issue' | 'updatedAt'>>

export interface UiWizardStore {
  readonly read: (issue: string) => UiWizardDraft | null
  readonly save: (issue: string, patch: UiWizardDraftPatch) => UiWizardDraft
}

const draftSchema = z.object({
  schemaVersion: z.literal(UI_WIZARD_SCHEMA_VERSION), issue: z.string().min(1), step: z.number().int().min(0).max(6),
  configHash: z.string().nullable(), flow: z.string().nullable(), builder: z.string().nullable(), contractDigest: z.string().nullable(), contractError: z.string().nullable().default(null),
  maxFixRounds: z.number().int().min(0).nullable(), perIssueTokens: z.number().int().min(0).nullable(),
  preflight: z.enum(['not-run', 'passed', 'blocked']), updatedAt: z.string(),
})
const draftPatchSchema = z.object({
  step: z.number().int().min(0).max(6).optional(), configHash: z.string().nullable().optional(), flow: z.string().nullable().optional(), builder: z.string().nullable().optional(), contractDigest: z.string().nullable().optional(), contractError: z.string().nullable().optional(),
  maxFixRounds: z.number().int().min(0).nullable().optional(), perIssueTokens: z.number().int().min(0).nullable().optional(), preflight: z.enum(['not-run', 'passed', 'blocked']).optional(),
}).strict()

export const parseUiWizardDraftPatch = (value: unknown): UiWizardDraftPatch => draftPatchSchema.parse(value) as UiWizardDraftPatch

const fileName = (issue: string): string => `${encodeURIComponent(issue)}.json`

export const createUiWizardStore = (stateDir: string, now: () => Date = () => new Date()): UiWizardStore => {
  const root = join(stateDir, 'ui', 'wizards')
  mkdirSync(root, { recursive: true })
  const pathFor = (issue: string): string => join(root, fileName(issue))
  const read = (issue: string): UiWizardDraft | null => {
    const path = pathFor(issue)
    if (!existsSync(path)) return null
    try {
      const parsed = draftSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      return parsed.success ? parsed.data as UiWizardDraft : null
    } catch {
      return null
    }
  }
  const save = (issue: string, patch: UiWizardDraftPatch): UiWizardDraft => {
    const previous = read(issue)
    const draft: UiWizardDraft = {
      schemaVersion: UI_WIZARD_SCHEMA_VERSION,
      issue,
      step: patch.step ?? previous?.step ?? 0,
      configHash: patch.configHash !== undefined ? patch.configHash : previous?.configHash ?? null,
      flow: patch.flow !== undefined ? patch.flow : previous?.flow ?? null,
      builder: patch.builder !== undefined ? patch.builder : previous?.builder ?? null,
      contractDigest: patch.contractDigest !== undefined ? patch.contractDigest : previous?.contractDigest ?? null,
      contractError: patch.contractError !== undefined ? patch.contractError : previous?.contractError ?? null,
      maxFixRounds: patch.maxFixRounds !== undefined ? patch.maxFixRounds : previous?.maxFixRounds ?? null,
      perIssueTokens: patch.perIssueTokens !== undefined ? patch.perIssueTokens : previous?.perIssueTokens ?? null,
      preflight: patch.preflight ?? previous?.preflight ?? 'not-run',
      updatedAt: now().toISOString(),
    }
    writeJsonAtomic(pathFor(issue), draft)
    return draft
  }
  return { read, save }
}

export const uiWizardPath = (stateDir: string, issue: string): string => join(stateDir, 'ui', 'wizards', fileName(issue))
