import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentRuntime, type Contracts } from 'nanocode-ts'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import { openAgent, runTurn, submitOnce, type AgentHost, type AgentSpec } from '../src/core/agent.ts'
import { runLock, type Egress } from '../src/core/egress.ts'
import { BudgetStop, usageOf } from '../src/core/usage.ts'
import { createWorkspace } from '../src/core/workspace.ts'
import { fileLedger } from '../src/node/ledger.ts'
import { sqliteStore } from '../src/node/platform.ts'
import { memoryArtifacts } from './support/artifacts.ts'
import { credentials, module } from './support/fixture.ts'
import { scriptedDispatch, webSearch, type Script, type Turn } from './support/scripted-model.ts'

const submitNote: Contracts.HostTool = {
  name: 'submit_note',
  description: 'Submit the note one time.',
  parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false },
}

/** Two hosts on the same files, as a run and its resumed run. Each logs to `lines`, and each submit_note call counts. */
function resumeSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-agent-resume-'))
  const lines: string[] = []
  let submits = 0
  const host = (dispatch: Contracts.RuntimeOptions['dispatch']): AgentHost => ({
    module,
    store: sqliteStore(join(dir, 'agents.sqlite'), join(dir, 'agents')),
    ledger: fileLedger(join(dir, 'state.json')),
    credentials,
    dispatch,
    log: (line) => lines.push(line),
  })
  const spec = async (on: AgentHost): Promise<AgentSpec> => ({
    id: 'note',
    provider: 'claude',
    model: 'claude-opus-5-5',
    instructions: 'Agent role: note',
    workspace: await createWorkspace({ repo: MemoryFileSystem.create(), review: {} }),
    tools: submitOnce(on, 'output:note', submitNote, async (input) => {
      submits++
      return input
    }),
  })
  const changed = () => lines.filter((line) => /prompt of turn/.test(line))
  return { host, spec, changed, submits: () => submits }
}

test('a turn that failed on a model error asks again under a new request ID when the run resumes', async () => {
  const run = resumeSetup()
  const turns: Turn[] = []
  const scripted = scriptedDispatch((turn) => (turn.output === null ? { cell: "await tools.submit_note({ note: 'done' }); text('submitted')" } : { text: 'done' }), turns)
  let credit = false
  const dispatch: Contracts.RuntimeOptions['dispatch'] = async (...args) =>
    credit
      ? scripted(...args)
      : new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }), {
          headers: { 'content-type': 'application/json' },
          status: 400,
        })

  const first = run.host(dispatch)
  await assert.rejects(runTurn(first, await run.spec(first), 'Write a note.', 'submit_note'), /note: turn failed/)
  assert.equal(turns.length, 0)

  credit = true
  const second = run.host(dispatch)
  assert.deepEqual(await runTurn(second, await run.spec(second), 'Write a note.', 'submit_note'), { note: 'done' })
  assert.ok(turns.length > 0)
  assert.match(turns[0]!.request, /Your last turn stopped with an error/)
  assert.equal(second.ledger.get('retries:note:task'), 1)
})

const changedLine = 'note: the prompt of turn task changed, so the turn continues with the prompt of its journal'

test('a resumed ask with a changed prompt drives the pending journal turn without a new request for its finished cell', async () => {
  const run = resumeSetup()
  // The submit cell, then a second cell, then the end of the turn.
  const script: Script = (turn) => {
    // The cell builds the word, so that only the cell output, not the cell code, has it.
    if (turn.output === null) return { cell: "await tools.submit_note({ note: 'done' }); text('sub' + 'mitted')" }
    return turn.output.includes('submitted') ? { cell: "text('checked')" } : { text: 'done' }
  }
  const firstTurns: Turn[] = []
  const scripted = scriptedDispatch(script, firstTurns)
  let held = () => {}
  const holding = new Promise<void>((resolve) => (held = resolve))
  let release = () => {}
  // The first run stops at its third model request, after both cells, as a host that crashed: the request ends only at release.
  const holdThird: Contracts.RuntimeOptions['dispatch'] = async (request, signal, timing) => {
    if (firstTurns.length < 2) return scripted(request, signal, timing)
    held()
    return new Promise<Response>((_resolve, reject) => (release = () => reject(new Error('the first host stopped'))))
  }
  const first = run.host(holdThird)
  const firstAgent = await openAgent(await run.spec(first), first)
  const stopped = firstAgent.ask('task', 'Write note A.').catch(() => null)
  await holding
  assert.equal(run.submits(), 1)

  const resumedTurns: Turn[] = []
  const second = run.host(scriptedDispatch(script, resumedTurns))
  const agent = await openAgent(await run.spec(second), second)
  try {
    const report = await agent.ask('task', 'Write note B.')
    assert.equal(report.status, 'completed')
    assert.deepEqual(second.ledger.get('report:note:task'), report)
  } finally {
    await agent.close()
    release()
    await stopped
    await firstAgent.close()
  }
  assert.deepEqual(second.ledger.get('output:note'), { note: 'done' })
  assert.equal(run.submits(), 1)
  assert.equal(firstTurns.length, 2)
  // One request after the resume: the held third request, with the output of the submit cell in its history.
  assert.equal(resumedTurns.length, 1)
  assert.match(resumedTurns[0]!.request, /submitted/)
  assert.doesNotMatch(resumedTurns[0]!.request, /abandoned: 1 submit_note/)
  assert.match(resumedTurns[0]!.request, /Write note A\./)
  assert.doesNotMatch(resumedTurns[0]!.request, /Write note B\./)
  assert.deepEqual(run.changed(), [changedLine])
})

