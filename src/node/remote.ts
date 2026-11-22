import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { parseParallel } from '../core/plan.ts'
import { StopError } from '../core/stop.ts'
import { parseBudget } from '../core/usage.ts'

const usage = `Usage: npm run remote -- <command> [<number or repo>] [options]

Drives the Cloudflare Worker without the GitHub webhook.

Commands:
  start <pr>        Start a review run on the PR (--ship: on PASS, push the fixes to the PR branch and mark it ready;
                    --full: the strict loop, also when triage allows the light or the standard loop)
  develop <issue>   Start a development run on the issue: its title and body are the ask (--base <branch>,
                    --hotfix, --full, --parallel <n>, as in npm run develop)
  research <issue>  Start a research run on the program issue: its title and body are the program (--base <branch>,
                    --parallel <n>)
  resume <number>   Wake a paused run of the PR or issue now, for example after you answered its questions, and
                    print the state of the latest run and the reason (exit 1 when the run does not wake)
  status <number>   Print the runs of the PR or issue
  report <number>   Print the report of the latest run
  prune <repo>      Delete the factory/* branches that are merged, applied or stranded, and print each deleted,
                    kept and failed branch (exit 0 also with failed deletes)
  inbox             Print the items on all repositories of the GitHub App that wait for you: open questions, failed,
                    blocked and stopped runs, and ready PRs to merge

<pr>, <issue> and <number> are owner/repo#123, or a GitHub PR or issue URL. <repo> is owner/repo, or its GitHub URL.

start, develop and research also take --budget <usd>, the cost budget of the run in USD. At the budget, the run puts
a notice into its status comment. At two times the budget, it asks on the PR or issue to raise the budget or to stop.

Environment: FACTORY_URL and ADMIN_TOKEN, or the same keys in .secrets/cloudflare.env.`

const secretsFile = new URL('../../.secrets/cloudflare.env', import.meta.url)

export function parseTarget(text: string): { owner: string; repo: string; pr: number } {
  const match = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:#|\/pull\/|\/issues\/)(\d+)\/?$/.exec(text.trim())
  if (!match) throw new StopError(`${text} is not owner/repo#123 or a GitHub PR or issue URL`)
  return { owner: match[1]!, pr: Number(match[3]), repo: match[2]! }
}

export function parseRepo(text: string): { owner: string; repo: string } {
  const match = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(text.trim())
  if (!match) throw new StopError(`${text} is not owner/repo or a GitHub repository URL`)
  return { owner: match[1]!, repo: match[2]! }
}

/**
 * Gives the lines and the exit code for a prune response: one line for each deleted, kept and failed branch. A failed
 * delete does not change the exit code. A failed route, or a body without the three valid lists, gives the raw text and exit code 1.
 */
export function pruneOutcome({ ok, text }: { ok: boolean; text: string }): { code: number; text: string } {
  if (!ok) return { code: 1, text }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { code: 1, text }
  }
  // The detail is the rule of a deleted branch, else the reason.
  type Entry = { name: string; detail: string }
  const list = (key: string, detail: string, valid = (_value: string) => true): Entry[] | null => {
    const value = typeof body === 'object' && body !== null && key in body ? (body as Record<string, unknown>)[key] : undefined
    if (!Array.isArray(value)) return null
    const entries = value.map((item: unknown) => {
      if (typeof item !== 'object' || item === null) return null
      const fields = item as Record<string, unknown>
      const [name, info] = [fields.name, fields[detail]]
      return typeof name === 'string' && typeof info === 'string' && valid(info) ? { name, detail: info } : null
    })
    return entries.every((entry): entry is Entry => entry !== null) ? entries : null
  }
  const deleted = list('deleted', 'rule', (rule) => ['merged', 'applied', 'stranded'].includes(rule))
  const [kept, failed] = [list('kept', 'reason'), list('failed', 'reason')]
  if (!deleted || !kept || !failed) return { code: 1, text }
  const lines = [
    ...deleted.map((branch) => `deleted ${branch.name} (${branch.detail})`),
    ...kept.map((branch) => `kept ${branch.name}: ${branch.detail}`),
    ...failed.map((branch) => `failed ${branch.name}: ${branch.detail}`),
  ]
  return { code: 0, text: lines.length > 0 ? lines.join('\n') : 'no factory/* branches' }
}

const inboxKinds = ['question', 'failed', 'blocked', 'error', 'ready']

/**
 * Gives the lines and the exit code for an inbox response: one line for each item and each skipped entry. A failed
 * route, or a body without the two valid lists, gives the raw text and exit code 1.
 */
export function inboxOutcome({ ok, text }: { ok: boolean; text: string }): { code: number; text: string } {
  if (!ok) return { code: 1, text }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { code: 1, text }
  }
  const fields = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
  const list = (key: string): Record<string, unknown>[] | null => {
    const value = fields(body)?.[key]
    if (!Array.isArray(value)) return null
    const entries = value.map(fields)
    return entries.every((entry) => entry !== null) ? entries : null
  }
  const [items, skipped] = [list('items'), list('skipped')]
  if (!items || !skipped) return { code: 1, text }
  const lines: string[] = []
  for (const { kind, repository, number, cause, link } of items) {
    if (typeof kind !== 'string' || !inboxKinds.includes(kind) || typeof repository !== 'string' || !Number.isInteger(number) || typeof cause !== 'string' || typeof link !== 'string')
      return { code: 1, text }
    lines.push(`${kind} ${repository}#${String(number)}: ${cause}${link ? ` ${link}` : ''}`)
  }
  for (const { what, reason } of skipped) {
    if (typeof what !== 'string' || typeof reason !== 'string') return { code: 1, text }
    lines.push(`skipped ${what}: ${reason}`)
  }
  return { code: 0, text: lines.length > 0 ? lines.join('\n') : 'nothing waits for you' }
}

