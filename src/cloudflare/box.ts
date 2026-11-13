import type { Machine } from '../core/checks.ts'
import type { FileSystem } from 'nanocode-ts/bash'
import { tar, type TarEntry } from './tar.ts'
import { base64 } from './trees.ts'

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
const boxEnv = {
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
      const body = { argv, cwd, env, stdin: stdin ? base64(stdin) : null, timeoutMs }
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

/**
 * Copies a tree into a directory of the machine: all of it the first time, then only the files that changed or
 * went away since the last sync. Returns the manifest to give to the next sync.
 */
export async function syncTree(box: Box, tree: FileSystem.FileSystem, dir: string, last: Map<string, string> | null): Promise<Map<string, string>> {
  const next = await manifest(tree)
  const run = async (argv: string[], cwd: string, stdin?: Uint8Array) => {
    const result = await box.exec(argv, { cwd, env: boxEnv, timeoutMs: 10 * 60_000, ...(stdin ? { stdin } : {}) })
    if (result.exit_code !== 0) throw new Error(`syncing ${dir} failed: ${argv.join(' ')}: ${result.output.slice(-2000)}`)
  }
  if (!last) await run(['bash', '-c', 'rm -rf -- "$1" && mkdir -p -- "$1"', 'bash', dir], '')
  const removed = last ? [...last.keys()].filter((path) => !next.has(path)) : []
  if (removed.length > 0) await run(['bash', '-c', 'xargs -0 rm -f --'], dir, new TextEncoder().encode(removed.join('\0')))
  const changed = [...next].filter(([path, stamp]) => last?.get(path) !== stamp).map(([path]) => path)
  if (changed.length > 0) {
    const entries: TarEntry[] = []
    for (const path of changed) {
      const stat = await tree.lstat!(`/${path}`)
      if (stat?.kind === 'symlink') entries.push({ data: new Uint8Array(), mode: 0o777, path, target: (await tree.readlink!(`/${path}`)) ?? '', type: 'symlink' })
      else entries.push({ data: await tree.read(`/${path}`), mode: stat?.mode ?? 0o644, path, target: '', type: 'file' })
    }
    await run(['tar', '-x', '-f', '-'], dir, tar(entries))
  }
  return next
}

/**
 * Makes a directory of the machine hold `tree`, for the next command. `synced` holds what each directory got from
 * the last sync. The machine starts before the sync reads `synced`. A machine that starts is empty, and its start
 * clears `synced`. The sync then copies all of the tree and runs the setup again.
 */
export async function syncWithSetup(
  box: Box,
  synced: Map<string, Map<string, string>>,
  tree: FileSystem.FileSystem,
  dir: string,
  setup: { command: string | undefined; timeoutMs: number },
): Promise<void> {
  await box.start()
  const last = synced.get(dir) ?? null
  const next = await syncTree(box, tree, dir, last)
  if (!last && setup.command) {
    const result = await box.exec(['bash', '-c', setup.command], { cwd: dir, env: boxEnv, timeoutMs: setup.timeoutMs })
    if (result.exit_code !== 0) throw new Error(`the setup command failed: ${result.output.slice(-2000)}`)
  }
  synced.set(dir, next)
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
