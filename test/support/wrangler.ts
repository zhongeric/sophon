import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const startupMs = 90_000

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** The real Worker under wrangler dev, in local mode, with `vars` as its bindings and a fresh Durable Object store. */
export async function startWorker(vars: Record<string, string>) {
  const port = await freePort()
  const args = ['wrangler', 'dev', '--local', '--port', String(port), '--inspector-port', String(await freePort()), '--persist-to', mkdtempSync(join(tmpdir(), 'factory-do-'))]
  for (const [name, value] of Object.entries(vars)) args.push('--var', `${name}:${value}`)
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NODE_USE_ENV_PROXY']) delete env[name]
  const child = spawn('npx', args, { cwd: new URL('../../', import.meta.url).pathname, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev did not start:\n${output}`)), startupMs)
    const watch = (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes('Ready on')) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout.on('data', watch)
    child.stderr.on('data', watch)
    child.on('exit', (code) => reject(new Error(`wrangler dev exited with ${code}:\n${output}`)))
  })
  await ready
  return {
    url: `http://127.0.0.1:${port}`,
    output: () => output,
    stop: () => {
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch {}
    },
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
