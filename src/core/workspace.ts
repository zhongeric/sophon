import type { Contracts } from 'nanocode-ts'
import { Bash, FileSystem, MemoryFileSystem, Mount } from 'nanocode-ts/bash'

/** Names that agents never see in a repository tree. */
const hidden = new Set(['.git'])

const isHidden = (path: string) => FileSystem.normalize(path).split('/').some((part) => hidden.has(part))

/** Wraps a file system so that every write fails with EROFS. */
export function readOnly(fs: FileSystem.FileSystem): FileSystem.FileSystem {
  const refuse = async (path: string): Promise<never> => {
    throw new FileSystem.FsError('EROFS', path)
  }
  return {
    stat: (path) => fs.stat(path),
    lstat: fs.lstat && ((path) => fs.lstat!(path)),
    readlink: fs.readlink && ((path) => fs.readlink!(path)),
    read: (path) => fs.read(path),
    list: (path) => fs.list(path),
    write: refuse,
    mkdir: refuse,
    remove: refuse,
    rename: refuse,
  }
}

/**
 * The rails of a repository tree on any file system: .git is hidden, writes never go through a symlink
 * on any part of the path, and `protect` refuses writes to paths that the host owns.
 */
export function guard(fs: FileSystem.FileSystem, protect: (path: string) => boolean = () => false): FileSystem.FileSystem {
  const visible = (path: string) => {
    if (isHidden(path)) throw new FileSystem.FsError('ENOENT', path)
  }
  const writable = async (path: string) => {
    visible(path)
    const normalized = FileSystem.normalize(path)
    if (protect(normalized)) throw new FileSystem.FsError('EACCES', path)
    let prefix = ''
    for (const part of normalized.split('/').filter(Boolean)) {
      prefix += `/${part}`
      if ((await fs.lstat?.(prefix))?.kind === 'symlink') throw new FileSystem.FsError('EACCES', path)
    }
  }
  return {
    stat: async (path) => (isHidden(path) ? null : fs.stat(path)),
    lstat: fs.lstat && (async (path) => (isHidden(path) ? null : fs.lstat!(path))),
    readlink: fs.readlink && (async (path) => (isHidden(path) ? null : fs.readlink!(path))),
    read: async (path) => (visible(path), fs.read(path)),
    list: async (path) => (visible(path), (await fs.list(path)).filter((name) => !hidden.has(name))),
    write: async (path, data, append) => (await writable(path), fs.write(path, data, append)),
    mkdir: async (path) => (await writable(path), fs.mkdir(path)),
    remove: async (path) => (await writable(path), fs.remove(path)),
    rename: async (from, to) => (await writable(from), await writable(to), fs.rename(from, to)),
  }
}

/** Refuses writes, removals and renames of files that `allow` refuses. Directories stay creatable, so that new files can go in new folders. */
export function allowFiles(fs: FileSystem.FileSystem, allow: (path: string) => boolean): FileSystem.FileSystem {
  const check = (path: string) => {
    if (!allow(FileSystem.normalize(path).replace(/^\/+/, ''))) throw new FileSystem.FsError('EACCES', path)
  }
  return {
    stat: (path) => fs.stat(path),
    lstat: fs.lstat && ((path) => fs.lstat!(path)),
    readlink: fs.readlink && ((path) => fs.readlink!(path)),
    read: (path) => fs.read(path),
    list: (path) => fs.list(path),
    mkdir: (path) => fs.mkdir(path),
    write: async (path, data, append) => (check(path), fs.write(path, data, append)),
    remove: async (path) => (check(path), fs.remove(path)),
    rename: async (from, to) => (check(from), check(to), fs.rename(from, to)),
  }
}

export type WorkspaceLayout = {
  /** The repository tree, mounted at /repo. */
  repo: FileSystem.FileSystem
  /** Task inputs that the host writes, mounted read-only at /review. */
  review: Record<string, string>
  /** Reference material, mounted read-only under /guides/<name>. */
  guides?: Record<string, FileSystem.FileSystem>
}

export const repoMount = '/repo'

/**
 * The workspace of one agent: a virtual shell over /repo, /review and /guides. The shell runs text tools
 * in-process, so an agent cannot start real processes or reach the network from it.
 */
export async function createWorkspace(layout: WorkspaceLayout): Promise<Contracts.WorkspaceHost> {
  const mounts: Record<string, FileSystem.FileSystem> = {
    [repoMount]: layout.repo,
    '/review': readOnly(MemoryFileSystem.create({ files: layout.review })),
  }
  for (const [name, fs] of Object.entries(layout.guides ?? {})) mounts[`/guides/${name}`] = readOnly(fs)
  const bash = await Bash.create({
    cwd: repoMount,
    fetch: async () => {
      throw new Error('network access is off in this workspace')
    },
    fs: Mount.create(MemoryFileSystem.create(), { mounts }),
  })
  return bash.workspace()
}
