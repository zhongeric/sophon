import { readCi } from '../core/ci.ts'
import type { CheckResult } from '../core/checks.ts'
import type { Ledger } from '../core/ledger.ts'
import type { Checker } from '../core/platform.ts'
import { PausedError } from '../core/questions.ts'
import { SetupError } from './box.ts'
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

/**
 * The checker of a review run whose config has tests or ci. The tests, the agent checks and ci use the build machine.
 * A failed setup there gives a failed result named setup, so the gate accepts the log with a report note. With ci, the
 * final checks publish the fixes and then run ci on the machine, not GitHub CI (D15). Without ci, the final checks
 * use GitHub CI.
 */
export function reviewChecker(ci: Checker, machine: Checker, publish: () => Promise<string>): Checker {
  const settle = async (run: () => Promise<CheckResult[]>): Promise<CheckResult[]> => {
    try {
      return await run()
    } catch (error) {
      if (!(error instanceof SetupError)) throw error
      return [{ name: 'setup', command: error.command, status: 'fail', ...error.result }]
    }
  }
  const { tests, agentChecks, ci: boxCi } = machine
  if (!agentChecks) throw new Error('the machine checker of a review run needs agent checks')
  const settled: Checker = {
    checks: ci.checks,
    tests: tests ? (paths) => settle(() => tests(paths)) : null,
    agentChecks: (changed) => settle(() => agentChecks(changed)),
  }
  if (!boxCi) return settled
  const runCi = (changed: string[]) => settle(() => boxCi(changed))
  return {
    ...settled,
    // The publish comes first, so that outcome() and the development run read the fixes as final.
    async checks(changed) {
      await publish()
      return runCi(changed)
    },
    ci: runCi,
  }
}
