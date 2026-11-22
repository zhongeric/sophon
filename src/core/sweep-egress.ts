import { artifactSizeLimit } from './artifacts.ts'
import { egressFetch, type Egress, type EgressHost } from './egress.ts'

/** The clock of a rate limiter. Tests give a fake clock. */
export type LimiterClock = { now(): number; wait(ms: number): Promise<void> }

const realClock: LimiterClock = { now: () => Date.now(), wait: (ms) => new Promise((done) => setTimeout(done, ms)) }

/**
 * A limiter of `rate` starts in each second. Each start waits until about 1000 / rate ms after the previous start. Thus a
 * one-second window never has more than `rate` starts, and a new limiter, also after a resume, has no burst.
 * The caller awaits the function before each request.
 */
export function rateLimiter(rate: number, clock: LimiterClock = realClock): () => Promise<void> {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`the rate ${rate} is not a finite number more than 0`)
  // Whole milliseconds, rounded up, so that a float error never puts one more start into a window.
  const interval = Math.ceil(1000 / rate)
  let next = Number.NEGATIVE_INFINITY
  return async () => {
    const now = clock.now()
    const start = Math.max(now, next)
    // The slot is taken before the wait, so requests that wait at the same time get different slots.
    next = start + interval
    if (start > now) await clock.wait(start - now)
  }
}

/** What the sweep egress gets from the host. `limit` is a rateLimiter. */
export type SweepEgressOptions = { egress: Egress; host: EgressHost; log(line: string): void; limit(): Promise<void> }

/** The name in the log lines. */
const agent = 'sweep fetch'

const plainHost = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/

const answer = (status: number, message: string) => new Response(`${message}\n`, { status, headers: { 'content-type': 'text/plain' } })

/**
 * The handler of the egress proxy of sweep fetch jobs (section 6.3 of docs/specs/research-workflow.md). A request to
 * `<proxy>/<host>/<path>?<query>` goes to `https://<host>/<path>?<query>` through egressFetch. Each upstream request,
 * also each redirect hop, waits for the limiter. A malformed path gives 400, a refusal of the egress 403, and an
 * upstream error 502. Messages never contain a secret.
 */
export function sweepEgressHandler(options: SweepEgressOptions): (request: Request) => Promise<Response> {
  const upstream = options.host.fetch ?? fetch
  const limited: typeof fetch = async (input, init) => {
    await options.limit()
    return upstream(input, init)
  }
  const send = egressFetch(agent, { ...options.egress, max_bytes: artifactSizeLimit }, { ...options.host, fetch: limited }, options.log)
  return async (request) => {
    const { pathname, search } = new URL(request.url)
    const [, host = '', ...path] = pathname.split('/')
    const target = `https://${host}/${path.join('/')}${search}`
    if (!plainHost.test(host) || !URL.canParse(target)) {
      const message = `egress: the path must be /<host>/<path>, not ${pathname}`
      options.log(`${agent}: egress ${request.method} ${JSON.stringify(pathname)} 400 ${message}`)
      return answer(400, message)
    }
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : new Uint8Array(await request.arrayBuffer())
    let response: Response
    try {
      response = await send(target, { method: request.method, headers: request.headers, body })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // egressFetch names secrets, never their values, so a refusal message is safe to give.
      return message.startsWith('egress refused: ') ? answer(403, message) : answer(502, `egress: the request to ${host} failed`)
    }
    const headers = new Headers()
    for (const name of ['content-type', 'x-artifact-id', 'x-provenance-id']) {
      const value = response.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    return new Response(response.body, { status: response.status, headers })
  }
}
