import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { StopError } from '../core/stop.ts'

const usage = `Usage: npm run remote -- <command> <pr> [--ship]

Drives the Cloudflare Worker without the GitHub webhook.

Commands:
  start <pr>     Start a review run on the PR (--ship: on PASS, push the fixes to the PR branch and mark it ready)
  resume <pr>    Wake a paused run now, for example after you answered its questions, and print the state of the
                 latest run and the reason (exit 1 when the run does not wake)
  status <pr>    Print the runs of the PR
  report <pr>    Print the report of the latest run

<pr> is owner/repo#123 or https://github.com/owner/repo/pull/123.

Environment: FACTORY_URL and ADMIN_TOKEN, or the same keys in .secrets/cloudflare.env.`

const secretsFile = new URL('../../.secrets/cloudflare.env', import.meta.url)

export function parseTarget(text: string): { owner: string; repo: string; pr: number } {
  const match = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:#|\/pull\/)(\d+)\/?$/.exec(text.trim())
  if (!match) throw new StopError(`${text} is not owner/repo#123 or a GitHub PR URL`)
  return { owner: match[1]!, pr: Number(match[3]), repo: match[2]! }
}

/**
 * Gives the text to print and the exit code for the body of a resume response. A body without a boolean `resumed` gives
 * the raw text and exit 1. A body without a valid `state` and `reason`, for example `{ resumed }` from an older Worker,
 * gives the raw text and the exit code of `resumed`.
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
  return { code, text: code === 0 ? `resumed: latest run was ${state ?? 'none'}: ${reason}` : `not resumed: latest run is ${state ?? 'none'}: ${reason}` }
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
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { help: { short: 'h', type: 'boolean' }, ship: { type: 'boolean' } } })
  const [command, target] = positionals
  if (values.help || !command || !target) {
    console.log(usage)
    return values.help ? 0 : 2
  }
  const { owner, repo, pr } = parseTarget(target)
  const url = `${setting('FACTORY_URL').replace(/\/$/, '')}/runs/${owner}/${repo}/${pr}`
  const headers = { authorization: `Bearer ${setting('ADMIN_TOKEN')}`, 'content-type': 'application/json' }
  const requests: Record<string, () => Promise<Response>> = {
    report: () => fetch(`${url}/report`, { headers }),
    resume: () => fetch(`${url}/resume`, { headers, method: 'POST' }),
    start: () => fetch(url, { body: JSON.stringify({ ship: values.ship === true }), headers, method: 'POST' }),
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
