import { splitLines, toPosix } from '@agentskit/cross-platform'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { isRecord } from '../record.js'
import { LOOP_PRESETS, type PresetName } from './presets.js'

/**
 * What a repository says about itself when it carries no `loop.config.yaml` (or one that only overrides a few keys):
 * where it lives, its integration branch, what kind of project it is, how it is verified and where its tests are.
 *
 * Detection only ever fills silence — the loader drops every detected key some file already sets. It never guesses a
 * verify command: a repository with none of the known shapes is refused, by name, instead of run on an invention.
 *
 * Git metadata is read from the files under `.git`, not by spawning git: the config is loaded synchronously by every
 * command, and a file read is portable where a sync subprocess is not.
 */

const readText = (path: string): string | null => { try { return readFileSync(path, 'utf8') } catch { return null } }

/** The repository's common git dir (where config, refs and info/ live), following a worktree's `.git` file; `null` outside a repository. */
export const findGitDir = (root: string): string | null => {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git')
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return dotGit
      const pointer = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? '')?.[1]?.trim()
      if (!pointer) return null
      const gitDir = resolve(dir, pointer)
      const common = readText(join(gitDir, 'commondir'))?.trim()
      return common ? resolve(gitDir, common) : gitDir
    }
    if (dirname(dir) === dir) return null
  }
}

/** `remote.origin.url` from the git config. ponytail: `url.<x>.insteadOf` rewrites are not applied; a rewritten origin reads as written. */
const originUrl = (gitDir: string): string | null => {
  let inOrigin = false
  for (const line of splitLines(readText(join(gitDir, 'config')) ?? '')) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line)?.[1]
    if (section !== undefined) { inOrigin = /^remote\s+"origin"$/.test(section.trim()); continue }
    const url = inOrigin ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1] : undefined
    if (url) return url
  }
  return null
}

/** The branch `refs/remotes/origin/HEAD` points at (set by `git clone` / `git remote set-head`). */
const originHead = (gitDir: string): string | null => /^ref:\s*refs\/remotes\/origin\/(.+?)\s*$/m.exec(readText(join(gitDir, 'refs', 'remotes', 'origin', 'HEAD')) ?? '')?.[1] ?? null

/**
 * Built-in models, used only when no layer declares `models` at all: the two CLIs a first run most likely has.
 * Also what `loop init --global` writes, so the starter file and the built-in never disagree.
 */
export const STARTER_MODELS_YAML: readonly string[] = [
  'models:',
  '  orchestrator: [[claude/opus, codex/gpt-5.6-sol]]',
  '  reviewer:     [[claude/opus, codex/gpt-5.6-sol]]',
  '  builder:      [[claude/sonnet, codex/gpt-5.6-luna]]',
  '  watcher:      [[claude/haiku]]',
  '  providers:',
  '    claude:',
  '      bin: claude',
  '      auth: subscription',
  '      tui: "claude --model {model} --permission-mode auto"',
  '      headless: [claude, -p, "{prompt}", --model, "{model}", --permission-mode, plan, --output-format, text]',
  '    codex:',
  '      bin: codex',
  '      auth: subscription',
  '      tui: "codex -m {model} -s workspace-write -a never"',
  '      headless: [codex, exec, -m, "{model}", -s, read-only, --skip-git-repo-check, "{prompt}"]',
  '',
]

export const BUILTIN_DEFAULTS: Readonly<Record<string, unknown>> = parseYaml(STARTER_MODELS_YAML.join('\n')) as Record<string, unknown>

export interface RemoteRepo { readonly host: 'github' | 'gitlab'; readonly owner: string; readonly name: string }

