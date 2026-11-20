import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandResult, type BoxResult, type JobState } from '../../src/cloudflare/box.ts'
import { probeOutputTokens } from '../../src/core/preflight.ts'
import type { Provider } from '../../src/core/providers.ts'
import { scriptedDispatch, type Script, type Turn } from './scripted-model.ts'

export type MockComment = { id: number; issue: number; user: { login: string }; body: string; created_at: string; updated_at: string; html_url: string }
type TreeEntry = { path: string; mode: string; type: string; sha: string | null }
/** `merged` is the merge commit, after the host merged the PR. `closed` is a PR closed without a merge. */
type Pull = { head: string; title: string; body: string; draft: boolean; headRepo?: string; merged?: string; closed?: boolean }

/** The provider probe of the preflight in a request, or null: a request without a stream, with the probe output limit (D17). */
function probeOf(route: string, body: Buffer): { provider: Provider; model: string } | null {
  if (route !== 'POST /v1/messages' && route !== 'POST /v1/responses') return null
  let fields: { model?: unknown; max_tokens?: unknown; max_output_tokens?: unknown; stream?: unknown }
  try {
    fields = JSON.parse(body.toString()) as typeof fields
  } catch {
    return null
  }
  const [provider, limit] = route === 'POST /v1/messages' ? (['claude', fields.max_tokens] as const) : (['codex', fields.max_output_tokens] as const)
  return limit === probeOutputTokens[provider] && !fields.stream ? { model: String(fields.model), provider } : null
}

/**
 * GitHub, Anthropic, OpenAI and a build machine on one local port, for the Cloudflare host under wrangler dev.
 * GitHub answers from a local repository: the Git Data API writes real objects and refs into it, so later
 * tarballs, compares and contents see the host's commits. PRs and issues share one number sequence, as on GitHub.
 * The machine runs each command in a directory of its own, in place of a container. The egress route stands in for
 * the hosts of a research notebook: it answers each page with `pages`.
 */
