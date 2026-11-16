import type { SqlValue } from './artifacts.ts'
import type { SyncState, SyncStore } from './box.ts'

/** The part of SqlStorage that the sync store uses. This file declares it, so that tests can import the store under the Node types. */
export type SyncSql = { exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, SqlValue>[] } }

/** One row for each file, and one row for each directory with its sync ID. A row stays under the 2 MB row limit of Durable Object SQLite. */
export function createSyncTables(sql: SyncSql): void {
  sql.exec('create table if not exists factory_syncs (run text not null, dir text not null, sync text not null, primary key (run, dir))')
  sql.exec('create table if not exists factory_sync_files (run text not null, dir text not null, path text not null, stamp text not null, primary key (run, dir, path))')
}

function files(sql: SyncSql, run: string, dir: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const row of sql.exec('select path, stamp from factory_sync_files where run = ? and dir = ?', run, dir).toArray()) {
    if (typeof row.path !== 'string' || typeof row.stamp !== 'string') throw new Error('invalid sync file row')
    result.set(row.path, row.stamp)
  }
  return result
}

/**
 * What the container directories of one run got from their last sync, in Durable Object SQL. A directory without a
 * sync row has no valid state, so a sync that stops part of the way never counts. The file rows of an invalid
 * directory stay, so that the next save writes only the rows that changed.
 */
export function sqlSyncs(sql: SyncSql, run: string): SyncStore {
  return {
    read(dir) {
      const sync = sql.exec('select sync from factory_syncs where run = ? and dir = ?', run, dir).toArray()[0]?.sync
      if (sync === undefined) return null
      if (typeof sync !== 'string') throw new Error('invalid sync row')
      return { files: files(sql, run, dir), sync }
    },
    invalidate(dir) {
      sql.exec('delete from factory_syncs where run = ? and dir = ?', run, dir)
    },
    save(dir, state: SyncState) {
      sql.exec('delete from factory_syncs where run = ? and dir = ?', run, dir)
      const last = files(sql, run, dir)
      for (const path of last.keys()) if (!state.files.has(path)) sql.exec('delete from factory_sync_files where run = ? and dir = ? and path = ?', run, dir, path)
      for (const [path, stamp] of state.files) {
        if (last.get(path) !== stamp) sql.exec('insert or replace into factory_sync_files (run, dir, path, stamp) values (?, ?, ?, ?)', run, dir, path, stamp)
      }
      // The sync row comes last: only a complete manifest is valid.
      sql.exec('insert into factory_syncs (run, dir, sync) values (?, ?, ?)', run, dir, state.sync)
    },
    // The container is shared by all runs of the object, so its start clears the state of every run.
    clear() {
      sql.exec('delete from factory_syncs')
      sql.exec('delete from factory_sync_files')
    },
  }
}
