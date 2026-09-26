import spawn from 'cross-spawn'
import { mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

export interface DetachedWorkerResult {
  readonly pid: number | null
  readonly logPath: string
}

/**
 * Fire-and-forget: launch `<harnessCommand> <args>` detached from this process, for a caller that will keep
 * running a little longer itself before exiting — see the IMPORTANT note below; this function's own return does
 * not mean the child is safely independent yet.
 *
 * Exists so `stage tick`'s precheck can stay inside Orca's 600s ceiling: the precheck itself only decides
 * whether to spawn this (see `peekStageLock`) and reports back in well under a second of its own work, while the
 * real, potentially many-minutes-long contract-generation-and-dispatch work runs here, in a child Orca never
 * waits on and this process does not hold pipes open to.
 *
 * Uses `cross-spawn` for the same reason `loop/process.ts` does — see its doc comment: a bare `.cmd` shim
 * (any globally-installed Node CLI on Windows, `ak-harness` included) cannot be spawned with `shell: false`
 * without it. `windowsHide` avoids a console window flashing open every few minutes.
 *
 * stdout/stderr are appended to a log file rather than left to inherit or pipe: an inherited pipe would keep this
 * process's own stdout artificially open past its own exit (Orca would see the precheck "still running"), and an
 * un-drained `stdio: 'pipe'` with nothing reading it fills its OS buffer and stalls the child once full. The fd
 * is deliberately never closed here — the process calling this exits on its own shortly after anyway, and the OS
 * reclaims it then regardless.
 *
 * IMPORTANT (reproduced live, Windows): `detached: true` + `.unref()` is the documented Node idiom for a child
 * that outlives its parent, but on Windows it is not sufficient on its own — a parent that exits immediately
 * after this call can silently kill a child that is still mid-startup (its own process/module-load/config-read
 * has not finished yet), with zero output and no error anywhere. This reproduced with both `cross-spawn` and
 * `node:child_process` directly, and a fixed few-hundred-ms post-spawn delay before the parent exits was not
 * reliably enough under real load either — 2-4s was. The caller (`stage tick` in cli.ts) does not use a fixed
 * delay: it polls for the child's own stage-lock acquisition (a real "it's alive and past startup" checkpoint)
 * before exiting, capped at a ceiling well inside Orca's precheck budget. A caller on a POSIX host has not
 * reproduced this and may not need to wait at all, but the safe thing is to always wait for that checkpoint
 * rather than assume the platform matters.
 */
export const spawnDetachedWorker = (input: { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly logPath: string; readonly env?: NodeJS.ProcessEnv }): DetachedWorkerResult => {
  mkdirSync(join(input.logPath, '..'), { recursive: true })
  const fd = openSync(input.logPath, 'a')
  const child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env ?? process.env, shell: false, stdio: ['ignore', fd, fd], detached: true, windowsHide: true })
  child.unref()
  return { pid: child.pid ?? null, logPath: input.logPath }
}
