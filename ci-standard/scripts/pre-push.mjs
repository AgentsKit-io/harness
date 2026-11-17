#!/usr/bin/env node
// Pre-push hook (mandatory, versioned via husky), from the CI standard's ci-standard/scripts/pre-push.mjs.
// Adapted: this repository has no oxlint/Biome (the typecheck is its lint), so the hook runs only the
// typecheck with TypeScript 7 (native tsc), and only when a TS/JS file changed. Do not use --no-verify.
// Budget: 10 s. Base = upstream of the current branch, else origin/main.
import { execFileSync, spawnSync } from 'node:child_process'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
let base
try {
  base = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')
} catch {
  base = 'origin/main'
}
let files = []
try {
  const mergeBase = git('merge-base', base, 'HEAD')
  files = git('diff', '--name-only', '--diff-filter=ACMR', mergeBase, 'HEAD').split('\n').filter(Boolean)
} catch {
  console.error(`pre-push: base ${base} not found; checking the whole project`)
}
const started = Date.now()
const run = (label, cmd, args) => {
  const t = Date.now()
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  console.log(`pre-push: ${label} ${((Date.now() - t) / 1000).toFixed(1)}s`)
  if (r.status !== 0) {
    console.error(`pre-push: ${label} failed, push aborted`)
    process.exit(1)
  }
}
const code = files.filter((f) => /\.(m?[jt]sx?)$/.test(f))
if (files.length > 0 && code.length === 0) console.log('pre-push: no changed TS/JS files')
else {
  run('tsc (TS 7) typecheck', 'npx', ['tsc', '-p', 'tsconfig.json', '--noEmit'])
  run('tsc (TS 7) typecheck ui', 'npx', ['tsc', '-p', 'src/ui/app/tsconfig.json', '--noEmit'])
}
const total = (Date.now() - started) / 1000
console.log(`pre-push: total ${total.toFixed(1)}s${total > 10 ? ' (over the 10 s budget!)' : ''}`)
