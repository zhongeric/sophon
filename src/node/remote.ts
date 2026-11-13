import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { parseParallel } from '../core/plan.ts'
import { StopError } from '../core/stop.ts'

const usage = `Usage: npm run remote -- <command> <number> [options]

Drives the Cloudflare Worker without the GitHub webhook.

Commands:
  start <pr>        Start a review run on the PR (--ship: on PASS, push the fixes to the PR branch and mark it ready;
                    --full: the full loop, also when triage allows the light loop)
  develop <issue>   Start a development run on the issue: its title and body are the ask (--base <branch>,
                    --hotfix, --full, --parallel <n>, as in npm run develop)
  resume <number>   Wake a paused run of the PR or issue now, for example after you answered its questions, and
                    print the state of the latest run and the reason (exit 1 when the run does not wake)
  status <number>   Print the runs of the PR or issue
  report <number>   Print the report of the latest run

<pr>, <issue> and <number> are owner/repo#123, or a GitHub PR or issue URL.

Environment: FACTORY_URL and ADMIN_TOKEN, or the same keys in .secrets/cloudflare.env.`

const secretsFile = new URL('../../.secrets/cloudflare.env', import.meta.url)

export function parseTarget(text: string): { owner: string; repo: string; pr: number } {
  const match = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:#|\/pull\/|\/issues\/)(\d+)\/?$/.exec(text.trim())
  if (!match) throw new StopError(`${text} is not owner/repo#123 or a GitHub PR or issue URL`)
  return { owner: match[1]!, pr: Number(match[3]), repo: match[2]! }
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

function setting(name: string): string {
  const fromFile = existsSync(secretsFile)
    ? Object.fromEntries(
        readFileSync(secretsFile, 'utf8')
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      )[name]
    : undefined
  const value = process.env[name] ?? fromFile
  if (!value) throw new StopError(`set ${name}, in the environment or in .secrets/cloudflare.env`)
  return value
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      full: { type: 'boolean' },
      help: { short: 'h', type: 'boolean' },
      hotfix: { type: 'boolean' },
      parallel: { type: 'string' },
      ship: { type: 'boolean' },
    },
  })
  const [command, target] = positionals
  if (values.help || !command || !target) {
    console.log(usage)
    return values.help ? 0 : 2
  }
  const { owner, repo, pr } = parseTarget(target)
  const factory = setting('FACTORY_URL').replace(/\/$/, '')
  const url = `${factory}/runs/${owner}/${repo}/${pr}`
  const headers = { authorization: `Bearer ${setting('ADMIN_TOKEN')}`, 'content-type': 'application/json' }
  const develop = { base: values.base, full: values.full === true, hotfix: values.hotfix === true, parallel: values.parallel !== undefined ? parseParallel(values.parallel) : undefined }
  const requests: Record<string, () => Promise<Response>> = {
    develop: () => fetch(`${factory}/develop/${owner}/${repo}/${pr}`, { body: JSON.stringify(develop), headers, method: 'POST' }),
    report: () => fetch(`${url}/report`, { headers }),
    resume: () => fetch(`${url}/resume`, { headers, method: 'POST' }),
    start: () => fetch(url, { body: JSON.stringify({ full: values.full === true, ship: values.ship === true }), headers, method: 'POST' }),
    status: () => fetch(url, { headers }),
  }
  const send = requests[command]
  if (!send) throw new StopError(`unknown command ${command}\n\n${usage}`)
  const response = await send()
  const text = await response.text()
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
