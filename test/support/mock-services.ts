import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedDispatch, type Script, type Turn } from './scripted-model.ts'

export type MockComment = { id: number; issue: number; user: { login: string }; body: string; created_at: string; updated_at: string; html_url: string }
type TreeEntry = { path: string; mode: string; type: string; sha: string | null }
type Pull = { head: string; title: string; body: string; draft: boolean; headRepo?: string }

/**
 * GitHub, Anthropic, OpenAI and a build machine on one local port, for the Cloudflare host under wrangler dev.
 * GitHub answers from a local repository: the Git Data API writes real objects and refs into it, so later
 * tarballs, compares and contents see the host's commits. PRs and issues share one number sequence, as on GitHub.
 * The machine runs each command in a directory of its own, in place of a container.
 */
export async function mockServices(
  repo: string,
  options: { owner: string; name: string; pr?: number; script: Script; botLogin: string; headRepo?: string; issues?: Record<number, { title: string; body: string }> },
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
    /** The commands that the machine ran, with their directories. */
    commands: [] as { argv: string[]; cwd: string }[],
    /** The HTTP status of the workflow-runs endpoint, so that a test can withhold the Actions permission. */
    ciStatus: 200,
  }
  let next = Math.max(100, ...pulls.keys(), ...issues.keys())
  let ids = 0
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
    node_id: `PR_${number}`,
    number,
    title: pull.title,
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
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ exit_code: code, output: output.slice(-20_000) })
      })
      child.stdin.end(body.stdin ? Buffer.from(body.stdin, 'base64') : undefined)
    })

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
    state.requests.push(route)
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
      if (route === 'POST /machine') {
        const { argv, cwd, env, stdin, timeoutMs } = input()
        if (typeof timeoutMs !== 'number') throw new Error(`${route}: timeoutMs must be a number`)
        const environment = Object.fromEntries(Object.entries(object(env, 'env')).map(([key, value]) => [key, string(value, `env.${key}`)]))
        return json(response, 200, await exec({ argv: strings(argv, 'argv'), cwd: string(cwd, 'cwd'), env: environment, stdin: stdin === null ? null : string(stdin, 'stdin'), timeoutMs }))
      }
      if (route === 'POST /graphql') {
        const variables = input().variables
        const id = variables === undefined ? '' : String(object(variables, 'variables').id ?? '')
        const pull = pulls.get(Number(id.replace('PR_', '')))
        if (pull) pull.draft = false
        return json(response, 200, { data: {} })
      }
      if (route === `GET ${api}`) return json(response, 200, { default_branch: 'main' })
      if (route === `GET ${api}/pulls`) {
        const head = url.searchParams.get('head')?.split(':')[1]
        return json(response, 200, [...pulls].filter(([, pull]) => pull.head === head).map(([number, pull]) => view(number, pull)))
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
        const entries = text(['ls-tree', url.searchParams.get('ref')!])
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [meta = '', name = ''] = line.split('\t')
            const [mode, type] = meta.split(' ')
            return { name, path: name, type: type === 'tree' ? 'dir' : type === 'commit' ? 'submodule' : mode === '120000' ? 'symlink' : 'file' }
          })
        return json(response, 200, entries)
      }
      if (route.startsWith(`GET ${api}/contents/`)) {
        const path = decodeURIComponent(url.pathname.slice(`${api}/contents/`.length))
        const ref = url.searchParams.get('ref')!
        const listing = text(['ls-tree', ref, '--', path])
        if (!listing) return json(response, 404, { message: 'Not Found' })
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
  return { close: () => server.close(), comment, fileAt, headSha: shaOf('feature'), machineRoot, state, url }
}
