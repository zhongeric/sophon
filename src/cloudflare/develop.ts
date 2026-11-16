import { Sql } from 'nanocode-ts/cloudflare'
import module from 'nanocode-ts/nanocode_wasm.wasm'
import { commandChecker, requireChecks } from '../core/checks.ts'
import type { Ledger } from '../core/ledger.ts'
import type { Branch } from '../core/platform.ts'
import { commentChannel, commentLimit, PausedError, type Comments } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { addTokens, parsePrices, zeroTokens, type RunUsage } from '../core/usage.ts'
import { allowedModelsFrom, mergeModels, type LoopModels, type LoopResult } from '../core/workflows/code-review-loop.ts'
import { defaultDevelopModels, develop, developProviders, type DevelopInput, type DevelopModels, type ReviewRequest } from '../core/workflows/develop.ts'
import { developAnnouncement } from './announcements.ts'
import { boxMachine, containerBox, httpBox, syncWithSetup, type Box, type SyncStore } from './box.ts'
import { sqlBranches } from './branches.ts'
import type { GitHub } from './github.ts'
import { bundledGuides } from './guides.ts'
import { githubPulls } from './pulls.ts'
import { baseConfig } from './config.ts'
import { answerersOf, credentialsFor, defaultCiTimeoutMinutes, Runs } from './runs.ts'
import { sqlFiles } from './storage.ts'
import { sqlSyncs } from './syncs.ts'
import { encodePath } from './trees.ts'

/**
 * A development run on a GitHub issue: the issue's title and body are the ask, and its comments carry the questions.
 * `budget` is the cost budget in USD.
 */
export type DevelopRequest = { owner: string; repo: string; issue: number; by: string; base?: string; hotfix?: boolean; full?: boolean; parallel?: number; budget?: number }

/**
 * The container stops after this long without a command. A stopped container comes back empty. Its start clears
 * the sync state in SQL, so the next sync copies the trees again.
 */
const containerIdleMs = 30 * 60_000
const setupTimeoutMs = 20 * 60_000

/**
 * The development runs of one issue. The brain stays here: the ledger, the branches as trees in SQL, every agent
 * session, and the GitHub token. The run's Cloudflare Container only runs the repository's setup and checks on a
 * copy of each branch, so code under development never runs beside a secret. The SQL also keeps what each
 * container directory got from its last sync, for each run. Thus a restart of this object does not cause a full copy.
 */
export class DevelopmentRuns extends Runs<DevelopRequest> {
  protected number(request: DevelopRequest) {
    return request.issue
  }

  protected runName(request: DevelopRequest, stamp: string) {
    return `dev-${request.issue}-${stamp}`
  }

  protected announcement(run: string, request: DevelopRequest) {
    return developAnnouncement(run, request.by)
  }

  protected async execute(run: string, request: DevelopRequest, ledger: Ledger, gh: GitHub, comments: Comments) {
    const input = ledger.get<DevelopInput>('input') ?? (await this.input(run, request, gh))
    const prices = parsePrices(this.env.MODEL_PRICES)
    const { owner, repo } = request
    const log = (line: string) => console.log(`[${owner}/${repo}#${request.issue} ${run}] ${line}`)
    const sql = Sql.create(this.ctx.storage)
    const syncs = sqlSyncs(this.ctx.storage.sql, run)
    const box = this.box(syncs)
    const setup = input.config.setup
    const pending = new Map<string, Promise<void>>()
    const checker = (branch: Branch) => {
      const dir = `work/${branch.name.replace(/[^A-Za-z0-9._-]/g, '-')}`
      // The setup runs after each full copy, so a container that came back empty installs its dependencies again.
      const sync = () => syncWithSetup(box, syncs, pending, branch.tree, dir, { command: setup, timeoutMs: setupTimeoutMs }, log)
      return commandChecker(branch, { ...input.config, setup: undefined }, boxMachine(box, dir, sync))
    }
    const result = await develop(input, {
      branches: sqlBranches({ gh, ledger, log, owner, repo, run, sql }),
      channel: commentChannel({ answerers: answerersOf(this.env, input.config.answerers), comments, pollMs: 0, waitMs: 0 }),
      checker,
      ci: { pollMs: 0, startMs: Number(this.env.CI_TIMEOUT_MINUTES ?? defaultCiTimeoutMinutes) * 60_000, waitMs: 0 },
      credentials: credentialsFor(this.env, developProviders(input.models)),
      files: sqlFiles(this.ctx.storage.sql, run),
      guides: await bundledGuides(),
      ledger,
      log,
      module,
      prices,
      pulls: githubPulls(gh, owner, repo, input.baseRef),
      review: (review) => this.review(request, ledger, review),
      store: { record: () => {}, scope: (agent) => `${run}/${agent}`, sql },
    })
    // A run that waits for the user, for example for CI, stops on an error, so that the admin resume starts it again from its ledger.
    if (result.resume) throw new StopError(result.resume)
    const summary = result.report.length > commentLimit ? `${result.report.slice(0, commentLimit)}\n\n(cut: see the report of run \`${run}\`)` : result.report
    return { passed: result.status === 'ready', summary }
  }

