import { DurableObject } from 'cloudflare:workers'
import { Sql } from 'nanocode-ts/cloudflare'
import module from 'nanocode-ts/nanocode_wasm.wasm'
import { parseRepoConfig, repoConfigFile } from '../core/checks.ts'
import type { Ledger } from '../core/ledger.ts'
import { apiKeyCredential, type Credentials } from '../core/providers.ts'
import { commentChannel, PausedError, type Comments } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { codeReviewLoop, defaultModels, providersOf, type LoopInput, type LoopModels, type LoopResult } from '../core/workflows/code-review-loop.ts'
import { ciChecker } from './checker.ts'
import { githubComments } from './comments.ts'
import { github, GitHubError, type GitHub } from './github.ts'
import { bundledGuides } from './guides.ts'
import { githubRepo, type PullRequest } from './repo.ts'
import { createTables, sqlFiles, sqlLedger } from './storage.ts'

export type Env = {
  PULL_REQUESTS: DurableObjectNamespace<PullRequestRuns>
  GITHUB_TOKEN: string
  GITHUB_WEBHOOK_SECRET: string
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
  /** GitHub logins, comma-separated, that may start runs and answer questions. */
  ALLOWED_USERS: string
  /** Bearer token for the status and report routes. */
  ADMIN_TOKEN?: string
  /** JSON that overrides the default models per step and role. */
  MODELS?: string
  CI_TIMEOUT_MINUTES?: string
  PAUSE_POLL_SECONDS?: string
  /** Endpoint overrides, for gateways and for local tests. */
  GITHUB_API_URL?: string
  ANTHROPIC_URL?: string
  OPENAI_URL?: string
}

export type StartRequest = PullRequest & { ship: boolean; by: string }
type State = 'queued' | 'running' | 'paused' | 'passed' | 'failed' | 'error'
type RunRow = { run: string; state: State; note: string; created: number; request: string }
/** The result of `resume`: `state` is the state of the latest run before the call, or null when the PR has no run. */
type ResumeResult = { resumed: boolean; state: State | null; reason: string }

/** Why `resume` does not wake the latest run, for each state that it does not wake. */
const notResumed: Record<Exclude<State, 'paused'>, string> = {
  error: 'the run stopped on an error. Only the admin route starts it again: use npm run remote -- resume',
  failed: 'the run is complete with FAIL. Start a new run to review the PR again',
  passed: 'the run is complete with PASS. Start a new run to review the PR again',
  queued: 'the run is queued and starts on its next alarm',
  running: 'the run is running now',
}

/** While a run works, its alarm stays this far ahead, so that a run whose isolate died restarts from its ledger. */
const heartbeatMs = 60_000
const heartbeatEveryMs = 20_000
const maxAttempts = 3
/** Restarts of a run whose isolate died with no finished step in between, before the run stops. */
const maxRestarts = 5
const retryMs = 60_000
const defaultPauseSeconds = 60
const defaultCiTimeoutMinutes = 30
/** GitHub refuses comments over 65,536 characters. */
const commentLimit = 60_000

export function allowedUsers(env: Env): string[] {
  return env.ALLOWED_USERS.split(',')
    .map((login) => login.trim())
    .filter(Boolean)
}

/**
 * The review runs of one PR. The run's ledger, its repository tree and every agent session live in this
 * object's SQLite. Alarms drive the run: a heartbeat restarts a run that died, a pause re-checks its answers
 * or CI, and webhooks wake it early.
 */
