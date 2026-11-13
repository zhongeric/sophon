import { spawn } from 'node:child_process'
import type { Machine } from '../core/checks.ts'

const outputTailChars = 20_000

let queue: Promise<unknown> = Promise.resolve()

/** Runs one command at a time across the whole host: parallel test runs slow each other down. */
function serialize<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}

export function runCommand(cwd: string, command: string, timeoutMs: number, allowed: string[]): Promise<{ exit_code: number | null; output: string }> {
  const names = new Set(allowed)
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name)))
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-outputTailChars)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      output += `\n[host] killed after ${timeoutMs} ms`
      process.kill(-child.pid!, 'SIGKILL')
    }, timeoutMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exit_code: code, output })
    })
  })
}

/** This machine, running commands in the run's worktree. */
export function localMachine(tree: string): Machine {
  return { run: (command, { env, timeoutMs }) => serialize(() => runCommand(tree, command, timeoutMs, env)) }
}