export async function mockServices(
  repo: string,
  options: {
    owner: string
    name: string
    pr?: number
    script: Script
    botLogin: string
    headRepo?: string
    issues?: Record<number, { title: string; body: string }>
    /** A GitHub App: its slug, whether it is installed on the repository, and the life of its installation tokens. */
    app?: { slug: string; installed: boolean; expiresInSeconds?: number }
    /** The text of each page that the egress route answers, by path. */
    pages?: (path: string) => string
  },
) {
  const git = (args: string[], input?: Buffer, env: Record<string, string> = {}) =>
    execFileSync('git', args, { cwd: repo, env: { ...process.env, ...env }, input, maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' })
  const text = (args: string[], input?: Buffer, env?: Record<string, string>) => git(args, input, env).toString().trim()
  const shaOf = (ref: string) => {
    try {
      return text(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    } catch {
      return null
    }
  }
  const turns: Turn[] = []
  const dispatch = scriptedDispatch(options.script, turns)
  const pulls = new Map<number, Pull>()
  if (options.pr) pulls.set(options.pr, { body: 'Add a sub function that subtracts b from a.', draft: false, head: 'feature', headRepo: options.headRepo, title: 'Add sub' })
  const issues = new Map(Object.entries(options.issues ?? {}).map(([number, issue]) => [Number(number), issue]))
  const state = {
    turns,
    comments: [] as MockComment[],
    pulls,
    /** The refs that the host set, with their commits. */
    refs: new Map<string, string>(),
    requests: [] as string[],
    /** The authorization header of each request, so that a test can see which credential the host used. */
    authorizations: [] as { route: string; authorization: string }[],
    /** The commands that the machine ran, with their directories. A job start is also here. */
    commands: [] as { argv: string[]; cwd: string }[],
    /** The jobs that the machine started, so that a test can count the starts of a command. */
    jobs: [] as { id: string; argv: string[]; cwd: string }[],
    /** True for a command whose job the machine loses at start. */
    loseJob: (_argv: string[]) => false,
    /** The HTTP status of the workflow-runs endpoint, so that a test can withhold the Actions permission. */
    ciStatus: 200,
    /** The PR merges that the host made, with the squash commit on main of each. */
    merges: [] as { pr: number; method: string; sha: string; commit: string }[],
    /** The branches that the host deleted. Their entries stay in refs, so that fileAt still reads them. */
    deleted: [] as string[],
    /** The requests that reached the egress route: the URL that the run fetched, and its x-api-key header. */
    egress: [] as { url: string; key: string | null }[],
    /** The provider probes of the preflight. They are not in requests or turns, so that the counts of model calls stay. */
    probes: [] as { provider: Provider; model: string }[],
    /** The answer to the probes of each provider, so that a test can make a provider refuse its key. */
    probeReply: {
      claude: { status: 200, body: { content: [], id: 'msg_probe', model: 'probe', role: 'assistant', type: 'message' } },
      codex: { status: 200, body: { id: 'resp_probe', object: 'response', output: [], status: 'completed' } },
    } as Record<Provider, { status: number; body: unknown }>,
    /** False makes the listing of .github/workflows 404. True lists ci.yml when the repository has no such directory. */
    workflows: true,
  }
  let next = Math.max(100, ...pulls.keys(), ...issues.keys())
  let ids = 0
  let installationTokens = 0
  const comment = (login: string, body: string, issue = options.pr ?? 0): MockComment => {
    const id = ++ids
    const at = new Date(Date.now() + id).toISOString()
    const kind = pulls.has(issue) ? 'pull' : 'issues'
    const created = { body, created_at: at, html_url: `https://github.com/${options.owner}/${options.name}/${kind}/${issue}#issuecomment-${id}`, id, issue, updated_at: at, user: { login } }
    state.comments.push(created)
    return created
  }
  const api = `/repos/${options.owner}/${options.name}`
  const statusOf = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied' } as Record<string, string>
  const changes = (from: string, to: string) =>
    text(['diff', '--name-status', from, to])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status = '', first = '', second] = line.split('\t')
        return second ? { filename: second, previous_filename: first, status: statusOf[status[0]!] } : { filename: first, status: statusOf[status[0]!] }
      })
  const view = (number: number, pull: Pull) => ({
    base: { ref: 'main', repo: { full_name: `${options.owner}/${options.name}` } },
    body: pull.body,
    draft: pull.draft,
    head: { ref: pull.head, repo: { full_name: pull.headRepo ?? `${options.owner}/${options.name}` }, sha: shaOf(pull.head) },
    html_url: `https://github.com/${options.owner}/${options.name}/pull/${number}`,
    merge_commit_sha: pull.merged ?? null,
    merged: pull.merged !== undefined,
    merged_at: pull.merged === undefined ? null : '2026-11-16T12:00:00Z',
    node_id: `PR_${number}`,
    number,
    state: pull.merged === undefined && !pull.closed ? 'open' : 'closed',
    title: pull.title,
  })
  /** The entries of a directory at a ref, as the contents API lists them: the root, or the directory at `dir`. */
  const entriesAt = (ref: string, dir?: string) =>
    text(['ls-tree', ref, ...(dir ? ['--', `${dir}/`] : [])])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [meta = '', path = ''] = line.split('\t')
        const [mode, type] = meta.split(' ')
        return { name: path.slice(path.lastIndexOf('/') + 1), path, type: type === 'tree' ? 'dir' : type === 'commit' ? 'submodule' : mode === '120000' ? 'symlink' : 'file' }
      })
  const machineRoot = mkdtempSync(join(tmpdir(), 'factory-machine-'))

  const read = (request: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => resolve(Buffer.concat(chunks)))
    })
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  const page = <T>(url: URL, items: T[]) => {
    const number = Number(url.searchParams.get('page') ?? 1)
    const size = Number(url.searchParams.get('per_page') ?? 30)
    return items.slice((number - 1) * size, number * size)
  }

  /** The running commands of the machine, with their time limits, so that close() can kill them. */
  const machines = new Map<ChildProcess, NodeJS.Timeout>()
  /** Runs one command of the machine: argv in a directory under the machine's root, with stdin and a time limit. */
  const exec = (body: { argv: string[]; cwd: string; env: Record<string, string>; stdin: string | null; timeoutMs: number }) =>
    new Promise<{ exit_code: number | null; output: string }>((resolve) => {
      state.commands.push({ argv: body.argv, cwd: body.cwd })
      const cwd = join(machineRoot, body.cwd)
      mkdirSync(cwd, { recursive: true })
      const child = spawn(body.argv[0]!, body.argv.slice(1), { cwd, env: { ...body.env, PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
      const timer = setTimeout(() => child.kill('SIGKILL'), body.timeoutMs)
      machines.set(child, timer)
      child.on('close', (code) => {
        clearTimeout(timer)
        machines.delete(child)
        resolve({ exit_code: code, output: output.slice(-20_000) })
      })
      child.stdin.end(body.stdin ? Buffer.from(body.stdin, 'base64') : undefined)
    })

  /**
   * The jobs of the machine. They belong to this test process, not to workerd, so they live through a restart of
   * wrangler dev. A job keeps its output and its result, so that a poll after its start request finds them.
   */
  const jobs = new Map<string, { child: ChildProcess; output: string; result: BoxResult | null; timer: NodeJS.Timeout }>()
  /** Kills the process group of a job: the job runs detached, so its pid is its group. */
  const killGroup = (child: ChildProcess) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
    } catch {
      // The group is gone.
    }
  }
  const startJob = (body: { id: string; argv: string[]; cwd: string; env: Record<string, string>; timeoutMs: number }) => {
    if (jobs.has(body.id)) throw new Error(`the job ${body.id} started before`)
    state.jobs.push({ argv: body.argv, cwd: body.cwd, id: body.id })
    state.commands.push({ argv: body.argv, cwd: body.cwd })
    if (state.loseJob(body.argv)) return
    const cwd = join(machineRoot, body.cwd)
    mkdirSync(cwd, { recursive: true })
    const started = Date.now()
    const child = spawn(body.argv[0]!, body.argv.slice(1), { cwd, detached: true, env: { ...body.env, PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    // The test process does not wait for a job when it ends.
    child.unref()
    const job = { child, output: '', result: null as BoxResult | null, timer: setTimeout(() => killGroup(child), body.timeoutMs) }
    jobs.set(body.id, job)
    const append = (chunk: Buffer) => (job.output = (job.output + chunk.toString()).slice(-20_000))
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (error) => {
      clearTimeout(job.timer)
      job.result ??= { exit_code: 127, output: String(error) }
    })
    child.on('close', (code, signal) => {
      clearTimeout(job.timer)
      job.result ??= commandResult(code ?? 128 + (signal ? constants.signals[signal] : 0), job.output, Date.now() - started, body.timeoutMs)
    })
  }
  const pollJob = (id: string): JobState => {
    const job = jobs.get(id)
    if (!job) return { state: 'missing' }
    return job.result ? { result: job.result, state: 'done' } : { state: 'running' }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const body = await read(request)
    const route = `${request.method} ${url.pathname}`
    const object = (value: unknown, name: string): Record<string, unknown> => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${route}: ${name} must be an object`)
      return value as Record<string, unknown>
    }
    /** The JSON body as an object. A route reads each field with the checks below, so a wrong request shape fails the request. */
    const input = () => object(JSON.parse(body.toString()), 'the body')
    const string = (value: unknown, name: string): string => {
      if (typeof value !== 'string') throw new Error(`${route}: ${name} must be a string`)
      return value
    }
    const strings = (value: unknown, name: string): string[] => {
      if (!Array.isArray(value)) throw new Error(`${route}: ${name} must be an array`)
      return value.map((item, index) => string(item, `${name}[${index}]`))
    }
    const probe = probeOf(route, body)
    if (probe) {
      state.probes.push(probe)
      const reply = state.probeReply[probe.provider]
      return json(response, reply.status, reply.body)
    }
    state.requests.push(route)
    state.authorizations.push({ authorization: request.headers.authorization ?? '', route })
    try {
      if (route === 'POST /v1/messages' || route === 'POST /v1/responses') {
        const reply = await dispatch(
          { body: new Uint8Array(body), endpoint: url.href, headers: [], method: 'POST', origin: null, provider: route.endsWith('messages') ? 'claude' : 'codex', subagent: null },
          new AbortController().signal,
          {} as never,
        )
        response.writeHead(reply.status, { 'content-type': 'text/event-stream' })
        response.end(await reply.text())
        return
      }
      if (route === 'POST /machine/jobs/start') {
        const { argv, cwd, env, id, timeoutMs } = input()
        if (typeof timeoutMs !== 'number') throw new Error(`${route}: timeoutMs must be a number`)
        const environment = Object.fromEntries(Object.entries(object(env, 'env')).map(([key, value]) => [key, string(value, `env.${key}`)]))
        startJob({ argv: strings(argv, 'argv'), cwd: string(cwd, 'cwd'), env: environment, id: string(id, 'id'), timeoutMs })
        return json(response, 200, {})
      }
      if (route === 'POST /machine/jobs/poll') return json(response, 200, pollJob(string(input().id, 'id')))
      if (route === 'POST /machine/jobs/kill') {
        const job = jobs.get(string(input().id, 'id'))
        if (job && !job.result) killGroup(job.child)
        return json(response, 200, {})
      }
      if (route === 'POST /machine') {
        const { argv, cwd, env, stdin, timeoutMs } = input()
        if (typeof timeoutMs !== 'number') throw new Error(`${route}: timeoutMs must be a number`)
        const environment = Object.fromEntries(Object.entries(object(env, 'env')).map(([key, value]) => [key, string(value, `env.${key}`)]))
        return json(response, 200, await exec({ argv: strings(argv, 'argv'), cwd: string(cwd, 'cwd'), env: environment, stdin: stdin === null ? null : string(stdin, 'stdin'), timeoutMs }))
      }
      if (request.method === 'GET' && url.pathname.startsWith('/egress/')) {
        const [host = '', ...rest] = url.pathname.slice('/egress/'.length).split('/')
        const path = `/${rest.join('/')}`
        const key = request.headers['x-api-key']
        state.egress.push({ key: typeof key === 'string' ? key : null, url: `https://${host}${path}${url.search}` })
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end((options.pages ?? ((page: string) => `page ${page}`))(path))
        return
      }
      if (route === 'POST /graphql') {
        const variables = input().variables
        const id = variables === undefined ? '' : String(object(variables, 'variables').id ?? '')
        const pull = pulls.get(Number(id.replace('PR_', '')))
        if (pull) pull.draft = false
        return json(response, 200, { data: {} })
      }
      if (route === `GET ${api}`) return json(response, 200, { default_branch: 'main' })
      // No ruleset requires signatures. The classic protection keeps the default 404: no requirement.
      if (route.startsWith(`GET ${api}/rules/branches/`)) return json(response, 200, [])
      if (route === `GET ${api}/installation`) return options.app?.installed ? json(response, 200, { id: 42 }) : json(response, 404, { message: 'Not Found' })
      if (options.app && route === 'GET /app') return json(response, 200, { slug: options.app.slug })
      if (options.app?.installed && route === 'POST /app/installations/42/access_tokens') {
        const expires_at = new Date(Date.now() + (options.app.expiresInSeconds ?? 3_600) * 1_000).toISOString()
        return json(response, 201, { expires_at, token: `ghs_installation${++installationTokens}` })
      }
      if (route === `GET ${api}/pulls`) {
        const head = url.searchParams.get('head')?.split(':')[1]
        const wanted = url.searchParams.get('state') ?? 'open'
        const listed = [...pulls].filter(([, pull]) => pull.head === head).map(([number, pull]) => view(number, pull))
        return json(response, 200, wanted === 'all' ? listed : listed.filter((pull) => pull.state === wanted))
      }
      if (route === `POST ${api}/pulls`) {
        const fields = input()
        const head = string(fields.head, 'head')
        if (fields.base !== 'main' || !shaOf(head)) return json(response, 422, { message: 'Validation Failed' })
        const number = ++next
        pulls.set(number, { body: string(fields.body, 'body'), draft: fields.draft === true, head, title: string(fields.title, 'title') })
        return json(response, 201, view(number, pulls.get(number)!))
      }
      const pullRoute = new RegExp(`^GET ${api}/pulls/(\\d+)(/files)?$`).exec(route)
      if (pullRoute && pulls.has(Number(pullRoute[1]))) {
        const pull = pulls.get(Number(pullRoute[1]))!
        if (!pullRoute[2]) return json(response, 200, view(Number(pullRoute[1]), pull))
        const head = shaOf(pull.head)!
        return json(response, 200, page(url, changes(text(['merge-base', 'main', head]), head)))
      }
      const mergeRoute = new RegExp(`^PUT ${api}/pulls/(\\d+)/merge$`).exec(route)
      if (mergeRoute && pulls.has(Number(mergeRoute[1]))) {
        const number = Number(mergeRoute[1])
        const pull = pulls.get(number)!
        const fields = input()
        const method = string(fields.merge_method, 'merge_method')
        if (!['squash', 'merge', 'rebase'].includes(method)) throw new Error(`${route}: merge_method must be squash, merge or rebase`)
        const sha = string(fields.sha, 'sha')
        if (pull.merged) return json(response, 405, { message: 'Pull Request is not mergeable' })
        if (sha !== shaOf(pull.head)) return json(response, 409, { message: 'Head branch was modified. Review and try the merge again.' })
        if (pull.draft) return json(response, 405, { message: 'Pull Request is still a draft' })
        // Every method merges as a squash: the tests read only the tree on main.
        const identity = { GIT_AUTHOR_EMAIL: 'bot@example.com', GIT_AUTHOR_NAME: 'bot', GIT_COMMITTER_EMAIL: 'bot@example.com', GIT_COMMITTER_NAME: 'bot' }
        const commit = text(['commit-tree', `${sha}^{tree}`, '-p', shaOf('main')!, '-m', `${pull.title} (#${number})`], undefined, identity)
        git(['update-ref', 'refs/heads/main', commit])
        pull.merged = commit
        state.merges.push({ commit, method, pr: number, sha })
        return json(response, 200, { merged: true, message: 'Pull Request successfully merged', sha: commit })
      }
      const issueRoute = new RegExp(`^GET ${api}/issues/(\\d+)$`).exec(route)
      if (issueRoute) {
        const number = Number(issueRoute[1])
        if (pulls.has(number)) return json(response, 200, { body: pulls.get(number)!.body, pull_request: {}, title: pulls.get(number)!.title })
        if (issues.has(number)) return json(response, 200, issues.get(number))
        return json(response, 404, { message: 'Not Found' })
      }
      if (route.startsWith(`GET ${api}/compare/`)) {
        const [from = '', to = ''] = decodeURIComponent(url.pathname.slice(`${api}/compare/`.length)).split('...')
        const head = shaOf(to)!
        const base = text(['merge-base', shaOf(from)!, head])
        return json(response, 200, { files: changes(shaOf(from)!, head), merge_base_commit: { sha: base } })
      }
      if (route.startsWith(`GET ${api}/tarball/`)) {
        const sha = url.pathname.split('/').at(-1)!
        response.writeHead(200, { 'content-type': 'application/x-gzip' })
        response.end(git(['archive', '--format=tar.gz', `--prefix=${options.owner}-${options.name}-${sha.slice(0, 7)}/`, sha]))
        return
      }
      if (route === `GET ${api}/contents`) {
        // The root listing: the profiles look for their markers and lockfiles here.
        return json(response, 200, entriesAt(url.searchParams.get('ref')!))
      }
      if (route.startsWith(`GET ${api}/contents/`)) {
        const path = decodeURIComponent(url.pathname.slice(`${api}/contents/`.length))
        const ref = url.searchParams.get('ref')!
        const listing = text(['ls-tree', ref, '--', path])
        // The fixture repositories have no workflow files, and the Node tests share them, so the mock lists one.
        if (path === '.github/workflows' && !state.workflows) return json(response, 404, { message: 'Not Found' })
        if (path === '.github/workflows' && !listing) return json(response, 200, [{ name: 'ci.yml', path: '.github/workflows/ci.yml', type: 'file' }])
        if (!listing) return json(response, 404, { message: 'Not Found' })
        // A directory gives the array of its entries, as on GitHub.
        if (request.headers.accept !== 'application/vnd.github.raw' && listing.split(/\s/)[1] === 'tree') return json(response, 200, entriesAt(ref, path))
        const content = git(['show', `${ref}:${path}`])
        if (request.headers.accept === 'application/vnd.github.raw') {
          response.writeHead(200, { 'content-type': 'application/octet-stream' })
          response.end(content)
          return
        }
        return json(response, 200, listing.startsWith('120000') ? { target: content.toString(), type: 'symlink' } : { type: 'file' })
      }
      const comments = new RegExp(`^(GET|POST) ${api}/issues/(\\d+)/comments$`).exec(route)
      if (comments?.[1] === 'GET') return json(response, 200, page(url, state.comments.filter((entry) => entry.issue === Number(comments[2]))))
      if (comments?.[1] === 'POST') return json(response, 201, comment(options.botLogin, string(input().body, 'body'), Number(comments[2])))
      if (route.startsWith(`GET ${api}/git/commits/`)) {
        const sha = url.pathname.split('/').at(-1)!
        return json(response, 200, { sha, tree: { sha: text(['rev-parse', `${sha}^{tree}`]) } })
      }
      if (route.startsWith(`GET ${api}/git/matching-refs/heads/`)) {
        const prefix = decodeURIComponent(url.pathname.slice(`${api}/git/matching-refs/`.length))
        const refs = text(['for-each-ref', '--format=%(refname) %(objectname)', `refs/${prefix.replace(/\/$/, '')}`])
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split(' '))
          .filter(([ref = '']) => ref.startsWith(`refs/${prefix}`))
          .map(([ref, sha]) => ({ object: { sha, type: 'commit' }, ref }))
        return json(response, 200, page(url, refs))
      }
      if (route.startsWith(`GET ${api}/git/ref/heads/`)) {
        const name = decodeURIComponent(url.pathname.slice(`${api}/git/ref/heads/`.length))
        const sha = shaOf(`refs/heads/${name}`)
        return sha ? json(response, 200, { object: { sha }, ref: `refs/heads/${name}` }) : json(response, 404, { message: 'Not Found' })
      }
      if (route === `POST ${api}/git/blobs`) return json(response, 201, { sha: text(['hash-object', '-w', '--stdin'], Buffer.from(string(input().content, 'content'), 'base64')) })
      if (route === `POST ${api}/git/trees`) {
        const fields = input()
        const base_tree = string(fields.base_tree, 'base_tree')
        if (!Array.isArray(fields.tree)) throw new Error(`${route}: tree must be an array`)
        const tree = fields.tree.map((value: unknown, position): TreeEntry => {
          const entry = object(value, `tree[${position}]`)
          return { mode: string(entry.mode, 'mode'), path: string(entry.path, 'path'), sha: entry.sha === null ? null : string(entry.sha, 'sha'), type: string(entry.type, 'type') }
        })
        const index = join(mkdtempSync(join(tmpdir(), 'factory-index-')), 'index')
        const env = { GIT_INDEX_FILE: index }
        git(['read-tree', base_tree], undefined, env)
        for (const entry of tree)
          git(entry.sha ? ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.sha},${entry.path}`] : ['update-index', '--force-remove', entry.path], undefined, env)
        const sha = text(['write-tree'], undefined, env)
        rmSync(index, { force: true })
        return json(response, 201, { sha })
      }
      if (route === `POST ${api}/git/commits`) {
        const fields = input()
        const [message, parents, tree] = [string(fields.message, 'message'), strings(fields.parents, 'parents'), string(fields.tree, 'tree')]
        const identity = { GIT_AUTHOR_EMAIL: 'bot@example.com', GIT_AUTHOR_NAME: 'bot', GIT_COMMITTER_EMAIL: 'bot@example.com', GIT_COMMITTER_NAME: 'bot' }
        return json(response, 201, { sha: text(['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message], undefined, identity) })
      }
      if (route === `POST ${api}/git/refs`) {
        const fields = input()
        const [ref, sha] = [string(fields.ref, 'ref'), string(fields.sha, 'sha')]
        if (shaOf(ref)) return json(response, 422, { message: 'Reference already exists' })
        git(['update-ref', ref, sha])
        state.refs.set(ref, sha)
        return json(response, 201, { ref })
      }
      if (route.startsWith(`DELETE ${api}/git/refs/heads/`)) {
        const name = decodeURIComponent(url.pathname.slice(`${api}/git/refs/heads/`.length))
        if (!shaOf(`refs/heads/${name}`)) return json(response, 422, { message: 'Reference does not exist' })
        git(['update-ref', '-d', `refs/heads/${name}`])
        state.deleted.push(name)
        response.writeHead(204)
        response.end()
        return
      }
      if (request.method === 'PATCH' && url.pathname.startsWith(`${api}/git/refs/`)) {
        const ref = `refs/${decodeURIComponent(url.pathname.slice(`${api}/git/refs/`.length))}`
        const fields = input()
        const [force, sha] = [fields.force === true, string(fields.sha, 'sha')]
        const current = shaOf(ref)
        if (!force && current && text(['merge-base', current, sha]) !== current) return json(response, 422, { message: 'Update is not a fast forward' })
        git(['update-ref', ref, sha])
        state.refs.set(ref, sha)
        return json(response, 200, {})
      }
      if (route === `GET ${api}/actions/runs` && state.ciStatus !== 200) return json(response, state.ciStatus, { message: 'Resource not accessible by personal access token' })
      if (route === `GET ${api}/actions/runs`) {
        const created_at = new Date().toISOString()
        const run = (id: number, conclusion: string) => ({ conclusion, created_at, event: 'push', html_url: `https://github.com/ci/${id}`, id, name: 'CI', status: 'completed', workflow_id: 1 })
        // An earlier failed run of the same workflow and event, then its successful rerun: only the latest counts.
        return json(response, 200, { total_count: 2, workflow_runs: Number(url.searchParams.get('page') ?? 1) === 1 ? [run(1, 'failure'), run(2, 'success')] : [] })
      }
      if (route.endsWith('/status')) return json(response, 200, { statuses: [] })
      json(response, 404, { message: `mock has no route ${route}` })
    } catch (error) {
      json(response, 500, { message: String(error) })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  /** The content of `path` in the commit that a ref points at, or null. */
  const fileAt = (ref: string, path: string): string | null => {
    try {
      return git(['show', `${state.refs.get(ref) ?? ref}:${path}`]).toString()
    } catch {
      return null
    }
  }
  /** Sets a PR to merged or to closed without a merge, as the user does on GitHub. A merged PR does not change main. */
  const closePull = (number: number, merged: boolean) => {
    const pull = pulls.get(number)
    if (!pull) throw new Error(`mock has no PR ${number}`)
    if (merged) pull.merged = shaOf(pull.head)!
    else pull.closed = true
  }
  /**
   * Kills the running commands and jobs of the machine and closes the server with all its connections, also the
   * keep-alive connections of workerd. Resolves when the server closed. A second call gives the same promise.
   */
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= new Promise<void>((resolve, reject) => {
      for (const [child, timer] of machines) {
        clearTimeout(timer)
        child.kill('SIGKILL')
        // A grandchild can hold the pipes after the child exits.
        for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.destroy()
      }
      machines.clear()
      for (const job of jobs.values()) {
        clearTimeout(job.timer)
        if (job.result) continue
        killGroup(job.child)
        for (const pipe of [job.child.stdout, job.child.stderr]) pipe?.destroy()
      }
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    }))
  return { close, closePull, comment, fileAt, headSha: shaOf('feature'), machineRoot, state, url }
}
