import type { Machine } from '../core/checks.ts'
import type { Ledger } from '../core/ledger.ts'
import type { FileSystem } from 'nanocode-ts/bash'
import { artifactSizeLimit } from '../core/artifacts.ts'
import type { JobRunner } from './jobs.ts'
import { tar, type TarEntry } from './tar.ts'

/** The result of one command: its exit code, or null when the host killed it, and the end of its output. */
export type BoxResult = { exit_code: number | null; output: string }

/** A job of the machine: it runs, it is not in the machine (`missing`), or it ended with its result. */
export type JobState = { state: 'running' } | { state: 'missing' } | { state: 'done'; result: BoxResult }

export type JobOptions = { cwd: string; env: Record<string, string>; timeoutMs: number }

/**
 * A Linux machine for the commands of a development run: a Cloudflare Container, or a test machine over HTTP.
 * `cwd` is relative to the machine's root. The machine never gets the host's secrets.
 */
export type Box = {
  /** Starts the machine when it does not run. A machine that starts is empty. */
  start(): Promise<void>
  exec(argv: string[], options: { cwd: string; env: Record<string, string>; stdin?: Uint8Array; timeoutMs: number }): Promise<BoxResult>
  /**
   * Starts a command as a job in a process group of its own, and returns at once. The job keeps its output and its
   * exit code outside the work directories, so that a later call can poll it. Each ID starts one job only.
   */
  startJob(id: string, argv: string[], options: JobOptions): Promise<void>
  /** A job is `missing` when the machine has no such job, or when its processes died without an exit code. */
  pollJob(id: string): Promise<JobState>
  /** Kills the process group of a job. A job that is gone is not an error. */
  killJob(id: string): Promise<void>
}

const outputTailChars = 20_000

/**
 * The result of a command that `timeout` ran, after `elapsedMs`. timeout gives 124, or 137 when its SIGKILL follows.
 * A 137 before the time limit is another kill, for example for memory.
 */
export function commandResult(code: number, output: string, elapsedMs: number, timeoutMs: number): BoxResult {
  if (code === 124 || (code === 137 && elapsedMs >= timeoutMs)) return { exit_code: null, output: `${output}\n[host] killed after ${timeoutMs} ms` }
  if (code === 137) return { exit_code: code, output: `${output}\n[host] the command was killed before its time limit, possibly because it used too much memory` }
  return { exit_code: code, output }
}

/** The environment of every command: the toolchain on PATH, nothing from the host. */
export const boxEnv = {
  HOME: '/root',
  LANG: 'C.UTF-8',
  PATH: '/root/.foundry/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
}

async function tail(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ''
  const decoder = new TextDecoder()
  let output = ''
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) output = (output + decoder.decode(chunk, { stream: true })).slice(-outputTailChars)
  return output
}

/** The parts of a Cloudflare Container (`ctx.container` of a Durable Object) that a box uses. */
type ContainerHandle = {
  readonly running: boolean
  start(options: { enableInternet: boolean; entrypoint: string[]; env: Record<string, string> }): void
  setInactivityTimeout(durationMs: number): Promise<void>
  exec(
    argv: string[],
    options: { cwd: string; env: Record<string, string>; stdin?: ReadableStream; stdout: 'pipe'; stderr: 'combined' },
  ): Promise<{ stdout: ReadableStream<Uint8Array> | null; exitCode: Promise<number> }>
}

/** The job directory of the ID in $1, under /jobs, outside all work and clean directories. */
const jobDir = 'job="${PWD%/}/jobs/$1"'

/**
 * The shell code that runs a job as the session leader under setsid. timeout puts itself and the command in a
 * process group of its own, so the file pgid holds both groups. The exit file holds the exit code and the end time.
 * Each file that a poll reads comes with mv, so a poll never reads a part of it.
 */
const jobWrapper = [
  'job=$1 seconds=$2',
  'shift 2',
  'timeout -k 10 "$seconds" "$@" > "$job/output" 2>&1 < /dev/null &',
  'printf "%s %s\\n" "$$" "$!" > "$job/pgid.tmp" && mv -f -- "$job/pgid.tmp" "$job/pgid"',
  'wait "$!"',
  'code=$?',
  'printf "%s %s\\n" "$code" "$(date +%s%3N)" > "$job/exit.tmp" && mv -f -- "$job/exit.tmp" "$job/exit"',
].join('\n')

