import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Commits files on main of `repo` and pushes them to origin, so that the base moves. Returns the new base head. */
export function moveBase(repo: string, files: Record<string, string>): string {
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim()
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content)
  run('add', '-A')
  run('commit', '-q', '-m', 'base moves')
  run('push', '-q', 'origin', 'main')
  return run('rev-parse', 'HEAD')
}

/** The parents of a commit, in a bare or a normal repository. */
export const parents = (repo: string, commit: string) =>
  execFileSync('git', ['rev-list', '--parents', '-n', '1', commit], { cwd: repo, stdio: 'pipe' }).toString().trim().split(' ').slice(1)
