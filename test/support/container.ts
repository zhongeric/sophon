import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A container whose root is a local directory. It comes back empty when it starts, as a stopped Cloudflare Container
 * does, and it keeps its start options and each inactivity timeout. When `exitCode` is set, each command gives it.
 */
export function localContainer(root: string, exitCode?: number) {
  const container = {
    running: false,
    starts: [] as { enableInternet: boolean }[],
    timeouts: [] as number[],
    start(options: { enableInternet: boolean; entrypoint: string[]; env: Record<string, string> }) {
      rmSync(root, { force: true, recursive: true })
      mkdirSync(root, { recursive: true })
      container.starts.push({ enableInternet: options.enableInternet })
      container.running = true
    },
    async setInactivityTimeout(durationMs: number) {
      container.timeouts.push(durationMs)
    },
    async exec(argv: string[], options: { cwd: string; env: Record<string, string>; stdin?: ReadableStream }) {
      // The box wraps each command in timeout -k 10 <seconds>.
      const command = argv.slice(4)
      const cwd = join(root, options.cwd)
      const input = options.stdin ? Buffer.from(await new Response(options.stdin).arrayBuffer()) : undefined
      // A user other than root cannot read /root/.bashrc, and bash reads it when its stdin is a socket. Thus HOME is the
      // root of this container, which has no .bashrc.
      const env = { ...options.env, HOME: root }
      const result = existsSync(cwd) ? spawnSync(command[0]!, command.slice(1), { cwd, env, input }) : { status: 1, stdout: '', stderr: `no directory ${options.cwd}` }
      return { stdout: new Blob([`${result.stdout}${result.stderr}`]).stream(), exitCode: Promise.resolve(exitCode ?? result.status ?? 1) }
    },
  }
  return container
}