/** Starts a job, and returns when the file pgid exists. Arguments: the wrapper, the ID, the directory, the seconds, the limit in ms, argv. */
const jobStart = [
  'wrapper=$1',
  'shift',
  jobDir,
  'dir=$2 seconds=$3 limit=$4',
  'shift 4',
  'mkdir -p -- "$job" && printf "%s\\n" "$limit" > "$job/limit" && date +%s%3N > "$job/started" || exit 1',
  'cd -- "$dir" || exit 1',
  'setsid bash -c "$wrapper" bash "$job" "$seconds" "$@" > /dev/null 2>&1 < /dev/null &',
  'for _ in $(seq 100); do test -e "$job/pgid" && exit 0; sleep 0.1; done',
  'echo "the job did not start in 10 s"',
  'exit 1',
].join('\n')

/**
 * Prints the state of a job. A group is alive when a process of it is not a zombie: the init of a container does not
 * always reap them. The poll reads the exit file again after the check of the groups, because the job can end between the two.
 */
const jobPoll = [
  jobDir,
  'finished() { test -e "$job/exit" && printf "state=done exit=%s started=%s limit=%s\\n" "$(cat -- "$job/exit")" "$(cat -- "$job/started")" "$(cat -- "$job/limit")"; }',
  // The fields of /proc/<pid>/stat after the command name: the state, the parent and the process group.
  'alive() { for stat in /proc/[0-9]*/stat; do read -r line 2>/dev/null < "$stat" || continue; set -- ${line##*")"}; test "$1" != Z && { test "$3" = "$leader" || test "$3" = "$group"; } && return 0; done; return 1; }',
  'finished && exit 0',
  'if read -r leader group 2>/dev/null < "$job/pgid" && alive; then echo state=running; exit 0; fi',
  'finished && exit 0',
  'echo state=missing',
].join('\n')

/** Kills the groups of a job, and removes the job directory with the full output. */
const jobKill = [jobDir, 'if read -r leader group 2>/dev/null < "$job/pgid"; then kill -KILL -- "-$group" "-$leader" 2>/dev/null; fi', 'rm -rf -- "$job"'].join('\n')

// No ID starts with a dot, so that the job directory is never /jobs or its parent: a kill removes it.
const checkJobId = (id: string) => {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id)) throw new Error(`the job ID ${JSON.stringify(id)} is not a valid file name`)
}

/**
 * The run's Cloudflare Container. It starts on the first command and stops after `inactivityMs` without one. A function
 * gives the timeout again at each call, for a caller whose timeout depends on its running job. `enableInternet` is true
 * when the caller does not give it.
 */
