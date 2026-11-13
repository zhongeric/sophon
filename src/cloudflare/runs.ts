import { DurableObject } from 'cloudflare:workers'
import type { Ledger } from '../core/ledger.ts'
import { apiKeyCredential, type Credentials, type Provider } from '../core/providers.ts'
import { PausedError, type Comments } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { githubComments } from './comments.ts'
import type { DevelopmentRuns } from './develop.ts'
import { github, GitHubError, refusedCredential, type GitHub } from './github.ts'
import type { PullRequestRuns } from './run.ts'
import { createTables, sqlFiles, sqlLedger } from './storage.ts'

export type Env = {
  PULL_REQUESTS: DurableObjectNamespace<PullRequestRuns>
  DEVELOPMENT_RUNS: DurableObjectNamespace<DevelopmentRuns>
  GITHUB_TOKEN: string
  GITHUB_WEBHOOK_SECRET: string
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
  CI_TIMEOUT_MINUTES?: string
  PAUSE_POLL_SECONDS?: string
  /** Endpoint overrides, for gateways and for local tests. */
  GITHUB_API_URL?: string
  ANTHROPIC_URL?: string
  OPENAI_URL?: string
  /** A machine endpoint that replaces the development run's container, for local tests. */
  MACHINE_URL?: string
}

export type State = 'queued' | 'running' | 'paused' | 'passed' | 'failed' | 'error'
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
const maxAttempts = 3
/** Restarts of a run whose isolate died with no finished step in between, before the run stops. */
const maxRestarts = 5
const retryMs = 60_000
const defaultPauseSeconds = 60
/** How long CI can take, when CI_TIMEOUT_MINUTES does not say. */
export const defaultCiTimeoutMinutes = 30

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
    const request = JSON.parse(row.request) as Request
    const ledger = progressLedger(sqlLedger(this.ctx.storage.sql, row.run))
    const gh = github(this.env.GITHUB_TOKEN, this.env.GITHUB_API_URL)
    const target = `${request.owner}/${request.repo}#${this.number(request)}`
    const comments = githubComments(gh, request.owner, request.repo, this.number(request))
    let next: number | null = null
    try {
      if (row.state === 'running') {
        // The last invocation died mid-run. Count it, so that a crash that repeats stops instead of looping.
        const restarts = (ledger.get<number>('restarts') ?? 0) + 1
        ledger.put('restarts', restarts)
        if (restarts > maxRestarts) throw new StopError(`the run died ${maxRestarts} times without finishing a step, for example on the memory or CPU limit`)
      }
      this.setState(row.run, 'running', '')
      await once(ledger, 'announced', () => comments.post(this.announcement(row.run, request)))
      const result = await this.execute(row.run, request, ledger, gh, comments)
      this.setState(row.run, result.passed ? 'passed' : 'failed', '')
      await once(ledger, 'summary', () => comments.post(result.summary))
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
        const permanent = error instanceof StopError || refusedCredential(error)
        if (permanent || attempts >= maxAttempts) {
          this.setState(row.run, 'error', message)
          const hint = error instanceof GitHubError ? ' Check the permissions of GITHUB_TOKEN.' : ''
          await comments
            .post(`agent-factory stopped run \`${row.run}\`: ${message}${hint} After you fix the cause, continue the run from where it stopped with \`npm run remote -- resume ${target}\`.`)
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
