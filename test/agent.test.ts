import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Contracts } from 'nanocode-ts'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import { runTurn, submitOnce, type AgentHost, type AgentSpec } from '../src/core/agent.ts'
import { BudgetStop, usageOf } from '../src/core/usage.ts'
import { createWorkspace } from '../src/core/workspace.ts'
import { fileLedger } from '../src/node/ledger.ts'
import { sqliteStore } from '../src/node/platform.ts'
import { credentials, module } from './support/fixture.ts'
import { scriptedDispatch, type Turn } from './support/scripted-model.ts'

const submitNote: Contracts.HostTool = {
  name: 'submit_note',
  description: 'Submit the note one time.',
  parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false },
}

test('a turn that failed on a model error asks again under a new request ID when the run resumes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-agent-'))
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
  // Each host reads the ledger and the journals from disk, as a resumed run does.
  const host = (): AgentHost => ({
    module,
    store: sqliteStore(join(dir, 'agents.sqlite'), join(dir, 'agents')),
    ledger: fileLedger(join(dir, 'state.json')),
    credentials,
    dispatch,
    log: () => {},
  })
  const spec = async (on: AgentHost): Promise<AgentSpec> => ({
    id: 'note',
    provider: 'claude',
    model: 'claude-opus-5-5',
    instructions: 'Agent role: note',
    workspace: await createWorkspace({ repo: MemoryFileSystem.create(), review: {} }),
    tools: submitOnce(on, 'output:note', submitNote, async (input) => input),
  })

  const first = host()
  await assert.rejects(runTurn(first, await spec(first), 'Write a note.', 'submit_note'), /note: turn failed/)
  assert.equal(turns.length, 0)

  credit = true
  const second = host()
  assert.deepEqual(await runTurn(second, await spec(second), 'Write a note.', 'submit_note'), { note: 'done' })
  assert.ok(turns.length > 0)
  assert.match(turns[0]!.request, /Your last turn stopped with an error/)
  assert.equal(second.ledger.get('retries:note:task'), 1)
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
  assert.deepEqual(usageOf(host.ledger), { agents: [{ id: 'note', model: 'gpt-5.5', tokens }], total: tokens })
  assert.deepEqual(usageOf(fileLedger(join(dir, 'state.json'))).total, tokens)
})