export function containerBox(container: ContainerHandle, options: { inactivityMs: number | (() => number); onStart(): void; enableInternet?: boolean }): Box {
  const ready = async () => {
    if (!container.running) {
      options.onStart()
      container.start({ enableInternet: options.enableInternet ?? true, entrypoint: ['sleep', 'infinity'], env: boxEnv })
    }
    await container.setInactivityTimeout(typeof options.inactivityMs === 'number' ? options.inactivityMs : options.inactivityMs())
  }
  const exec: Box['exec'] = async (argv, { cwd, env, stdin, timeoutMs }) => {
    await ready()
    const started = Date.now()
    const seconds = String(Math.ceil(timeoutMs / 1_000))
    const process = await container.exec(['timeout', '-k', '10', seconds, ...argv], {
      cwd: `/${cwd}`,
      env,
      stderr: 'combined',
      stdout: 'pipe',
      ...(stdin ? { stdin: new Blob([new Uint8Array(stdin)]).stream() } : {}),
    })
    const [output, code] = await Promise.all([tail(process.stdout), process.exitCode])
    return commandResult(code, output, Date.now() - started, timeoutMs)
  }
  // Each job call is a short exec, so it goes through ready() and renews the inactivity timeout.
  const script = async (name: string, code: string, args: string[], env: Record<string, string> = boxEnv): Promise<string> => {
    const result = await exec(['bash', '-c', code, 'bash', ...args], { cwd: '', env, timeoutMs: 60_000 })
    if (result.exit_code !== 0) throw new Error(`${name} failed: ${result.output.slice(-2000)}`)
    return result.output
  }
  return {
    start: ready,
    exec,
    async startJob(id, argv, { cwd, env, timeoutMs }) {
      checkJobId(id)
      await script(`the start of job ${id}`, jobStart, [jobWrapper, id, `./${cwd}`, String(Math.ceil(timeoutMs / 1_000)), String(timeoutMs), ...argv], env)
    },
    async pollJob(id) {
      checkJobId(id)
      const output = await script(`the poll of job ${id}`, jobPoll, [id])
      if (/^state=running$/m.test(output)) return { state: 'running' }
      if (/^state=missing$/m.test(output)) return { state: 'missing' }
      const done = /^state=done exit=(\d+) (\d+) started=(\d+) limit=(\d+)$/m.exec(output)
      if (!done) throw new Error(`the poll of job ${id} gave no state: ${JSON.stringify(output.slice(-300))}`)
      const [code, ended, started, limit] = done.slice(1).map(Number) as [number, number, number, number]
      // 80,000 bytes hold at least the last 20,000 characters, and the exec keeps only those. The job keeps only
      // these bytes on the disk, and a poll again reads the same bytes.
      const last = await script(`the output of job ${id}`, `${jobDir}; tail -c 80000 -- "$job/output" > "$job/output.tmp" && mv -f -- "$job/output.tmp" "$job/output" && cat -- "$job/output"`, [id])
      return { result: commandResult(code, last, ended - started, limit), state: 'done' }
    },
    async killJob(id) {
      checkJobId(id)
      await script(`the kill of job ${id}`, jobKill, [id])
    },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The result in a response of a test machine, or null when the response is not a result. */
function parseResult(value: unknown): BoxResult | null {
  if (!isRecord(value) || typeof value.output !== 'string') return null
  const code = value.exit_code
  if (code === null || (typeof code === 'number' && Number.isInteger(code))) return { exit_code: code, output: value.output }
  return null
}

/** The job state in a response of a test machine, or null when the response is not a job state. */
function parseJobState(value: unknown): JobState | null {
  if (!isRecord(value)) return null
  if (value.state === 'running' || value.state === 'missing') return { state: value.state }
  const result = value.state === 'done' ? parseResult(value.result) : null
  return result && { result, state: 'done' }
}

/**
 * A machine behind an HTTP endpoint that runs one command for each POST, for local tests of the Worker. The job
 * routes are under the same URL.
 */
export function httpBox(url: string): Box {
  const post = async (to: string, body: unknown): Promise<unknown> => {
    const response = await fetch(to, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, method: 'POST' })
    if (!response.ok) throw new Error(`the machine at ${to} answered HTTP ${response.status}: ${await response.text()}`)
    return response.json()
  }
  /** Posts `body`, and throws when `parse` refuses the response. */
  const ask = async <T>(to: string, body: unknown, parse: (value: unknown) => T | null, what: string): Promise<T> => {
    const value = await post(to, body)
    const parsed = parse(value)
    if (parsed === null) throw new Error(`the machine at ${to} answered without ${what}: ${JSON.stringify(value).slice(0, 300)}`)
    return parsed
  }
  return {
    async start() {},
    exec(argv, { cwd, env, stdin, timeoutMs }) {
      let binary = ''
      for (let offset = 0; stdin && offset < stdin.length; offset += 0x8000) binary += String.fromCharCode(...stdin.subarray(offset, offset + 0x8000))
      return ask(url, { argv, cwd, env, stdin: stdin ? btoa(binary) : null, timeoutMs }, parseResult, 'a command result')
    },
    async startJob(id, argv, { cwd, env, timeoutMs }) {
      await post(`${url}/jobs/start`, { argv, cwd, env, id, timeoutMs })
    },
    pollJob: (id) => ask(`${url}/jobs/poll`, { id }, parseJobState, 'a job state'),
    async killJob(id) {
      await post(`${url}/jobs/kill`, { id })
    },
  }
}

/** The files of a tree with their kind, size and change time, without .git, so that a sync sends only what changed. */
async function manifest(tree: FileSystem.FileSystem): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const walk = async (dir: string) => {
    for (const name of await tree.list(dir)) {
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`
      if (path === '/.git') continue
      const stat = await tree.lstat!(path)
      if (stat?.kind === 'directory') await walk(path)
      else if (stat) files.set(path.slice(1), `${stat.kind}:${stat.size}:${stat.mtime}:${stat.mode}`)
    }
  }
  await walk('/')
  return files
}

/** The files that went away and the files that changed or are new, from the last manifest to the next one. */
function changes(last: Map<string, string> | null, next: Map<string, string>): { removed: string[]; changed: string[] } {
  return {
    removed: last ? [...last.keys()].filter((path) => !next.has(path)) : [],
    changed: [...next].filter(([path, stamp]) => last?.get(path) !== stamp).map(([path]) => path),
  }
}

/**
 * Copies a tree into a directory of the machine: all of it the first time, then only the files that changed or
 * went away since the last sync. A full copy also removes the marker `<dir>.sync`. Returns the manifest to give to
 * the next sync. `next` is the manifest of `tree` when the caller has it.
 */
export async function syncTree(
  box: Box,
  tree: FileSystem.FileSystem,
  dir: string,
  last: Map<string, string> | null,
  next?: Map<string, string>,
): Promise<Map<string, string>> {
  const files = next ?? (await manifest(tree))
  const run = async (argv: string[], cwd: string, stdin?: Uint8Array) => {
    const result = await box.exec(argv, { cwd, env: boxEnv, timeoutMs: 10 * 60_000, ...(stdin ? { stdin } : {}) })
    if (result.exit_code !== 0) throw new Error(`syncing ${dir} failed: ${argv.join(' ')}: ${result.output.slice(-2000)}`)
  }
  if (!last) await run(['bash', '-c', 'rm -rf -- "$1" "$1.sync" && mkdir -p -- "$1"', 'bash', dir], '')
  const { removed, changed } = changes(last, files)
  if (removed.length > 0) await run(['bash', '-c', 'xargs -0 rm -f --'], dir, new TextEncoder().encode(removed.join('\0')))
  if (changed.length > 0) {
    const entries: TarEntry[] = []
    for (const path of changed) {
      const stat = await tree.lstat!(`/${path}`)
      if (stat?.kind === 'symlink') entries.push({ data: new Uint8Array(), mode: 0o777, path, target: (await tree.readlink!(`/${path}`)) ?? '', type: 'symlink' })
      else entries.push({ data: await tree.read(`/${path}`), mode: stat?.mode ?? 0o644, path, target: '', type: 'file' })
    }
    await run(['tar', '-x', '-f', '-'], dir, tar(entries))
  }
  return files
}

/** A setup command that failed in a sync, with its result, so that a caller can report it as a failed check. */
export class SetupError extends Error {
  readonly command: string
  readonly result: BoxResult

  constructor(command: string, result: BoxResult) {
    super(`the setup command failed: ${result.output.slice(-2000)}`)
    this.command = command
    this.result = result
  }
}

/** What a directory of the machine got from its last complete sync: the sync ID in its marker, and its manifest. */
export type SyncState = { sync: string; files: Map<string, string> }

/** The sync state of the directories of the machine, kept outside the machine. */
export type SyncStore = {
  /** The state of a directory, or null when it has no valid state. */
  read(dir: string): SyncState | null
  invalidate(dir: string): void
  /** Keeps the state of a directory after its copy and its setup passed. */
  save(dir: string, state: SyncState): void
  /** Removes the state of all directories, for a machine that starts empty. */
  clear(): void
}

/**
 * Makes a directory of the machine hold `tree`, for the next command. The machine starts before the sync reads
 * `store`. A machine that starts is empty, and its start clears `store`.
 *
 * The caller owns `pending` and shares it across its syncs. The syncs of one directory run one at a time.
 * Without this queue, two syncs at the same time read the same state.
 * Then the first removes the marker, and the second does a full copy while the first or its command uses the directory.
 *
 * The marker `<dir>.sync` is beside the directory, so the tree and the checks never see it. It holds the sync ID
 * of the last complete sync. The sync sends only the changes when the stored ID and the marker agree. Else it
 * copies all of the tree and runs the setup again. Before the first write, the sync removes the stored state and
 * the marker. It writes them again only after the copy and the setup pass. Thus a sync or a setup that fails part
 * of the way always gives a full copy and the setup on the next sync.
 */
export function syncWithSetup(
  box: Box,
  store: SyncStore,
  pending: Map<string, Promise<void>>,
  tree: FileSystem.FileSystem,
  dir: string,
  setup: { command: string | undefined; timeoutMs: number },
  log: (line: string) => void,
  jobs?: JobRunner,
): Promise<void> {
  const current = (pending.get(dir) ?? Promise.resolve()).catch(() => {}).then(() => syncOnce(box, store, tree, dir, setup, log, jobs))
  pending.set(dir, current)
  const done = () => {
    if (pending.get(dir) === current) pending.delete(dir)
  }
  current.then(done, done)
  return current
}

async function syncOnce(
  box: Box,
  store: SyncStore,
  tree: FileSystem.FileSystem,
  dir: string,
  setup: { command: string | undefined; timeoutMs: number },
  log: (line: string) => void,
  jobs: JobRunner | undefined,
): Promise<void> {
  await box.start()
  const started = Date.now()
  const marker = `${dir}.sync`
  const last = store.read(dir)
  const next = await manifest(tree)
  const { removed, changed } = changes(last?.files ?? null, next)
  const writes = removed.length > 0 || changed.length > 0
  let agrees = false
  if (last) {
    // When the sync writes, the same command removes the marker that agrees.
    const check = `test "$(cat -- "$1" 2>/dev/null)" = "$2"${writes ? ' && rm -f -- "$1"' : ''}`
    agrees = (await box.exec(['bash', '-c', check, 'bash', marker, last.sync], { cwd: '', env: boxEnv, timeoutMs: 60_000 })).exit_code === 0
  }
  if (agrees && !writes) {
    log(`sync ${dir}: changes, 0 files sent in ${Date.now() - started} ms`)
    return
  }
  store.invalidate(dir)
  const base = agrees && last ? last.files : null
  const kind = base ? 'changes' : 'full'
  const count = base ? changed.length : next.size
  try {
    await syncTree(box, tree, dir, base, next)
  } catch (error) {
    log(`sync ${dir}: ${kind}, ${count} files failed in ${Date.now() - started} ms`)
    throw error
  }
  log(`sync ${dir}: ${kind}, ${count} files sent in ${Date.now() - started} ms`)
  if (!base && setup.command) {
    const setupStarted = Date.now()
    const result = await runCommand(box, jobs, setup.command, { cwd: dir, env: boxEnv, timeoutMs: setup.timeoutMs })
    log(`setup ${dir}: ${result.exit_code === 0 ? 'pass' : 'fail'}, ${next.size} files in ${Date.now() - setupStarted} ms`)
    if (result.exit_code !== 0) throw new SetupError(setup.command, result)
  }
  const sync = crypto.randomUUID()
  const written = await box.exec(['bash', '-c', 'printf %s "$2" > "$1"', 'bash', marker, sync], { cwd: '', env: boxEnv, timeoutMs: 60_000 })
  if (written.exit_code !== 0) throw new Error(`writing the marker ${marker} failed: ${written.output.slice(-2000)}`)
  store.save(dir, { files: next, sync })
}

/** Runs a command as a job that the call waits for, when the caller gives a job runner. Else it runs inline. */
function runCommand(box: Box, jobs: JobRunner | undefined, command: string, options: JobOptions): Promise<BoxResult> {
  return jobs ? jobs.wait(['bash', '-c', command], options) : box.exec(['bash', '-c', command], options)
}

/** Runs the checks of one branch on the machine, after the branch's tree is copied to its directory there. */
export function boxMachine(box: Box, dir: string, sync: () => Promise<void>, jobs?: JobRunner): Machine {
  return {
    async run(command, { timeoutMs }) {
      await sync()
      return runCommand(box, jobs, command, { cwd: dir, env: boxEnv, timeoutMs })
    },
  }
}

// The base64 text of one chunk has 19,200 characters, so the output tail of a command always holds all of it.
const readChunkBytes = 14_400

/**
 * The shell code that resolves the path in $1 in the working directory. It exits 3 when there is no file, and 4 when
 * the path, or a symlink in it, resolves outside the directory.
 */
const resolveFile = 'root=$(realpath .) && file=$(realpath -- "$1" 2>/dev/null) || exit 3; case "$file" in "$root"/*) ;; *) exit 4 ;; esac; test -f "$file" || exit 3'

/**
 * The exact bytes of a file in the directory `dir` of the machine, also of a binary file, in base64 chunks. Refuses a
 * path outside `dir`, also through a symlink, a missing file, and a file over artifactSizeLimit.
 */
export async function readBoxFile(box: Box, dir: string, path: string): Promise<Uint8Array> {
  let depth = 0
  for (const part of path.split('/')) {
    if (part === '..') depth -= 1
    else if (part !== '' && part !== '.') depth += 1
    if (depth < 0) break
  }
  if (path.startsWith('/') || depth < 0) throw new Error(`read ${path}: the path is not relative to ${dir}`)
  // Each command checks the path again, because a command of the run can replace a directory with a symlink.
  const readFile = async (script: string, args: string[]): Promise<string> => {
    const result = await box.exec(['bash', '-c', `${resolveFile}; ${script}`, 'bash', path, ...args], { cwd: dir, env: boxEnv, timeoutMs: 60_000 })
    if (result.exit_code === 3) throw new Error(`read ${path}: no such file in ${dir}`)
    if (result.exit_code === 4) throw new Error(`read ${path}: the path resolves outside ${dir}`)
    if (result.exit_code !== 0) throw new Error(`read ${path} failed: ${result.output.slice(-2000)}`)
    return result.output
  }
  // The output can hold other lines, for example warnings on stderr, so each value comes after a marker.
  const sized = await readFile('printf "size=%s\\n" "$(wc -c < "$file")"', [])
  const size = Number(/^size=\s*(\d+)\s*$/m.exec(sized)?.[1])
  if (!Number.isSafeInteger(size)) throw new Error(`read ${path}: no size for the file in the output ${JSON.stringify(sized.slice(-300))}`)
  if (size > artifactSizeLimit) throw new Error(`read ${path}: the file has ${size} bytes, over the limit of ${artifactSizeLimit} bytes`)
  const bytes = new Uint8Array(size)
  for (let offset = 0; offset < size; offset += readChunkBytes) {
    const output = await readFile('printf "base64=%s\\n" "$(tail -c "+$2" -- "$file" | head -c "$3" | base64 | tr -d "\\n")"', [String(offset + 1), String(readChunkBytes)])
    const text = /^base64=([A-Za-z0-9+/=]*)$/m.exec(output)?.[1]
    if (text === undefined) throw new Error(`read ${path}: no bytes in the output ${JSON.stringify(output.slice(-300))}`)
    const chunk = Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
    if (chunk.length !== Math.min(readChunkBytes, size - offset)) throw new Error(`read ${path}: the file changed while the host read it`)
    bytes.set(chunk, offset)
  }
  return bytes
}

/**
 * The jobs of a clean box across alarm calls: the runner and the ledger of the run, the step key of the caller, and
 * the end of the call for the pause.
 */
export type CleanJobs = { runner: JobRunner; ledger: Ledger; key: string; deadline: number }

/**
 * Copies `tree`, which holds only the files of a commit, to the new directory `dir` of the machine. Commands of the
 * result run in `dir` without a sync. runDomainCommand runs the setup, so it does not run here. `read` gives the exact
 * bytes of a file in `dir`, also of a binary file, in base64 chunks.
 *
 * With `jobs`, each command is a pause-mode job, and the clean box keeps `dir` across calls: when the ledger has the
 * copy of `dir` for the step key and the marker `<dir>.sync` agrees, it does not copy again. Thus it never removes a
 * directory under a running job. The pause key holds the copy ID, so that a new copy, for example in a new machine,
 * runs each command again and makes its output files again.
 */
export async function cleanBox(
  box: Box,
  tree: FileSystem.FileSystem,
  dir: string,
  log: (line: string) => void,
  jobs?: CleanJobs,
): Promise<Machine & { id: string; read(path: string): Promise<Uint8Array> }> {
  await box.start()
  const started = Date.now()
  const marker = `${dir}.sync`
  const ledgerKey = `clean-box:${jobs?.key}`
  // The caller keeps one directory for each step key, so the ledger keeps only the copy ID in its marker.
  let sync = jobs?.ledger.get<string>(ledgerKey) ?? ''
  const agrees = sync && (await box.exec(['bash', '-c', 'test "$(cat -- "$1" 2>/dev/null)" = "$2"', 'bash', marker, sync], { cwd: '', env: boxEnv, timeoutMs: 60_000 })).exit_code === 0
  if (agrees) {
    log(`sync ${dir}: kept, 0 files sent in ${Date.now() - started} ms`)
  } else {
    const files = await syncTree(box, tree, dir, null)
    log(`sync ${dir}: full, ${files.size} files sent in ${Date.now() - started} ms`)
    if (jobs) {
      sync = crypto.randomUUID()
      const written = await box.exec(['bash', '-c', 'printf %s "$2" > "$1"', 'bash', marker, sync], { cwd: '', env: boxEnv, timeoutMs: 60_000 })
      if (written.exit_code !== 0) throw new Error(`writing the marker ${marker} failed: ${written.output.slice(-2000)}`)
      jobs.ledger.put(ledgerKey, sync)
    }
  }
  return {
    id: sync || crypto.randomUUID(),
    run(command, { timeoutMs }) {
      const options = { cwd: dir, env: boxEnv, timeoutMs }
      if (!jobs) return box.exec(['bash', '-c', command], options)
      return jobs.runner.pause(`${dir}@${sync}:${command}`, ['bash', '-c', command], { ...options, deadline: jobs.deadline })
    },
    read: (path) => readBoxFile(box, dir, path),
  }
}
