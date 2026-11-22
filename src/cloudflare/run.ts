import { Sql } from 'nanocode-ts/cloudflare'
import module from 'nanocode-ts/nanocode_wasm.wasm'
import { commandChecker, hasCi, type FailedFinalCheck, type RepoConfig } from '../core/checks.ts'
import type { Ledger } from '../core/ledger.ts'
import type { Checker } from '../core/platform.ts'
import { commentChannel, commentLimit, type Comments } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { parsePrices, zeroTokens, type RunUsage } from '../core/usage.ts'
import { allowedModelsFrom, codeReviewLoop, mergeModels, providersOf, type LoopInput, type LoopModels, type LoopResult } from '../core/workflows/code-review-loop.ts'
import { statusHeader } from './announcements.ts'
import { boxMachine, syncWithSetup } from './box.ts'
import { ciChecker, reviewChecker } from './checker.ts'
import { baseConfig } from './config.ts'
import type { GitHub } from './github.ts'
import { bundledGuides } from './guides.ts'
import { workLabels } from './labels.ts'
import { loopChoices, type PreflightNeeds } from './preflight.ts'
import { githubRepo, type GitHubRepo, type PullRequest } from './repo.ts'
import type { ReviewOutcome } from './review.ts'
import { githubSigning } from './signing.ts'
import { answerersOf, credentialsFor, defaultCiTimeoutMinutes, Runs, setupTimeoutMs, type Call, type ResumeResult, type RunMachine } from './runs.ts'
import { sqlFiles, sqlLedger } from './storage.ts'

export { allowedUsers, type Env } from './runs.ts'

/**
 * `ask` replaces the PR title and body as the original ask, for a review that the development workflow starts.
 * `budget` is the cost budget in USD. With `stopAtBudget`, the run stops at the budget without a question, because the
 * development run that started it asks with the run totals.
 */
export type StartRequest = PullRequest & { ship: boolean; by: string; full?: boolean; ask?: string; budget?: number; stopAtBudget?: boolean }

/** The review runs of one PR. */
export class PullRequestRuns extends Runs<StartRequest> {
  protected readonly label = workLabels.review

  protected number(request: StartRequest) {
    return request.pr
  }

  protected runName(request: StartRequest, stamp: string) {
    return `pr-${request.pr}-${stamp}`
  }

  protected announcement(run: string, request: StartRequest) {
    return statusHeader('review', run, request.by)
  }

  /** A review that a development or research run started has the ask of its parent, and the parent reports to the user. */
  protected override reportsToParent(request: StartRequest) {
    return request.ask !== undefined
  }

  /** The result of a review run, with its fixes as a commit on GitHub, or what the run waits for. */
  outcome(run: string): ReviewOutcome {
    const row = this.row(run)
    if (!row) return { waiting: `no review run ${run}` }
    if (row.state === 'error') return { error: row.note }
    if (row.state !== 'passed' && row.state !== 'failed') return { waiting: `review run ${run} is ${row.state}${row.note ? `: ${row.note}` : ''}` }
    const ledger = sqlLedger(this.ctx.storage.sql, run)
    // A run that finished before the usage records has no usage and no stop at the budget, and an older run has no failed checks.
    const result = ledger.get<{ pass: boolean; criteria: LoopResult['criteria']; final: string; usage?: RunUsage; stopped?: boolean; failedChecks?: FailedFinalCheck[] }>('result')!
    const published = ledger.get<{ local: string; sha: string }>('published')
    const headSha = ledger.get<{ headSha: string }>('snapshot')!.headSha
    return {
      branch: `factory/${run}`,
      criteria: result.criteria,
      failedChecks: result.failedChecks ?? [],
      final: published?.local === result.final ? published.sha : headSha,
      pass: result.pass,
      report: sqlFiles(this.ctx.storage.sql, run).read('report.md') ?? '',
      stopped: result.stopped ?? false,
      usage: result.usage ?? { tokens: zeroTokens(), unpriced: [], usd: 0 },
    }
  }

  /** Starts a review run in `error` again, as the admin resume does. Its parent run calls it at each restart and at its admin resume (D13). */
  async resumeAfterError(run: string): Promise<ResumeResult> {
    const row = this.row(run)
    if (!row) return { reason: `no review run ${run}`, resumed: false, state: null }
    if (row.state !== 'error') return { reason: `review run ${run} is ${row.state}`, resumed: false, state: row.state }
    const active = this.active()
    if (active) return { reason: `review run ${active.run} of this PR is ${active.state}`, resumed: false, state: row.state }
    this.queueAfterError(run)
    await this.ctx.storage.setAlarm(Date.now())
    return { reason: `started review run ${run} again from its ledger after the error`, resumed: true, state: row.state }
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
    const machine = input.config.tests || hasCi(input.config) ? await call.machine() : undefined
    const result = await codeReviewLoop(input, {
      channel: commentChannel({ answerers: answerersOf(this.env, input.config.answerers), comments, notice: call.notice, pollMs: 0, waitMs: 0 }),
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
    return { needsUser: !this.reportsToParent(request) && !result.pass, passed: result.pass, summary: summary(run, result) }
  }

  /** The base config, when it is not recorded, says whether the run tests on the build container. A fork PR stops here. */
  protected async preflightNeeds(request: StartRequest, ledger: Ledger, gh: GitHub | undefined): Promise<PreflightNeeds> {
    const recorded = ledger.get<LoopInput>('input')
    const models = loopChoices(recorded ? mergeModels(recorded.models) : this.models())
    if (!gh) return { ciBase: null, container: recorded ? Boolean(recorded.config.tests) || hasCi(recorded.config) : false, models }
    const view = await this.pull(request, gh)
    const config = recorded?.config ?? (await baseConfig(gh, request.owner, request.repo, view.base.ref))
    // A review with ci runs it on the build container and reads no GitHub CI (D15).
    return { ciBase: hasCi(config) ? null : view.base.ref, container: Boolean(config.tests) || hasCi(config), models }
  }

  /** The models of a new run: the defaults with the MODELS overrides. */
  private models(): LoopModels {
    return mergeModels(this.env.MODELS ? (JSON.parse(this.env.MODELS) as Partial<LoopModels>) : {})
  }

  /** The PR. A fork PR stops the run. */
  private async pull(request: StartRequest, gh: GitHub) {
    type Side = { ref: string; repo: { full_name: string } | null }
    const view = await gh.json<{ title: string; body: string | null; base: Side; head: Side }>('GET', `/repos/${request.owner}/${request.repo}/pulls/${request.pr}`)
    if (view.head.repo?.full_name.toLowerCase() !== view.base.repo?.full_name.toLowerCase())
      throw new StopError(
        'fork PRs are not supported: the fixes would go to a branch of this repository, where push CI runs the fork code with the repository secrets',
      )
    return view
  }

  /** The run's input. The checks and rails come from the base branch, so a PR cannot change its own. */
  private async input(run: string, request: StartRequest, gh: GitHub): Promise<LoopInput> {
    const view = await this.pull(request, gh)
    const config = await baseConfig(gh, request.owner, request.repo, view.base.ref)
    return {
      allowedModels: allowedModelsFrom(this.env.ALLOWED_MODELS),
      ask: request.ask ?? `${view.title}\n\n${view.body ?? ''}`.trim(),
      config,
      headRef: view.head.ref,
      models: this.models(),
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
  return reviewChecker(ci, commandChecker(repo, { ...config, setup: undefined }, boxMachine(box, dir, sync, jobs)), repo.publish)
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
