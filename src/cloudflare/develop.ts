import { Sql } from 'nanocode-ts/cloudflare'
import module from 'nanocode-ts/nanocode_wasm.wasm'
import { commandChecker } from '../core/checks.ts'
import type { Ledger } from '../core/ledger.ts'
import type { Branch } from '../core/platform.ts'
import { commentChannel, PausedError, type Comments } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { mergeModels, providersOf, type LoopModels, type LoopResult } from '../core/workflows/code-review-loop.ts'
import { defaultDevelopModels, develop, type DevelopInput, type DevelopModels, type ReviewRequest } from '../core/workflows/develop.ts'
import { boxEnv, boxMachine, containerBox, httpBox, syncTree, type Box } from './box.ts'
import { sqlBranches } from './branches.ts'
import type { GitHub } from './github.ts'
import { bundledGuides } from './guides.ts'
import { githubPulls } from './pulls.ts'
import { baseConfig } from './run.ts'
import { answerersOf, credentialsFor, Runs } from './runs.ts'
import { sqlFiles } from './storage.ts'
import { encodePath } from './trees.ts'

/** A development run on a GitHub issue: the issue's title and body are the ask, and its comments carry the questions. */
export type DevelopRequest = { owner: string; repo: string; issue: number; by: string; base?: string; hotfix?: boolean; full?: boolean; parallel?: number }

const defaultCiTimeoutMinutes = 30
/** The container stops after this long without a command. A stopped container comes back empty, and the next sync copies the trees again. */
const containerIdleMs = 30 * 60_000
const setupTimeoutMs = 20 * 60_000

/**
 * The development runs of one issue. The brain stays here: the ledger, the branches as trees in SQL, every agent
 * session, and the GitHub token. The run's Cloudflare Container only runs the repository's setup and checks on a
 * copy of each branch, so code under development never runs beside a secret.
 */
export class DevelopmentRuns extends Runs<DevelopRequest> {
  /** What each container directory holds, for the next sync. The container and this map both start empty. */
  private synced = new Map<string, Map<string, string>>()

  protected number(request: DevelopRequest) {
    return request.issue
  }

  protected runName(request: DevelopRequest, stamp: string) {
    return `dev-${request.issue}-${stamp}`
  }

  protected announcement(run: string, request: DevelopRequest) {
    return `agent-factory started development run \`${run}\` for @${request.by}. Questions for you will appear here; answer them with a \`/answer\` comment. The PR and the report come when the work is ready, or a blocker when it cannot be.`
  }

  protected async execute(run: string, request: DevelopRequest, ledger: Ledger, gh: GitHub, comments: Comments) {
    const input = ledger.get<DevelopInput>('input') ?? (await this.input(run, request, gh))
    const { owner, repo } = request
    const log = (line: string) => console.log(`[${owner}/${repo}#${request.issue} ${run}] ${line}`)
    const sql = Sql.create(this.ctx.storage)
    const box = this.box()
    const setup = input.config.setup
    const checker = (branch: Branch) => {
      const dir = `work/${branch.name.replace(/[^A-Za-z0-9._-]/g, '-')}`
      // The setup runs after each full copy, so a container that came back empty installs its dependencies again.
      const sync = async () => {
        const last = this.synced.get(dir) ?? null
        const next = await syncTree(box, branch.tree, dir, last)
        if (!last && setup) {
          const result = await box.exec(['bash', '-c', setup], { cwd: dir, env: boxEnv, timeoutMs: setupTimeoutMs })
          if (result.exit_code !== 0) throw new Error(`the setup command failed: ${result.output.slice(-2000)}`)
        }
        this.synced.set(dir, next)
      }
      return commandChecker(branch, { ...input.config, setup: undefined }, boxMachine(box, dir, sync))
    }
    const result = await develop(input, {
      branches: sqlBranches({ gh, ledger, log, owner, repo, run, sql }),
      channel: commentChannel({ answerers: answerersOf(this.env, input.config.answerers), comments, pollMs: 0, waitMs: 0 }),
      checker,
      ci: { pollMs: 0, startMs: Number(this.env.CI_TIMEOUT_MINUTES ?? defaultCiTimeoutMinutes) * 60_000, waitMs: 0 },
      credentials: credentialsFor(this.env, new Set([...providersOf(input.models.review), ...Object.values(input.models.develop).map((choice) => choice.provider)])),
      files: sqlFiles(this.ctx.storage.sql, run),
      guides: bundledGuides,
      ledger,
      log,
      module,
      pulls: githubPulls(gh, owner, repo, input.baseRef),
      review: (review) => this.review(request, ledger, review),
      store: { record: () => {}, scope: (agent) => `${run}/${agent}`, sql },
    })
    return { passed: result.status === 'ready', summary: result.report }
  }

  private box(): Box {
    if (this.env.MACHINE_URL) return httpBox(this.env.MACHINE_URL)
    if (!this.ctx.container) throw new StopError('this Worker has no container for builds: add the containers section of wrangler.jsonc and deploy again')
    return containerBox(this.ctx.container, { inactivityMs: containerIdleMs, onStart: () => this.synced.clear() })
  }

  /** The review loop runs as a review run of the new PR, in that PR's own object, as a /review would. */
  private async review(request: DevelopRequest, ledger: Ledger, review: ReviewRequest): Promise<LoopResult> {
    const { owner, repo } = request
    const runs = this.env.PULL_REQUESTS.get(this.env.PULL_REQUESTS.idFromName(`${owner}/${repo}#${review.pr}`.toLowerCase()))
    const key = `review-run:${review.runId}`
    let run = ledger.get<string>(key)
    if (!run) {
      run = (await runs.start({ ask: review.ask, by: request.by, full: review.full, owner, pr: review.pr, repo, ship: false })).run
      ledger.put(key, run)
    }
    const outcome = await runs.outcome(run)
    if (outcome.waiting !== undefined) throw new PausedError(outcome.waiting)
    return outcome
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
      ask: `${issue.title}\n\n${issue.body ?? ''}`.trim(),
      base,
      baseRef,
      config: await baseConfig(gh, request.owner, request.repo, baseRef),
      models: { develop: { ...defaultDevelopModels, ...overrides.develop }, review: mergeModels(overrides) },
      runId: run,
      source: `${request.owner}/${request.repo}#${request.issue}`,
      ...(request.hotfix ? { hotfix: true } : {}),
      ...(request.full ? { full: true } : {}),
      ...(request.parallel ? { parallel: request.parallel } : {}),
    }
  }
}
