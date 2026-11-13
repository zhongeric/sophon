/** The GitHub REST and GraphQL calls that the Cloudflare host makes, signed with one token. */
export type GitHub = {
  json<T>(method: string, path: string, body?: unknown): Promise<T>
  raw(path: string, accept: string): Promise<Response>
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>
}

export class GitHubError extends Error {
  override name = 'GitHubError'
  readonly status: number
  /** True when GitHub refused the call because of a rate limit, not because of the credential. */
  readonly rateLimited: boolean
  constructor(status: number, message: string, rateLimited = false) {
    super(message)
    this.status = status
    this.rateLimited = rateLimited
  }
}

/** True for a refused token or a missing permission. These do not fix themselves, but a rate limit does. */
export function refusedCredential(error: unknown): boolean {
  return error instanceof GitHubError && !error.rateLimited && (error.status === 401 || error.status === 403)
}

/** The maximum number of tries for one call: 1 try plus 2 retries. */
const maxTries = 3
/** The wait before the first retry. Each subsequent retry waits two times longer. */
const backoffMs = 1_000
/** A rate-limit wait longer than this is left to the run loop. */
const maxRateLimitWaitMs = 60_000
/** The server errors that the client retries. Other 5xx answers fail at once. */
const transientStatuses = new Set([500, 502, 503, 504])
/** The Git Data object writes. A repeated write makes no duplicate, so the client retries them. */
const gitObjectPath = /\/git\/(blobs|trees|commits|refs)(\/|$)/

export type GitHubOptions = {
  /** Waits between tries. Tests replace it so that they do not wait in real time. */
  sleep?: (ms: number) => Promise<void>
}

const backoff = (tryNumber: number) => backoffMs * 2 ** (tryNumber - 1)

/** The wait in milliseconds that a rate-limit answer asks for, or undefined when the answer is not a rate limit. */
function rateLimitWait(response: Response, tryNumber: number): number | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined
  const retryAfter = response.headers.get('retry-after')
  const exhausted = response.headers.get('x-ratelimit-remaining') === '0'
  if (retryAfter === null && !exhausted) return undefined
  const seconds = Number(retryAfter)
  if (retryAfter !== null && retryAfter.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const reset = response.headers.get('x-ratelimit-reset')
  const resetSeconds = Number(reset)
  if (exhausted && reset !== null && reset.trim() !== '' && Number.isFinite(resetSeconds)) return Math.max(0, resetSeconds * 1_000 - Date.now())
  return backoff(tryNumber)
}

export function github(token: string, api = 'https://api.github.com', fetcher: typeof fetch = fetch, options: GitHubOptions = {}): GitHub {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const headers = (accept: string) => ({
    accept,
    authorization: `Bearer ${token}`,
    'user-agent': 'agent-factory',
    'x-github-api-version': '2022-11-28',
  })
  const send = async (method: string, path: string, accept: string, body?: unknown): Promise<Response> => {
    // A comment POST or the GraphQL POST can take effect before a 5xx or a network error, so a retry can duplicate it.
    const repeatable = method === 'GET' || method === 'PATCH' || (method === 'POST' && gitObjectPath.test(path))
    for (let tryNumber = 1; ; tryNumber++) {
      const last = tryNumber >= maxTries
      let response: Response
      try {
        response = await fetcher(`${api}${path}`, {
          body: body === undefined ? undefined : JSON.stringify(body),
          headers: { ...headers(accept), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          method,
        })
      } catch (error) {
        if (!repeatable || last) throw error
        await sleep(backoff(tryNumber))
        continue
      }
      if (response.ok) return response
      const wait = rateLimitWait(response, tryNumber)
      const rateLimited = wait !== undefined
      const transient = rateLimited ? wait <= maxRateLimitWaitMs : repeatable && transientStatuses.has(response.status)
      if (!transient || last)
        throw new GitHubError(response.status, `GitHub ${method} ${path} answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`, rateLimited)
      await response.body?.cancel()
      await sleep(wait ?? backoff(tryNumber))
    }
  }
  return {
    json: async <T>(method: string, path: string, body?: unknown) => (await (await send(method, path, 'application/vnd.github+json', body)).json()) as T,
    raw: (path, accept) => send('GET', path, accept),
    async graphql<T>(query: string, variables: Record<string, unknown>) {
      const result = (await (await send('POST', '/graphql', 'application/vnd.github+json', { query, variables })).json()) as { data?: T; errors?: unknown }
      if (result.errors) throw new GitHubError(200, `GitHub GraphQL: ${JSON.stringify(result.errors).slice(0, 300)}`)
      return result.data as T
    },
  }
}

/** Checks a webhook delivery against its X-Hub-Signature-256 header. */
export async function verifySignature(secret: string, body: string, signature: string | null): Promise<boolean> {
  if (!signature?.startsWith('sha256=')) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { hash: 'SHA-256', name: 'HMAC' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  return sameSecret(signature, `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`)
}

/** Compares a presented secret with the expected one in time that does not depend on where they differ. */
export function sameSecret(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ presented.charCodeAt(index)
  return difference === 0
}
