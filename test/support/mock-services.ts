import { execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Jev } from '../../src/core/gate.ts'
import { scriptedDispatch, type Script, type Turn } from './scripted-model.ts'

export type MockComment = { id: number; user: { login: string }; body: string; created_at: string; html_url: string }
type TreeEntry = { path: string; mode: string; type: string; sha: string | null }

/**
 * GitHub, Anthropic, OpenAI and TypeSafe on one local port, for the Cloudflare host under wrangler dev.
 * GitHub answers from a local fixture repository and records comments, blobs, trees, commits and refs.
 */
export async function mockServices(
  repo: string,
  options: { owner: string; name: string; pr: number; script: Script; jev: Jev; botLogin: string; headRepo?: string },
) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 })
  const headSha = git('rev-parse', 'feature').toString().trim()
  const mergeBase = git('merge-base', 'main', 'feature').toString().trim()
  const turns: Turn[] = []
  const dispatch = scriptedDispatch(options.script, turns)
  const state = {
    turns,
    comments: [] as MockComment[],
    blobs: new Map<string, Buffer>(),
    trees: new Map<string, { base_tree: string; tree: TreeEntry[] }>(),
    commits: new Map<string, { tree: string; parents: string[]; message: string }>(),
    refs: new Map<string, string>(),
    requests: [] as string[],
  }
  let ids = 0
  const comment = (login: string, body: string): MockComment => {
    const id = ++ids
    const at = new Date(Date.now() + id).toISOString()
    const created = { id, user: { login }, body, created_at: at, updated_at: at, html_url: `https://github.com/${options.owner}/${options.name}/pull/${options.pr}#issuecomment-${id}` }
    state.comments.push(created)
    return created
  }
  const api = `/repos/${options.owner}/${options.name}`
  const statusOf = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied' } as Record<string, string>

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

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const body = await read(request)
    const route = `${request.method} ${url.pathname}`
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
      if (route === 'POST /v1/systemone') return json(response, 200, await options.jev(JSON.parse(body.toString())))
      if (route === 'POST /graphql') return json(response, 200, { data: {} })
      if (route === `GET ${api}/pulls/${options.pr}`)
        return json(response, 200, {
          base: { ref: 'main', repo: { full_name: `${options.owner}/${options.name}` } },
          body: 'Add a sub function that subtracts b from a.',
          draft: false,
          head: { ref: 'feature', repo: { full_name: options.headRepo ?? `${options.owner}/${options.name}` }, sha: headSha },
          node_id: 'PR_node',
          title: 'Add sub',
        })
      if (route.startsWith(`GET ${api}/compare/`)) return json(response, 200, { merge_base_commit: { sha: mergeBase } })
      if (route === `GET ${api}/pulls/${options.pr}/files`) {
        const files = git('diff', '--name-status', mergeBase, headSha)
          .toString()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [status = '', first = '', second] = line.split('\t')
            return second ? { filename: second, previous_filename: first, status: statusOf[status[0]!] } : { filename: first, status: statusOf[status[0]!] }
          })
        const page = Number(url.searchParams.get('page') ?? 1)
        const size = Number(url.searchParams.get('per_page') ?? 30)
        return json(response, 200, files.slice((page - 1) * size, page * size))
      }
      if (route.startsWith(`GET ${api}/tarball/`)) {
        const sha = url.pathname.split('/').at(-1)!
        response.writeHead(200, { 'content-type': 'application/x-gzip' })
        response.end(git('archive', '--format=tar.gz', `--prefix=${options.owner}-${options.name}-${sha.slice(0, 7)}/`, sha))
        return
      }
      if (route.startsWith(`GET ${api}/contents/`)) {
        const path = decodeURIComponent(url.pathname.slice(`${api}/contents/`.length))
        const ref = url.searchParams.get('ref')
        const listing = git('ls-tree', ref!, '--', path).toString().trim()
        if (!listing) return json(response, 404, { message: 'Not Found' })
        const content = git('show', `${ref}:${path}`)
        if (request.headers.accept === 'application/vnd.github.raw') {
          response.writeHead(200, { 'content-type': 'application/octet-stream' })
          response.end(content)
          return
        }
        return json(response, 200, listing.startsWith('120000') ? { target: content.toString(), type: 'symlink' } : { type: 'file' })
      }
      if (route === `GET ${api}/issues/${options.pr}/comments`) {
        const page = Number(url.searchParams.get('page') ?? 1)
        const size = Number(url.searchParams.get('per_page') ?? 30)
        return json(response, 200, state.comments.slice((page - 1) * size, page * size))
      }
      if (route === `POST ${api}/issues/${options.pr}/comments`) return json(response, 201, comment(options.botLogin, JSON.parse(body.toString()).body))
      if (route.startsWith(`GET ${api}/git/commits/`)) {
        const sha = url.pathname.split('/').at(-1)!
        const recorded = state.commits.get(sha)
        return json(response, 200, { sha, tree: { sha: recorded?.tree ?? git('rev-parse', `${sha}^{tree}`).toString().trim() } })
      }
      if (route === `POST ${api}/git/blobs`) {
        const sha = `blob${state.blobs.size + 1}`
        state.blobs.set(sha, Buffer.from(JSON.parse(body.toString()).content, 'base64'))
        return json(response, 201, { sha })
      }
      if (route === `POST ${api}/git/trees`) {
        const sha = `tree${state.trees.size + 1}`
        state.trees.set(sha, JSON.parse(body.toString()))
        return json(response, 201, { sha })
      }
      if (route === `POST ${api}/git/commits`) {
        const sha = `commit${state.commits.size + 1}`
        state.commits.set(sha, JSON.parse(body.toString()))
        return json(response, 201, { sha })
      }
      if (route === `POST ${api}/git/refs`) {
        const { ref, sha } = JSON.parse(body.toString()) as { ref: string; sha: string }
        if (state.refs.has(ref)) return json(response, 422, { message: 'Reference already exists' })
        state.refs.set(ref, sha)
        return json(response, 201, { ref })
      }
      if (request.method === 'PATCH' && url.pathname.startsWith(`${api}/git/refs/`)) {
        state.refs.set(`refs/${url.pathname.slice(`${api}/git/refs/`.length)}`, JSON.parse(body.toString()).sha)
        return json(response, 200, {})
      }
      if (route.endsWith('/check-runs'))
        return json(response, 200, {
          check_runs: Number(url.searchParams.get('page') ?? 1) === 1 ? [{ conclusion: 'success', html_url: 'https://ci.example.com/1', name: 'ci', status: 'completed' }] : [],
          total_count: 1,
        })
      if (route.endsWith('/status')) return json(response, 200, { statuses: [] })
      json(response, 404, { message: `mock has no route ${route}` })
    } catch (error) {
      json(response, 500, { message: String(error) })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  /** The content of `path` in the commit that a ref points at, from the trees and blobs that the host created. */
  const fileAt = (ref: string, path: string): string | null => {
    const commit = state.commits.get(state.refs.get(ref) ?? '')
    const entry = commit && state.trees.get(commit.tree)?.tree.find((item) => item.path === path)
    return entry?.sha ? (state.blobs.get(entry.sha)?.toString() ?? null) : null
  }
  return { close: () => server.close(), comment, fileAt, headSha, state, url }
}
