import { DurableObject } from 'cloudflare:workers'
import type { Ledger } from '../core/ledger.ts'
import { callBudget, PlannedStop } from '../core/planned-stop.ts'
import { apiKeyCredential, type Credentials, type Provider } from '../core/providers.ts'
import type { Comments } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { afterError, alarmBudgetMs, countRestart, initCounters, progressLedger } from './alarm.ts'
import { containerBox, httpBox, type Box, type SyncStore } from './box.ts'
import { githubComments } from './comments.ts'
import type { WorkerSetting } from './egress.ts'
import type { DevelopmentRuns } from './develop.ts'
import { GitHubError, type GitHub } from './github.ts'
import { githubAccess, type InstallationTokens } from './github-app.ts'
import type { State } from './prune.ts'
import type { ResearchRuns } from './research.ts'
import type { PullRequestRuns } from './run.ts'
import { createTables, sqlFiles, sqlLedger } from './storage.ts'

export type Env = {
  PULL_REQUESTS: DurableObjectNamespace<PullRequestRuns>
  DEVELOPMENT_RUNS: DurableObjectNamespace<DevelopmentRuns>
  RESEARCH_RUNS: DurableObjectNamespace<ResearchRuns>
  /** The token of the runs when the GitHub App secrets are not set. */
  GITHUB_TOKEN?: string
  /** With GITHUB_APP_PRIVATE_KEY, runs call GitHub as the App. */
  GITHUB_APP_ID?: string
  /** The private key of the App, in PKCS#8 PEM. */
  GITHUB_APP_PRIVATE_KEY?: string
  /** The secret of the webhook of each repository. GITHUB_APP_WEBHOOK_SECRET replaces it when set. */
  GITHUB_WEBHOOK_SECRET?: string
  /** The secret of the App webhook. */
  GITHUB_APP_WEBHOOK_SECRET?: string
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
  /** GitHub logins, comma-separated, that can start runs and answer questions. Without it, no one can. */
  ALLOWED_USERS?: string
  /** Model IDs, comma-separated, that runs accept. Default: defaultAllowedModels. */
  ALLOWED_MODELS?: string
  /** Bearer token for the status and report routes. */
  ADMIN_TOKEN?: string
  /** JSON that overrides the default models per step and role, and per development role under "develop". */
  MODELS?: string
  /** JSON with the USD per million tokens of each model ID, for the Usage section and the cost budget. See README.md. */
  MODEL_PRICES?: string
  CI_TIMEOUT_MINUTES?: string
  PAUSE_POLL_SECONDS?: string
  /** The wall time in seconds of one alarm call before the run stops at a safe point and continues in the next call. Default: 480. */
  ALARM_BUDGET_SECONDS?: string
  /** Endpoint overrides, for gateways and for local tests. */
  GITHUB_API_URL?: string
  ANTHROPIC_URL?: string
  OPENAI_URL?: string
  /** A machine endpoint that replaces the development run's container, for local tests. */
  MACHINE_URL?: string
  /** An endpoint that gets each request that the research egress approved, as /<host><path>, for local tests. */
  EGRESS_URL?: string
}

/** The keys that are in only one of Env and workerSettings. The Worker typecheck fails on the line below when there is one. */
type SettingGap = Exclude<keyof Env, WorkerSetting> | Exclude<WorkerSetting, keyof Env>
export const sameSettings: [SettingGap] extends [never] ? true : SettingGap = true

export type RunRow = { run: string; state: State; note: string; created: number; request: string }
/** The result of `resume`: `state` is the state of the latest run before the call, or null when there is no run. */
export type ResumeResult = { resumed: boolean; state: State | null; reason: string }

/** Why `resume` does not wake the latest run, for each state that it does not wake. */
const notResumed: Record<Exclude<State, 'paused'>, string> = {
  error: 'the run stopped on an error. Only the admin route starts it again: use npm run remote -- resume',
  failed: 'the run is complete with FAIL. Start a new run to try again',
  passed: 'the run is complete with PASS. Start a new run to try again',
  queued: 'the run is queued and starts on its next alarm',
  running: 'the run is running now',
}
/** What starts a run, and who started it. */
export type RunRequest = { owner: string; repo: string; by: string }

/** While a run works, its alarm stays this far ahead, so that a run whose isolate died restarts from its ledger. */
const heartbeatMs = 60_000
const heartbeatEveryMs = 20_000
/** How long CI can take, when CI_TIMEOUT_MINUTES does not say. */
export const defaultCiTimeoutMinutes = 30
/**
 * The container stops after this long without a command. A stopped container comes back empty. Its start clears
 * the sync state in SQL, so the next sync copies the trees again.
 */
const containerIdleMs = 30 * 60_000
export const setupTimeoutMs = 20 * 60_000

export function allowedUsers(env: Env): string[] {
  return (env.ALLOWED_USERS ?? '')
    .split(',')
    .map((login) => login.trim())
    .filter(Boolean)
}

/** The answerers of a run: the config can limit who answers, but cannot permit users outside ALLOWED_USERS. */
export function answerersOf(env: Env, configured: string[] | undefined): string[] {
  const allowed = allowedUsers(env).map((login) => login.toLowerCase())
  return (configured ?? allowed).filter((login) => allowed.includes(login.toLowerCase()))
}

export function credentialsFor(env: Env, providers: Iterable<Provider>): Credentials {
  const credentials: Credentials = {}
  for (const provider of providers)
    credentials[provider] = provider === 'claude' ? apiKeyCredential('claude', env.ANTHROPIC_API_KEY, env.ANTHROPIC_URL) : apiKeyCredential('codex', env.OPENAI_API_KEY, env.OPENAI_URL)
  return credentials
}

