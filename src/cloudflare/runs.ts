import { DurableObject } from 'cloudflare:workers'
import type { Ledger } from '../core/ledger.ts'
import { callBudget, PlannedStop } from '../core/planned-stop.ts'
import { apiKeyCredential, type Credentials, type Provider } from '../core/providers.ts'
import type { Comments } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { afterError, alarmBudgetMs, countRestart, initCounters, progressLedger, restartAtKey } from './alarm.ts'
import { containerBox, httpBox, type Box, type SyncStore } from './box.ts'
import { githubComments } from './comments.ts'
import type { WorkerSetting } from './egress.ts'
import type { DevelopmentRuns } from './develop.ts'
import { GitHubError, type GitHub } from './github.ts'
import { githubAccess, type InstallationTokens } from './github-app.ts'
import { hasOpenJobs, jobRunner, resetJobStarts, type JobRunner } from './jobs.ts'
import { addLabel } from './labels.ts'
import type { State } from './prune.ts'
import type { ResearchRuns } from './research.ts'
import type { PullRequestRuns } from './run.ts'
import type { ScanBoxes } from './scan.ts'
import { createTables, sqlFiles, sqlLedger } from './storage.ts'
import { sqlSyncs } from './syncs.ts'

export type Env = {
  PULL_REQUESTS: DurableObjectNamespace<PullRequestRuns>
  DEVELOPMENT_RUNS: DurableObjectNamespace<DevelopmentRuns>
  RESEARCH_RUNS: DurableObjectNamespace<ResearchRuns>
  SCAN_BOXES: DurableObjectNamespace<ScanBoxes>
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
  /** The wall time in seconds that one alarm call plans for. A turn starts only when it fits, and its commands end by then. Default: 780. */
  ALARM_BUDGET_SECONDS?: string
  /** Endpoint overrides, for gateways and for local tests. */
  GITHUB_API_URL?: string
  ANTHROPIC_URL?: string
  OPENAI_URL?: string
  /** A machine endpoint that replaces the build container of the runs, for local tests. */
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

/** The build machine of a run, the sync state of its directories, and the jobs of the run on it. */
export type RunMachine = { box: Box; syncs: SyncStore; jobs: JobRunner }

/** What one alarm call gives to execute(). */
export type Call = {
  /** The end of the call budget. A host step that waits for a job pauses the run at this time. */
  deadline: number
  /**
   * The machine of the run. Its first use in an alarm call kills the wait-mode jobs of earlier calls, so that no job of
   * a turn that did not finish runs when the turn runs again.
   */
  machine(): Promise<RunMachine>
}

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
  /** The work label of this kind of run. The run adds it to its issue or PR at its start. */
  protected abstract readonly label: string
  protected abstract runName(request: Request, stamp: string): string
  protected abstract announcement(run: string, request: Request): string
  /** Runs the work, or resumes it from the ledger. Returns whether it passed, and the comment for the end of the run. */
  protected abstract execute(run: string, request: Request, ledger: Ledger, gh: GitHub, comments: Comments, call: Call): Promise<{ passed: boolean; summary: string }>

  /** The build machine of this object: MACHINE_URL in local tests, else the object's Cloudflare Container. */
  protected box(syncs: SyncStore): Box {
    if (this.env.MACHINE_URL) return httpBox(this.env.MACHINE_URL)
    if (!this.ctx.container) throw new StopError('this Worker has no container for builds: add the containers section of wrangler.jsonc and deploy again')
    return containerBox(this.ctx.container, { inactivityMs: containerIdleMs, onStart: () => syncs.clear() })
  }

  /**
   * Starts a run unless one is active. With `once`, also refuses when this object has a run in any state: the work
   * sweep never starts a run again (D13 restarts runs). The check and the insert are in one call, so no start comes between.
   */
  async start(request: Request, options: { once?: boolean } = {}): Promise<{ run: string; started: boolean }> {
    const active = options.once ? this.ctx.storage.sql.exec<RunRow>('select * from factory_runs order by created desc limit 1').toArray()[0] : this.active()
    if (active) return { run: active.run, started: false }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const run = this.runName(request, stamp)
    this.ctx.storage.sql.exec('insert into factory_runs (run, state, note, created, request) values (?, ?, ?, ?, ?)', run, 'queued', '', Date.now(), JSON.stringify(request))
    await this.ctx.storage.setAlarm(Date.now())
    return { run, started: true }
  }

  /**
   * Wakes a paused run, for example after an answer or a CI result. With \`afterError\`, also restarts a run that
   * stopped on an error, from its ledger, once the cause is fixed, or a run that waits for its restart (D13). Only the
   * admin route passes it.
   */
  async resume(options: { afterError?: boolean } = {}): Promise<ResumeResult> {
    const latest = this.ctx.storage.sql.exec<RunRow>('select * from factory_runs order by created desc limit 1').toArray()[0]
    if (!latest) return { reason: 'there is no run. Start a run first', resumed: false, state: null }
    const { state } = latest
    const ledger = sqlLedger(this.ctx.storage.sql, latest.run)
    let reason = 'woke the paused run'
    if (state === 'queued' && options.afterError && (ledger.get<number>(restartAtKey) ?? 0) > Date.now()) {
      reason = 'started the run again from its ledger after the error'
    } else if (state === 'error' && options.afterError) {
      ledger.put('attempts', 0)
      ledger.put('restarts', 0)
      resetJobStarts(ledger)
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
    const budgetMs = alarmBudgetMs(this.env.ALARM_BUDGET_SECONDS)
    const ledger = callBudget(progressLedger(sqlLedger(this.ctx.storage.sql, row.run)), { budgetMs, startedAt })
    const call = this.call(row.run, ledger, startedAt + budgetMs)
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
      // The ledger records the attempt also when it failed, so that a failed add does not repeat at each alarm.
      const log = (error: unknown) => console.error(`[${row.run}] the add of the label ${this.label} failed`, error)
      await once(ledger, 'label', () => addLabel({ gh: access.gh, log, name: this.label, number: this.number(request), owner: request.owner, repo: request.repo }))
      await once(ledger, 'announced', () => posts.post(this.announcement(row.run, request)))
      const result = await this.execute(row.run, request, ledger, access.gh, posts, call)
      this.setState(row.run, result.passed ? 'passed' : 'failed', '')
      await this.killJobs(row.run, ledger, call)
      await once(ledger, 'summary', () => posts.post(result.summary))
    } catch (error) {
      const outcome = afterError(ledger, error, { now: Date.now(), pauseSeconds: this.env.PAUSE_POLL_SECONDS })
      if (error instanceof PlannedStop) console.log(`[${row.run}] planned stop after ${Math.round((Date.now() - startedAt) / 1_000)} s of wall time`)
      if (outcome.attempts !== null) console.error(`[${row.run}] attempt ${outcome.attempts} failed`, error)
      this.setState(row.run, outcome.state, outcome.note)
      next = outcome.next
      if (outcome.state === 'error' || outcome.restart !== null) {
        await this.killJobs(row.run, ledger, call)
        const hint = error instanceof GitHubError ? (app ? ' Check the permissions of the GitHub App.' : ' Check the permissions of GITHUB_TOKEN.') : ''
        // A run that starts again by itself needs nothing from the user (D13).
        const ask = outcome.restart !== null ? '' : `${hint} After you fix the cause, continue the run from where it stopped with \`npm run remote -- resume ${target}\`.`
        await comments?.post(`agent-factory stopped run \`${row.run}\`: ${sentence(outcome.note)}${ask}`).catch(() => undefined)
      }
    } finally {
      clearInterval(heartbeat)
      this.busy = false
    }
    if (next === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(next)
  }

  /** The call of a run: the machine and its job runner start on the first use, because a run without a box has no machine. */
  private call(run: string, ledger: Ledger, deadline: number): Call {
    let machine: Promise<RunMachine> | undefined
    const start = async (): Promise<RunMachine> => {
      const syncs = sqlSyncs(this.ctx.storage.sql, run)
      const box = this.box(syncs)
      const jobs = jobRunner(box, ledger, { deadline })
      await jobs.killStale()
      return { box, jobs, syncs }
    }
    return {
      deadline,
      machine: () => (machine ??= start()),
    }
  }

  /** Kills the open jobs of a run that ended. The run result stays when the kill fails, because a job ends at its timeout. */
  private async killJobs(run: string, ledger: Ledger, call: Call): Promise<void> {
    if (!hasOpenJobs(ledger)) return
    try {
      await (await call.machine()).jobs.killAll()
    } catch (error) {
      console.error(`[${run}] the kill of the open jobs failed`, error)
    }
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

/** The text with a full stop at its end. */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`)

/** Runs `post` one time per run, even when the run resumes. */
async function once(ledger: Ledger, key: string, post: () => Promise<unknown>): Promise<void> {
  if (ledger.get(`posted:${key}`)) return
  await post()
  ledger.put(`posted:${key}`, true)
}
