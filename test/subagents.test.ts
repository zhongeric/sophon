import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Contracts } from 'nanocode-ts'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import { openAgent, type AgentHost, type HostTools } from '../src/core/agent.ts'
import type { SubagentLimit } from '../src/core/roles.ts'
import { subagentKey, subagentLimits, type SubagentCounts } from '../src/core/subagents.ts'
import { createWorkspace } from '../src/core/workspace.ts'
import { fileLedger } from '../src/node/ledger.ts'
import { sqliteStore } from '../src/node/platform.ts'
import { credentials, module } from './support/fixture.ts'
import { scriptedDispatch, type Reply, type Turn } from './support/scripted-model.ts'

const spawn = (task: string) =>
  `await tools.spawn_agent({ harness: null, model: null, output_contract: { kind: 'string' }, reasoning_mode: null, role: 'helper', task: '${task}', thinking: null })`
/** A cell line that waits for one subagent and shows its end state, its output or its error. */
const show = (name: string, agent: string) =>
  `{ const s = (await tools.wait_agent({ agent_ids: [${agent}.agent_id], timeout_ms: 20000 })).agents[0].status; text('${name}=' + s.state + ':' + (s.output ?? s.error) + '\\n') }`

const tool = (name: string, call: () => Promise<unknown>): HostTools => ({
  [name]: { definition: { name, description: `Test tool ${name}.`, parameters: { type: 'object', properties: {}, additionalProperties: false } }, call },
})

/**
 * A lead agent with subagents. The lead answers with `replies` in order. Each subagent submits 'hi' in a cell and then
 * ends: two model calls of 8 input and 4 output tokens. `hold` delays the second call of subagent 1 until the lead calls
 * tools.release, and the lead's tools.dispatched waits for the first call of subagent 1.
 */
