import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Contracts } from 'nanocode-ts'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import { openAgent, runTurn, submitOnce, type AgentHost, type AgentSpec } from '../src/core/agent.ts'
import { runLock, type Egress } from '../src/core/egress.ts'
import { createWorkspace } from '../src/core/workspace.ts'
import { fileLedger } from '../src/node/ledger.ts'
import { sqliteStore } from '../src/node/platform.ts'
import { memoryArtifacts } from './support/artifacts.ts'
import { credentials, module } from './support/fixture.ts'
import { scriptedDispatch, type Script, type Turn } from './support/scripted-model.ts'

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

/** The web search tool in a model request: a nested Code Mode tool, or a provider tool. */
const webSearch = /`WebSearch`|"type":"web_search/
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

test('openAgent refuses web_search on while the lock has a pending pattern', async () => {
  const run = egressSetup(() => ({ text: 'done' }), { lock: ['https://archive.example.org/holdout/'] })
  await assert.rejects(openAgent(await run.spec(archive), run.host), /^Error: note: egress: web_search is not possible while https:\/\/archive\.example\.org\/holdout\/ is locked/)
  assert.equal(run.host.ledger.get('session:note'), undefined)
  const agent = await openAgent(await run.spec({ ...archive, web_search: false }), run.host)
  await agent.close()
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
