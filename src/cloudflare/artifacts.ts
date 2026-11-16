import { artifactId, artifactMeta, checkArtifactSize, isArtifactId } from '../core/artifacts.ts'
import type { ArtifactMeta, ArtifactSource, Artifacts } from '../core/platform.ts'

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

type Row = Record<string, SqlValue>

const text = (row: Row, key: string): string => {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`artifact row: ${key} is not text`)
  return value
}

const integer = (row: Row, key: string): number => {
  const value = row[key]
  if (typeof value !== 'number') throw new Error(`artifact row: ${key} is not a number`)
  return value
}

const blob = (row: Row, key: string): ArrayBuffer => {
  const value = row[key]
  if (!(value instanceof ArrayBuffer)) throw new Error(`artifact row: ${key} is not a blob`)
  return value
}

function parseSource(json: string): ArtifactSource {
  const value: unknown = JSON.parse(json)
  if (typeof value === 'object' && value !== null) {
    if ('command' in value && typeof value.command === 'string') return { command: value.command }
    if ('url' in value && typeof value.url === 'string' && 'method' in value && typeof value.method === 'string') return { url: value.url, method: value.method }
  }
  throw new Error('artifact row: source is malformed')
}

function parseLabels(json: string): Record<string, string> {
  const value: unknown = JSON.parse(json)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('artifact row: labels are malformed')
  const labels: Record<string, string> = {}
  for (const [key, label] of Object.entries(value)) {
    if (typeof label !== 'string') throw new Error('artifact row: labels are malformed')
    labels[key] = label
  }
  return labels
}

const readMeta = (row: Row): ArtifactMeta => ({
  source: parseSource(text(row, 'source')),
  media_type: text(row, 'media_type'),
  labels: parseLabels(text(row, 'labels')),
  size: integer(row, 'size'),
  created: integer(row, 'created'),
})

/**
 * The artifacts of one run in Durable Object SQL. The meta row is in one table and the bytes are in chunk rows of
 * another table. One transaction writes the chunks and then the meta row, so an artifact is never partial.
 */
export function sqlArtifacts(storage: ArtifactStorage, run: string): Artifacts {
  const { sql } = storage
  const metaRow = (id: string) =>
    sql.exec('select source, media_type, labels, size, created from factory_artifacts where run = ? and id = ?', run, id).toArray()[0]
  return {
    async put(bytes, input) {
      checkArtifactSize(bytes.length)
      const id = await artifactId(bytes)
      const meta = artifactMeta(input, bytes.length, Date.now())
      storage.transactionSync(() => {
        // The first meta wins.
        if (metaRow(id)) return
        for (let seq = 0; seq * artifactChunkSize < bytes.length; seq++) {
          const chunk = bytes.slice(seq * artifactChunkSize, (seq + 1) * artifactChunkSize)
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
      if (!isArtifactId(id) || !metaRow(id)) return null
      const chunks = sql.exec('select data from factory_artifact_chunks where run = ? and id = ? order by seq', run, id).toArray().map((row) => new Uint8Array(blob(row, 'data')))
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
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
        .map((row) => ({ id: text(row, 'id'), meta: readMeta(row) })),
  }
}
