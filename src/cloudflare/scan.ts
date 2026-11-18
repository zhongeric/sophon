import { DurableObject } from 'cloudflare:workers'
import { containerBox, httpBox, type Box, type JobState } from './box.ts'
import type { Env } from './runs.ts'
import { scanSlot, slotInactivityMs, type SlotState, type SlotStore, type Unit } from './scan-slot.ts'

/** The slot state in Durable Object SQL: one row. */
function sqlSlotStore(sql: SqlStorage): SlotStore {
  return {
    read() {
      const row = sql.exec<{ name: string; job: string; timeout_ms: number }>('select name, job, timeout_ms from scan_slot where id = 0').toArray()[0]
      return row ? { job: row.job, name: row.name, timeoutMs: row.timeout_ms } : null
    },
    save: (state: SlotState) => void sql.exec('insert or replace into scan_slot (id, name, job, timeout_ms) values (0, ?, ?, ?)', state.name, state.job, state.timeoutMs),
  }
}

/**
 * One slot of a pool of scan boxes, named `<pool>/<slot>`: a small container with no network for one search unit.
 * The host starts a unit, polls or kills its job, and reads its output files (scan-slot.ts). Each RPC method takes the
 * name of the slot, and the object refuses a name other than the name of its first unit.
 */
export class ScanBoxes extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec('create table if not exists scan_slot (id integer primary key, name text not null, job text not null, timeout_ms integer not null)')
  }

  /** The slot over MACHINE_URL in local tests, else over the container of this object, with no network. */
  private slot(name: string) {
    const store = sqlSlotStore(this.ctx.storage.sql)
    return scanSlot(this.box(store), store, name)
  }

  private box(store: SlotStore): Box {
    if (this.env.MACHINE_URL) return httpBox(this.env.MACHINE_URL)
    if (!this.ctx.container) throw new Error('this Worker has no container for scan boxes: add the ScanBoxes container of wrangler.jsonc and deploy again')
    return containerBox(this.ctx.container, { enableInternet: false, inactivityMs: () => slotInactivityMs(store.read()), onStart: () => {} })
  }

  start(name: string, unit: Unit): Promise<{ job: string }> {
    return this.slot(name).start(unit)
  }

  poll(name: string): Promise<JobState> {
    return this.slot(name).poll()
  }

  kill(name: string): Promise<void> {
    return this.slot(name).kill()
  }

  read(name: string, path: string): Promise<Uint8Array> {
    return this.slot(name).read(path)
  }
}