/** `owner/name` of a GitHub or GitLab remote URL (https, ssh or scp form); `null` for anything else. */
export const parseRemote = (url: string): RemoteRepo | null => {
  const match = /(github\.com|gitlab\.[\w.-]+)[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  if (!match) return null
  return { host: match[1]?.startsWith('github') ? 'github' : 'gitlab', owner: match[2] ?? '', name: match[3] ?? '' }
}

const readJson = (path: string): Record<string, unknown> | null => {
  try { const value: unknown = JSON.parse(readFileSync(path, 'utf8')); return isRecord(value) ? value : null } catch { return null }
}

const WEB_FRAMEWORKS = ['next', 'vite', 'remix', '@remix-run/react', 'nuxt', 'astro', '@sveltejs/kit', '@angular/core', 'react-scripts', 'gatsby']

/** monorepo → mobile → web-app → library, first match; `null` for a repository that is not a JS package. */
export const detectPreset = (root: string): PresetName | null => {
  const pkg = readJson(join(root, 'package.json'))
  if (!pkg) return null
  const has = (file: string): boolean => existsSync(join(root, file))
  if (pkg['workspaces'] !== undefined || ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json'].some(has)) return 'monorepo'
  const deps = { ...(isRecord(pkg['dependencies']) ? pkg['dependencies'] : {}), ...(isRecord(pkg['devDependencies']) ? pkg['devDependencies'] : {}) }
  if ('expo' in deps || 'react-native' in deps) return 'mobile'
  if (WEB_FRAMEWORKS.some((name) => name in deps)) return 'web-app'
  return 'library'
}

/** The package manager the lockfile names; npm when there is none. */
export const packageManager = (root: string): 'pnpm' | 'yarn' | 'bun' | 'npm' => {
  const has = (file: string): boolean => existsSync(join(root, file))
  return has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bun' : 'npm'
}

/**
 * The repository's own verification, read from what it defines: a single aggregate script (`check`, `ci`, `verify`)
 * when there is one, else lint, typecheck, test and build joined; Makefile, pyproject, composer, Cargo and Go likewise.
 * `null` when it defines nothing the loop could run — the caller refuses rather than guesses.
 */
export const detectVerifyCommand = (root: string): string | null => {
  const has = (file: string): boolean => existsSync(join(root, file))
  const pkg = readJson(join(root, 'package.json'))
  if (pkg) {
    const scripts = isRecord(pkg['scripts']) ? pkg['scripts'] : {}
    const run = (script: string): string => `${packageManager(root)} run ${script}`
    const defined = (names: readonly string[]): string | undefined => names.find((name) => typeof scripts[name] === 'string')
    const aggregate = defined(['check', 'ci', 'verify'])
    if (aggregate) return run(aggregate)
    const steps = [defined(['lint']), defined(['typecheck', 'check-types']), defined(['test', 'test:unit']), defined(['build'])].filter((name): name is string => name !== undefined)
    if (steps.length) return steps.map(run).join(' && ')
  }
  if (has('Makefile')) {
    const makefile = readFileSync(join(root, 'Makefile'), 'utf8')
    const target = ['check', 'test'].find((name) => new RegExp(`^${name}\\s*:`, 'm').test(makefile))
    if (target) return `make ${target}`
  }
  if (has('composer.json')) {
    const scripts = readJson(join(root, 'composer.json'))?.['scripts']
    const script = isRecord(scripts) ? ['check', 'ci', 'verify', 'test'].find((name) => name in scripts) : undefined
    if (script) return `composer run-script ${script}`
  }
  if (has('pyproject.toml') || has('pytest.ini')) return 'python -m pytest'
  if (has('Cargo.toml')) return 'cargo test'
  if (has('go.mod')) return 'go test ./...'
  return null
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'vendor', '.venv', 'target'])

/** windowed: a bounded walk — at most `limit` paths, 8 levels deep, build output and dependencies skipped. */
const listFiles = (root: string, limit = 20_000): readonly string[] => {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || out.length >= limit) return
    let entries: Dirent[]
    try { entries = readdirSync(join(root, dir), { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(path, depth + 1) } else out.push(path)
    }
  }
  walk('', 0)
  return out
}

const TEST_SHAPES: readonly ((name: string) => string | null)[] = [
  (name) => { const match = /\.(test|spec)\.([cm]?[jt]sx?)$/.exec(name); return match ? `*.${match[1]}.${match[2]}` : null },
  (name) => /^test_.+\.py$/.test(name) ? 'test_*.py' : /_test\.py$/.test(name) ? '*_test.py' : null,
  (name) => /_test\.go$/.test(name) ? '*_test.go' : null,
  (name) => /Test\.php$/.test(name) ? '*Test.php' : null,
]

/** A glob that matches the repository's real test files and nothing invented; `null` when it has none. */
export const detectTestGlob = (files: readonly string[]): string | null => {
  const shapes = [...new Set(files.map((file) => basename(file)).flatMap((name) => TEST_SHAPES.map((shape) => shape(name)).filter((shape): shape is string => shape !== null)))].sort()
  if (!shapes.length) return null
  return shapes.length === 1 ? `**/${shapes[0]}` : `**/{${shapes.join(',')}}`
}

export interface DetectedProject {
  /** Config-shaped values read from the repository; the loader keeps only the ones no file sets. */
  readonly layer: Record<string, unknown>
  readonly preset: PresetName | null
  readonly remote: RemoteRepo | null
}

