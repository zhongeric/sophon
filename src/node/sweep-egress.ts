import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** The local egress proxy of sweep fetch jobs: `url` starts the server on first use and gives its base URL. */
export type SweepEgressServer = { url(): Promise<string>; close(): Promise<void> }

async function requestOf(message: IncomingMessage, base: string): Promise<Request> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  const method = message.method ?? 'GET'
  const chunks: Buffer[] = []
  if (method !== 'GET' && method !== 'HEAD') for await (const chunk of message) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return new Request(new URL(message.url ?? '/', base), { method, headers, body: chunks.length > 0 ? Buffer.concat(chunks) : undefined })
}

/**
 * An HTTP server on 127.0.0.1 and a free port, over a handler of core/sweep-egress.ts. The server does not keep the
 * process alive. Only the jobs of this machine can reach it, but it has no network isolation of its own.
 */
export function sweepEgressServer(handler: (request: Request) => Promise<Response>): SweepEgressServer {
  let started: Promise<{ server: Server; base: string }> | null = null
  const start = () =>
    new Promise<{ server: Server; base: string }>((done, fail) => {
      const server = createServer((message, reply) => {
        const port = (server.address() as AddressInfo).port
        requestOf(message, `http://127.0.0.1:${port}`)
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
        done({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
      })
    })
  return {
    async url() {
      started ??= start()
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
