import { Sql } from 'nanocode-ts/cloudflare'
import module from 'nanocode-ts/nanocode_wasm.wasm'
import { commandChecker, requireChecks } from '../core/checks.ts'
import type { Ledger } from '../core/ledger.ts'
import type { Branch } from '../core/platform.ts'
import { commentChannel, type Comments } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { parsePrices } from '../core/usage.ts'
import { allowedModelsFrom, mergeModels, type LoopModels } from '../core/workflows/code-review-loop.ts'
import { cutReport, defaultDevelopModels, develop, developProviders, type DevelopInput, type DevelopModels } from '../core/workflows/develop.ts'
import { developAnnouncement } from './announcements.ts'
import { boxMachine, syncWithSetup } from './box.ts'
import { sqlBranches } from './branches.ts'
import type { GitHub } from './github.ts'
import { bundledGuides } from './guides.ts'
import { githubPulls } from './pulls.ts'
import { githubSigning } from './signing.ts'
import { baseConfig } from './config.ts'
import { reviewPass } from './review.ts'
import { answerersOf, credentialsFor, defaultCiTimeoutMinutes, Runs, setupTimeoutMs, type Call } from './runs.ts'
import { sqlFiles } from './storage.ts'
import { encodePath } from './trees.ts'

/**
 * A development run on a GitHub issue: the issue's title and body are the ask, and its comments carry the questions.
 * `budget` is the cost budget in USD.
 */
export type DevelopRequest = { owner: string; repo: string; issue: number; by: string; base?: string; hotfix?: boolean; full?: boolean; parallel?: number; budget?: number }

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

  protected async execute(run: string, request: DevelopRequest, ledger: Ledger, gh: GitHub, comments: Comments, call: Call) {
    const input = ledger.get<DevelopInput>('input') ?? (await this.input(run, request, gh))
    const prices = parsePrices(this.env.MODEL_PRICES)
    const { owner, repo } = request
    const log = (line: string) => console.log(`[${owner}/${repo}#${request.issue} ${run}] ${line}`)
    const sql = Sql.create(this.ctx.storage)
    const { box, syncs, jobs } = await call.machine()
    const setup = input.config.setup
    const pending = new Map<string, Promise<void>>()
    const checker = (branch: Branch) => {
      const dir = `work/${branch.name.replace(/[^A-Za-z0-9._-]/g, '-')}`
      // The setup runs after each full copy, so a container that came back empty installs its dependencies again.
      const sync = () => syncWithSetup(box, syncs, pending, branch.tree, dir, { command: setup, timeoutMs: setupTimeoutMs }, log, jobs)
      return commandChecker(branch, { ...input.config, setup: undefined }, boxMachine(box, dir, sync, jobs))
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
      review: (review) => reviewPass(this.env, request, ledger, review),
      signing: githubSigning(gh, owner, repo),
      store: { record: () => {}, scope: (agent) => `${run}/${agent}`, sql },
    })
    // A run that waits for the user, for example for CI, stops on an error, so that the admin resume starts it again from its ledger.
    if (result.resume) throw new StopError(result.resume)
    return { passed: result.status === 'ready', summary: cutReport(result.report, `(cut: see the report of run \`${run}\`)`) }
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
