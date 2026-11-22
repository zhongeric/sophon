import type { ScanBoxes } from '../core/fanout.ts'
import type { InstanceSpec } from '../core/usage.ts'
import type { JobState } from './box.ts'
import { maxUnitMs, type Unit } from './scan-slot.ts'

/** The instance type of the run boxes and the scan boxes in wrangler.jsonc. */
export const standard4: InstanceSpec = { type: 'standard-4', vcpu: 4, gib: 12 }

/** The RPC methods of one ScanBoxes object (scan.ts). */
export type ScanSlotStub = {
  start(name: string, unit: Unit): Promise<{ job: string }>
  poll(name: string): Promise<JobState>
  kill(name: string): Promise<void>
  read(name: string, path: string): Promise<Uint8Array>
}

/** The part of the SCAN_BOXES namespace that the pool uses, so that Node tests can give a fake one. */
export type ScanNamespace<Id> = { idFromName(name: string): Id; get(id: Id): ScanSlotStub }

/** The error of a container start when all max_instances boxes of the class run. */
const capacityError = /no container instance that can be provided|maximum number of running container instances/i

/**
 * The scan boxes of a research run on Cloudflare: one ScanBoxes object for each slot name. A start that the container
 * capacity refuses is `full`, so that the fan-out waits. Each other error goes to the fan-out as a lost box.
 */
export function scanPool<Id>(namespace: ScanNamespace<Id>, pollMs = 5_000): ScanBoxes {
  const slot = (name: string) => namespace.get(namespace.idFromName(name))
  return {
    instance: standard4,
    maxUnitMs,
    pollMs,
    async start(name, { command, inputs, timeoutMs }) {
      try {
        return await slot(name).start(name, { argv: ['bash', '-c', command], inputs, timeoutMs })
      } catch (error) {
        if (error instanceof Error && capacityError.test(error.message)) return { full: true }
        throw error
      }
    },
    poll: (name) => slot(name).poll(name),
    kill: (name) => slot(name).kill(name),
    read: (name, path) => slot(name).read(name, path),
  }
}
