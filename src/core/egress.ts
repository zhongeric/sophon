import { artifactId, artifactSizeLimit } from './artifacts.ts'
import type { Ledger } from './ledger.ts'
import type { Artifacts } from './platform.ts'
import { hostSecrets } from './secrets.ts'

/** A header that the host adds for one host. `secret` is the name of a host secret, never its value. */
export type EgressCredential = { header: string; secret: string }

/** The network access of one agent. `credentials` are keyed by host name. */
export type Egress = { hosts: string[]; web_search: boolean; max_bytes?: number; credentials?: Record<string, EgressCredential> }

/** The default cap of a response body: 8 MiB. */
export const defaultResponseLimit = 8 * 1024 * 1024

/** URL prefixes that the egress refuses until the host unlocks them. Only the host can unlock. */
export type RunLock = { locked(url: string): boolean; pending(): string[]; unlock(pattern: string): void }

/** What the egress gets from the host. `fetch` replaces the global fetch, for tests. */
export type EgressHost = { artifacts: Artifacts; lock?: RunLock; secret(name: string): string | undefined; fetch?: typeof fetch }

const unlockedKey = 'egress:unlocked'
const maxRedirects = 5
const redirectStatuses = new Set([301, 302, 303, 307, 308])
const nullBodyStatuses = new Set([204, 205, 304])
const postTypes = new Set(['application/x-www-form-urlencoded', 'application/json'])
const httpToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const hostLabel = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/** The href of a URL without its fragment, so that two forms of one URL compare equal. */
const normalizeUrl = (url: string) => {
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.href
}

/** Lower case and no trailing dot. */
const hostName = (name: string) => name.toLowerCase().replace(/\.$/, '')

const isPlainHost = (name: string) => {
  const normal = hostName(name)
  return normal.length > 0 && normal.length <= 253 && normal.split('.').every((label) => hostLabel.test(label))
}

/** The lock of one run. The unlocked patterns are in the ledger, so a resumed run keeps each unlock. */
export function runLock(ledger: Ledger, patterns: string[]): RunLock {
  const list = [...new Set(patterns.map(normalizeUrl))]
  const unlocked = () => ledger.get<string[]>(unlockedKey) ?? []
  const pending = () => {
    const done = unlocked()
    return list.filter((pattern) => !done.includes(pattern))
  }
  return {
    locked(url) {
      const href = normalizeUrl(url)
      return pending().some((pattern) => href.startsWith(pattern))
    },
    pending,
    unlock(pattern) {
      const href = normalizeUrl(pattern)
      if (!list.includes(href)) throw new Error(`egress: ${pattern} is not a lock pattern of this run`)
      const done = unlocked()
      if (!done.includes(href)) ledger.put(unlockedKey, [...done, href])
    },
  }
}

/** Refuses a spec that the host must not run. The messages name secrets, never their values. */
export function checkEgress(egress: Egress, host: EgressHost): void {
  const max = egress.max_bytes
  if (max !== undefined && (!Number.isInteger(max) || max <= 0 || max > artifactSizeLimit))
    throw new Error(`egress: max_bytes ${max} is not an integer from 1 to ${artifactSizeLimit}`)
  for (const name of egress.hosts) if (!isPlainHost(name)) throw new Error(`egress: ${JSON.stringify(name)} is not a plain host name`)
  const hosts = new Set(egress.hosts.map(hostName))
  for (const [name, credential] of Object.entries(egress.credentials ?? {})) {
    if (!hosts.has(hostName(name))) throw new Error(`egress: the credential host ${name} is not in hosts`)
    if (!httpToken.test(credential.header)) throw new Error(`egress: the credential header ${JSON.stringify(credential.header)} of ${name} is not a valid HTTP token`)
    if (hostSecrets.includes(credential.secret)) throw new Error(`egress: the credential of ${name} cannot use the host secret ${credential.secret}`)
    if (!host.secret(credential.secret)) throw new Error(`egress: the secret ${credential.secret} for ${name} is not set`)
  }
  const pending = host.lock?.pending() ?? []
  if (egress.web_search && pending.length > 0) throw new Error(`egress: web_search is not possible while ${pending.join(', ')} is locked`)
}

const refused = (reason: string) => new Error(`egress refused: ${reason}`)

const refusedIpv4 = (octets: number[]) => {
  const [a = 0, b = 0] = octets
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    octets.every((octet) => octet === 255)
  )
}

/** The eight groups of an IPv6 literal in the normalized form of the URL parser, or null for a different form. */
function ipv6Groups(literal: string): number[] | null {
  const halves = literal.split('::')
  if (halves.length > 2) return null
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN)))
  const head = parse(halves[0] ?? '')
  const tail = parse(halves[1] ?? '')
  const fill = halves.length === 1 ? 0 : 8 - head.length - tail.length
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null
  const groups = [...head, ...new Array<number>(fill).fill(0), ...tail]
  return groups.some(Number.isNaN) ? null : groups
}

/** True for localhost names and for private, loopback, link-local and unspecified IP literals. There is no DNS lookup. */
function refusedAddress(name: string): boolean {
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return refusedIpv4(name.split('.').map(Number))
  if (!name.startsWith('[')) return false
  const groups = ipv6Groups(name.slice(1, -1))
  // The address of a literal in a different form is not known, thus the egress refuses it.
  if (!groups) return true
  const [first = 0, , , , , sixth = 0, seventh = 0, eighth = 0] = groups
  const zeros = (count: number) => groups.slice(0, count).every((group) => group === 0)
  if (zeros(7) && (eighth === 0 || eighth === 1)) return true
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true
  if (zeros(5) && sixth === 0xffff) return refusedIpv4([seventh >> 8, seventh & 0xff, eighth >> 8, eighth & 0xff])
  return false
}

