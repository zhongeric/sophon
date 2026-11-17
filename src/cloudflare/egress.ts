import type { ResearchCredential } from '../core/research.ts'
import { hostSecrets } from '../core/secrets.ts'
import { StopError } from '../core/stop.ts'

/**
 * Every setting that Env in runs.ts declares: bindings, vars and secrets. A notebook credential cannot name one of
 * them. runs.ts fails the Worker typecheck when a key of Env is not in this list. This file does not import runs.ts,
 * so that the Node tests typecheck it without Worker types.
 */
export const workerSettings = [
  'PULL_REQUESTS',
  'DEVELOPMENT_RUNS',
  'RESEARCH_RUNS',
  'GITHUB_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_WEBHOOK_SECRET',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'ALLOWED_USERS',
  'ALLOWED_MODELS',
  'ADMIN_TOKEN',
  'MODELS',
  'MODEL_PRICES',
  'CI_TIMEOUT_MINUTES',
  'PAUSE_POLL_SECONDS',
  'ALARM_BUDGET_SECONDS',
  'GITHUB_API_URL',
  'ANTHROPIC_URL',
  'OPENAI_URL',
  'MACHINE_URL',
  'EGRESS_URL',
] as const

export type WorkerSetting = (typeof workerSettings)[number]

const settings: readonly string[] = workerSettings

const refusedSecret = (name: string) => hostSecrets.includes(name) || settings.includes(name)

/**
 * Stops the run when a research credential names a host secret or a Worker setting. The message names the host and
 * the secret, never a value.
 */
export function checkWorkerCredentials(credentials: Record<string, ResearchCredential> | undefined): void {
  for (const [host, { secret }] of Object.entries(credentials ?? {})) {
    if (!refusedSecret(secret)) continue
    const kind = hostSecrets.includes(secret) ? 'a host secret' : 'a setting of the Worker'
    throw new StopError(
      `research.credentials of ${host} names ${secret}, which is ${kind}. Name a Worker secret that you set with \`npx wrangler secret put <NAME>\`.`,
    )
  }
}

/** The secret reader of the Worker egress: a non-empty string of the env, else undefined. It refuses host secrets and Worker settings. */
export function workerSecret(env: unknown): (name: string) => string | undefined {
  return (name) => {
    if (refusedSecret(name) || typeof env !== 'object' || env === null || !Object.hasOwn(env, name)) return undefined
    const value: unknown = Reflect.get(env, name)
    return typeof value === 'string' && value !== '' ? value : undefined
  }
}

/**
 * For local tests only: sends each request that the egress approved to `${base}/<hostname><path><query>`, with the
 * same method, headers, body and redirect mode.
 */
export function egressUrlFetch(base: string, send: typeof fetch = fetch): typeof fetch {
  const root = base.replace(/\/+$/, '')
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const body = request.body === null ? undefined : await request.arrayBuffer()
    return send(`${root}/${url.hostname}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body, redirect: request.redirect, signal: request.signal })
  }
}
