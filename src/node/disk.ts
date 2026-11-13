import type { Stats } from 'node:fs'
import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { FileSystem, MemoryFileSystem } from 'nanocode-ts/bash'

/** Paths that the host hides from agents in every workspace. */
const hidden = new Set(['.git'])

/**
 * A directory on disk as an agent file system. Paths cannot leave `root`, through `..` or symlinks,
 * and `protect` refuses writes to paths that the host owns, such as check configuration.
 */
export function diskFileSystem(root: string, protect: (path: string) => boolean = () => false): FileSystem.FileSystem {
  let realRoot: Promise<string> | undefined
  const isHidden = (path: string) => FileSystem.normalize(path).split('/').some((part) => hidden.has(part))

  /** The real path behind `path`, and that path relative to the root, so that rules apply to symlink targets too. */
  const locate = async (path: string, mustExist: boolean) => {
    const normalized = FileSystem.normalize(path)
    if (isHidden(normalized)) throw new FileSystem.FsError('ENOENT', path)
    const base = await (realRoot ??= realpath(root))
    let real: string
    try {
      real = mustExist ? await realpath(join(root, normalized)) : await realTarget(join(root, normalized))
    } catch (error) {
      throw new FileSystem.FsError((error as NodeJS.ErrnoException).code ?? 'EIO', path)
    }
    if (real !== base && !real.startsWith(base + sep)) throw new FileSystem.FsError('EACCES', path)
    const inside = `/${relative(base, real).split(sep).join('/')}`
    if (isHidden(inside)) throw new FileSystem.FsError('ENOENT', path)
    return { real, inside }
  }
  const resolve = async (path: string, mustExist: boolean) => (await locate(path, mustExist)).real

  /** Agents never write through a symlink, and protected paths are refused by name and by real target. */
  const writable = async (path: string) => {
    const normalized = FileSystem.normalize(path)
    if (protect(normalized)) throw new FileSystem.FsError('EACCES', path)
    const link = await lstat(join(root, normalized)).catch(() => null)
    if (link?.isSymbolicLink()) throw new FileSystem.FsError('EACCES', path)
    const { real, inside } = await locate(path, false)
    if (protect(inside)) throw new FileSystem.FsError('EACCES', path)
    return real
  }

  const toStat = (info: Stats): FileSystem.FileStat => ({
    kind: info.isDirectory() ? 'directory' : 'file',
    mode: info.mode,
    mtime: info.mtimeMs,
    size: info.size,
  })

  return {
    async stat(path) {
      try {
        return toStat(await stat(await resolve(path, true)))
      } catch {
        return null
      }
    },
    async lstat(path) {
      try {
        const info = await lstat(await resolve(path, true))
        return info.isSymbolicLink() ? { ...toStat(info), kind: 'symlink' } : toStat(info)
      } catch {
        return null
      }
    },
    async readlink(path) {
      try {
        return await readlink(join(root, FileSystem.normalize(path)))
      } catch {
        return null
      }
    },
    read: async (path) => new Uint8Array(await readFile(await resolve(path, true))),
    async list(path) {
      const names = await readdir(await resolve(path, true))
      return names.filter((name) => !hidden.has(name))
    },
    async write(path, data, append) {
      await writeFile(await writable(path), data, { flag: append ? 'a' : 'w' })
    },
    async mkdir(path) {
      await mkdir(await writable(path), { recursive: true })
    },
    async remove(path) {
      await rm(await writable(path), { recursive: true, force: true })
    },
    async rename(from, to) {
      await rename(await writable(from), await writable(to))
    },
  }
}

/**
 * The real path of `target`, which may not exist yet: its nearest existing ancestor, resolved, plus the rest.
 * A dangling symlink on the way is refused, because a write would create its target, wherever it points.
 */
async function realTarget(target: string): Promise<string> {
  const missing: string[] = []
  let existing = target
  for (;;) {
    try {
      return join(await realpath(existing), ...missing.reverse())
    } catch (error) {
      const parent = dirname(existing)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === existing) throw error
      if (await lstat(existing).then((info) => info.isSymbolicLink(), () => false)) throw Object.assign(new Error('dangling symlink'), { code: 'EACCES' })
      missing.push(basename(existing))
      existing = parent
    }
  }
}

/** A guide file or directory on disk as a mountable file system. */
export async function guideFileSystem(path: string): Promise<FileSystem.FileSystem> {
  const info = await stat(path)
  if (info.isDirectory()) return diskFileSystem(path)
  return MemoryFileSystem.create({ files: { [`/${basename(path)}`]: await readFile(path) } })
}