const urlOf = (input: Parameters<typeof fetch>[0]) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)

/** The body, or a refusal when its size is over the cap. A body of exactly the cap is accepted. */
async function readCapped(response: Response, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) > cap) {
    await response.body?.cancel()
    throw refused(`size: the content-length ${length} is over the cap of ${cap} bytes`)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  if (response.body) {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk: Uint8Array = value
      total += chunk.length
      if (total > cap) {
        await reader.cancel()
        throw refused(`size: the body is over the cap of ${cap} bytes`)
      }
      chunks.push(chunk)
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

/**
 * The fetch of an agent with an egress. Each request and each redirect hop must pass the rules, else the fetch
 * rejects and stores nothing. The host adds the credential header only on the origin of the first request, as
 * `dispatcher` in providers.ts does. Each final body goes into the artifact store, and the response gets its ID in
 * the x-artifact-id header.
 */
export function egressFetch(agent: string, egress: Egress, host: EgressHost, log: (line: string) => void): typeof fetch {
  const hosts = new Set(egress.hosts.map(hostName))
  const credentials = new Map(Object.entries(egress.credentials ?? {}).map(([name, credential]) => [hostName(name), credential]))
  const cap = egress.max_bytes ?? defaultResponseLimit
  const send = host.fetch ?? fetch

  /** The reason to refuse a URL, or null when the URL passes. */
  const refusal = (url: URL): string | null => {
    if (url.protocol !== 'https:') return `scheme ${url.protocol} is not https`
    if (url.username || url.password) return 'user info in the URL'
    if (url.port !== '') return `port ${url.port} is not 443`
    const name = hostName(url.hostname)
    if (refusedAddress(name)) return `address ${name} is private or local`
    if (!hosts.has(name)) return `host ${name} is not in the list`
    if (host.lock?.locked(url.href)) return `lock: ${url.href} is locked`
    return null
  }

  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const given = init?.method ?? (typeof input === 'object' && !(input instanceof URL) ? input.method : 'GET')
    let line = `${agent}: egress ${given} ${urlOf(input)}`
    try {
      let first: URL
      try {
        first = new URL(urlOf(input))
      } catch {
        throw refused('the URL is not valid')
      }
      // The fragment does not go to the server.
      first.hash = ''
      const reason = refusal(first)
      if (reason) throw refused(reason)
      // The Request API refuses a GET with a body with an error of its own. This check gives the egress reason.
      if (init?.body != null && /^(get|head)$/i.test(given)) throw refused(`method ${given} with a body`)
      let request: Request
      try {
        request = new Request(input, init)
      } catch (error) {
        throw refused(`the request is not valid: ${error instanceof Error ? error.message : String(error)}`)
      }
      line = `${agent}: egress ${request.method} ${first.href}`
      let method = request.method
      if (method !== 'GET' && method !== 'POST') throw refused(`method ${method} is not GET or POST`)
      const headers = new Headers(request.headers)
      let body: Uint8Array<ArrayBuffer> | undefined
      if (method === 'POST') {
        const type = (headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
        if (!postTypes.has(type)) throw refused(`method POST with the body type ${JSON.stringify(type)}`)
        body = new Uint8Array(await request.arrayBuffer())
      }

      const credential = credentials.get(hostName(first.hostname))
      const hopHeaders = (url: URL) => {
        const sent = new Headers(headers)
        if (!credential) return sent
        // The credential goes only to the first origin. The value of the agent does not go to a different origin.
        if (url.origin !== first.origin) {
          sent.delete(credential.header)
          return sent
        }
        const secret = host.secret(credential.secret)
        if (!secret) throw refused(`the secret ${credential.secret} for ${hostName(first.hostname)} is not set`)
        sent.set(credential.header, secret)
        return sent
      }
      const hop = (url: URL) => send(url.href, { method, headers: hopHeaders(url), body, redirect: 'manual', signal: request.signal })

      let url = first
      let response = await hop(url)
      for (let hops = 0; ; hops++) {
        const location = response.headers.get('location')
        if (!redirectStatuses.has(response.status) || location === null) break
        await response.body?.cancel()
        if (hops === maxRedirects) throw refused(`redirect: more than ${maxRedirects} hops`)
        let next: URL
        try {
          next = new URL(location, url)
        } catch {
          throw refused('redirect: the location is not a valid URL')
        }
        next.hash = ''
        const hopReason = refusal(next)
        if (hopReason) throw refused(`redirect to ${next.href}: ${hopReason}`)
        if (response.status === 303 || (method === 'POST' && (response.status === 301 || response.status === 302))) {
          method = 'GET'
          body = undefined
          headers.delete('content-type')
        }
        url = next
        response = await hop(url)
      }

      const bytes = await readCapped(response, cap)
      const id = await host.artifacts.put(bytes, {
        source: { url: url.href, method },
        media_type: response.headers.get('content-type') ?? 'application/octet-stream',
        labels: { body_sha256: await artifactId(body ?? new Uint8Array()), status: String(response.status) },
      })
      const answered = new Headers(response.headers)
      answered.delete('content-encoding')
      answered.delete('content-length')
      answered.set('x-artifact-id', id)
      const final = url.href === first.href ? '' : ` from ${method} ${url.href}`
      log(`${line} ${response.status}${final} artifact ${id}`)
      return new Response(nullBodyStatuses.has(response.status) ? null : bytes, { status: response.status, statusText: response.statusText, headers: answered })
    } catch (error) {
      log(`${line} ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }
}
