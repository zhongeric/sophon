import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Contracts } from 'nanocode-ts'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import { runTurn, submitOnce, type AgentHost, type AgentSpec } from '../src/core/agent.ts'
import { step, type Ledger } from '../src/core/ledger.ts'
import { alarmLines, callBudget, crashRestartsKey, PlannedStop, plannedStopsKey, settleAll } from '../src/core/planned-stop.ts'
import { createWorkspace } from '../src/core/workspace.ts'
import { fileLedger } from '../src/node/ledger.ts'
import { sqliteStore } from '../src/node/platform.ts'
import { credentials, module } from './support/fixture.ts'
import { scriptedDispatch, type Script, type Turn } from './support/scripted-model.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function memoryLedger(): Ledger {
  const state = new Map<string, unknown>()
  return { get: <T>(key: string) => state.get(key) as T | undefined, put: (key, value) => void state.set(key, value) }
}

const submitNote: Contracts.HostTool = {
  name: 'submit_note',
  description: 'Submit the note one time.',
  parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false },
}

const nudgeText = /You ended the turn without calling submit_note/

/** The model ends the first turn without the submit tool, and submits in the nudge turn. */
const submitOnNudge: Script = (turn) => {
  if (turn.output !== null) return { text: 'done' }
  return nudgeText.test(turn.request) ? { cell: "await tools.submit_note({ note: 'done' }); text('submitted')" } : { text: 'done' }
}

/**
 * The hosts of several alarm calls on the same files. Each call gets a new ledger with a budget that is already spent
 * at its start (a fake clock), so the run can stop at each safe point after its first new work.
 */
function callSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-planned-stop-'))
  const turns: Turn[] = []
  const dispatch = scriptedDispatch(submitOnNudge, turns)
  const call = (): AgentHost => ({
    module,
    store: sqliteStore(join(dir, 'agents.sqlite'), join(dir, 'agents')),
    ledger: callBudget(fileLedger(join(dir, 'state.json')), { budgetMs: 1000, startedAt: 0, now: () => 5000 }),
    credentials,
    dispatch,
    log: () => {},
  })
  const spec = async (host: AgentHost, id: string): Promise<AgentSpec> => ({
    id,
    provider: 'claude',
    model: 'claude-opus-5-5',
    instructions: `Agent role: ${id}`,
    workspace: await createWorkspace({ repo: MemoryFileSystem.create(), review: {} }),
    tools: submitOnce(host, `output:${id}`, submitNote, async (input) => input),
  })
  return { call, spec, turns }
}

test('a spent budget stops the run before the nudge, and a new call continues without a request for the finished turn', async () => {
  const run = callSetup()
  const first = run.call()
  // The budget is spent at the start, but the first turn runs: the call has no new work yet (decision 7).
  await assert.rejects(runTurn(first, await run.spec(first, 'note'), 'Write a note.', 'submit_note'), PlannedStop)
  assert.equal(run.turns.length, 1)
  assert.doesNotMatch(run.turns[0]!.request, nudgeText)
  assert.equal(first.ledger.get('output:note'), undefined)
  assert.equal(first.ledger.get('retries:note:task'), undefined)

  // The new call replays the finished turn from the journal. Its report is not new work, so the nudge runs.
  const second = run.call()
  assert.deepEqual(await runTurn(second, await run.spec(second, 'note'), 'Write a note.', 'submit_note'), { note: 'done' })
  const resumed = run.turns.slice(1)
  assert.ok(resumed.length > 0)
  for (const turn of resumed) assert.match(turn.request, nudgeText)
})

