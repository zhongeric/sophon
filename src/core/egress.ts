import { artifactId, artifactSizeLimit } from './artifacts.ts'
import type { Ledger } from './ledger.ts'
import type { Artifacts } from './platform.ts'
import { hostSecrets } from './secrets.ts'

/** A header that the host adds for one host. `secret` is the name of a host secret, never its value. */
export type EgressCredential = { header: string; secret: string }

/**
 * The network access of one agent. `credentials` are keyed by host name. `max_bytes` is the cap of a response body.
 * `max_request_bytes` is the cap of a request: the URL, the headers of the agent and the body.
 */
export type Egress = {
  hosts: string[]
  web_search: boolean
  max_bytes?: number
  max_request_bytes?: number
  credentials?: Record<string, EgressCredential>
}

/** The default cap of a response body: 8 MiB. */
const defaultResponseLimit = 8 * 1024 * 1024

/** The default cap of a request: 8 KiB. A small cap limits the data that an agent can send in one request. */
const defaultRequestLimit = 8 * 1024

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

/** An escape of an unreserved character decodes to that character. The hex digits of other escapes become upper case. */
const decodeUnreserved = (text: string) =>
  text.replace(/%[0-9a-fA-F]{2}/g, (escape) => {
    const char = String.fromCharCode(parseInt(escape.slice(1), 16))
    return /^[A-Za-z0-9\-._~]$/.test(char) ? char : escape.toUpperCase()
  })

/**
 * The href of a URL in one form, so that two forms of one URL compare equal. The form has no fragment and no trailing
 * dot on the host. It has no escapes of unreserved characters in the path and the query. The lock compares only this form.
 */
