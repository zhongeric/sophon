import { FileSystem } from 'nanocode-ts/bash'
import type { ArtifactInput, ArtifactMeta, ArtifactSource, Artifacts } from './platform.ts'

/** The largest artifact in bytes, on every platform: 32 MiB. */
export const artifactSizeLimit = 32 * 1024 * 1024

/** An ID is the SHA-256 lowercase hex of the bytes. Any other text is never a valid ID or a valid file name. */
export const isArtifactId = (id: string): boolean => /^[0-9a-f]{64}$/.test(id)

export async function artifactId(bytes: Uint8Array): Promise<string> {
  // The copy gives a plain ArrayBuffer, which Web Crypto accepts on every platform.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Refuses an artifact over the limit. An artifact of exactly the limit is accepted. */
export function checkArtifactSize(size: number): void {
  if (size > artifactSizeLimit) throw new Error(`artifact of ${size} bytes is over the limit of ${artifactSizeLimit} bytes`)
}

/** The stored meta, from the known fields only, so that extra keys of the caller cannot set the size or the time. */
export function artifactMeta(input: ArtifactInput, size: number, created: number): ArtifactMeta {
  const source: ArtifactSource = 'command' in input.source
    ? { command: input.source.command }
    : { url: input.source.url, method: input.source.method }
  return { source, media_type: input.media_type, labels: { ...input.labels }, size, created }
}

const metaText = (meta: ArtifactMeta) => `${JSON.stringify(meta, null, 2)}\n`

/**
 * A live, read-only view of a store: `/<id>` holds the bytes and `/<id>.json` the meta. Each call asks the store
 * again, so an artifact that a step puts after the mount shows at once.
 */
export function artifactsFileSystem(store: Artifacts): FileSystem.FileSystem {
  const name = (path: string) => FileSystem.normalize(path).replace(/^\/+/, '')
  /** The artifact behind a file name, or null for an unknown or malformed name. */
  const find = async (path: string) => {
    const file = name(path)
    const json = file.endsWith('.json')
    const id = json ? file.slice(0, -'.json'.length) : file
    if (!isArtifactId(id)) return null
    const meta = await store.meta(id)
    return meta && { id, meta, json }
  }
  const refuse = async (path: string): Promise<never> => {
    throw new FileSystem.FsError('EROFS', path)
  }
  return {
    async stat(path) {
      if (name(path) === '') return { kind: 'directory', mode: 0o555, mtime: 0, size: 0 }
      const found = await find(path)
      if (!found) return null
      const size = found.json ? new TextEncoder().encode(metaText(found.meta)).length : found.meta.size
      return { kind: 'file', mode: 0o444, mtime: found.meta.created, size }
    },
    async read(path) {
      if (name(path) === '') throw new FileSystem.FsError('EISDIR', path)
      const found = await find(path)
      if (!found) throw new FileSystem.FsError('ENOENT', path)
      if (found.json) return new TextEncoder().encode(metaText(found.meta))
      const bytes = await store.get(found.id)
      if (!bytes) throw new FileSystem.FsError('ENOENT', path)
      return bytes
    },
    async list(path) {
      if (name(path) !== '') throw new FileSystem.FsError((await find(path)) ? 'ENOTDIR' : 'ENOENT', path)
      return (await store.list()).flatMap(({ id }) => [id, `${id}.json`])
    },
    write: refuse,
    mkdir: refuse,
    remove: refuse,
    rename: refuse,
  }
}
