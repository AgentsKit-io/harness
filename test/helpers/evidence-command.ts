import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

/**
 * Builds a `verificationCheck.command` shell string that runs `node <script>` and prints one JSON-encoded value,
 * for tests that only care about a check's evidence, not what produced it.
 *
 * Not `<node> -e "<script>"`: that needs the script embedded in a single shell command-line argument, which
 * means quoting it — and there is no one quoting scheme that survives every shell `execution/verification.ts`'s
 * `spawn(command, { shell: true })` might hand it to (POSIX `sh` accepts single-quote literals; Windows' `cmd.exe`
 * does not, and re-interprets them as literal characters in the argument text instead of a string delimiter,
 * reliably breaking any script containing a naive POSIX-style quoted argument). Writing the script to a real
 * file sidesteps needing that: `"<node>" "<file>"` — double-quoted paths — is accepted by both `sh` and
 * `cmd.exe` for the common case (no embedded double quotes or shell metacharacters in a temp-dir path).
 */
const scratch = mkdtempSync(join(tmpdir(), 'agentskit-harness-evidence-'))
let counter = 0
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

const quotePath = (value: string): string => (value.includes(' ') || value.includes('\t')) ? `"${value}"` : value

export const evidenceCommand = (value: unknown, exitCode = 0): string => {
  counter += 1
  const scriptPath = join(scratch, `evidence-${counter}.mjs`)
  writeFileSync(scriptPath, `console.log(${JSON.stringify(JSON.stringify(value))});\nprocess.exit(${exitCode});\n`, 'utf8')
  return `${quotePath(process.execPath)} ${quotePath(scriptPath)}`
}
