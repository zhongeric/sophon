import { artifactId, artifactMeta, checkArtifactSize, isArtifactId } from '../core/artifacts.ts'
import type { ArtifactMeta, Artifacts } from '../core/platform.ts'

/** The size of one chunk row: 1 MiB, under the 2 MB row limit of Durable Object SQLite. */
export const artifactChunkSize = 1024 * 1024

/** A value of Durable Object SQL. A blob is an ArrayBuffer. */
export type SqlValue = ArrayBuffer | string | number | null

/** The part of SqlStorage that the store uses. This file declares it, so that tests can import the store under the Node types. */
export type ArtifactSql = { exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, SqlValue>[] } }

/** The part of DurableObjectStorage that the store uses. */
export type ArtifactStorage = { sql: ArtifactSql; transactionSync(fn: () => void): void }

export function createArtifactTables(sql: ArtifactSql): void {
  sql.exec(
    'create table if not exists factory_artifacts (run text not null, id text not null, source text not null, media_type text not null, labels text not null, size integer not null, created integer not null, primary key (run, id))',
  )
  sql.exec('create table if not exists factory_artifact_chunks (run text not null, id text not null, seq integer not null, data blob not null, primary key (run, id, seq))')
}

type MetaRow = { source: string; media_type: string; labels: string; size: number; created: number }

function checkMetaRow(row: Record<string, SqlValue>): asserts row is MetaRow {
  if (typeof row.source !== 'string' || typeof row.media_type !== 'string' || typeof row.labels !== 'string' || typeof row.size !== 'number' || typeof row.created !== 'number') {
    throw new Error('invalid artifact meta row')
  }
}

/** The meta of a row that this store wrote itself, from a checked ArtifactMeta. */
const readMeta = (row: MetaRow): ArtifactMeta => ({
  source: JSON.parse(row.source),
  media_type: row.media_type,
  labels: JSON.parse(row.labels),
  size: row.size,
  created: row.created,
})

/**
 * The artifacts of one run in Durable Object SQL. The meta row is in one table and the bytes are in chunk rows of
 * another table. One transaction writes the chunks and then the meta row, so an artifact is never partial.
 */
export function sqlArtifacts(storage: ArtifactStorage, run: string): Artifacts {
  const { sql } = storage
  const metaRow = (id: string) => {
    const row = sql.exec('select source, media_type, labels, size, created from factory_artifacts where run = ? and id = ?', run, id).toArray()[0]
    if (!row) return undefined
    checkMetaRow(row)
    return row
  }
  return {
    async put(bytes, input) {
      checkArtifactSize(bytes.length)
      const id = await artifactId(bytes)
      const meta = artifactMeta(input, bytes.length, Date.now())
      storage.transactionSync(() => {
        // The first meta wins.
        if (metaRow(id)) return
        for (let seq = 0; seq * artifactChunkSize < bytes.length; seq++) {
          // An explicit copy: the slice of a Buffer is a view, and its buffer is the full backing memory.
          const chunk = new Uint8Array(bytes.subarray(seq * artifactChunkSize, (seq + 1) * artifactChunkSize))
          sql.exec('insert into factory_artifact_chunks (run, id, seq, data) values (?, ?, ?, ?)', run, id, seq, chunk.buffer)
        }
        sql.exec(
          'insert into factory_artifacts (run, id, source, media_type, labels, size, created) values (?, ?, ?, ?, ?, ?, ?)',
          run,
          id,
          JSON.stringify(meta.source),
          meta.media_type,
          JSON.stringify(meta.labels),
          meta.size,
          meta.created,
        )
      })
      return id
    },
    async get(id) {
      const row = isArtifactId(id) ? metaRow(id) : undefined
      if (!row) return null
      // Read one chunk row at a time, so that memory does not hold all chunks and the result.
      const bytes = new Uint8Array(row.size)
      for (let seq = 0; seq * artifactChunkSize < bytes.length; seq++) {
        const data = sql.exec('select data from factory_artifact_chunks where run = ? and id = ? and seq = ?', run, id, seq).toArray()[0]?.data
        if (!(data instanceof ArrayBuffer)) throw new Error(`artifact ${id}: chunk ${seq} is missing`)
        bytes.set(new Uint8Array(data), seq * artifactChunkSize)
      }
      return bytes
    },
    async meta(id) {
      const row = isArtifactId(id) ? metaRow(id) : undefined
      return row ? readMeta(row) : null
    },
    list: async () =>
      sql
        .exec('select id, source, media_type, labels, size, created from factory_artifacts where run = ? order by created, id', run)
        .toArray()
        .map((row) => {
          const id = row.id
          if (typeof id !== 'string') throw new Error('invalid artifact ID row')
          checkMetaRow(row)
          return { id, meta: readMeta(row) }
        }),
  }
}
