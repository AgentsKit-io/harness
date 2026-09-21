import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The counts the site is allowed to claim, read at build time from the file `scripts/build-docs-artifacts.mjs`
 * generated out of the repository — the same bytes served at `/api/stats.json`.
 *
 * Read from disk in a server component rather than fetched: the site is a static export, so there is no
 * request to fetch during, and a number rendered from a runtime fetch would be a number that can disagree with
 * the build it shipped in.
 */
export interface HarnessStatCounts {
  readonly cliCommands: number
  readonly loopEvents: number
  readonly configPaths: number
  readonly decisionRecords: number
  readonly testFiles: number
  readonly docPages: number
}

export interface HarnessStats {
  readonly schemaVersion: number
  readonly property: string
  readonly version: string
  readonly license: string
  readonly counts: HarnessStatCounts
}

export function readHarnessStats(): HarnessStats {
  const raw: unknown = JSON.parse(readFileSync(join(process.cwd(), 'public/api/stats.json'), 'utf8'))
  if (typeof raw !== 'object' || raw === null || !('counts' in raw)) {
    throw new Error('public/api/stats.json is missing — run `pnpm docs:artifacts` before building the site.')
  }
  return raw as HarnessStats
}
