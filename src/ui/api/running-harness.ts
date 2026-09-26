import { existsSync, realpathSync } from 'node:fs'
import type { LoadedLoopConfig } from '../../loop/config.js'
import { shellQuote } from '../../loop/install.js'

/**
 * Orca runs a scheduled stage by the command name in `schedule.harnessCommand`, resolved on Orca's own PATH — which
 * can be a different (older) harness than the one serving this page: a global npm install from last week will
 * reject a config the repository build accepts, and every scheduled deliver then crashes on load. When the config
 * leaves the default, pin the automations to the binary that is running right now.
 */
export const withRunningHarness = (loaded: LoadedLoopConfig): LoadedLoopConfig => {
  const script = process.argv[1]
  // ponytail: an explicit `harnessCommand: ak-harness` is indistinguishable from the default; both get pinned.
  if (loaded.config.schedule.harnessCommand !== 'ak-harness' || !script || !existsSync(script)) return loaded
  // `node` by name, not `process.execPath`: a quoted path first on the line is mangled by cmd.exe's /c quote rule.
  return { ...loaded, config: { ...loaded.config, schedule: { ...loaded.config.schedule, harnessCommand: `node ${shellQuote(realpathSync(script))}` } } }
}
