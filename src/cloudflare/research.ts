import { Sql } from 'nanocode-ts/cloudflare'
import module from 'nanocode-ts/nanocode_wasm.wasm'
import { commandChecker, repoConfigFile, type RepoConfig } from '../core/checks.ts'
import { runLock } from '../core/egress.ts'
import type { Ledger } from '../core/ledger.ts'
import type { Branch } from '../core/platform.ts'
import { commentChannel, type Comments } from '../core/questions.ts'
import type { ResearchDomain } from '../core/research.ts'
import { StopError } from '../core/stop.ts'
import { parseContainerPrices, parsePrices } from '../core/usage.ts'
import { allowedModelsFrom, mergeModels, type LoopModels } from '../core/workflows/code-review-loop.ts'
import { cutReport } from '../core/workflows/develop.ts'
import { defaultResearchModels, research, researchProviders, type ResearchInput, type ResearchModels } from '../core/workflows/research.ts'
import { researchAnnouncement } from './announcements.ts'
import { sqlArtifacts } from './artifacts.ts'
import { boxEnv, boxMachine, cleanBox, syncWithSetup } from './box.ts'
import { commitTree, sqlBranches } from './branches.ts'
import { baseConfig, baseResearch } from './config.ts'
import { checkWorkerCredentials, egressUrlFetch, workerSecret } from './egress.ts'
import type { GitHub } from './github.ts'
import { bundledGuides } from './guides.ts'
import { workLabels } from './labels.ts'
import { loopChoices, type PreflightNeeds } from './preflight.ts'
import { githubPulls } from './pulls.ts'
import { reviewPass } from './review.ts'
import { answerersOf, credentialsFor, Runs, setupTimeoutMs, type Call } from './runs.ts'
import { scanPool, standard4 } from './scan-pool.ts'
import { sqlFiles } from './storage.ts'
import { encodePath } from './trees.ts'

/**
 * A research run on a GitHub issue: the issue's title and body are the program, and its comments carry the questions.
 * `budget` is the cost budget in USD.
 */
export type ResearchRequest = { owner: string; repo: string; issue: number; by: string; base?: string; parallel?: number; budget?: number }

/** The input of a run, with the notebook config and the domain from its base commit. The ledger keeps it for each resume. */
type Notebook = { input: ResearchInput; config: RepoConfig; domain: ResearchDomain }

/**
 * The research runs of one program issue (docs/specs/research-workflow.md, section 7). As in DevelopmentRuns, the
 * ledger, the branch trees, the agent sessions and the secrets stay in this object. The container only runs the
 * commands of the notebook, on copies of the branches and on clean checkouts of commits.
 */
export class ResearchRuns extends Runs<ResearchRequest> {
  protected readonly label = workLabels.research

  protected number(request: ResearchRequest) {
    return request.issue
  }

  protected runName(request: ResearchRequest, stamp: string) {
    return `research-${request.issue}-${stamp}`
  }

  protected announcement(run: string, request: ResearchRequest) {
    return researchAnnouncement(run, request.by)
  }