const normalizeUrl = (url: string) => {
  const parsed = new URL(url)
  parsed.hash = ''
  if (parsed.hostname.endsWith('.')) parsed.hostname = parsed.hostname.slice(0, -1)
  const path = decodeUnreserved(parsed.pathname)
  if (path !== parsed.pathname) parsed.pathname = path
  const query = decodeUnreserved(parsed.search)
  if (query !== parsed.search) parsed.search = query
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

/** The Headers API refuses CR, LF, NUL and characters over U+00FF, with an error that contains the value. */
const validHeaderValue = (value: string) => !/[\0\r\n]|[^\u0000-\u00ff]/.test(value)

/** Refuses a spec that the host must not run. The messages name secrets, never their values. */
export function checkEgress(egress: Egress, host: EgressHost): void {
  for (const field of ['max_bytes', 'max_request_bytes'] as const) {
    const max = egress[field]
    if (max !== undefined && (!Number.isInteger(max) || max <= 0 || max > artifactSizeLimit))
      throw new Error(`egress: ${field} ${max} is not an integer from 1 to ${artifactSizeLimit}`)
  }
  for (const name of egress.hosts) if (!isPlainHost(name)) throw new Error(`egress: ${JSON.stringify(name)} is not a plain host name`)
  const hosts = new Set(egress.hosts.map(hostName))
  for (const [name, credential] of Object.entries(egress.credentials ?? {})) {
    if (!hosts.has(hostName(name))) throw new Error(`egress: the credential host ${name} is not in hosts`)
    if (!httpToken.test(credential.header)) throw new Error(`egress: the credential header ${JSON.stringify(credential.header)} of ${name} is not a valid HTTP token`)
    if (hostSecrets.includes(credential.secret)) throw new Error(`egress: the credential of ${name} cannot use the host secret ${credential.secret}`)
    const value = host.secret(credential.secret)
    if (!value) throw new Error(`egress: the secret ${credential.secret} for ${name} is not set`)
    if (!validHeaderValue(value)) throw new Error(`egress: the secret ${credential.secret} for ${name} is not a valid header value`)
  }
}

const refused = (reason: string) => new Error(`egress refused: ${reason}`)

/** Control characters become escapes, so that one request gives one log line. */
const logText = (text: string) =>
  text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** The egress removes these request headers of the agent. A server can use them to change the approved host or method. */
const removedHeaders = ['host', 'x-http-method-override', 'x-http-method', 'x-method-override']

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

/**
 * The UTF-8 bytes of the URL, of each header name and value of the agent, and of the body. The credential headers
 * of the host do not count, so a long secret does not refuse a request.
 */
function requestSize(url: URL, headers: Headers, body: Uint8Array | undefined): number {
  const encoder = new TextEncoder()
  let size = encoder.encode(url.href).length + (body?.length ?? 0)
  headers.forEach((value, name) => {
    size += encoder.encode(name).length + encoder.encode(value).length
  })
  return size
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
 * rejects and stores nothing. On each hop, the host adds the credential header of the host of that hop, as
 * `dispatcher` in providers.ts does. Each final body goes into the artifact store, and the response gets its ID in
 * the x-artifact-id header.
 *
 * The store keeps the first meta of a body. Each response also gets a JSON provenance record
 * with a unique nonce. The x-provenance-id header has the ID of this record. The record contains the body ID and the
 * request data. Its meta contains the time.
 */
export function egressFetch(agent: string, egress: Egress, host: EgressHost, log: (line: string) => void): typeof fetch {
  const hosts = new Set(egress.hosts.map(hostName))
  const credentials = new Map(Object.entries(egress.credentials ?? {}).map(([name, credential]) => [hostName(name), credential]))
  const cap = egress.max_bytes ?? defaultResponseLimit
  const requestCap = egress.max_request_bytes ?? defaultRequestLimit
  const send = host.fetch ?? fetch

  /** The reason to refuse a URL, or null when the URL passes. */
  const refusal = (url: URL): string | null => {
    if (url.protocol !== 'https:') return `scheme ${url.protocol} is not https`
    if (url.username || url.password) return 'user info in the URL'
    if (url.port !== '') return `port ${url.port} is not 443`
    const name = hostName(url.hostname)
    if (refusedAddress(name)) return `address ${name} is private or local`
    if (!hosts.has(name)) return `host ${name} is not in the list`
    // The lock compares the normalized form, so a trailing dot or an escape does not change the result.
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
      for (const name of removedHeaders) headers.delete(name)
      let body: Uint8Array<ArrayBuffer> | undefined
      if (method === 'POST') {
        const type = (headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
        if (!postTypes.has(type)) throw refused(`method POST with the body type ${JSON.stringify(type)}`)
        body = new Uint8Array(await request.arrayBuffer())
      }

      const hopHeaders = (url: URL) => {
        const sent = new Headers(headers)
        // A value of the agent for a credential header does not go to a different origin.
        if (url.origin !== first.origin) for (const { header } of credentials.values()) sent.delete(header)
        const name = hostName(url.hostname)
        const credential = credentials.get(name)
        if (!credential) return sent
        const secret = host.secret(credential.secret)
        if (!secret) throw refused(`the secret ${credential.secret} for ${name} is not set`)
        // The error of Headers.set contains the value, so the egress gives its own error without the value.
        if (!validHeaderValue(secret)) throw refused(`the secret ${credential.secret} for ${name} is not a valid header value`)
        sent.set(credential.header, secret)
        return sent
      }
      // Each hop has a different URL, so each hop gets the size check.
      const hop = (url: URL) => {
        const size = requestSize(url, headers, body)
        if (size > requestCap) throw refused(`size: the request of ${size} bytes is over the cap of ${requestCap} bytes`)
        return send(url.href, { method, headers: hopHeaders(url), body, redirect: 'manual', signal: request.signal })
      }

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
      const source = { url: url.href, method }
      const labels = { body_sha256: await artifactId(body ?? new Uint8Array()), status: String(response.status) }
      const id = await host.artifacts.put(bytes, { source, media_type: response.headers.get('content-type') ?? 'application/octet-stream', labels })
      const record = { body: id, url: url.href, method, ...labels, nonce: crypto.randomUUID() }
      const provenance = await host.artifacts.put(new TextEncoder().encode(JSON.stringify(record)), {
        source: { command: 'egress provenance' },
        media_type: 'application/json',
        labels: { ...labels, body: id },
      })
      const answered = new Headers(response.headers)
      answered.delete('content-encoding')
      answered.delete('content-length')
      answered.set('x-artifact-id', id)
      answered.set('x-provenance-id', provenance)
      const final = url.href === first.href ? '' : ` from ${method} ${url.href}`
      log(logText(`${line} ${response.status}${final} artifact ${id} provenance ${provenance}`))
      return new Response(nullBodyStatuses.has(response.status) ? null : bytes, { status: response.status, statusText: response.statusText, headers: answered })
    } catch (error) {
      log(logText(`${line} ${error instanceof Error ? error.message : String(error)}`))
      throw error
    }
  }
}
