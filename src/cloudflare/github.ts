/** The GitHub REST and GraphQL calls that the Cloudflare host makes, signed with one token. */
export type GitHub = {
  json<T>(method: string, path: string, body?: unknown): Promise<T>
  raw(path: string, accept: string): Promise<Response>
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>
}

export class GitHubError extends Error {
  override name = 'GitHubError'
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function github(token: string, api = 'https://api.github.com', fetcher: typeof fetch = fetch): GitHub {
  const headers = (accept: string) => ({
    accept,
    authorization: `Bearer ${token}`,
    'user-agent': 'agent-factory',
    'x-github-api-version': '2022-11-28',
  })
  const send = async (method: string, path: string, accept: string, body?: unknown) => {
    const response = await fetcher(`${api}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...headers(accept), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      method,
    })
    if (!response.ok) throw new GitHubError(response.status, `GitHub ${method} ${path} answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    return response
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
  const expected = `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
  if (expected.length !== signature.length) return false
  let difference = 0
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index)
  return difference === 0
}
