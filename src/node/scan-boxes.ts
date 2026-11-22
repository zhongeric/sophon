import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { commandOptions, type RepoConfig } from '../core/checks.ts'
import type { InputFile, ScanBoxes, ScanPoll } from '../core/fanout.ts'

const outputTailChars = 20_000
const slotPattern = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/

/** A job of a slot. `result` is set when the process closed. */
type Job = { id: string; child: ChildProcess; closed: Promise<void>; result?: { exit_code: number | null; output: string } }

/** The path of `path` in `root`. A path outside `root` is an error. */
export function inside(root: string, path: string): string {
  const full = resolve(root, path)
  const rel = relative(root, full)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || resolve(rel) === rel) throw new Error(`the path ${path} is outside its directory`)
  return full
}

/** Writes each file under `root`, with its directories. */
export function writeInputs(root: string, files: InputFile[]): void {
  for (const file of files) {
    const path = inside(root, file.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.data)
  }
}

/**
 * The scan boxes of this machine: each slot is a directory under `dir`, and each unit is a process of this Node
 * process, with the check environment of the config, so no host secret. The local machine has no box limit, so a start
 * is never full. After a restart of the host, each job of an earlier process is missing.
 */
export function localScanBoxes(dir: string, config: RepoConfig, options: { pollMs?: number } = {}): ScanBoxes {
  const jobs = new Map<string, Job>()
  const names = new Set(commandOptions(config).env)
  const slotDir = (slot: string) => {
    if (!slotPattern.test(slot)) throw new Error(`the slot ${slot} is not <pool>/<slot> with parts of [A-Za-z0-9_-]{1,64}`)
    return join(dir, ...slot.split('/'))
  }
  const stop = async (job: Job) => {
    if (job.result === undefined && job.child.pid !== undefined) {
      try {
        process.kill(-job.child.pid, 'SIGKILL')
      } catch {
        // The process group already ended.
      }
    }
    await job.closed
  }
  return {
    instance: null,
    maxUnitMs: 60 * 60 * 1000,
    pollMs: options.pollMs ?? 1000,
    async start(slot, unit) {
      const root = slotDir(slot)
      const previous = jobs.get(slot)
      if (previous) await stop(previous)
      rmSync(root, { recursive: true, force: true })
      mkdirSync(root, { recursive: true })
      writeInputs(root, unit.inputs)
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name)))
      const child = spawn('bash', ['-c', unit.command], { cwd: root, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
      const job: Job = { id: crypto.randomUUID(), child, closed: Promise.resolve() }
      let output = ''
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-outputTailChars)
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      let timedOut = false
      job.closed = new Promise<void>((done) => {
        const timer = setTimeout(() => {
          timedOut = true
          output += `\n[host] killed after ${unit.timeoutMs} ms`
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        }, unit.timeoutMs)
        const end = (code: number | null) => {
          if (job.result !== undefined) return
          clearTimeout(timer)
          job.result = { exit_code: timedOut ? null : code, output }
          done()
        }
        child.on('error', (error) => {
          output += `\n[host] ${error.message}`
          end(127)
        })
        child.on('close', end)
      })
      jobs.set(slot, job)
      return { job: job.id }
    },
    async poll(slot): Promise<ScanPoll> {
      const job = jobs.get(slot)
      if (!job) return { state: 'missing' }
      return job.result === undefined ? { state: 'running' } : { state: 'done', result: job.result }
    },
    async kill(slot) {
      const job = jobs.get(slot)
      if (job) await stop(job)
    },
    async read(slot, path) {
      return new Uint8Array(readFileSync(inside(slotDir(slot), path)))
    },
  }
}