  protected async execute(run: string, request: ResearchRequest, ledger: Ledger, gh: GitHub, comments: Comments, call: Call) {
    const { input, config, domain } = ledger.get<Notebook>('notebook') ?? (await this.notebook(run, request, gh, ledger))
    // A credential that names a Worker setting stops the run before any fetch.
    checkWorkerCredentials(domain.config.credentials)
    const { owner, repo } = request
    const log = (line: string) => console.log(`[${owner}/${repo}#${request.issue} ${run}] ${line}`)
    const sql = Sql.create(this.ctx.storage)
    const { box, syncs, jobs } = await call.machine()
    const pending = new Map<string, Promise<void>>()
    const checker = (branch: Branch) => {
      const dir = `work/${branch.name.replace(/[^A-Za-z0-9._-]/g, '-')}`
      const sync = () => syncWithSetup(box, syncs, pending, branch.tree, dir, { command: config.setup, timeoutMs: setupTimeoutMs }, log, jobs)
      return commandChecker(branch, { ...config, setup: undefined }, boxMachine(box, dir, sync, jobs))
    }
    const result = await research(input, {
      branches: sqlBranches({ gh, ledger, log, owner, repo, run, sql }),
      channel: commentChannel({ answerers: answerersOf(this.env, config.answerers), comments, pollMs: 0, waitMs: 0 }),
      checker,
      // A new directory for each step key, so that no file of an earlier command is in it. Only the last one stays. A replay
      // of the step, for example after a pause on its job, keeps the directory of the key and its files.
      async cleanBox(commit, key, files) {
        const dirKey = `clean-dir:${key}`
        let dir = ledger.get<string>(dirKey)
        if (dir === undefined) {
          const count = (ledger.get<number>('clean-boxes') ?? 0) + 1
          ledger.put('clean-boxes', count)
          if (count > 1) {
            const previous = await box.exec(['rm', '-rf', '--', `clean/${run}/${count - 1}`], { cwd: '', env: boxEnv, timeoutMs: 10 * 60_000 })
            if (previous.exit_code !== 0) throw new Error(`the removal of clean checkout ${count - 1} failed: ${previous.output.slice(-2000)}`)
          }
          dir = `clean/${run}/${count}`
          ledger.put(dirKey, dir)
        }
        const tree = await commitTree({ ledger, run, sql }, commit)
        return cleanBox(box, tree, dir, log, { deadline: call.deadline, key, ledger, runner: jobs }, files)
      },
      compute: { runBox: standard4 },
      config,
      containerPrices: parseContainerPrices(this.env.CONTAINER_PRICES),
      credentials: credentialsFor(this.env, researchProviders(input.models)),
      domain,
      egress: {
        artifacts: sqlArtifacts(this.ctx.storage, run),
        lock: runLock(ledger, domain.holdout.refuse),
        secret: workerSecret(this.env),
        ...(this.env.EGRESS_URL ? { fetch: egressUrlFetch(this.env.EGRESS_URL) } : {}),
      },
      files: sqlFiles(this.ctx.storage.sql, run),
      guides: await bundledGuides(),
      ledger,
      log,
      module,
      prices: parsePrices(this.env.MODEL_PRICES),
      pulls: githubPulls(gh, owner, repo, input.baseRef),
      review: (review) => reviewPass(this.env, request, ledger, review),
      scanBoxes: scanPool(this.env.SCAN_BOXES),
      store: { record: () => {}, scope: (agent) => `${run}/${agent}`, sql },
    })
    return { passed: result.status === 'ready', summary: cutReport(result.report, `(cut: see the report of run \`${run}\`)`) }
  }

  protected async preflightNeeds(_request: ResearchRequest, ledger: Ledger): Promise<PreflightNeeds> {
    const { generators, review, ...roles } = ledger.get<Notebook>('notebook')?.input.models ?? this.models()
    return { ciBase: null, container: true, models: [...Object.values(roles), ...generators, ...loopChoices(review)] }
  }

  /** The models of a new run: the defaults with the MODELS overrides. */
  private models(): ResearchModels {
    type Overrides = Partial<LoopModels> & { research?: Partial<Omit<ResearchModels, 'review'>> }
    const overrides = this.env.MODELS ? (JSON.parse(this.env.MODELS) as Overrides) : {}
    return { ...defaultResearchModels, ...overrides.research, review: mergeModels(overrides) }
  }

  /** The run's input: the issue is the program, verbatim. The config and the domain come from the base commit. */
  private async notebook(run: string, request: ResearchRequest, gh: GitHub, ledger: Ledger): Promise<Notebook> {
    const { owner, repo } = request
    const api = `/repos/${owner}/${repo}`
    const issue = await gh.json<{ title: string; body: string | null; pull_request?: unknown }>('GET', `${api}/issues/${request.issue}`)
    if (issue.pull_request) throw new StopError(`#${request.issue} is a PR. Start a research run on an issue, and a review run on a PR with /review.`)
    const baseRef = request.base ?? (await gh.json<{ default_branch: string }>('GET', api)).default_branch
    const base = (await gh.json<{ object: { sha: string } }>('GET', `${api}/git/ref/heads/${encodePath(baseRef)}`)).object.sha
    const config = await baseConfig(gh, owner, repo, base)
    if (!config.research) throw new StopError(`${repoConfigFile} on ${baseRef} has no research field`)
    const domain = await baseResearch(gh, owner, repo, base, config.research)
    const input: ResearchInput = {
      allowedModels: allowedModelsFrom(this.env.ALLOWED_MODELS),
      base,
      baseRef,
      models: this.models(),
      program: `${issue.title}\n\n${issue.body ?? ''}`.trim(),
      runId: run,
      source: `${owner}/${repo}#${request.issue}`,
      ...(request.parallel ? { parallel: request.parallel } : {}),
      ...(request.budget !== undefined ? { budget: request.budget } : {}),
    }
    const notebook = { config, domain, input }
    ledger.put('notebook', notebook)
    return notebook
  }
}
