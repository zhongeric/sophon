import { Bash, MemoryFileSystem, Mount, type FileSystem } from 'nanocode-ts/bash'
import type { GitHub } from './github.ts'
import { gunzip, untar, type TarEntry } from './tar.ts'

// Repository trees in Durable Object SQL, and in-process git on them, for the review and the development runs.

export type ChangedFile = { filename: string; status: string; previous_filename?: string }
type Contents = { type: 'file' | 'symlink' | 'dir' | 'submodule'; target?: string }

const identity = ['-c', 'user.name=agent-factory', '-c', 'user.email=agent-factory@users.noreply.github.com', '-c', 'core.quotePath=false']
/** Host git over a whole repository can take long, beyond the agents' 30-second shell limit. */
const gitTimeoutMs = 10 * 60_000
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
export const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

export function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

/** Name-status lines as [status, path] pairs; a rename gives its old path as a deletion. */
export function nameStatus(output: string): [string, string][] {
  return output
    .split('\n')
    .filter(Boolean)
    .flatMap((line): [string, string][] => {
      const [status = '', ...paths] = line.split('\t')
      return status.startsWith('R') ? [['D', paths[0]!], ['A', paths[1]!]] : [[status[0]!, paths[0]!]]
    })
}

/** In-process git on one tree, with the host's identity and no network. */
export function treeGit(tree: FileSystem.FileSystem): (...args: string[]) => Promise<string> {
  let shell: Promise<Bash.Bash> | undefined
  return async (...args) => {
    shell ??= Bash.create({
      cwd: '/repo',
      fetch: async () => {
        throw new Error('network access is off')
      },
      fs: Mount.create(MemoryFileSystem.create(), { mounts: { '/repo': tree } }),
      limits: { timeoutMs: gitTimeoutMs },
    })
    const result = await (await shell).exec(['git', ...identity, ...args].map(quote).join(' '))
    if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr || result.stdout}`)
    return result.stdout
  }
}

/** Writes to a tree that replace the path itself, so that a write never follows a symlink that the tree holds. */
export function treeWriter(tree: FileSystem.FileSystem) {
  const parents = (path: string) => {
    const parts = path.split('/').slice(0, -1)
    return parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)
  }
  const remove = (path: string) => tree.remove(`/${path}`).catch(() => undefined)
  const makeParents = async (path: string) => {
    for (const dir of parents(path)) if (!(await tree.stat(dir))) await tree.mkdir(dir)
  }
  const write = async (path: string, data: Uint8Array, mode = 0o644) => {
    await remove(path)
    await makeParents(path)
    await tree.write(`/${path}`, data)
    if (mode & 0o111) await tree.chmod!(`/${path}`, 0o755)
  }
  const link = async (path: string, target: string) => {
    await remove(path)
    await makeParents(path)
    await tree.symlink!(target, `/${path}`)
  }
  const restore = async (entry: TarEntry) => {
    if (entry.type === 'symlink') await link(entry.path, entry.target)
    else if (entry.type === 'file') await write(entry.path, entry.data, entry.mode)
  }
  /** Copies one path from another tree: its bytes and mode, or its link target. */
  const copy = async (from: FileSystem.FileSystem, path: string) => {
    const stat = await from.lstat!(`/${path}`)
    if (stat?.kind === 'symlink') await link(path, (await from.readlink!(`/${path}`)) ?? '')
    else if (stat?.kind === 'file') await write(path, await from.read(`/${path}`), stat.mode)
    else await remove(path)
  }
  return { remove, write, link, restore, copy }
}

/** Copies every file of a tree, with .git when `git` is true, so that the copy has the same commits. */
export async function copyTree(from: FileSystem.FileSystem, to: FileSystem.FileSystem, options: { git: boolean }): Promise<void> {
  const writer = treeWriter(to)
  const walk = async (dir: string) => {
    for (const name of await from.list(dir)) {
      const path = dir === '/' ? name : `${dir.slice(1)}/${name}`
      if (path === '.git' && !options.git) continue
      const stat = await from.lstat!(`/${path}`)
      if (stat?.kind === 'directory') {
        if (!(await to.stat(`/${path}`))) await to.mkdir(`/${path}`)
        await walk(`/${path}`)
      } else await writer.copy(from, path)
    }
  }
  await walk('/')
}

/** The version of a path at a commit on GitHub. The raw contents API follows symlinks, so ask for the entry type first. */
export async function restoreFromGitHub(gh: GitHub, api: string, tree: FileSystem.FileSystem, path: string, ref: string): Promise<void> {
  const writer = treeWriter(tree)
  const url = `${api}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`
  const entry = await gh.json<Contents>('GET', url)
  if (entry.type === 'symlink') await writer.link(path, entry.target ?? '')
  else if (entry.type === 'file') await writer.write(path, new Uint8Array(await (await gh.raw(url, 'application/vnd.github.raw')).arrayBuffer()))
  else await writer.remove(path)
}

/** Writes the tarball of a commit into a tree. Returns the entries, and the paths that it skipped for size. */
export async function writeTarball(gh: GitHub, api: string, tree: FileSystem.FileSystem & { maxFileBytes: number }, sha: string) {
  const archive = await gh.raw(`${api}/tarball/${sha}`, 'application/vnd.github+json')
  const entries = untar(await gunzip(archive.body!), 1)
  const writer = treeWriter(tree)
  const skipped: string[] = []
  for (const entry of entries) {
    if (entry.type === 'file' && entry.data.length > tree.maxFileBytes) skipped.push(entry.path)
    else await writer.restore(entry)
  }
  return { entries, skipped }
}