test('a resumed ask with a changed prompt returns the report of the finished journal turn with no model request', async () => {
  const run = resumeSetup()
  const turns: Turn[] = []
  const dispatch = scriptedDispatch((turn) => (turn.output === null ? { cell: "await tools.submit_note({ note: 'done' }); text('submitted')" } : { text: 'done' }), turns)
  const first = run.host(dispatch)
  const firstAgent = await openAgent(await run.spec(first), first)
  const finished = await firstAgent.ask('task', 'Write note A.')
  await firstAgent.close()
  assert.equal(finished.status, 'completed')
  const requests = turns.length

  const second = run.host(dispatch)
  const agent = await openAgent(await run.spec(second), second)
  try {
    assert.deepEqual(await agent.ask('task', 'Write note B.'), finished)
  } finally {
    await agent.close()
  }
  assert.equal(turns.length, requests)
  assert.equal(run.submits(), 1)
  assert.deepEqual(run.changed(), [changedLine])
})

test('a resumed ask with a changed prompt still fails when the journal has no turn for the request ID', async (t) => {
  const run = resumeSetup()
  const dispatch = scriptedDispatch((turn) => (turn.output === null ? { cell: "await tools.submit_note({ note: 'done' }); text('submitted')" } : { text: 'done' }), [])
  const first = run.host(dispatch)
  const firstAgent = await openAgent(await run.spec(first), first)
  assert.equal((await firstAgent.ask('task', 'Write note A.')).status, 'completed')
  await firstAgent.close()

  // The submit of the resumed runtime gets a conflict from the journal, but its turn view is empty.
  const instantiate = AgentRuntime.instantiate.bind(AgentRuntime)
  t.mock.method(AgentRuntime, 'instantiate', async (...args: Parameters<typeof instantiate>) => {
    const runtime = await instantiate(...args)
    t.mock.method(runtime, 'turn', async () => null)
    return runtime
  })
  const second = run.host(dispatch)
  const agent = await openAgent(await run.spec(second), second)
  try {
    await assert.rejects(agent.ask('task', 'Write note B.'), /note: turn task exists with another prompt/)
  } finally {
    await agent.close()
  }
  assert.deepEqual(run.changed(), [])
})

test('a rejected beforeTurn opens no agent, and a completed turn leaves the usage of the agent in the ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-agent-'))
  const turns: Turn[] = []
  const dispatch = scriptedDispatch((turn) => (turn.output === null ? { cell: "await tools.submit_note({ note: 'done' }); text('submitted')" } : { text: 'done' }), turns)
  const host: AgentHost = {
    module,
    store: sqliteStore(join(dir, 'agents.sqlite'), join(dir, 'agents')),
    ledger: fileLedger(join(dir, 'state.json')),
    credentials,
    dispatch,
    beforeTurn: async () => {
      throw new BudgetStop('over the budget')
    },
    log: () => {},
  }
  const spec: AgentSpec = {
    id: 'note',
    provider: 'codex',
    model: 'gpt-5.5',
    instructions: 'Agent role: note',
    workspace: await createWorkspace({ repo: MemoryFileSystem.create(), review: {} }),
    tools: submitOnce(host, 'output:note', submitNote, async (input) => input),
  }

  await assert.rejects(runTurn(host, spec, 'Write a note.', 'submit_note'), BudgetStop)
  assert.equal(turns.length, 0)
  assert.equal(host.ledger.get('session:note'), undefined)

  host.beforeTurn = async () => {}
  assert.deepEqual(await runTurn(host, spec, 'Write a note.', 'submit_note'), { note: 'done' })
  // Two model calls (the cell and the final text), each with input 8 and output 4.
  const tokens = { input: 16, cached: 0, cache_write: 0, output: 8 }
  assert.deepEqual(usageOf(host.ledger), { agents: [{ step: 'note', model: 'gpt-5.5', tokens }], total: tokens })
  assert.deepEqual(usageOf(fileLedger(join(dir, 'state.json'))).total, tokens)
})

