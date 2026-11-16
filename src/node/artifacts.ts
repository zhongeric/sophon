import { randomUUID } from 'node:crypto'
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { artifactId, artifactMeta, checkArtifactSize, isArtifactId } from '../core/artifacts.ts'
import type { ArtifactMeta, ArtifactSource, Artifacts } from '../core/platform.ts'

const code = (error: unknown) => (error as NodeJS.ErrnoException).code
const missing = (error: unknown) => code(error) === 'ENOENT'

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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'

/**
 * The meta in the text of a meta file, or null when the text is not a complete meta. A power loss, a disk error or
 * an edit by hand can leave such a file, so the store does not trust its own files.
 */
function parseArtifactMeta(text: string): ArtifactMeta | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const { source, media_type, labels, size, created } = value
  if (!isRecord(source) || !isRecord(labels) || !isText(media_type)) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null
  if (typeof created !== 'number' || !Number.isFinite(created)) return null
  const { command, url, method } = source
  const parsed: ArtifactSource | null = isText(command) ? { command } : isText(url) && isText(method) ? { url, method } : null
  if (!parsed) return null
  const strings: [string, string][] = []
  for (const [key, label] of Object.entries(labels)) {
    if (!isText(label)) return null
    strings.push([key, label])
  }
  return artifactMeta({ source: parsed, media_type, labels: Object.fromEntries(strings) }, size, created)
}

/**
 * The artifacts of one run on this machine, in <runDir>/artifacts/: `<id>` holds the bytes and `<id>.json` the meta.
 * The file system must support hard links. Each file comes from a complete temporary file. The meta file comes last.
 * An artifact exists only when its meta file holds a valid meta and its bytes file exists.
 * Thus a crash never shows a partial artifact under its ID.
 */
export function nodeArtifacts(runDir: string): Artifacts {
  const dir = join(runDir, 'artifacts')

  /** Writes a file under a temporary name that is never a valid ID, then gives it the name `name` with `move`. */
  const place = async (name: string, data: Uint8Array | string, move: (temp: string, path: string) => Promise<void>) => {
    const temp = join(dir, `.tmp-${name}-${randomUUID()}`)
    try {
      await writeFile(temp, data)
      await move(temp, join(dir, name))
    } finally {
      await rm(temp, { force: true })
    }
  }

  /** The meta of a valid ID, or null when the meta file is missing or does not hold a valid meta. */
  const readMeta = async (id: string): Promise<ArtifactMeta | null> => {
    const text = await readOrNull(join(dir, `${id}.json`))
    return text && parseArtifactMeta(text.toString('utf8'))
  }

  const repairMeta = async (id: string, temp: string, path: string) => {
    // The directory lock makes the check and replacement atomic across stores and processes.
    const lock = join(dir, `.repair-${id}`)
    const deadline = Date.now() + 5_000
    for (;;) {
      try {
        await mkdir(lock)
        break
      } catch (error) {
        if (code(error) !== 'EEXIST') throw error
        if (await readMeta(id)) return
        // A crash can leave the lock. The operation stops after five seconds.
        if (Date.now() >= deadline) throw new Error(`artifact ${id}: metadata repair lock is busy: ${lock}`)
        await sleep(10)
      }
    }
    try {
      if (!(await readMeta(id))) await rename(temp, path)
    } finally {
      await rm(lock, { recursive: true })
    }
  }

  /** The meta of a valid ID, or null when either file is missing or the meta is not valid. */
  const find = async (id: string): Promise<ArtifactMeta | null> => {
    const meta = await readMeta(id)
    return meta && (await exists(join(dir, id))) ? meta : null
  }

  return {
    async put(bytes, meta) {
      checkArtifactSize(bytes.length)
      const id = await artifactId(bytes)
      if (await find(id)) return id
      await mkdir(dir, { recursive: true })
      // The bytes are the same for each put of this ID, so a rename over the file of another put is safe.
      await place(id, bytes, rename)
      // The first meta wins. A hard link fails when the name exists.
      // Thus a put that runs at the same time never replaces valid meta.
      // A put replaces only a meta file that is not valid.
      await place(`${id}.json`, `${JSON.stringify(artifactMeta(meta, bytes.length, Date.now()), null, 2)}\n`, async (temp, path) => {
        try {
          await link(temp, path)
        } catch (error) {
          if (code(error) !== 'EEXIST') throw error
          await repairMeta(id, temp, path)
        }
      })
      return id
    },
    async get(id) {
      // The ID check comes before any path join, so a read never leaves the directory.
      if (!isArtifactId(id) || !(await readMeta(id))) return null
      const bytes = await readOrNull(join(dir, id))
      return bytes && new Uint8Array(bytes)
    },
    async meta(id) {
      return isArtifactId(id) ? find(id) : null
    },
    async list() {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch (error) {
        if (missing(error)) return []
        throw error
      }
      // The directory listing gives the bytes files, so list needs no stat for each ID.
      const files = new Set(names)
      const ids = names
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .filter((id) => isArtifactId(id) && files.has(id))
      const entries = await Promise.all(ids.map(async (id) => ({ id, meta: await readMeta(id) })))
      return entries
        .flatMap(({ id, meta }) => (meta ? [{ id, meta }] : []))
        .sort((a, b) => a.meta.created - b.meta.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    },
  }
}
