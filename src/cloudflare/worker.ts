import { DevelopmentRuns, type DevelopRequest } from './develop.ts'
import { sameSecret, verifySignature } from './github.ts'
import { allowedUsers, PullRequestRuns, type Env } from './run.ts'

export { DevelopmentRuns, PullRequestRuns }

const key = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`.toLowerCase()
const pullRequest = (env: Env, owner: string, repo: string, pr: number) => env.PULL_REQUESTS.get(env.PULL_REQUESTS.idFromName(key(owner, repo, pr)))
const issue = (env: Env, owner: string, repo: string, number: number) => env.DEVELOPMENT_RUNS.get(env.DEVELOPMENT_RUNS.idFromName(key(owner, repo, number)))
const accepted = (body: unknown) => Response.json(body, { status: 202 })

/** The review runs of a PR, or the development runs of an issue. GitHub numbers both in one sequence, so a number is one or the other. */
async function runsOf(env: Env, owner: string, repo: string, number: number) {
  const reviews = pullRequest(env, owner, repo, number)
  return (await reviews.status()).runs.length > 0 ? reviews : issue(env, owner, repo, number)
}

type DevelopOptions = Pick<DevelopRequest, 'base' | 'hotfix' | 'full' | 'parallel'>

/** The options of a development run, from the admin route's body or from the words after /develop. */
function developOptions(source: { base?: unknown; hotfix?: unknown; full?: unknown; parallel?: unknown }): DevelopOptions {
  return {
    ...(typeof source.base === 'string' && source.base ? { base: source.base } : {}),
    ...(source.hotfix === true ? { hotfix: true } : {}),
    ...(source.full === true ? { full: true } : {}),
    ...(Number(source.parallel) >= 1 ? { parallel: Math.floor(Number(source.parallel)) } : {}),
  }
}

const commandOptions = (text: string): DevelopOptions =>
  developOptions({
    base: /--base\s+(\S+)/.exec(text)?.[1],
    full: /--full\b/.test(text),
    hotfix: /--hotfix\b/.test(text),
    parallel: /--parallel\s+(\d+)/.exec(text)?.[1],
  })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/github/webhook') return webhook(request, env)
    const route = /^\/(runs|develop)\/([^/]+)\/([^/]+)\/(\d+)(?:\/(report|resume))?$/.exec(url.pathname)
    if (!route) return new Response('agent-factory', { status: url.pathname === '/' ? 200 : 404 })
    if (!env.ADMIN_TOKEN || !sameSecret(request.headers.get('authorization') ?? '', `Bearer ${env.ADMIN_TOKEN}`)) return new Response('unauthorized', { status: 401 })
    const [, kind, owner = '', repo = '', number, action] = route
    const by = allowedUsers(env)[0] ?? owner
    if (kind === 'develop') {
      if (request.method !== 'POST' || action) return new Response('method not allowed', { status: 405 })
      const options = (await request.json().catch(() => ({}))) as Record<string, unknown>
      return accepted(await issue(env, owner, repo, Number(number)).start({ by, issue: Number(number), owner, repo, ...developOptions(options) }))
    }
    const pr = Number(number)
    if (request.method === 'POST' && !action) {
      const options = (await request.json().catch(() => ({}))) as { ship?: boolean; full?: boolean }
      return accepted(await pullRequest(env, owner, repo, pr).start({ by, full: options.full === true, owner, pr, repo, ship: options.ship === true }))
    }
    const runs = await runsOf(env, owner, repo, pr)
    if (request.method === 'GET' && action === 'report')
      return new Response((await runs.report()) ?? 'no report yet', { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
    if (request.method === 'GET' && !action) return Response.json(await runs.status())
    // Starts and resumes for callers without the webhook, such as npm run remote.
    if (request.method === 'POST' && action === 'resume') return accepted(await runs.resume({ afterError: true }))
    return new Response('method not allowed', { status: 405 })
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
  workflow_run?: { head_branch: string | null; pull_requests: { number: number }[] }
  branches?: { name: string }[]
}

/**
 * GitHub webhooks: `/review` and the agent-review label start a review run on a PR, `/develop` and the agent-develop
 * label start a development run on an issue, and `/answer` and CI results (workflow runs, statuses) wake a paused run.
 */
async function webhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text()
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256')))) return new Response('bad signature', { status: 401 })
  const event = request.headers.get('x-github-event')
  const payload = JSON.parse(body) as Payload
  const [owner = '', repo = ''] = payload.repository.full_name.split('/')
  const allowed = (login: string | undefined) => allowedUsers(env).some((user) => user.toLowerCase() === login?.toLowerCase())

  if (event === 'issue_comment' && payload.action === 'created' && payload.issue && payload.comment) {
    const by = payload.comment.user.login
    if (!allowed(by)) return accepted({ ignored: 'not an allowed user' })
    const text = payload.comment.body.trim()
    const number = payload.issue.number
    // The webhook body stays `{ resumed }`. Only the admin route gives the state and the reason.
    if (payload.issue.pull_request) {
      const runs = pullRequest(env, owner, repo, number)
      if (/^\/review\b/.test(text)) return accepted(await runs.start({ by, full: /--full\b/.test(text), owner, pr: number, repo, ship: /--ship\b/.test(text) }))
      if (/^\/answer\b/.test(text)) return accepted({ resumed: (await runs.resume()).resumed })
    } else {
      const runs = issue(env, owner, repo, number)
      if (/^\/develop\b/.test(text)) return accepted(await runs.start({ by, issue: number, owner, repo, ...commandOptions(text) }))
      if (/^\/answer\b/.test(text)) return accepted({ resumed: (await runs.resume()).resumed })
    }
  }
  if (event === 'pull_request' && payload.action === 'labeled' && payload.label?.name === 'agent-review' && payload.pull_request && allowed(payload.sender?.login))
    return accepted(await pullRequest(env, owner, repo, payload.pull_request.number).start({ by: payload.sender!.login, owner, pr: payload.pull_request.number, repo, ship: false }))
  if (event === 'issues' && payload.action === 'labeled' && payload.label?.name === 'agent-develop' && payload.issue && !payload.issue.pull_request && allowed(payload.sender?.login))
    return accepted(await issue(env, owner, repo, payload.issue.number).start({ by: payload.sender!.login, issue: payload.issue.number, owner, repo }))
  if (event === 'workflow_run' || event === 'check_suite' || event === 'check_run' || event === 'status') {
    const suite = payload.workflow_run ?? payload.check_suite ?? payload.check_run?.check_suite
    const branches = suite ? [suite.head_branch ?? ''] : (payload.branches ?? []).map((branch) => branch.name)
    const prs = new Set([...(suite?.pull_requests ?? []).map((pull) => pull.number), ...branches.flatMap((branch) => /^factory\/pr-(\d+)-/.exec(branch)?.[1] ?? []).map(Number)])
    for (const pr of prs) await pullRequest(env, owner, repo, pr).resume()
    return accepted({ woke: [...prs] })
  }
  return accepted({ ignored: event })
}