  private box(syncs: SyncStore): Box {
    if (this.env.MACHINE_URL) return httpBox(this.env.MACHINE_URL)
    if (!this.ctx.container) throw new StopError('this Worker has no container for builds: add the containers section of wrangler.jsonc and deploy again')
    return containerBox(this.ctx.container, { inactivityMs: containerIdleMs, onStart: () => syncs.clear() })
  }

  /**
   * The review loop runs as a review run of the new PR, in that PR's own object, as a /review would. A finished review
   * run cannot resume. Thus, when a pass stopped at its budget and develop() calls again after a raise, a new review run
   * starts with what remains after the earlier runs. The usage of the pass includes the earlier runs.
   */
  private async review(request: DevelopRequest, ledger: Ledger, review: ReviewRequest): Promise<LoopResult> {
    const { owner, repo } = request
    const runs = this.env.PULL_REQUESTS.get(this.env.PULL_REQUESTS.idFromName(`${owner}/${repo}#${review.pr}`.toLowerCase()))
    const key = `review-run:${review.runId}`
    const stoppedKey = `review-stopped:${review.runId}`
    const stopped = ledger.get<Record<string, RunUsage>>(stoppedKey) ?? {}
    const earlierUsd = Object.values(stopped).reduce((sum, usage) => sum + usage.usd, 0)
    let run = ledger.get<string>(key)
    let outcome = run ? await runs.outcome(run) : undefined
    // The parent must collect the stopped usage and raise the budget before another run can start.
    if (run && stopped[run] && outcome?.waiting === undefined && outcome?.stopped && review.budget !== undefined && review.budget > earlierUsd) run = undefined
    if (!run || !outcome) {
      const budget = review.budget !== undefined ? { budget: review.budget - earlierUsd } : {}
      run = (await runs.start({ ask: review.ask, by: request.by, full: review.full, owner, pr: review.pr, repo, ship: false, stopAtBudget: true, ...budget })).run
      ledger.put(key, run)
      outcome = await runs.outcome(run)
    }
    if (outcome.waiting !== undefined) throw new PausedError(outcome.waiting)
    if (outcome.stopped && !stopped[run]) ledger.put(stoppedKey, { ...stopped, [run]: outcome.usage })
    // The current outcome can also be in the ledger after an earlier collection. Count each run once.
    const usage = [...Object.entries(stopped).filter(([id]) => id !== run).map(([, usage]) => usage), outcome.usage].reduce<RunUsage>(
      (a, b) => ({ tokens: addTokens(a.tokens, b.tokens), usd: a.usd + b.usd, unpriced: [...new Set([...a.unpriced, ...b.unpriced])] }),
      { tokens: zeroTokens(), usd: 0, unpriced: [] },
    )
    return { ...outcome, usage }
  }

  /** The run's input: the issue is the ask, verbatim. The checks and rails come from the base branch. */
  private async input(run: string, request: DevelopRequest, gh: GitHub): Promise<DevelopInput> {
    const api = `/repos/${request.owner}/${request.repo}`
    const issue = await gh.json<{ title: string; body: string | null; pull_request?: unknown }>('GET', `${api}/issues/${request.issue}`)
    if (issue.pull_request) throw new StopError(`#${request.issue} is a PR. Start a development run on an issue, and a review run on a PR.`)
    const baseRef = request.base ?? (await gh.json<{ default_branch: string }>('GET', api)).default_branch
    const base = (await gh.json<{ object: { sha: string } }>('GET', `${api}/git/ref/heads/${encodePath(baseRef)}`)).object.sha
    type Overrides = Partial<LoopModels> & { develop?: Partial<DevelopModels> }
    const overrides = this.env.MODELS ? (JSON.parse(this.env.MODELS) as Overrides) : {}
    return {
      allowedModels: allowedModelsFrom(this.env.ALLOWED_MODELS),
      ask: `${issue.title}\n\n${issue.body ?? ''}`.trim(),
      base,
      baseRef,
      // The build container runs the checks, so a development run needs at least one.
      config: requireChecks(await baseConfig(gh, request.owner, request.repo, baseRef), `${request.owner}/${request.repo}`),
      models: { develop: { ...defaultDevelopModels, ...overrides.develop }, review: mergeModels(overrides) },
      runId: run,
      source: `${request.owner}/${request.repo}#${request.issue}`,
      issue: request.issue,
      ...(request.hotfix ? { hotfix: true } : {}),
      ...(request.full ? { full: true } : {}),
      ...(request.parallel ? { parallel: request.parallel } : {}),
      ...(request.budget !== undefined ? { budget: request.budget } : {}),
    }
  }
}
