import { verifySignature } from './github.ts'
import { allowedUsers, PullRequestRuns, type Env } from './run.ts'

export { PullRequestRuns }

const pullRequest = (env: Env, owner: string, repo: string, pr: number) => env.PULL_REQUESTS.get(env.PULL_REQUESTS.idFromName(`${owner}/${repo}#${pr}`.toLowerCase()))
const accepted = (body: unknown) => Response.json(body, { status: 202 })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/github/webhook') return webhook(request, env)
    const route = /^\/runs\/([^/]+)\/([^/]+)\/(\d+)(\/report)?$/.exec(url.pathname)
    if (request.method === 'GET' && route) {
      if (!env.ADMIN_TOKEN || request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return new Response('unauthorized', { status: 401 })
      const runs = pullRequest(env, route[1]!, route[2]!, Number(route[3]))
      if (route[4]) return new Response((await runs.report()) ?? 'no report yet', { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
      return Response.json(await runs.status())
    }
    return new Response('agent-factory', { status: url.pathname === '/' ? 200 : 404 })
  },
} satisfies ExportedHandler<Env>

type Payload = {
  action?: string
  repository: { full_name: string }
  sender?: { login: string }
  issue?: { number: number; pull_request?: unknown }
  comment?: { body: string; user: { login: string } }
  pull_request?: { number: number }
  label?: { name: string }
  check_suite?: { head_branch: string | null; pull_requests: { number: number }[] }
  check_run?: { check_suite: { head_branch: string | null; pull_requests: { number: number }[] } }
  branches?: { name: string }[]
}

/** GitHub webhooks: `/review` and the agent-review label start a run; `/answer` and CI results wake a paused run. */
async function webhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text()
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256')))) return new Response('bad signature', { status: 401 })
  const event = request.headers.get('x-github-event')
  const payload = JSON.parse(body) as Payload
  const [owner = '', repo = ''] = payload.repository.full_name.split('/')
  const allowed = (login: string | undefined) => allowedUsers(env).some((user) => user.toLowerCase() === login?.toLowerCase())

  if (event === 'issue_comment' && payload.action === 'created' && payload.issue?.pull_request && payload.comment) {
    const by = payload.comment.user.login
    if (!allowed(by)) return accepted({ ignored: 'not an allowed user' })
    const text = payload.comment.body.trim()
    const runs = pullRequest(env, owner, repo, payload.issue.number)
    if (/^\/review\b/.test(text)) return accepted(await runs.start({ by, owner, pr: payload.issue.number, repo, ship: /--ship\b/.test(text) }))
    if (/^\/answer\b/.test(text)) return accepted({ resumed: await runs.resume() })
  }
  if (event === 'pull_request' && payload.action === 'labeled' && payload.label?.name === 'agent-review' && payload.pull_request && allowed(payload.sender?.login))
    return accepted(await pullRequest(env, owner, repo, payload.pull_request.number).start({ by: payload.sender!.login, owner, pr: payload.pull_request.number, repo, ship: false }))
  if (event === 'check_suite' || event === 'check_run' || event === 'status') {
    const suite = payload.check_suite ?? payload.check_run?.check_suite
    const branches = suite ? [suite.head_branch ?? ''] : (payload.branches ?? []).map((branch) => branch.name)
    const prs = new Set([...(suite?.pull_requests ?? []).map((pull) => pull.number), ...branches.flatMap((branch) => /^factory\/pr-(\d+)-/.exec(branch)?.[1] ?? []).map(Number)])
    for (const pr of prs) await pullRequest(env, owner, repo, pr).resume()
    return accepted({ woke: [...prs] })
  }
  return accepted({ ignored: event })
}
