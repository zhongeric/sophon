import { systemClock } from '../core/clock.ts'
import { StopError } from '../core/stop.ts'
import { github, GitHubError, type GitHub } from './github.ts'

/** The secrets that select the GitHub credential of a run. The Env of runs.ts is assignable to this type. */
export type GitHubSecrets = { GITHUB_TOKEN?: string; GITHUB_APP_ID?: string; GITHUB_APP_PRIVATE_KEY?: string; GITHUB_API_URL?: string }

/** The installation tokens of the App, keyed by installation ID. Keep it in memory only, never in storage. */
export type InstallationTokens = Map<number, { token: string; expiresAt: number }>

/** The login of the App bot, keyed by App ID. Keep it in memory only, never in storage. */
export type BotLogins = Map<string, string>

type AccessOptions = {
  /** The clock in milliseconds. Tests replace it to make a token expire. */
  now?: () => number
  /** Waits between the tries of a request. */
  sleep?: (ms: number) => Promise<void>
}

/** The client gets a new installation token when this time or less remains before the token expires. */
const refreshMs = 5 * 60_000

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const encoded = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)))

async function importKey(pem: string): Promise<CryptoKey> {
  try {
    const der = Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')), (char) => char.charCodeAt(0))
    return await crypto.subtle.importKey('pkcs8', der, { hash: 'SHA-256', name: 'RSASSA-PKCS1-v1_5' }, false, ['sign'])
  } catch {
    throw new StopError('GITHUB_APP_PRIVATE_KEY is not an RSA key in PKCS#8 PEM. Convert it with openssl pkcs8 -topk8 -nocrypt.')
  }
}

/** The JWT (RS256) of the App itself. GitHub accepts it for at most 10 minutes. iat is 60 seconds in the past because clocks drift. */
export async function appJwt(appId: string, pem: string, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1_000) - 60
  const unsigned = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ exp: iat + 600, iat, iss: appId })}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await importKey(pem), new TextEncoder().encode(unsigned))
  return `${unsigned}.${base64url(new Uint8Array(signature))}`
}

/** The slug of the App from GET /app. The client must use the App JWT. */
async function appSlug(app: GitHub): Promise<string> {
  const { slug } = await app.json<{ slug?: unknown }>('GET', '/app')
  if (typeof slug !== 'string') throw new Error('GitHub gave no slug for the App')
  return slug
}

/**
 * The login of the App bot, `<slug>[bot]`, from GET /app. Without GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY, it gives
 * undefined and sends no request. The cache keeps only a login that GitHub gave.
 */
export async function appBotLogin(secrets: GitHubSecrets, cache: BotLogins): Promise<string | undefined> {
  const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: pem } = secrets
  if (!appId || !pem) return undefined
  const cached = cache.get(appId)
  if (cached) return cached
  const app = github(() => appJwt(appId, pem, Date.now()), secrets.GITHUB_API_URL ?? 'https://api.github.com')
  const login = `${await appSlug(app)}[bot]`
  cache.set(appId, login)
  return login
}

/**
 * The GitHub client of a run on owner/repo. With GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, it uses installation tokens
 * of the App from the cache, also when GITHUB_TOKEN is set. Else it uses GITHUB_TOKEN. A configuration error or a
 * repository without the App throws StopError. Other failures stay GitHubError.
 */
export async function githubAccess(
  secrets: GitHubSecrets,
  owner: string,
  repo: string,
  cache: InstallationTokens,
  options: AccessOptions = {},
): Promise<{ gh: GitHub; app: boolean }> {
  const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: pem } = secrets
  if (!appId && !pem) {
    if (!secrets.GITHUB_TOKEN) throw new StopError('GITHUB_TOKEN is not set: set it, or set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY to use the GitHub App')
    return { app: false, gh: github(secrets.GITHUB_TOKEN, secrets.GITHUB_API_URL ?? 'https://api.github.com', fetch, options) }
  }
  const { app, installation } = githubApp(secrets, cache, options)
  let id: number
  try {
    const found = await app.json<{ id?: unknown }>('GET', `/repos/${owner}/${repo}/installation`)
    if (typeof found.id !== 'number') throw new Error(`GitHub gave no installation ID for ${owner}/${repo}`)
    id = found.id
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) throw error
    throw new StopError(`the GitHub App is not installed on ${owner}/${repo}. Install it: https://github.com/apps/${await appSlug(app)}/installations/new`)
  }
  return { app: true, gh: installation(id, `${owner}/${repo}`) }
}

/**
 * The client of the App with its JWT, and the client of an installation with installation tokens from the cache. A
 * missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY throws StopError before any request.
 */
export function githubApp(
  secrets: GitHubSecrets,
  cache: InstallationTokens,
  options: AccessOptions = {},
): { app: GitHub; installation: (id: number, name?: string) => GitHub } {
  const api = secrets.GITHUB_API_URL ?? 'https://api.github.com'
  const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: pem } = secrets
  if (!appId || !pem) {
    const [missing, set] = appId ? ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_ID'] : ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY']
    throw new StopError(`${missing} is not set: the GitHub App needs it together with ${set}`)
  }
  const now = options.now ?? systemClock.now
  const app = github(() => appJwt(appId, pem, now()), api, fetch, options)
  /** `name` names the installation in errors, for example its repository. */
  const installation = (id: number, name = `installation ${id}`) => {
    const create = async () => {
      const created = await app.json<{ token?: unknown; expires_at?: unknown }>('POST', `/app/installations/${id}/access_tokens`)
      const expiresAt = typeof created.expires_at === 'string' ? Date.parse(created.expires_at) : NaN
      if (typeof created.token !== 'string' || !Number.isFinite(expiresAt)) throw new Error(`GitHub gave no installation token for ${name}`)
      cache.set(id, { expiresAt, token: created.token })
      return created.token
    }
    // Requests at the same time get one installation token.
    let pending: Promise<string> | undefined
    const token = () => {
      const cached = cache.get(id)
      if (cached && cached.expiresAt - now() > refreshMs) return Promise.resolve(cached.token)
      pending ??= create().finally(() => { pending = undefined })
      return pending
    }
    return github(token, api, fetch, options)
  }
  return { app, installation }
}