/**
 * The runs of one PR or issue. The run's ledger, its repository trees and every agent session live in this
 * object's SQLite. Alarms drive the run: a heartbeat restarts a run that died, a pause re-checks its answers
 * or CI, and webhooks wake it early.
 */
export abstract class Runs<Request extends RunRequest> extends DurableObject<Env> {
  busy = false
  tokens: InstallationTokens = new Map()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    createTables(ctx.storage.sql)
  }

  /** The number of the PR or issue whose comments carry the run's questions and results. */
  protected abstract number(request: Request): number
  protected abstract runName(request: Request, stamp: string): string
  protected abstract announcement(run: string, request: Request): string
  /** Runs the work, or resumes it from the ledger. Returns whether it passed, and the comment for the end of the run. */
  protected abstract execute(run: string, request: Request, ledger: Ledger, gh: GitHub, comments: Comments): Promise<{ passed: boolean; summary: string }>

  async start(request: Request): Promise<{ run: string; started: boolean }> {
    const active = this.active()
    if (active) return { run: active.run, started: false }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const run = this.runName(request, stamp)
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
    if (!latest) return { reason: 'there is no run. Start a run first', resumed: false, state: null }
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

  /** The state and the ship flag of a run, for the prune of its branches, or null when this object has no such run. */
  runState(run: string): { state: State; ship: boolean } | null {
    const row = this.row(run)
    if (!row) return null
    const request = JSON.parse(row.request) as { ship?: unknown }
    return { ship: request.ship === true, state: row.state }
  }

  report(run?: string): string | null {
    const latest = run ?? this.ctx.storage.sql.exec<RunRow>('select run from factory_runs order by created desc limit 1').toArray()[0]?.run
    return latest ? sqlFiles(this.ctx.storage.sql, latest).read('report.md') : null
  }

  override async alarm(): Promise<void> {
    const startedAt = Date.now()
    const row = this.active()
    if (!row || this.busy) return
    this.busy = true
    const heartbeat = setInterval(() => void this.ctx.storage.setAlarm(Date.now() + heartbeatMs), heartbeatEveryMs)
    await this.ctx.storage.setAlarm(Date.now() + heartbeatMs)
    const request = JSON.parse(row.request) as Request
    const ledger = callBudget(progressLedger(sqlLedger(this.ctx.storage.sql, row.run)), { budgetMs: alarmBudgetMs(this.env.ALARM_BUDGET_SECONDS), startedAt })
    const target = `${request.owner}/${request.repo}#${this.number(request)}`
    // Without a client, the run cannot post: a failed GitHub setup goes only to the state note.
    let comments: Comments | undefined
    let app = false
    let next: number | null = null
    try {
      const access = await githubAccess(this.env, request.owner, request.repo, this.tokens)
      app = access.app
      const posts = githubComments(access.gh, request.owner, request.repo, this.number(request))
      comments = posts
      initCounters(ledger)
      if (row.state === 'running') countRestart(ledger)
      this.setState(row.run, 'running', '')
      await once(ledger, 'announced', () => posts.post(this.announcement(row.run, request)))
      const result = await this.execute(row.run, request, ledger, access.gh, posts)
      this.setState(row.run, result.passed ? 'passed' : 'failed', '')
      await once(ledger, 'summary', () => posts.post(result.summary))
    } catch (error) {
      const outcome = afterError(ledger, error, { now: Date.now(), pauseSeconds: this.env.PAUSE_POLL_SECONDS })
      if (error instanceof PlannedStop) console.log(`[${row.run}] planned stop after ${Math.round((Date.now() - startedAt) / 1_000)} s of wall time`)
      if (outcome.attempts !== null) console.error(`[${row.run}] attempt ${outcome.attempts} failed`, error)
      this.setState(row.run, outcome.state, outcome.note)
      next = outcome.next
      if (outcome.state === 'error') {
        const hint = error instanceof GitHubError ? (app ? ' Check the permissions of the GitHub App.' : ' Check the permissions of GITHUB_TOKEN.') : ''
        await comments
          ?.post(`agent-factory stopped run \`${row.run}\`: ${outcome.note}${hint} After you fix the cause, continue the run from where it stopped with \`npm run remote -- resume ${target}\`.`)
          .catch(() => undefined)
      }
    } finally {
      clearInterval(heartbeat)
      this.busy = false
    }
    if (next === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(next)
  }

  /** The machine of the run's commands: the MACHINE_URL endpoint, else the object's Cloudflare Container. */
  protected box(syncs: SyncStore): Box {
    if (this.env.MACHINE_URL) return httpBox(this.env.MACHINE_URL)
    if (!this.ctx.container) throw new StopError('this Worker has no container for builds: add the containers section of wrangler.jsonc and deploy again')
    return containerBox(this.ctx.container, { inactivityMs: containerIdleMs, onStart: () => syncs.clear() })
  }

  protected active(): RunRow | undefined {
    return this.ctx.storage.sql
      .exec<RunRow>("select * from factory_runs where state in ('queued', 'running', 'paused') order by created desc limit 1")
      .toArray()[0]
  }

  protected row(run: string): RunRow | undefined {
    return this.ctx.storage.sql.exec<RunRow>('select * from factory_runs where run = ?', run).toArray()[0]
  }

  protected setState(run: string, state: State, note: string) {
    this.ctx.storage.sql.exec('update factory_runs set state = ?, note = ? where run = ?', state, note, run)
  }
}

/** Runs `post` one time per run, even when the run resumes. */
async function once(ledger: Ledger, key: string, post: () => Promise<unknown>): Promise<void> {
  if (ledger.get(`posted:${key}`)) return
  await post()
  ledger.put(`posted:${key}`, true)
}
