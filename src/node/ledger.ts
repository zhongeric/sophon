import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Ledger } from '../core/ledger.ts'

/** The ledger as a JSON file. Each write replaces the file atomically, so a crash leaves the last complete state. */
export function fileLedger(path: string): Ledger {
  let state: Record<string, unknown> = {}
  try {
    state = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return {
    get: <T>(key: string) => state[key] as T | undefined,
    put(key, value) {
      state[key] = value
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2))
      renameSync(`${path}.tmp`, path)
    },
  }
}
