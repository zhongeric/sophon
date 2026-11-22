import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** The local egress proxy of sweep fetch jobs: `url` starts the server on first use and gives its base URL. */
export type SweepEgressServer = { url(): Promise<string>; close(): Promise<void> }

/** Hop-by-hop headers and the length of the buffered body. The upstream fetch refuses some of them. */
const hopHeaders = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect', 'proxy-connection', 'proxy-authorization', 'content-length'])

/** The request to the handler, with `rest` (the URL after the token) as its path, and without hop-by-hop headers. */
async function requestOf(message: IncomingMessage, rest: string, base: string): Promise<Request> {
  const named = new Set(String(message.headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase()))
  const headers = new Headers()
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined || hopHeaders.has(name) || named.has(name)) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  const method = message.method ?? 'GET'
  const chunks: Buffer[] = []
  if (method !== 'GET' && method !== 'HEAD') for await (const chunk of message) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return new Request(new URL(`${base}/${rest.replace(/^\//, '')}`), { method, headers, body: chunks.length > 0 ? Buffer.concat(chunks) : undefined })
}

/**
 * An HTTP server on 127.0.0.1 and a free port, over a handler of core/sweep-egress.ts. The server does not keep the
 * process alive. The base URL has a random token as its first path segment. The server refuses a request without
 * the token with 403, because other processes of this machine can also reach the port.
 */
export function sweepEgressServer(handler: (request: Request) => Promise<Response>): SweepEgressServer {
  let started: Promise<{ server: Server; base: string }> | null = null
  const start = () =>
    new Promise<{ server: Server; base: string }>((done, fail) => {
      const prefix = `/${randomBytes(32).toString('hex')}`
      const server = createServer((message, reply) => {
        const port = (server.address() as AddressInfo).port
        const url = message.url ?? '/'
        if (url !== prefix && !url.startsWith(`${prefix}/`) && !url.startsWith(`${prefix}?`)) {
          message.resume()
          reply.writeHead(403, { 'content-type': 'text/plain' })
          reply.end('egress: the request has no valid token\n')
          return
        }
        requestOf(message, url.slice(prefix.length), `http://127.0.0.1:${port}`)
          .then(handler)
          .then(async (response) => {
            const body = new Uint8Array(await response.arrayBuffer())
            reply.writeHead(response.status, Object.fromEntries(response.headers))
            reply.end(body)
          })
          .catch((error: unknown) => {
            reply.writeHead(500, { 'content-type': 'text/plain' })
            reply.end(`egress: ${error instanceof Error ? error.message : String(error)}\n`)
          })
      })
      server.once('error', fail)
      server.listen(0, '127.0.0.1', () => {
        server.unref()
        done({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}` })
      })
    })
  return {
    async url() {
      // A failed start is not kept, so the next call tries the listen again.
      started ??= start().catch((error: unknown) => {
        started = null
        throw error
      })
      return (await started).base
    },
    async close() {
      if (!started) return
      const { server } = await started
      started = null
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}
