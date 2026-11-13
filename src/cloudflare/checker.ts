import { readCi } from '../core/ci.ts'
import type { CheckResult } from '../core/checks.ts'
import type { Ledger } from '../core/ledger.ts'
import type { Checker } from '../core/platform.ts'
import { PausedError } from '../core/questions.ts'
import type { GitHub } from './github.ts'
import type { GitHubRepo, PullRequest } from './repo.ts'

/**
 * The repository's own CI as the checks: the fixes go to the run's branch, and the run waits for the GitHub
 * Actions workflow runs and the commit statuses of that commit. CI runs the full suite, so the run never runs
 * tests itself.
 */
export function ciChecker(options: { gh: GitHub; pull: PullRequest; repo: GitHubRepo; ledger: Ledger; branch: string; timeoutMs: number }): Checker {
  const api = `/repos/${options.pull.owner}/${options.pull.repo}`
  return {
    tests: null,
    async checks(): Promise<CheckResult[]> {
      const sha = await options.repo.publish()
      const startedKey = `ci-started:${sha}`
      const started = options.ledger.get<number>(startedKey) ?? Date.now()
      options.ledger.put(startedKey, started)
      const results = await readCi((path) => options.gh.json('GET', path), api, sha)
      const waited = Date.now() - started
      if (results.length === 0 && waited < options.timeoutMs) throw new PausedError(`waiting for CI to start on ${sha.slice(0, 12)} (${options.branch})`)
      if (results.length === 0)
        return [
          {
            name: 'ci',
            command: '',
            status: 'fail',
            exit_code: null,
            output: `no CI ran on ${sha} in ${Math.round(waited / 60_000)} minutes. Run CI on pushes to factory/** branches.`,
          },
        ]
      const pending = results.filter((result) => !result.done)
      if (pending.length > 0) throw new PausedError(`waiting for CI on ${sha.slice(0, 12)}: ${pending.map((result) => result.name).join(', ')}`)
      return results.map((result) => ({ name: result.name, command: result.url, status: result.ok ? 'pass' : 'fail', exit_code: null, output: '' }))
    },
  }
}