test('the budget check also runs before the nudge turn, so a first turn that reaches the budget opens no nudge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-agent-'))
  const turns: Turn[] = []
  // The model ends each turn with a text and never calls the submit tool.
  const dispatch = scriptedDispatch(() => ({ text: 'done' }), turns)
  let checks = 0
  const host: AgentHost = {
    module,
    store: sqliteStore(join(dir, 'agents.sqlite'), join(dir, 'agents')),
    ledger: fileLedger(join(dir, 'state.json')),
    credentials,
    dispatch,
    beforeTurn: async () => {
      if (++checks > 1) throw new BudgetStop('over the budget')
    },
    log: () => {},
  }
  const spec: AgentSpec = {
    id: 'note',
    provider: 'codex',
    model: 'gpt-5.5',
    instructions: 'Agent role: note',
    workspace: await createWorkspace({ repo: MemoryFileSystem.create(), review: {} }),
    tools: submitOnce(host, 'output:note', submitNote, async (input) => input),
  }

  await assert.rejects(runTurn(host, spec, 'Write a note.', 'submit_note'), BudgetStop)
  assert.equal(checks, 2)
  assert.equal(turns.length, 1)
  assert.ok(!turns.some((turn) => /You ended the turn without calling/.test(turn.request)))
  assert.equal(host.ledger.get('retries:note:task'), undefined)
})

const archive: Egress = { hosts: ['archive.example.org'], web_search: true }
const page = 'archive page'

/** A host with an EgressHost over an injected fetch that records each URL. Without `egress`, the host has no EgressHost. */
function egressSetup(script: Script, options: { egress?: boolean; lock?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-agent-egress-'))
  const turns: Turn[] = []
  const fetched: string[] = []
  const artifacts = memoryArtifacts()
  const ledger = fileLedger(join(dir, 'state.json'))
  const injected = async (input: string | URL | Request): Promise<Response> => {
    fetched.push(input instanceof Request ? input.url : String(input))
    return new Response(page, { headers: { 'content-type': 'text/plain' } })
  }
  const host: AgentHost = {
    module,
    store: sqliteStore(join(dir, 'agents.sqlite'), join(dir, 'agents')),
    ledger,
    credentials,
    dispatch: scriptedDispatch(script, turns),
    log: () => {},
    ...(options.egress === false
      ? {}
      : { egress: { artifacts, secret: () => undefined, fetch: injected, ...(options.lock ? { lock: runLock(ledger, options.lock) } : {}) } }),
  }
  const spec = async (egress?: Egress): Promise<AgentSpec> => ({
    id: 'note',
    provider: 'claude',
    model: 'claude-opus-5-5',
    instructions: 'Agent role: note',
    workspace: await createWorkspace({ repo: MemoryFileSystem.create(), review: {} }),
    tools: submitOnce(host, 'output:note', submitNote, async (input) => input),
    ...(egress ? { egress } : {}),
  })
  return { host, spec, turns, fetched, artifacts }
}

test('an egress agent fetches an allowed URL in a cell, gets the body and the artifact ID, and has web search', async () => {
  const cell = [
    `const response = await fetch('https://archive.example.org/paper')`,
    `await tools.submit_note({ note: (await response.text()) + ' ' + response.headers.get('x-artifact-id') })`,
    `text('submitted')`,
  ].join('\n')
  const run = egressSetup((turn) => (turn.output === null ? { cell } : { text: 'done' }))
  const output = await runTurn<{ note: string }>(run.host, await run.spec(archive), 'Read the paper.', 'submit_note')
  const id = createHash('sha256').update(page).digest('hex')
  assert.equal(output.note, `${page} ${id}`)
  assert.deepEqual(run.fetched, ['https://archive.example.org/paper'])
  assert.deepEqual((await run.artifacts.meta(id))?.source, { url: 'https://archive.example.org/paper', method: 'GET' })
  assert.match(run.turns[0]!.request, webSearch)
})

test('openAgent refuses an egress spec when the host has no EgressHost', async () => {
  const run = egressSetup(() => ({ text: 'done' }), { egress: false })
  await assert.rejects(openAgent(await run.spec(archive), run.host), /^Error: note: .*no egress/)
  assert.equal(run.host.ledger.get('session:note'), undefined)
  assert.equal(run.turns.length, 0)
})

test('openAgent allows web_search while the lock has a pending pattern: web search is outside the lock (RD9)', async () => {
  const run = egressSetup(() => ({ text: 'done' }), { lock: ['https://archive.example.org/holdout/'] })
  const agent = await openAgent(await run.spec(archive), run.host)
  await agent.close()
  assert.notEqual(run.host.ledger.get('session:note'), undefined)
})

test('an agent without egress is offline: the cell fetch fails, the request has no web search, the host fetch is never called', async () => {
  const cell = [
    `let note = 'FETCHED'`,
    `try { await fetch('https://archive.example.org/paper') } catch (error) { note = String(error) }`,
    `await tools.submit_note({ note })`,
    `text('submitted')`,
  ].join('\n')
  const run = egressSetup((turn) => (turn.output === null ? { cell } : { text: 'done' }))
  const output = await runTurn<{ note: string }>(run.host, await run.spec(), 'Read the paper.', 'submit_note')
  assert.match(output.note, /network access is off for agents/)
  assert.deepEqual(run.fetched, [])
  assert.deepEqual(await run.artifacts.list(), [])
  assert.ok(run.turns.length > 0)
  for (const turn of run.turns) assert.doesNotMatch(turn.request, webSearch)
})
