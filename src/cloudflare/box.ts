import type { Machine } from '../core/checks.ts'
import type { FileSystem } from 'nanocode-ts/bash'
import { artifactSizeLimit } from '../core/artifacts.ts'
import { tar, type TarEntry } from './tar.ts'

/** The result of one command: its exit code, or null when the host killed it, and the end of its output. */
export type BoxResult = { exit_code: number | null; output: string }

/**
 * A Linux machine for the commands of a development run: a Cloudflare Container, or a test machine over HTTP.
 * `cwd` is relative to the machine's root. The machine never gets the host's secrets.
 */
export type Box = {
  /** Starts the machine when it does not run. A machine that starts is empty. */
  start(): Promise<void>
  exec(argv: string[], options: { cwd: string; env: Record<string, string>; stdin?: Uint8Array; timeoutMs: number }): Promise<BoxResult>
}

const outputTailChars = 20_000
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

/** The run's Cloudflare Container. It starts on the first command and stops after `inactivityMs` without one. */
export function containerBox(container: ContainerHandle, options: { inactivityMs: number; onStart(): void }): Box {
  const ready = async () => {
    if (!container.running) {
      options.onStart()
      container.start({ enableInternet: true, entrypoint: ['sleep', 'infinity'], env: boxEnv })
    }
    await container.setInactivityTimeout(options.inactivityMs)
  }
  return {
    start: ready,
    async exec(argv, { cwd, env, stdin, timeoutMs }) {
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
      // timeout gives 124, or 137 when its SIGKILL follows. A 137 before the time limit is another kill, for example for memory.
      if (code === 124 || (code === 137 && Date.now() - started >= timeoutMs)) return { exit_code: null, output: `${output}\n[host] killed after ${timeoutMs} ms` }
      if (code === 137) return { exit_code: code, output: `${output}\n[host] the command was killed before its time limit, possibly because it used too much memory` }
      return { exit_code: code, output }
    },
  }
}

/** A machine behind an HTTP endpoint that runs one command for each POST, for local tests of the Worker. */
export function httpBox(url: string): Box {
  return {
    async start() {},
    async exec(argv, { cwd, env, stdin, timeoutMs }) {
      let binary = ''
      for (let offset = 0; stdin && offset < stdin.length; offset += 0x8000) binary += String.fromCharCode(...stdin.subarray(offset, offset + 0x8000))
      const body = { argv, cwd, env, stdin: stdin ? btoa(binary) : null, timeoutMs }
      const response = await fetch(url, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, method: 'POST' })
      if (!response.ok) throw new Error(`the machine at ${url} answered HTTP ${response.status}: ${await response.text()}`)
      return (await response.json()) as BoxResult
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
): Promise<void> {
  const current = (pending.get(dir) ?? Promise.resolve()).catch(() => {}).then(() => syncOnce(box, store, tree, dir, setup, log))
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
    const result = await box.exec(['bash', '-c', setup.command], { cwd: dir, env: boxEnv, timeoutMs: setup.timeoutMs })
    log(`setup ${dir}: ${result.exit_code === 0 ? 'pass' : 'fail'}, ${next.size} files in ${Date.now() - setupStarted} ms`)
    if (result.exit_code !== 0) throw new Error(`the setup command failed: ${result.output.slice(-2000)}`)
  }
  const sync = crypto.randomUUID()
  const written = await box.exec(['bash', '-c', 'printf %s "$2" > "$1"', 'bash', marker, sync], { cwd: '', env: boxEnv, timeoutMs: 60_000 })
  if (written.exit_code !== 0) throw new Error(`writing the marker ${marker} failed: ${written.output.slice(-2000)}`)
  store.save(dir, { files: next, sync })
}

/** Runs the checks of one branch on the machine, after the branch's tree is copied to its directory there. */
export function boxMachine(box: Box, dir: string, sync: () => Promise<void>): Machine {
  return {
    async run(command, { timeoutMs }) {
      await sync()
      return box.exec(['bash', '-c', command], { cwd: dir, env: boxEnv, timeoutMs })
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
 * Copies `tree`, which holds only the files of a commit, to the new directory `dir` of the machine. Commands of the
 * result run in `dir` without a sync. runDomainCommand runs the setup, so it does not run here. `read` gives the exact
 * bytes of a file in `dir`, also of a binary file, in base64 chunks.
 */
export async function cleanBox(
  box: Box,
  tree: FileSystem.FileSystem,
  dir: string,
  log: (line: string) => void,
): Promise<Machine & { read(path: string): Promise<Uint8Array> }> {
  await box.start()
  const started = Date.now()
  const files = await syncTree(box, tree, dir, null)
  log(`sync ${dir}: full, ${files.size} files sent in ${Date.now() - started} ms`)
  // Each command checks the path again, because a command of the run can replace a directory with a symlink.
  const readFile = async (path: string, script: string, args: string[]): Promise<string> => {
    const result = await box.exec(['bash', '-c', `${resolveFile}; ${script}`, 'bash', path, ...args], { cwd: dir, env: boxEnv, timeoutMs: 60_000 })
    if (result.exit_code === 3) throw new Error(`read ${path}: no such file in ${dir}`)
    if (result.exit_code === 4) throw new Error(`read ${path}: the path resolves outside ${dir}`)
    if (result.exit_code !== 0) throw new Error(`read ${path} failed: ${result.output.slice(-2000)}`)
    return result.output
  }
  return {
    run: (command, { timeoutMs }) => box.exec(['bash', '-c', command], { cwd: dir, env: boxEnv, timeoutMs }),
    async read(path) {
      let depth = 0
      for (const part of path.split('/')) {
        if (part === '..') depth -= 1
        else if (part !== '' && part !== '.') depth += 1
        if (depth < 0) break
      }
      if (path.startsWith('/') || depth < 0) throw new Error(`read ${path}: the path is not relative to ${dir}`)
      // The output can hold other lines, for example warnings on stderr, so each value comes after a marker.
      const sized = await readFile(path, 'printf "size=%s\\n" "$(wc -c < "$file")"', [])
      const size = Number(/^size=\s*(\d+)\s*$/m.exec(sized)?.[1])
      if (!Number.isSafeInteger(size)) throw new Error(`read ${path}: no size for the file in the output ${JSON.stringify(sized.slice(-300))}`)
      if (size > artifactSizeLimit) throw new Error(`read ${path}: the file has ${size} bytes, over the limit of ${artifactSizeLimit} bytes`)
      const bytes = new Uint8Array(size)
      for (let offset = 0; offset < size; offset += readChunkBytes) {
        const output = await readFile(path, 'printf "base64=%s\\n" "$(tail -c "+$2" -- "$file" | head -c "$3" | base64 | tr -d "\\n")"', [String(offset + 1), String(readChunkBytes)])
        const text = /^base64=([A-Za-z0-9+/=]*)$/m.exec(output)?.[1]
        if (text === undefined) throw new Error(`read ${path}: no bytes in the output ${JSON.stringify(output.slice(-300))}`)
        const chunk = Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
        if (chunk.length !== Math.min(readChunkBytes, size - offset)) throw new Error(`read ${path}: the file changed while the host read it`)
        bytes.set(chunk, offset)
      }
      return bytes
    },
  }
}