/**
 * Read the repository at `root`. `full` (the repository has no config file) adds the preset and its Definition of
 * Done; with a file present only the identity and the verify command are offered, so an existing config never gains
 * a DoD item it did not ask for.
 */
export const detectProject = (root: string, options: { readonly full: boolean }): DetectedProject => {
  const gitDir = findGitDir(root)
  const url = gitDir ? originUrl(gitDir) : null
  const remote = url ? parseRemote(url) : null
  const baseBranch = gitDir ? originHead(gitDir) : null
  const verifyCommand = detectVerifyCommand(root)
  const project: Record<string, unknown> = { name: remote?.name ?? basename(resolve(root)) }
  if (remote) project['repo'] = `${remote.owner}/${remote.name}`
  if (baseBranch) project['baseBranch'] = baseBranch
  const layer: Record<string, unknown> = { project }
  if (verifyCommand) layer['delivery'] = { verifyCommand }
  if (remote) layer['connectors'] = { ...(remote.host === 'github' ? { tracker: 'github', scm: 'github' } : {}), fleet: { project: `${remote.host}:${remote.owner}/${remote.name}`.toLowerCase() } }
  if (!options.full) return { layer, preset: null, remote }
  const preset = detectPreset(root)
  // The preset's own DoD names a `verify` command and a test glob it cannot know; keep its other items, prove the
  // verification through `delivery.verifyCommand`, and ask for tests only where the repository already has some.
  const presetItems = preset ? ((LOOP_PRESETS[preset]['dod'] as { items?: readonly Record<string, unknown>[] } | undefined)?.items ?? []) : []
  const testGlob = detectTestGlob(listFiles(root))
  const items = presetItems
    .filter((item) => item['kind'] !== 'command' && item['id'] !== 'test-for-new-code')
    .filter((item) => item['id'] !== 'changelog' || existsSync(join(root, 'CHANGELOG.md')))
  if (testGlob) items.unshift({ id: 'test-for-new-code', description: 'new behaviour ships with a test', kind: 'file-changed', glob: testGlob })
  layer['dod'] = { items }
  return { layer, preset, remote }
}

/** Every leaf key path a mapping sets; arrays are leaves (they replace, they do not merge). */
export const leafPaths = (value: unknown, prefix = ''): readonly string[] => !isRecord(value) || (prefix && !Object.keys(value).length)
  ? (prefix ? [prefix] : [])
  : Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key))

/** True when `declared` sets this path, or a scalar/list at one of its parents. */
const declaresPath = (declared: unknown, keys: readonly string[]): boolean => {
  let node = declared
  for (const key of keys) {
    if (!isRecord(node) || !(key in node)) return false
    node = node[key]
    if (!isRecord(node)) return true
  }
  return true
}

/** `detected` minus every leaf some file already sets. */
export const unsetOnly = (detected: Record<string, unknown>, declared: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const path of leafPaths(detected)) {
    const keys = path.split('.')
    if (declaresPath(declared, keys)) continue
    let node = out
    let source: unknown = detected
    for (const [index, key] of keys.entries()) {
      source = isRecord(source) ? source[key] : undefined
      if (index === keys.length - 1) node[key] = source
      else node = (node[key] ??= {}) as Record<string, unknown>
    }
  }
  return out
}

/**
 * Whether a root `.gitignore` / `info/exclude` line names `rel` or one of its parents.
 * ponytail: plain names only — wildcards, negations and nested .gitignore files are not evaluated; a miss only adds one redundant exclude line.
 */
const ignoredBy = (text: string, rel: string): boolean => {
  const targets = rel.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))
  return splitLines(text).map((line) => line.trim().replace(/^\//, '').replace(/\/(\*\*)?$/, '')).some((line) => targets.includes(line))
}

/**
 * Make sure the state directory is git-ignored: nothing when the root `.gitignore` or `info/exclude` already names
 * it, else one line in `info/exclude` — local to this clone, so the loop never needs a commit for it.
 * Returns what it did, or `null` when nothing was needed or possible.
 */
export const ensureStateDirIgnored = (root: string, stateDir: string): string | null => {
  const rel = toPosix(relative(root, stateDir))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  const gitDir = findGitDir(root)
  if (!gitDir) return null
  const exclude = join(gitDir, 'info', 'exclude')
  const current = readText(exclude) ?? ''
  if (ignoredBy(readText(join(root, '.gitignore')) ?? '', rel) || ignoredBy(current, rel)) return null
  try {
    mkdirSync(dirname(exclude), { recursive: true })
    appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}/${rel}/\n`, 'utf8')
    return `added /${rel}/ to ${exclude}`
  } catch { return null }
}
