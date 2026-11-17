import type { Contracts } from 'nanocode-ts'
import type { Ledger } from './ledger.ts'
import type { SubagentLimit } from './roles.ts'
import { modelCall } from './usage.ts'

type Dispatch = Contracts.RuntimeOptions['dispatch']

/**
 * The subagents of one root turn. `started` and `running` hold subagent IDs. `tokens` holds the input and output
 * tokens of the subagents.
 */
export type SubagentCounts = { started: number[]; running: number[]; tokens: number }

/** The counts and cross-turn call sequences share one record so that a ledger write commits both. */
export type SubagentRecord = { turns: Record<string, SubagentCounts>; seen: Record<string, number> }

/** The `update` of a published subagent event. Only the fields that the limits read. */
type SubagentUpdate = { type?: unknown; id?: unknown; status?: { state?: unknown } | null; event?: unknown }

const endStates = new Set(['completed', 'failed', 'interrupted', 'closed'])

export const subagentKey = (agentId: string) => `subagents:${agentId}`

/**
 * Checks the subagent limit of one agent (RD1 of the research spec). nanocode-ts has a concurrent limit that queues
 * a spawn, but no limit that refuses a spawn. Thus the host refuses the first model request of a new subagent, and the
 * parent agent gets the error as the result of the subagent. The counts of each root turn are in the ledger, so a
 * resumed turn keeps them.
 */
export function subagentLimits(ledger: Ledger, agentId: string, limit: SubagentLimit) {
  let turn: string | undefined
  const key = subagentKey(agentId)
  const read = (): SubagentRecord => ledger.get<SubagentRecord>(key) ?? { turns: {}, seen: {} }

  /** Records a new subagent, or throws the error of the first limit that it is over. */
  function admit(id: number): void {
    if (turn === undefined) throw new Error(`subagent limit: ${agentId} has no root turn`)
    const record = read()
    const counts = record.turns[turn] ?? { started: [], running: [], tokens: 0 }
    // A known subagent continues, also over the token limit, because the limits stop only new spawns.
    if (counts.started.includes(id)) return
    if (counts.running.length >= limit.concurrent) throw new Error(`subagent limit: ${counts.running.length} of ${limit.concurrent} subagents run at the same time`)
    if (counts.started.length >= limit.perTurn) throw new Error(`subagent limit: this turn started ${counts.started.length} of ${limit.perTurn} subagents`)
    if (counts.tokens >= limit.tokens) throw new Error(`subagent limit: the subagents of this turn used ${counts.tokens} of ${limit.tokens} tokens`)
    ledger.put(key, {
      ...record,
      turns: { ...record.turns, [turn]: { ...counts, started: [...counts.started, id], running: [...counts.running, id] } },
    } satisfies SubagentRecord)
  }

  return {
    /** Starts or resumes the counts of a root turn. Each root request ID has its own counts. */
    begin(requestId: string): void {
      turn = requestId
    },
    /** Wraps the dispatch. The check and the record of a new subagent are one synchronous step, before the first await. */
    dispatch(inner: Dispatch): Dispatch {
      return async (request, signal, timing) => {
        if (request.subagent) admit(request.subagent.id)
        return inner(request, signal, timing)
      }
    },
    /** Removes the subagents that ended from `running`, and adds the tokens of the model calls of subagents. */
    observe(events: Contracts.LoggedEvent[]): void {
      if (turn === undefined) return
      const record = read()
      let counts = record.turns[turn] ?? { started: [], running: [], tokens: 0 }
      let seen = record.seen
      let changed = false
      for (const logged of events) {
        const event = logged.event as { source?: unknown; update?: SubagentUpdate | null } | null
        const update = event?.source === 'subagent' ? event.update : undefined
        if (!update) continue
        const ended = update.type === 'completion' || (update.type === 'status' && endStates.has(String(update.status?.state)))
        const id = Number(update.id)
        if (ended && counts.running.includes(id)) {
          counts = { ...counts, running: counts.running.filter((running) => running !== id) }
          changed = true
        }
        const call = update.type === 'event' ? modelCall(update.event, logged) : undefined
        if (!call) continue
        const last = seen[call.run]
        if (last !== undefined && call.seq <= last) continue
        seen = { ...seen, [call.run]: call.seq }
        changed = true
        if (!call.replayed) counts = { ...counts, tokens: counts.tokens + call.tokens.input + call.tokens.output }
      }
      if (changed) {
        ledger.put(key, { turns: { ...record.turns, [turn]: counts }, seen } satisfies SubagentRecord)
      }
    },
  }
}
