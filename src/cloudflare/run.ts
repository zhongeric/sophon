import { Sql } from 'nanocode-ts/cloudflare'
import module from 'nanocode-ts/nanocode_wasm.wasm'
import { commandChecker, type RepoConfig } from '../core/checks.ts'
import type { Ledger } from '../core/ledger.ts'
import type { Checker } from '../core/platform.ts'
import { commentChannel, commentLimit, type Comments } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { parsePrices, zeroTokens, type RunUsage } from '../core/usage.ts'
import { allowedModelsFrom, codeReviewLoop, mergeModels, providersOf, type LoopInput, type LoopModels, type LoopResult } from '../core/workflows/code-review-loop.ts'
import { reviewAnnouncement } from './announcements.ts'
import { boxMachine, syncWithSetup } from './box.ts'
import { ciChecker, reviewChecker } from './checker.ts'
import { baseConfig } from './config.ts'
import type { GitHub } from './github.ts'
import { bundledGuides } from './guides.ts'
import { githubRepo, type GitHubRepo, type PullRequest } from './repo.ts'
import { githubSigning } from './signing.ts'
import { answerersOf, credentialsFor, defaultCiTimeoutMinutes, Runs, setupTimeoutMs, type Call, type RunMachine } from './runs.ts'
import { sqlFiles, sqlLedger } from './storage.ts'

export { allowedUsers, type Env } from './runs.ts'

/**
 * `ask` replaces the PR title and body as the original ask, for a review that the development workflow starts.
 * `budget` is the cost budget in USD. With `stopAtBudget`, the run stops at the budget without a question, because the
 * development run that started it asks with the run totals.
 */
export type StartRequest = PullRequest & { ship: boolean; by: string; full?: boolean; ask?: string; budget?: number; stopAtBudget?: boolean }

/** A finished review as the development workflow needs it: the fixes as a commit on GitHub. */
export type ReviewOutcome = { waiting: string } | (LoopResult & { waiting?: undefined })

/** The review runs of one PR. */
export class PullRequestRuns extends Runs<StartRequest> {
  protected number(request: StartRequest) {
    return request.pr
  }

  protected runName(request: StartRequest, stamp: string) {
    return `pr-${request.pr}-${stamp}`
  }

  protected announcement(run: string, request: StartRequest) {
    return reviewAnnouncement(run, request.by)
  }

  /** The result of a review run, with its fixes as a commit on GitHub, or what the run waits for. */
  outcome(run: string): ReviewOutcome {
    const row = this.row(run)
    if (!row) return { waiting: `no review run ${run}` }
    if (row.state === 'error') return { waiting: `review run ${run} stopped: ${row.note}. Resume it with npm run remote -- resume.` }
    if (row.state !== 'passed' && row.state !== 'failed') return { waiting: `review run ${run} is ${row.state}${row.note ? `: ${row.note}` : ''}` }
    const ledger = sqlLedger(this.ctx.storage.sql, run)
    // A run that finished before the usage records has no usage and no stop at the budget.
    const result = ledger.get<{ pass: boolean; criteria: LoopResult['criteria']; final: string; usage?: RunUsage; stopped?: boolean }>('result')!
    const published = ledger.get<{ local: string; sha: string }>('published')
    const headSha = ledger.get<{ headSha: string }>('snapshot')!.headSha
    return {
      branch: `factory/${run}`,
      criteria: result.criteria,
      final: published?.local === result.final ? published.sha : headSha,
      pass: result.pass,
      report: sqlFiles(this.ctx.storage.sql, run).read('report.md') ?? '',
      stopped: result.stopped ?? false,
      usage: result.usage ?? { tokens: zeroTokens(), unpriced: [], usd: 0 },
    }
  }

