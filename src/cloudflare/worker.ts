import { DevelopmentRuns, type DevelopRequest } from './develop.ts'
import { ResearchRuns } from './research.ts'
import { ScanBoxes } from './scan.ts'
import { StopError } from '../core/stop.ts'
import { parseBudget } from '../core/usage.ts'
import { sameSecret, verifySignature, type GitHub } from './github.ts'
import { appBotLogin, githubAccess, githubApp, type BotLogins, type InstallationTokens } from './github-app.ts'
import { listInbox } from './inbox.ts'
import { workLabels, type WorkKind } from './labels.ts'
import { openApi } from './openapi.ts'
import { sweepBranches } from './prune.ts'
import { allowedUsers, PullRequestRuns, type Env } from './run.ts'
import { sweepWork, type WorkItem } from './work-sweep.ts'

export { DevelopmentRuns, PullRequestRuns, ResearchRuns, ScanBoxes }

const key = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`.toLowerCase()
const pullRequest = (env: Env, owner: string, repo: string, pr: number) => env.PULL_REQUESTS.get(env.PULL_REQUESTS.idFromName(key(owner, repo, pr)))
const issue = (env: Env, owner: string, repo: string, number: number) => env.DEVELOPMENT_RUNS.get(env.DEVELOPMENT_RUNS.idFromName(key(owner, repo, number)))
const research = (env: Env, owner: string, repo: string, number: number) => env.RESEARCH_RUNS.get(env.RESEARCH_RUNS.idFromName(key(owner, repo, number)))
const accepted = (body: unknown) => Response.json(body, { status: 202 })
/** The installation tokens of the sweeps in this isolate. The runs keep their own. */
const tokens: InstallationTokens = new Map()

/** Prunes the factory/* branches of owner/repo, or with `only` the branches that it selects. `client` is a client that the caller has for the repository. */
async function prune(env: Env, owner: string, repo: string, only?: (name: string) => boolean, client?: GitHub) {
  const gh = client ?? (await githubAccess(env, owner, repo, tokens)).gh
  return sweepBranches({
    gh,
    lookup: (kind, number, run) => (kind === 'review' ? pullRequest(env, owner, repo, number) : issue(env, owner, repo, number)).runState(run),
    owner,
    repo,
    ...(only ? { only } : {}),
  })
}

const botLogins: BotLogins = new Map()
/** True after the cron logged the missing App secrets in this isolate. */
let missingLogged = false

/** The object of each work kind for an issue or a PR. */
const objectOf = { review: pullRequest, develop: issue, research } satisfies Record<WorkKind, unknown>

/**
 * Starts the run of a work label, from the webhook or the work sweep. A label gives no options, and its review does not
 * ship. With `once`, the object refuses when it has a run in any state.
 */
function startLabeled(env: Env, kind: WorkKind, { by, number, owner, repo }: WorkItem, once = false) {
  if (kind === 'review') return pullRequest(env, owner, repo, number).start({ by, owner, pr: number, repo, ship: false }, { once })
  return objectOf[kind](env, owner, repo, number).start({ by, issue: number, owner, repo }, { once })
}

/**
 * The review runs of a PR, else the development or the research runs of an issue: the object whose latest run started
 * last. GitHub numbers PRs and issues in one sequence, so a number is one or the other.
 */
async function runsOf(env: Env, owner: string, repo: string, number: number) {
  const reviews = pullRequest(env, owner, repo, number)
  if ((await reviews.status()).runs.length > 0) return reviews
  const develops = issue(env, owner, repo, number)
  const researches = research(env, owner, repo, number)
  const [developed, researched] = await Promise.all([develops.status(), researches.status()])
  return (researched.runs[0]?.created ?? -1) > (developed.runs[0]?.created ?? -1) ? researches : develops
}

/** The inbox of D21 for all installations of the App. Without the App secrets, it responds 503. */
async function inbox(env: Env): Promise<Response> {
  let clients: ReturnType<typeof githubApp>
  try {
    clients = githubApp(env, tokens)
  } catch (error) {
    if (!(error instanceof StopError)) throw error
    return new Response(`the inbox needs the GitHub App: ${error.message}`, { status: 503 })
  }
  const { app, installation } = clients
  return Response.json(
    await listInbox({
      app,
      entries: (kind, owner, repo, number) => objectOf[kind](env, owner, repo, number).inbox(),
      installation,
      log: (line) => console.log(line),
    }),
  )
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

/** The JSON body of an admin start route. An empty body gives no options, and a body that is not an object gives 400. */
async function bodyOf(request: Request): Promise<Record<string, unknown> | Response> {
  const body: unknown = await request.json().catch(() => ({}))
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return new Response('the body must be a JSON object', { status: 400 })
  return body as Record<string, unknown>
}

/** The cost budget of an admin start route. The comment commands and the labels do not take a budget. */
function budgetOf(body: Record<string, unknown>): { budget?: number } | Response {
  if (body.budget === undefined) return {}
  try {
    return { budget: parseBudget(body.budget) }
  } catch (error) {
    if (error instanceof StopError) return new Response(error.message, { status: 400 })
    throw error
  }
}

export default {
  // The cron trigger of wrangler.jsonc calls this every 5 minutes for the work sweep of D18.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    let clients: ReturnType<typeof githubApp>
    try {
      clients = githubApp(env, tokens)
    } catch (error) {
      if (!(error instanceof StopError)) throw error
      if (!missingLogged) console.error(`the work sweep does nothing: ${error.message}`)
      missingLogged = true
      return
    }
    const { app, installation } = clients
    await sweepWork({
      allowed: allowedUsers(env),
      app,
      hasRun: async (kind, owner, repo, number) => (await objectOf[kind](env, owner, repo, number).status()).runs.length > 0,
      installation,
      log: (line) => console.log(line),
      prune: (owner, repo, gh) => prune(env, owner, repo, undefined, gh),
      start: (kind, item) => startLabeled(env, kind, item, true),
    })
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/github/webhook') return webhook(request, env)
    // The description has no data, and a tool reads it before it has the token.
    if (request.method === 'GET' && url.pathname === '/openapi.json') return Response.json(openApi(url.origin))
    const route = /^\/(runs|develop|research)\/([^/]+)\/([^/]+)\/(\d+)(?:\/(report|resume))?$/.exec(url.pathname)
    const pruneRoute = /^\/prune\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    const inboxRoute = url.pathname === '/inbox'
    if (!route && !pruneRoute && !inboxRoute) return new Response('agent-factory', { status: url.pathname === '/' ? 200 : 404 })
    if (!env.ADMIN_TOKEN || !sameSecret(request.headers.get('authorization') ?? '', `Bearer ${env.ADMIN_TOKEN}`)) return new Response('unauthorized', { status: 401 })
    if (inboxRoute) return request.method === 'GET' ? inbox(env) : new Response('method not allowed', { status: 405 })
    if (pruneRoute) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      return Response.json(await prune(env, pruneRoute[1]!, pruneRoute[2]!))
    }
    if (!route) return new Response('agent-factory', { status: 404 })
    const [, kind, owner = '', repo = '', number, action] = route
    const by = allowedUsers(env)[0] ?? owner
    if (kind === 'develop') {
      if (request.method !== 'POST' || action) return new Response('method not allowed', { status: 405 })
      const options = await bodyOf(request)
      if (options instanceof Response) return options
      const budget = budgetOf(options)
      if (budget instanceof Response) return budget
      return accepted(await issue(env, owner, repo, Number(number)).start({ by, issue: Number(number), owner, repo, ...developOptions(options), ...budget }))
    }
    if (kind === 'research') {
      if (request.method !== 'POST' || action) return new Response('method not allowed', { status: 405 })
      const options = await bodyOf(request)
      if (options instanceof Response) return options
      const budget = budgetOf(options)
      if (budget instanceof Response) return budget
      const { base, parallel } = developOptions(options)
      return accepted(await research(env, owner, repo, Number(number)).start({ by, issue: Number(number), owner, repo, base, parallel, ...budget }))
    }
    const pr = Number(number)
    if (request.method === 'POST' && !action) {
      const options = await bodyOf(request)
      if (options instanceof Response) return options
      const budget = budgetOf(options)
      if (budget instanceof Response) return budget
      return accepted(await pullRequest(env, owner, repo, pr).start({ by, full: options.full === true, owner, pr, repo, ship: options.ship === true, ...budget }))
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
  /** Absent in the events of the App itself, for example ping and installation. */
  repository?: { full_name: string }
  sender?: { login: string }
  issue?: { number: number; pull_request?: unknown }
  comment?: { body: string; user: { login: string } }
  pull_request?: { number: number; head?: { ref: string } }
  label?: { name: string }
  check_suite?: { head_branch: string | null; pull_requests: { number: number }[] }
  check_run?: { check_suite: { head_branch: string | null; pull_requests: { number: number }[] } }
  workflow_run?: { head_branch: string | null; pull_requests: { number: number }[] }
  branches?: { name: string }[]
}

/**
 * GitHub webhooks: `/review` and the agent-review label start a review run on a PR, `/develop` and the agent-develop
 * label start a development run on an issue, `/research` and the agent-research label start a research run on an issue,
 * and `/answer` and CI results (workflow runs, statuses) wake a paused run. An `/answer` on an issue wakes its
 * development run and its research run. A closed PR prunes its factory/* head branch and its review fix branches. Other
 * comment, issue and PR events of the App bot do nothing, so that the posts of a run do not start or wake runs.
 */
async function webhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text()
  const secret = env.GITHUB_APP_WEBHOOK_SECRET || env.GITHUB_WEBHOOK_SECRET
  if (!secret || !(await verifySignature(secret, body, request.headers.get('x-hub-signature-256')))) return new Response('bad signature', { status: 401 })
  const event = request.headers.get('x-github-event')
  const payload = JSON.parse(body) as Payload
  if (!payload.repository) return accepted({ ignored: event })
  const [owner = '', repo = ''] = payload.repository.full_name.split('/')
  const allowed = (login: string | undefined) => allowedUsers(env).some((user) => user.toLowerCase() === login?.toLowerCase())
  // Only a sender that ends with [bot] makes the GET /app request, so human and CI deliveries cost no request.
  const sender = payload.sender?.login.toLowerCase() ?? ''
  // A closed PR still prunes its branches, also when the App merged it: the prune starts and wakes no run.
  const closedPr = event === 'pull_request' && payload.action === 'closed'
  if ((event === 'issue_comment' || event === 'issues' || event === 'pull_request') && !closedPr && sender.endsWith('[bot]') && sender === (await appBotLogin(env, botLogins))?.toLowerCase())
    return accepted({ ignored: 'the App bot' })

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
      const researches = research(env, owner, repo, number)
      if (/^\/develop\b/.test(text)) return accepted(await runs.start({ by, issue: number, owner, repo, ...commandOptions(text) }))
      if (/^\/research\b/.test(text)) {
        const { base, parallel } = commandOptions(text)
        return accepted(await researches.start({ by, issue: number, owner, repo, base, parallel }))
      }
      if (/^\/answer\b/.test(text)) {
        const [developed, researched] = await Promise.all([runs.resume(), researches.resume()])
        return accepted({ resumed: developed.resumed || researched.resumed })
      }
    }
  }
  if (event === 'pull_request' && payload.action === 'labeled' && payload.label?.name === workLabels.review && payload.pull_request && allowed(payload.sender?.login))
    return accepted(await startLabeled(env, 'review', { by: payload.sender!.login, number: payload.pull_request.number, owner, repo }))
  if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request) {
    const { number, head } = payload.pull_request
    const own = head?.ref.startsWith('factory/') ? head.ref : null
    return accepted(await prune(env, owner, repo, (name) => name === own || name.startsWith(`factory/pr-${number}-`)))
  }
  const issueKind = payload.label?.name === workLabels.develop ? 'develop' : payload.label?.name === workLabels.research ? 'research' : null
  if (event === 'issues' && payload.action === 'labeled' && issueKind && payload.issue && !payload.issue.pull_request && allowed(payload.sender?.login))
    return accepted(await startLabeled(env, issueKind, { by: payload.sender!.login, number: payload.issue.number, owner, repo }))
  if (event === 'workflow_run' || event === 'check_suite' || event === 'check_run' || event === 'status') {
    const suite = payload.workflow_run ?? payload.check_suite ?? payload.check_run?.check_suite
    const branches = suite ? [suite.head_branch ?? ''] : (payload.branches ?? []).map((branch) => branch.name)
    const prs = new Set([...(suite?.pull_requests ?? []).map((pull) => pull.number), ...branches.flatMap((branch) => /^factory\/pr-(\d+)-/.exec(branch)?.[1] ?? []).map(Number)])
    for (const pr of prs) await pullRequest(env, owner, repo, pr).resume()
    return accepted({ woke: [...prs] })
  }
  return accepted({ ignored: event })
}
