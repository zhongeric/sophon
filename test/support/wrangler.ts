import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const startupMs = 90_000
const graceMs = 5_000

/** Sends a signal to the process group of `pid`. False when no process of the group is left. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

/**
 * True while a process of the group of `pid` runs. A zombie does not count: in a container whose init reaps no
 * orphans, a zombie stays in the group, and it holds no handle. Without /proc, each zombie counts.
 */
export function groupAlive(pid: number): boolean {
  if (!signalGroup(pid, 0)) return false
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return true
  }
  return entries.some((entry) => {
    if (!/^\d+$/.test(entry)) return false
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      // The fields after the command name: state, ppid, pgrp.
      const [state, , group] = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return Number(group) === pid && state !== 'Z'
    } catch {
      return false
    }
  })
}

/**
 * Ends the process group of a detached child: SIGTERM, then SIGKILL after `graceMs`. Resolves when no process of the
 * group runs, or after the SIGKILL wait, and closes the pipes of the child.
 */
export async function stopGroup(child: ChildProcess, graceMs: number): Promise<void> {
  try {
    if (child.pid === undefined) return
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (!groupAlive(child.pid)) return
      signalGroup(child.pid, signal)
      const deadline = Date.now() + graceMs
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (!groupAlive(child.pid)) return
      }
    }
  } finally {
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * The real Worker under wrangler dev, in local mode, with `vars` as its bindings and a fresh Durable Object store.
 * Without `containers`, a test gives the Worker a machine over HTTP (MACHINE_URL), so that it needs no Docker.
 * `persistTo` of an earlier Worker starts the Worker again on the same Durable Object store.
 */
export async function startWorker(vars: Record<string, string>, options: { containers?: boolean; persistTo?: string } = {}) {
  const port = await freePort()
  const persistTo = options.persistTo ?? mkdtempSync(join(tmpdir(), 'factory-do-'))
  const args = ['wrangler', 'dev', '--local', `--enable-containers=${options.containers === true}`, '--port', String(port), '--inspector-port', String(await freePort()), '--persist-to', persistTo]
  for (const [name, value] of Object.entries(vars)) args.push('--var', `${name}:${value}`)
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NODE_USE_ENV_PROXY']) delete env[name]
  const child = spawn('npx', args, { cwd: new URL('../../', import.meta.url).pathname, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let timer: NodeJS.Timeout | undefined
  const ready = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`wrangler dev did not start:\n${output}`)), startupMs)
    const watch = (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes('Ready on')) resolve()
    }
    child.stdout.on('data', watch)
    child.stderr.on('data', watch)
    child.on('error', reject)
    child.on('exit', (code) => reject(new Error(`wrangler dev exited with ${code}:\n${output}`)))
  })
  try {
    await ready
  } catch (error) {
    await stopGroup(child, graceMs)
    throw error
  } finally {
    clearTimeout(timer)
  }
  let stopping: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${port}`,
    persistTo,
    output: () => output,
    /** Resolves when the whole wrangler dev process group exited. A second call gives the same promise. */
    stop: () => (stopping ??= stopGroup(child, graceMs)),
  }
}

/** Sends a webhook delivery, signed with `secret` unless `secret` is null. */
export function sendWebhook(url: string, secret: string | null, event: string, payload: unknown) {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-github-event': event }
  if (secret) headers['x-hub-signature-256'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  return fetch(`${url}/github/webhook`, { body, headers, method: 'POST' })
}

export async function until<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs: number, describe: () => string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out: ${describe()}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