  protected async execute(run: string, request: StartRequest, ledger: Ledger, gh: GitHub, comments: Comments, call: Call) {
    const recorded = ledger.get<LoopInput>('input')
    // A run that started before a model role existed has no choice for it: use the default.
    const input = recorded ? { ...recorded, models: mergeModels(recorded.models) } : await this.input(run, request, gh)
    const prices = parsePrices(this.env.MODEL_PRICES)
    const pull = { owner: request.owner, pr: request.pr, repo: request.repo }
    const branch = `factory/${run}`
    const log = (line: string) => console.log(`[${request.owner}/${request.repo}#${request.pr} ${run}] ${line}`)
    const sql = Sql.create(this.ctx.storage)
    const repo = githubRepo({ branch, gh, ledger, log, pull, runId: run, sql })
    const signing = githubSigning(gh, request.owner, request.repo)
    const ci = ciChecker({ branch, gh, ledger, pull, repo, timeoutMs: Number(this.env.CI_TIMEOUT_MINUTES ?? defaultCiTimeoutMinutes) * 60_000 })
    const machine = input.config.tests ? await call.machine() : undefined
    const result = await codeReviewLoop(input, {
      channel: commentChannel({ answerers: answerersOf(this.env, input.config.answerers), comments, pollMs: 0, waitMs: 0 }),
      checker: machine ? machineChecker(machine, run, repo, input.config, ci, log) : ci,
      credentials: credentialsFor(this.env, providersOf(input.models)),
      files: sqlFiles(this.ctx.storage.sql, run),
      guides: await bundledGuides(),
      ledger,
      log,
      module,
      prices,
      repo,
      // The run also pushes its fixes to the publish branch, so the check also reads the rules of that branch.
      signing: { apply: signing.apply, check: (branches) => signing.check([...branches, branch]) },
      store: { record: () => {}, scope: (agent) => `${run}/${agent}`, sql },
    })
    return { passed: result.pass, summary: summary(run, result) }
  }

  /** The run's input. The checks and rails come from the base branch, so a PR cannot change its own. */
  private async input(run: string, request: StartRequest, gh: GitHub): Promise<LoopInput> {
    const api = `/repos/${request.owner}/${request.repo}`
    type Side = { ref: string; repo: { full_name: string } | null }
    const view = await gh.json<{ title: string; body: string | null; base: Side; head: Side }>('GET', `${api}/pulls/${request.pr}`)
    if (view.head.repo?.full_name.toLowerCase() !== view.base.repo?.full_name.toLowerCase())
      throw new StopError(
        'fork PRs are not supported: the fixes would go to a branch of this repository, where push CI runs the fork code with the repository secrets',
      )
    const config = await baseConfig(gh, request.owner, request.repo, view.base.ref)
    const overrides = this.env.MODELS ? (JSON.parse(this.env.MODELS) as Partial<LoopModels>) : {}
    return {
      allowedModels: allowedModelsFrom(this.env.ALLOWED_MODELS),
      ask: request.ask ?? `${view.title}\n\n${view.body ?? ''}`.trim(),
      config,
      headRef: view.head.ref,
      models: mergeModels(overrides),
      pr: request.pr,
      runId: run,
      source: `${request.owner}/${request.repo}#${request.pr}`,
      ...(request.ship ? { ship: { headRef: view.head.ref, pr: request.pr } } : {}),
      ...(request.full ? { full: true } : {}),
      ...(request.budget !== undefined ? { budget: request.budget } : {}),
      ...(request.stopAtBudget ? { stopAtBudget: true } : {}),
    }
  }
}

/** The review tree has a directory of its own, because the runs of all objects share one MACHINE_URL machine. */
function machineChecker({ box, syncs, jobs }: RunMachine, run: string, repo: GitHubRepo, config: RepoConfig, ci: Checker, log: (line: string) => void): Checker {
  const dir = `review/${run}`
  const pending = new Map<string, Promise<void>>()
  // The setup runs after each full copy, so a container that came back empty installs its dependencies again.
  const sync = () => syncWithSetup(box, syncs, pending, repo.tree, dir, { command: config.setup, timeoutMs: setupTimeoutMs }, log, jobs)
  return reviewChecker(ci, commandChecker(repo, { ...config, setup: undefined }, boxMachine(box, dir, sync, jobs)))
}

function summary(run: string, result: LoopResult): string {
  const report = result.report.length > commentLimit ? `${result.report.slice(0, commentLimit)}\n\n(cut)` : result.report
  return [
    `### agent-factory: ${result.pass ? 'PASS' : 'FAIL'} (run \`${run}\`)`,
    '',
    ...result.criteria.map((criterion) => `- [${criterion.ok ? 'x' : ' '}] ${criterion.name}`),
    '',
    `Fixes: \`${result.branch}\` at \`${result.final.slice(0, 12)}\``,
    '',
    '<details><summary>Full report</summary>',
    '',
    report,
    '',
    '</details>',
  ].join('\n')
}
