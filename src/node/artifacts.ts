import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artifactId, artifactMeta, checkArtifactSize, isArtifactId } from '../core/artifacts.ts'
import type { ArtifactMeta, Artifacts } from '../core/platform.ts'

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** The contents of a file, or null when it does not exist. */
async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

/**
 * The artifacts of one run on this machine, in <runDir>/artifacts/: `<id>` holds the bytes and `<id>.json` the meta.
 * Each file comes from a temporary name through a rename, and the meta file comes last. Thus an artifact exists only
 * when its meta file exists, and a crash never shows a partial artifact under its ID.
 */
export function nodeArtifacts(runDir: string): Artifacts {
  const dir = join(runDir, 'artifacts')

  /** Writes a file under a temporary name that is never a valid ID, then renames it to `name`. */
  const place = async (name: string, data: Uint8Array | string) => {
    const temp = join(dir, `.tmp-${name}-${randomUUID()}`)
    try {
      await writeFile(temp, data)
      await rename(temp, join(dir, name))
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }

  /** The meta of a valid ID. The store wrote the file itself. */
  const readMeta = async (id: string): Promise<ArtifactMeta | null> => {
    const text = await readOrNull(join(dir, `${id}.json`))
    return text && (JSON.parse(text.toString('utf8')) as ArtifactMeta)
  }

  return {
    async put(bytes, meta) {
      checkArtifactSize(bytes.length)
      const id = await artifactId(bytes)
      // The first meta wins: the same bytes again change nothing.
      if (await readMeta(id)) return id
      await mkdir(dir, { recursive: true })
      await place(id, bytes)
      await place(`${id}.json`, `${JSON.stringify(artifactMeta(meta, bytes.length, Date.now()), null, 2)}\n`)
      return id
    },
    async get(id) {
      // The ID check comes before any path join, so a read never leaves the directory.
      if (!isArtifactId(id) || !(await readMeta(id))) return null
      const bytes = await readOrNull(join(dir, id))
      return bytes && new Uint8Array(bytes)
    },
    async meta(id) {
      if (!isArtifactId(id)) return null
      const meta = await readMeta(id)
      return meta && (await exists(join(dir, id))) ? meta : null
    },
    async list() {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch (error) {
        if (missing(error)) return []
        throw error
      }
      const ids = names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).filter(isArtifactId)
      const entries = await Promise.all(ids.map(async (id) => ({ id, meta: await readMeta(id) })))
      return entries
        .flatMap(({ id, meta }) => (meta ? [{ id, meta }] : []))
        .sort((a, b) => a.meta.created - b.meta.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    },
  }
}