async function lead(limit: SubagentLimit, replies: Reply[], options: { hold?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-subagents-'))
  const turns: Turn[] = []
  const queue = [...replies]
  const scripted = scriptedDispatch((turn) => {
    if (turn.subagent) return turn.output === null ? { cell: "await tools.submit_result({ output: 'hi' }); text('submitted')" } : { text: 'child done' }
    return queue.shift() ?? { text: 'done' }
  }, turns)
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  let started = () => {}
  const dispatched = new Promise<void>((resolve) => (started = resolve))
  let firstCalls = 0
  const dispatch: Contracts.RuntimeOptions['dispatch'] = async (request, signal, timing) => {
    if (options.hold && request.subagent?.id === 1 && firstCalls++ > 0) await released
    if (request.subagent?.id === 1) started()
    return scripted(request, signal, timing)
  }
  const host: AgentHost = {
    module,
    store: sqliteStore(join(dir, 'agents.sqlite'), join(dir, 'agents')),
    ledger: fileLedger(join(dir, 'state.json')),
    credentials,
    dispatch,
    log: () => {},
  }
  const agent = await openAgent(
    {
      id: 'lead',
      provider: 'claude',
      model: 'claude-opus-5-5',
      instructions: 'Agent role: lead',
      workspace: await createWorkspace({ repo: MemoryFileSystem.create(), review: {} }),
      tools: {
        ...tool('release', async () => release()),
        ...tool('dispatched', () => dispatched),
      },
      subagents: limit,
    },
    host,
  )
  /** The text of the cell outputs that the lead got. */
  const output = () =>
    turns
      .filter((turn) => !turn.subagent && turn.output !== null)
      .flatMap((turn) => (JSON.parse(turn.output ?? '[]') as { text?: string }[]).map((block) => block.text ?? ''))
      .join('')
  const counts = (request = 'task') => host.ledger.get<SubagentCounts>(subagentKey('lead', request))
  return { agent, output, counts }
}

const roomy: SubagentLimit = { concurrent: 5, perTurn: 5, tokens: 1_000 }

test('a spawn under all limits works, and its result reaches the parent', async () => {
  const { agent, output, counts } = await lead({ concurrent: 1, perTurn: 1, tokens: 24 }, [{ cell: `const a = ${spawn('one')}; ${show('A', 'a')}` }])
  try {
    assert.equal((await agent.ask('task', 'Start one subagent.')).status, 'completed')
    assert.match(output(), /A=completed:hi/)
    const { started, running, tokens } = counts() ?? {}
    assert.deepEqual({ started, running, tokens }, { started: [1], running: [], tokens: 24 })
  } finally {
    await agent.close()
  }
})

test('a spawn while the concurrent limit runs fails and does not count, and a spawn after a subagent ends works', async () => {
  const first = [
    'const a = ' + spawn('one'),
    'await tools.dispatched({})',
    'const b = ' + spawn('two'),
    show('B', 'b'),
    'await tools.release({})',
    show('A', 'a'),
  ].join('\n')
  const { agent, output, counts } = await lead({ ...roomy, concurrent: 1, perTurn: 2 }, [{ cell: first }, { cell: `const c = ${spawn('three')}; ${show('C', 'c')}` }], { hold: true })
  try {
    assert.equal((await agent.ask('task', 'Start subagents.')).status, 'completed')
    assert.match(output(), /B=failed:.*subagent limit: 1 of 1 subagents run at the same time/)
    assert.match(output(), /A=completed:hi/)
    assert.match(output(), /C=completed:hi/)
    assert.deepEqual(counts()?.started, [1, 3])
  } finally {
    await agent.close()
  }
})

test('a spawn after the per-turn limit fails, also with fewer running subagents than the concurrent limit', async () => {
  const cell = [`const a = ${spawn('one')}`, show('A', 'a'), `const b = ${spawn('two')}`, show('B', 'b'), `const c = ${spawn('three')}`, show('C', 'c')].join('\n')
  const { agent, output, counts } = await lead({ ...roomy, perTurn: 2 }, [{ cell }])
  try {
    assert.equal((await agent.ask('task', 'Start subagents.')).status, 'completed')
    assert.match(output(), /A=completed:hi\n+B=completed:hi\n+C=failed:.*subagent limit: this turn started 2 of 2 subagents/)
    assert.deepEqual(counts()?.started, [1, 2])
  } finally {
    await agent.close()
  }
})

test('a spawn after the subagent tokens reach the token limit fails', async () => {
  const { agent, output, counts } = await lead({ ...roomy, tokens: 24 }, [
    { cell: `const a = ${spawn('one')}; ${show('A', 'a')}` },
    { cell: `const b = ${spawn('two')}; ${show('B', 'b')}` },
  ])
  try {
    assert.equal((await agent.ask('task', 'Start subagents.')).status, 'completed')
    assert.match(output(), /A=completed:hi\n[^]*B=failed:.*subagent limit: the subagents of this turn used 24 of 24 tokens/)
    // Only the two calls of subagent 1 count. The calls of the lead do not.
    assert.equal(counts()?.tokens, 24)
    assert.deepEqual(counts()?.started, [1])
  } finally {
    await agent.close()
  }
})

test('a new root request ID starts its counts at zero', async () => {
  const one = (name: string) => ({ cell: `const x = ${spawn(name)}; ${show(name, 'x')}` })
  const { agent, output, counts } = await lead({ ...roomy, perTurn: 1 }, [one('A'), one('B'), { text: 'done' }, one('C')])
  try {
    assert.equal((await agent.ask('task', 'Start subagents.')).status, 'completed')
    assert.equal((await agent.ask('nudge', 'Start one more.')).status, 'completed')
    assert.match(output(), /A=completed:hi[^]*B=failed:.*this turn started 1 of 1 subagents[^]*C=completed:hi/)
    assert.deepEqual(counts('task')?.started, [1])
    assert.deepEqual(counts('nudge')?.started, [3])
  } finally {
    await agent.close()
  }
})

const call = (run: string, seq: number, replayed = false): Contracts.LoggedEvent => ({
  seq: 0,
  request_id: 'other',
  created_at: 0,
  event: {
    source: 'subagent',
    update: {
      type: 'event',
      id: 1,
      event: { type: 'model.call.completed', request_id: run, seq, payload: { usage: { input_tokens: 8, output_tokens: 4 }, timing: { replayed } } },
    },
  },
})
const completion = (id: number): Contracts.LoggedEvent => ({
  seq: 9,
  request_id: null,
  created_at: 0,
  event: { source: 'subagent', update: { type: 'completion', id, status: { state: 'completed', output: 'hi' }, revision: 1 } },
})

test('the counts persist in the ledger, and a replayed spawn or event adds nothing', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'factory-subagents-')), 'state.json')
  const sent: (number | undefined)[] = []
  const inner: Contracts.RuntimeOptions['dispatch'] = async (request) => {
    sent.push(request.subagent?.id)
    return new Response('ok')
  }
  const request = (id: number | null) =>
    ({
      body: new Uint8Array(),
      endpoint: 'https://api.anthropic.com/v1/messages',
      headers: [],
      method: 'POST',
      origin: null,
      provider: 'claude',
      subagent: id === null ? null : { id, parent: null, tree: id, lineage: [id], budgets: [] },
    }) satisfies Parameters<Contracts.RuntimeOptions['dispatch']>[0]
  const timing = {} as never
  const signal = new AbortController().signal
  const limit = { concurrent: 1, perTurn: 2, tokens: 100 }

  const first = subagentLimits(fileLedger(path), 'lead', limit)
  first.begin('task')
  const dispatch = first.dispatch(inner)
  await dispatch(request(null), signal, timing)
  await dispatch(request(1), signal, timing)
  await assert.rejects(dispatch(request(2), signal, timing), /1 of 1 subagents run at the same time/)
  first.observe([call('s1', 1), call('s1', 2)])

  // A new host reads the same ledger file, as a resumed turn does.
  const ledger = fileLedger(path)
  const resumed = subagentLimits(ledger, 'lead', limit)
  resumed.begin('task')
  const again = resumed.dispatch(inner)
  // The known subagent continues, and the same events and a replayed call add nothing.
  await again(request(1), signal, timing)
  resumed.observe([call('s1', 1), call('s1', 2), call('s1', 3, true), completion(1)])
  assert.deepEqual(ledger.get(subagentKey('lead', 'task')), { started: [1], running: [], tokens: 24, seen: { s1: 3 } })
  await again(request(2), signal, timing)
  resumed.observe([completion(2)])
  await assert.rejects(again(request(3), signal, timing), /this turn started 2 of 2 subagents/)
  assert.deepEqual(sent, [undefined, 1, 1, 2])
})