test('a spent budget stops before a new step only after the call recorded new work, and a recorded step needs no check', async () => {
  const ledger = memoryLedger()
  ledger.put('step:done', { result: 'old' })
  ledger.put('report:note:task', { status: 'completed' })
  const budget = callBudget(ledger, { budgetMs: 1000, startedAt: 0, now: () => 1000 })

  // The same key again, as a replayed journal turn, and a key that is not a step, an output or a report: no new work.
  budget.put('report:note:task', { status: 'completed' })
  budget.put('session:note', 'id')
  assert.equal(await step(budget, 'done', async () => 'new'), 'old')
  assert.equal(await step(budget, 'first', async () => 'first'), 'first')

  const ran: string[] = []
  await assert.rejects(
    step(budget, 'second', async () => void ran.push('second')),
    (error: unknown) => error instanceof PlannedStop && /used 1 s of its budget of 1 s/.test(error.message),
  )
  assert.deepEqual(ran, [])
  assert.equal(await step(budget, 'done', async () => 'new'), 'old')

  // A budget that is not spent never stops.
  const open = callBudget(ledger, { budgetMs: 1000, startedAt: 0, now: () => 999 })
  open.put('step:third', { result: 3 })
  assert.doesNotThrow(() => open.safePoint?.())
})

test('two agents at the same time both stop at their safe points, and a new call finishes both', async () => {
  const run = callSetup()
  const settled: string[] = []
  // The specs exist before the turns start, so both agents pass the first safe point before either turn ends.
  const turns = async (host: AgentHost) => {
    const specs = [await run.spec(host, 'note-a'), await run.spec(host, 'note-b')]
    return specs.map(async (spec) => {
      try {
        return await runTurn<{ note: string }>(host, spec, `Write note ${spec.id}.`, 'submit_note')
      } finally {
        settled.push(spec.id)
      }
    })
  }
  await assert.rejects(settleAll(await turns(run.call())), (error: unknown) => {
    assert.ok(error instanceof PlannedStop)
    assert.deepEqual([...settled].sort(), ['note-a', 'note-b'])
    return true
  })
  const requests = run.turns.length
  assert.deepEqual(run.turns.map((entry) => entry.role).sort(), ['note-a', 'note-b'])
  await sleep(100)
  assert.equal(run.turns.length, requests)

  assert.deepEqual(await settleAll(await turns(run.call())), [{ note: 'done' }, { note: 'done' }])
  for (const entry of run.turns.slice(requests)) assert.match(entry.request, nudgeText)
})

test('settleAll gives the results in order, and a real error wins over a PlannedStop', async () => {
  const later = async <T>(ms: number, value: T, fail?: unknown) => {
    await sleep(ms)
    if (fail !== undefined) throw fail
    return value
  }
  assert.deepEqual(await settleAll([later(20, 'a'), later(0, 'b')]), ['a', 'b'])
  assert.deepEqual(await settleAll([]), [])

  const real = new Error('real')
  await assert.rejects(settleAll([later(0, 1, new PlannedStop('stop')), later(10, 2, real)]), real)
  await assert.rejects(settleAll([later(10, 1, real), later(0, 2, new PlannedStop('stop'))]), real)
  await assert.rejects(settleAll([later(10, 1, new Error('second')), later(0, 2, new Error('first')), later(5, 3, new PlannedStop('stop'))]), { message: 'first' })
  await assert.rejects(settleAll([later(0, 1, new PlannedStop('one')), later(5, 2, new PlannedStop('two'))]), PlannedStop)

  // settleAll rejects only after each promise settled.
  let done = false
  await assert.rejects(settleAll([later(0, 1, real), later(20, 2).finally(() => (done = true))]), real)
  assert.equal(done, true)
})

test('alarmLines renders the counters, and gives no line without them', () => {
  const ledger = memoryLedger()
  assert.deepEqual(alarmLines(ledger), [])
  ledger.put(plannedStopsKey, 2)
  ledger.put(crashRestartsKey, 1)
  assert.deepEqual(alarmLines(ledger), ['- Alarm calls: 2 planned stops, 1 crash restart'])
  ledger.put(plannedStopsKey, 1)
  ledger.put(crashRestartsKey, 0)
  assert.deepEqual(alarmLines(ledger), ['- Alarm calls: 1 planned stop, 0 crash restarts'])
  const restartsOnly = memoryLedger()
  restartsOnly.put(crashRestartsKey, 3)
  assert.deepEqual(alarmLines(restartsOnly), ['- Alarm calls: 0 planned stops, 3 crash restarts'])
})
