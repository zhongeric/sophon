import type { Ledger } from '../core/ledger.ts'
import type { Files } from '../core/platform.ts'

/** The tables of the host's own state in a Durable Object, beside the SDK's journal. */
export function createTables(sql: SqlStorage): void {
  sql.exec('create table if not exists factory_ledger (run text not null, key text not null, value text not null, primary key (run, key))')
  sql.exec('create table if not exists factory_files (run text not null, name text not null, text text not null, primary key (run, name))')
  sql.exec(
    'create table if not exists factory_runs (run text primary key, state text not null, note text not null, created integer not null, request text not null)',
  )
}

/** One run's ledger in Durable Object SQL. Writes are synchronous, so each step is stored before the next one starts. */
export function sqlLedger(sql: SqlStorage, run: string): Ledger {
  const cache = new Map<string, unknown>()
  for (const row of sql.exec<{ key: string; value: string }>('select key, value from factory_ledger where run = ?', run)) cache.set(row.key, JSON.parse(row.value))
  return {
    get: <T>(key: string) => cache.get(key) as T | undefined,
    put(key, value) {
      const text = JSON.stringify(value) ?? 'null'
      sql.exec('insert or replace into factory_ledger (run, key, value) values (?, ?, ?)', run, key, text)
      cache.set(key, JSON.parse(text))
    },
  }
}

export function sqlFiles(sql: SqlStorage, run: string): Files & { read(name: string): string | null } {
  const read = (name: string) => sql.exec<{ text: string }>('select text from factory_files where run = ? and name = ?', run, name).toArray()[0]?.text ?? null
  return {
    read,
    write: (name, text) => void sql.exec('insert or replace into factory_files (run, name, text) values (?, ?, ?)', run, name, text),
    append: (name, text) => void sql.exec('insert or replace into factory_files (run, name, text) values (?, ?, ?)', run, name, (read(name) ?? '') + text),
    exists: (name) => read(name) !== null,
  }
}