export class PullRequestRuns extends DurableObject<Env> {
  busy = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    createTables(ctx.storage.sql)
  }

  async start(request: StartRequest): Promise<{ run: string; started: boolean }> {
    const active = this.active()
    if (active) return { run: active.run, started: false }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const run = `pr-${request.pr}-${stamp}`
    this.ctx.storage.sql.exec('insert into factory_runs (run, state, note, created, request) values (?, ?, ?, ?, ?)', run, 'queued', '', Date.now(), JSON.stringify(request))
    await this.ctx.storage.setAlarm(Date.now())
    return { run, started: true }
  }

  /**
   * Wakes a paused run, for example after an answer or a CI result. With \`afterError\`, also restarts a run that
   * stopped on an error, from its ledger, once the cause is fixed. Only the admin route passes it.
   */
  async resume(options: { afterError?: boolean } = {}): Promise<ResumeResult> {
    const latest = this.ctx.storage.sql.exec<RunRow>('select * from factory_runs order by created desc limit 1').toArray()[0]
    if (!latest) return { reason: 'the PR has no run. Start a run first', resumed: false, state: null }
    const { state } = latest
    let reason = 'woke the paused run'
    if (state === 'error' && options.afterError) {
      const ledger = sqlLedger(this.ctx.storage.sql, latest.run)
      ledger.put('attempts', 0)
      ledger.put('restarts', 0)
      this.setState(latest.run, 'queued', 'resumed after an error')
      reason = 'started the run again from its ledger after the error'
    } else if (state !== 'paused') return { reason: notResumed[state], resumed: false, state }
    await this.ctx.storage.setAlarm(Date.now())
    return { reason, resumed: true, state }
  }

  status() {
    const runs = this.ctx.storage.sql.exec<RunRow>('select run, state, note, created from factory_runs order by created desc').toArray()
    const latest = runs[0]
    return { runs, result: latest ? (sqlLedger(this.ctx.storage.sql, latest.run).get('result') ?? null) : null }
  }

  report(run?: string): string | null {
    const latest = run ?? this.ctx.storage.sql.exec<RunRow>('select run from factory_runs order by created desc limit 1').toArray()[0]?.run
    return latest ? sqlFiles(this.ctx.storage.sql, latest).read('report.md') : null
  }

  override async alarm(): Promise<void> {
    const row = this.active()
    if (!row || this.busy) return
    this.busy = true
    const heartbeat = setInterval(() => void this.ctx.storage.setAlarm(Date.now() + heartbeatMs), heartbeatEveryMs)
    await this.ctx.storage.setAlarm(Date.now() + heartbeatMs)
    const request = JSON.parse(row.request) as StartRequest
    const ledger = progressLedger(sqlLedger(this.ctx.storage.sql, row.run))
    const gh = github(this.env.GITHUB_TOKEN, this.env.GITHUB_API_URL)
    const comments = githubComments(gh, request.owner, request.repo, request.pr)
    let next: number | null = null
    try {
      if (row.state === 'running') {
        // The last invocation died mid-run. Count it, so that a crash that repeats stops instead of looping.
        const restarts = (ledger.get<number>('restarts') ?? 0) + 1
        ledger.put('restarts', restarts)
        if (restarts > maxRestarts) throw new StopError(`the run died ${maxRestarts} times without finishing a step, for example on the memory or CPU limit`)
      }
      this.setState(row.run, 'running', '')
      await once(ledger, 'announced', () =>
        comments.post(`agent-factory started review run \`${row.run}\` for @${request.by}. Questions for you will appear here; answer them with a \`/answer\` comment.`),
      )
      const result = await this.execute(row.run, request, ledger, gh, comments)
      this.setState(row.run, result.pass ? 'passed' : 'failed', '')
      await once(ledger, 'summary', () => comments.post(summary(row.run, result)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof PausedError) {
        ledger.put('attempts', 0)
        this.setState(row.run, 'paused', message)
        next = Date.now() + Number(this.env.PAUSE_POLL_SECONDS ?? defaultPauseSeconds) * 1_000
      } else {
        const attempts = (ledger.get<number>('attempts') ?? 0) + 1
        ledger.put('attempts', attempts)
        console.error(`[${row.run}] attempt ${attempts} failed`, error)
        // A refused credential or permission does not fix itself: stop at once instead of retrying.
        const permanent = error instanceof StopError || (error instanceof GitHubError && (error.status === 401 || error.status === 403))
        if (permanent || attempts >= maxAttempts) {
          this.setState(row.run, 'error', message)
          const hint = error instanceof GitHubError ? ' Check the permissions of GITHUB_TOKEN.' : ''
          await comments
            .post(`agent-factory stopped run \`${row.run}\`: ${message}${hint} After you fix the cause, continue the run from where it stopped with \`npm run remote -- resume ${request.owner}/${request.repo}#${request.pr}\`.`)
            .catch(() => undefined)
        } else {
          this.setState(row.run, 'queued', `attempt ${attempts} failed: ${message}`)
          next = Date.now() + retryMs
        }
      }
    } finally {
      clearInterval(heartbeat)
      this.busy = false
    }
    if (next === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(next)
  }

  private active(): RunRow | undefined {
    return this.ctx.storage.sql
      .exec<RunRow>("select * from factory_runs where state in ('queued', 'running', 'paused') order by created desc limit 1")
      .toArray()[0]
  }

  private setState(run: string, state: State, note: string) {
    this.ctx.storage.sql.exec('update factory_runs set state = ?, note = ? where run = ?', state, note, run)
  }

  private async execute(run: string, request: StartRequest, ledger: Ledger, gh: GitHub, comments: Comments): Promise<LoopResult> {
    const input = ledger.get<LoopInput>('input') ?? (await this.input(run, request, gh))
    const pull = { owner: request.owner, pr: request.pr, repo: request.repo }
    const branch = `factory/${run}`
    const log = (line: string) => console.log(`[${request.owner}/${request.repo}#${request.pr} ${run}] ${line}`)
    const sql = Sql.create(this.ctx.storage)
    const repo = githubRepo({ branch, gh, ledger, log, pull, runId: run, sql })
    const credentials: Credentials = {}
    for (const provider of providersOf(input.models))
      credentials[provider] =
        provider === 'claude' ? apiKeyCredential('claude', this.env.ANTHROPIC_API_KEY, this.env.ANTHROPIC_URL) : apiKeyCredential('codex', this.env.OPENAI_API_KEY, this.env.OPENAI_URL)
    // The config may narrow who answers, never widen it past ALLOWED_USERS.
    const allowed = allowedUsers(this.env).map((login) => login.toLowerCase())
    const answerers = (input.config.answerers ?? allowed).filter((login) => allowed.includes(login.toLowerCase()))
    return codeReviewLoop(input, {
      channel: commentChannel({ answerers, comments, pollMs: 0, waitMs: 0 }),
      checker: ciChecker({ branch, gh, ledger, pull, repo, timeoutMs: Number(this.env.CI_TIMEOUT_MINUTES ?? defaultCiTimeoutMinutes) * 60_000 }),
      credentials,
      files: sqlFiles(this.ctx.storage.sql, run),
      guides: bundledGuides,
      ledger,
      log,
      module,
      repo,
      store: { record: () => {}, scope: (agent) => `${run}/${agent}`, sql },
    })
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
    let text: string
    try {
      text = await (await gh.raw(`${api}/contents/${repoConfigFile}?ref=${encodeURIComponent(view.base.ref)}`, 'application/vnd.github.raw')).text()
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404)
        throw new StopError(`add ${repoConfigFile} to ${view.base.ref} first. The run reads its rails from the base branch, so a PR cannot change its own.`)
      throw error
    }
    const config = parseRepoConfig(text, `${repoConfigFile} on ${view.base.ref}`)
    const overrides = this.env.MODELS ? (JSON.parse(this.env.MODELS) as Partial<LoopModels>) : {}
    return {
      ask: `${view.title}\n\n${view.body ?? ''}`.trim(),
      config: { ...config, guides: {} },
      models: { step1: { ...defaultModels.step1, ...overrides.step1 }, step2: { ...defaultModels.step2, ...overrides.step2 } },
      pr: request.pr,
      runId: run,
      source: `${request.owner}/${request.repo}#${request.pr}`,
      ...(request.ship ? { ship: { headRef: view.head.ref, pr: request.pr } } : {}),
    }
  }
}

/** A finished step is progress: it clears the counts of failed attempts and restarts. */
function progressLedger(ledger: Ledger): Ledger {
  return {
    get: (key) => ledger.get(key),
    put(key, value) {
      ledger.put(key, value)
      if (key.startsWith('step:')) {
        ledger.put('attempts', 0)
        ledger.put('restarts', 0)
      }
    },
  }
}

/** Runs `post` one time per run, even when the run resumes. */
async function once(ledger: Ledger, key: string, post: () => Promise<unknown>): Promise<void> {
  if (ledger.get(`posted:${key}`)) return
  await post()
  ledger.put(`posted:${key}`, true)
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
