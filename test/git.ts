import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const initializeGitRepository = (root: string): void => {
  execFileSync('git', ['init', root])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'harness@example.test'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Harness Test'])
  writeFileSync(join(root, '.harness-fixture'), 'fixture\n')
  execFileSync('git', ['-C', root, 'add', '.harness-fixture'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'fixture'])
}
