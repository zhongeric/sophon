import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { commandOptions, type RepoConfig } from '../core/checks.ts'
import type { InputFile, ScanBoxes, ScanPoll } from '../core/fanout.ts'
import { sweepEgressServer } from './sweep-egress.ts'

const outputTailChars = 20_000
const slotPattern = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/

/** A job of a slot. `result` is set when the process closed. */
type Job = { id: string; child: ChildProcess; closed: Promise<void>; result?: { exit_code: number | null; output: string; ended_at: number } }

/** The path of `path` in `root`. A path outside `root` is an error. */
function inside(root: string, path: string): string {
  const full = resolve(root, path)
  const rel = relative(root, full)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || resolve(rel) === rel) throw new Error(`the path ${path} is outside its directory`)
  return full
}

// A unit runs detached in its own process group, so neither the signal of the terminal nor the end of the host ends it.
const groups = new Set<number>()

/** Kills each process group of a unit that has not closed. */
function killGroups(): void {
  for (const pid of groups) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // The process group already ended.
    }
  }
  groups.clear()
}

let hooked = false

/** Kills the units when the host exits, or when SIGINT or SIGTERM ends it. Then the signal ends the host as before. */
function hookExit(): void {
  if (hooked) return
  hooked = true
  process.on('exit', killGroups)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      killGroups()
      process.kill(process.pid, signal)
    })
  }
}

/** Writes each file under `root`, with its directories. A path through a symlink under `root`, for example of a checkout, is an error. */
export function writeInputs(root: string, files: InputFile[]): void {
  for (const file of files) {
    const path = inside(root, file.path)
    let current = root
    for (const part of relative(root, path).split(sep)) {
      current = join(current, part)
      let link: boolean
      try {
        link = lstatSync(current).isSymbolicLink()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
      if (link) throw new Error(`the path ${file.path} goes through the symlink ${relative(root, current)}`)
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.data)
  }
}

/**
 * The scan boxes of this machine. Each slot is a directory under `dir`. Units get the check environment, without host secrets.
 * The setup of the config runs in the shell of each unit, and a start returns after the setup, so the unit time limit starts there.
 * A start is never full. A host restart loses all jobs. With an `egress` handler, a job started with `egress: true` gets
 * AGENT_FACTORY_EGRESS, the base URL of a local proxy over the handler. The local machine has no network isolation.
 */
export function localScanBoxes(
  dir: string,
  config: RepoConfig,
  options: { pollMs?: number; egress?: (request: Request) => Promise<Response> } = {},
): ScanBoxes {
  const jobs = new Map<string, Job>()
  const proxy = options.egress && sweepEgressServer(options.egress)
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
    // The local machine has no unit limit. This value only keeps the timer correct: setTimeout fires at once above it.
    maxUnitMs: 2 ** 31 - 1,
    pollMs: options.pollMs ?? 1000,
    egress: proxy !== undefined,
    async start(slot, unit) {
      if (unit.egress && !proxy) throw new Error(`the local scan boxes have no egress, so the job of ${slot} cannot start`)
      const root = slotDir(slot)
      const previous = jobs.get(slot)
      if (previous) await stop(previous)
      rmSync(root, { recursive: true, force: true })
      mkdirSync(root, { recursive: true })
      writeInputs(root, unit.inputs)
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name)))
      if (unit.egress && proxy) env.AGENT_FACTORY_EGRESS = await proxy.url()
      hookExit()
      // After the setup, the shell writes to descriptor 3. The setup and the unit do not get descriptor 3.
      const command = config.setup ? `{\n${config.setup}\n} 3>&- && {\nprintf ready >&3\nexec 3>&-\n${unit.command}\n}` : unit.command
      const child = spawn('bash', ['-c', command], { cwd: root, detached: true, env, stdio: config.setup ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] })
      const pid = child.pid
      if (pid !== undefined) groups.add(pid)
      const job: Job = { id: crypto.randomUUID(), child, closed: Promise.resolve() }
      let output = ''
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-outputTailChars)
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      let timedOut = false
      let ready: () => void = () => {}
      const setupDone = new Promise<void>((done) => {
        ready = () => done()
      })
      job.closed = new Promise<void>((done) => {
        const limit = (ms: number, what: string) =>
          setTimeout(() => {
            timedOut = true
            output += `\n[host] ${what} killed after ${ms} ms`
            try {
              if (pid !== undefined) process.kill(-pid, 'SIGKILL')
            } catch {
              // The process group already ended.
            }
          }, ms)
        let timer = config.setup ? limit(commandOptions(config).timeoutMs, 'the setup was') : limit(unit.timeoutMs, 'the unit was')
        if (!config.setup) ready()
        child.stdio[3]?.once('data', () => {
          clearTimeout(timer)
          timer = limit(unit.timeoutMs, 'the unit was')
          ready()
        })
        const end = (code: number | null) => {
          if (job.result !== undefined) return
          clearTimeout(timer)
          ready()
          if (pid !== undefined) groups.delete(pid)
          job.result = { exit_code: timedOut ? null : code, output, ended_at: Date.now() }
          done()
        }
        child.on('error', (error) => {
          output += `\n[host] ${error.message}`
          end(127)
        })
        child.on('close', end)
      })
      jobs.set(slot, job)
      await setupDone
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
