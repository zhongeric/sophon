import { artifactId, isArtifactId } from '../core/artifacts.ts'
import type { DataStore } from '../core/platform.ts'

/** The part of an R2 bucket that the data store uses, so that Node tests can give a fake. */
export type DataBucket = {
  head(key: string): Promise<unknown>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  put(key: string, value: Uint8Array): Promise<unknown>
}

/** A DataStore over the SWEEP_DATA bucket. The key is the SHA-256 hex, so a second put of the same bytes writes nothing. */
export function r2DataStore(bucket: DataBucket): DataStore {
  return {
    async put(bytes) {
      const id = await artifactId(bytes)
      if ((await bucket.head(id)) === null) await bucket.put(id, bytes)
      return id
    },
    async get(id) {
      if (!isArtifactId(id)) return null
      const object = await bucket.get(id)
      return object ? new Uint8Array(await object.arrayBuffer()) : null
    },
  }
}