/**
 * Gives the text and the exit code for a resume response.
 * A body without a boolean `resumed` gives the raw text and exit code 1.
 * When `resumed` is a boolean, the exit code is 0 for true and 1 for false.
 * If `state` or `reason` is missing or has an incorrect type, the function gives the raw text.
 * For example, a Worker of an earlier version can return `{ resumed }`.
 */
export function resumeOutcome(text: string): { code: number; text: string } {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { code: 1, text }
  }
  if (typeof body !== 'object' || body === null || !('resumed' in body) || typeof body.resumed !== 'boolean') return { code: 1, text }
  const code = body.resumed ? 0 : 1
  const state = 'state' in body ? body.state : undefined
  const reason = 'reason' in body ? body.reason : undefined
  if (typeof reason !== 'string' || (state !== null && typeof state !== 'string')) return { code, text }
  // The state is the state before the call: a resumed run is queued or running now.
  return { code, text: `${body.resumed ? 'resumed: latest run was' : 'not resumed: latest run is'} ${state ?? 'none'}: ${reason}` }
}

/** A setting from the environment, else from .secrets/cloudflare.env. */
export function optionalSetting(name: string): string | undefined {
  const fromFile = existsSync(secretsFile)
    ? Object.fromEntries(
        readFileSync(secretsFile, 'utf8')
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      )[name]
    : undefined
  return process.env[name] ?? fromFile
}

export function setting(name: string): string {
  const value = optionalSetting(name)
  if (!value) throw new StopError(`set ${name}, in the environment or in .secrets/cloudflare.env`)
  return value
}

export type RemoteOptions = { base?: string; budget?: string; full?: boolean; hotfix?: boolean; parallel?: string; ship?: boolean }

export type RemoteRequest = { body?: string; method: 'GET' | 'POST'; path: string }

/** Checks the options of a command and gives its request to the Worker. A bad option stops before any network call. */
export function remoteRequest(command: string, target: string | undefined, options: RemoteOptions): RemoteRequest {
  if (options.budget !== undefined && command !== 'start' && command !== 'develop' && command !== 'research')
    throw new StopError('only start, develop and research take --budget')
  if (command === 'inbox') {
    if (target !== undefined) throw new StopError('inbox takes no target: it lists all repositories of the GitHub App')
    return { method: 'GET', path: '/inbox' }
  }
  if (target === undefined) throw new StopError(`${command} needs a target\n\n${usage}`)
  if (command === 'research')
    for (const flag of ['hotfix', 'full', 'ship'] as const) if (options[flag]) throw new StopError(`research does not take --${flag}`)
  if (command === 'prune') {
    const { owner, repo } = parseRepo(target)
    return { method: 'POST', path: `/prune/${owner}/${repo}` }
  }
  const { owner, repo, pr } = parseTarget(target)
  const budget = options.budget !== undefined ? { budget: parseBudget(options.budget) } : {}
  const parallel = options.parallel !== undefined ? parseParallel(options.parallel) : undefined
  const runs = `/runs/${owner}/${repo}/${pr}`
  const post = (to: string, body: object): RemoteRequest => ({ body: JSON.stringify(body), method: 'POST', path: to })
  const requests: Record<string, () => RemoteRequest> = {
    develop: () => post(`/develop/${owner}/${repo}/${pr}`, { base: options.base, full: options.full === true, hotfix: options.hotfix === true, parallel, ...budget }),
    report: () => ({ method: 'GET', path: `${runs}/report` }),
    research: () => post(`/research/${owner}/${repo}/${pr}`, { base: options.base, parallel, ...budget }),
    resume: () => ({ method: 'POST', path: `${runs}/resume` }),
    start: () => post(runs, { full: options.full === true, ship: options.ship === true, ...budget }),
    status: () => ({ method: 'GET', path: runs }),
  }
  const request = Object.hasOwn(requests, command) ? requests[command] : undefined
  if (!request) throw new StopError(`unknown command ${command}\n\n${usage}`)
  return request()
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      budget: { type: 'string' },
      full: { type: 'boolean' },
      help: { short: 'h', type: 'boolean' },
      hotfix: { type: 'boolean' },
      parallel: { type: 'string' },
      ship: { type: 'boolean' },
    },
  })
  const [command, target] = positionals
  if (values.help || !command || (!target && command !== 'inbox')) {
    console.log(usage)
    return values.help ? 0 : 2
  }
  const request = remoteRequest(command, target, values)
  const factory = setting('FACTORY_URL').replace(/\/$/, '')
  const headers: Record<string, string> = { authorization: `Bearer ${setting('ADMIN_TOKEN')}` }
  if (request.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${factory}${request.path}`, { body: request.body, headers, method: request.method })
  const text = await response.text()
  if (command === 'inbox') {
    const outcome = inboxOutcome({ ok: response.ok, text })
    console.log(outcome.text)
    return outcome.code
  }
  if (command === 'prune') {
    const outcome = pruneOutcome({ ok: response.ok, text })
    console.log(outcome.text)
    return outcome.code
  }
  if (command === 'resume' && response.ok) {
    const outcome = resumeOutcome(text)
    console.log(outcome.text)
    return outcome.code
  }
  console.log(text)
  return response.ok ? 0 : 1
}

if (fileURLToPath(import.meta.url) === process.argv[1])
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof StopError ? `stop: ${error.message}` : error)
      process.exit(2)
    },
  )
