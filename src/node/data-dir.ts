import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { artifactId, isArtifactId } from '../core/artifacts.ts'
import type { DataStore } from '../core/platform.ts'

/**
 * A DataStore over a directory: one file for each SHA-256 hex, written one time. A put writes a temporary file and
 * renames it, so a reader never sees a part of a file. Only a valid ID names a file, so no path is outside the directory.
 */
export function dirDataStore(dir: string): DataStore {
  return {
    async put(bytes) {
      const id = await artifactId(bytes)
      const path = join(dir, id)
      if (existsSync(path)) return id
      mkdirSync(dir, { recursive: true })
      const temporary = `${path}.${crypto.randomUUID()}.tmp`
      writeFileSync(temporary, bytes)
      renameSync(temporary, path)
      return id
    },
    async get(id) {
      if (!isArtifactId(id)) return null
      try {
        return new Uint8Array(readFileSync(join(dir, id)))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
  }
}
