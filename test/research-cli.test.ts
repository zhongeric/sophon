import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { StopError } from '../src/core/stop.ts'
import { defaultResearchModels } from '../src/core/workflows/research.ts'
import { newInput, parseWait, researchModels, resumeInput } from '../src/node/research.ts'
import { memoryChannel } from './support/fixture.ts'
import { notebook, researchScript, runResearch } from './support/research.ts'
import { scriptedDispatch } from './support/scripted-model.ts'

const runsDir = () => mkdtempSync(join(tmpdir(), 'factory-research-runs-'))
const stops = (pattern: RegExp) => (error: unknown) => error instanceof StopError && pattern.test(error.message)

test('research CLI: a bad --models file or a bad --wait stops with status 2 and names the option', () => {
  const { repo } = notebook()
  const models = join(mkdtempSync(join(tmpdir(), 'factory-research-models-')), 'models.json')
  writeFileSync(models, '{"generators":null}')
  const cli = fileURLToPath(new URL('../src/node/research.ts', import.meta.url))
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--repo', repo, '--program', 'p', '--runs-dir', runsDir(), ...args], { encoding: 'utf8' })
  const badModels = run('--models', models)
  assert.equal(badModels.status, 2, badModels.stderr)
  assert.match(badModels.stderr, /stop: --models .*models\.json: generators must be a list of two models/)
  writeFileSync(models, '{"surveyor":{"provider":"codex","model":"m","thinking":"max"}}')
  const badThinking = run('--models', models)
  assert.equal(badThinking.status, 2, badThinking.stderr)
  assert.match(badThinking.stderr, /stop: --models .*models\.json: surveyor must be/)
  const badWait = run('--wait', '1h')
  assert.equal(badWait.status, 2, badWait.stderr)
  assert.match(badWait.stderr, /stop: --wait must be a number of minutes of 0 or more, not "1h"/)
})

test('research CLI: researchModels refuses a models file with another shape', () => {
  const sol = { provider: 'codex' as const, model: 'gpt-6.1-sol' }
  assert.deepEqual(researchModels(JSON.stringify({ surveyor: sol }), 'm.json'), { ...defaultResearchModels, surveyor: sol })
  const stages = { builder: sol, skeptic: sol, lateSkeptic: defaultResearchModels.intake, analyst: sol, writer: sol }
  assert.deepEqual(researchModels(JSON.stringify(stages), 'm.json'), { ...defaultResearchModels, ...stages })
  const refused: [string, RegExp][] = [
    ['{"generators":null}', /generators must be a list of two models/],
    ['{"generators":[{"provider":"codex","model":"m"}]}', /generators must be a list of two models/],
    ['{"generators":[{"provider":"codex","model":"m"},{"provider":"claude"}]}', /generators\[1\] must be/],
    ['{"surveyor":null}', /surveyor must be \{ "provider"/],
    ['{"surveyor":{"provider":"other","model":"m"}}', /surveyor must be/],
    ['{"surveyor":{"provider":"codex","model":"m","thinking":"max"}}', /surveyor must be/],
    ['{"surveyor":{"provider":"codex","model":"m","thinking":null}}', /surveyor must be/],
    ['{"surveyor":{"provider":"codex","model":"m","thinking":1}}', /surveyor must be/],
    ['{"surveyor":{"provider":"codex","model":"m","thinking":true}}', /surveyor must be/],
    ['{"surveyor":{"provider":"codex","model":"m","thinking":{}}}', /surveyor must be/],
    ['{"surveyor":{"provider":"codex","model":"m","thinking":[]}}', /surveyor must be/],
    ['{"surveyor":{"provider":"codex","model":"m","thinking":"high","extra":true}}', /surveyor must be/],
    ['{"reviewer":{"provider":"codex","model":"m"}}', /reviewer is not a research role \(generators, intake, surveyor, preregistrar, builder, skeptic, lateSkeptic, analyst, writer\)/],
    ['{"builder":{"provider":"codex","model":"m","thinking":"max"}}', /builder must be/],
    ['[]', /must be a JSON object of roles/],
    ['{', /is not valid JSON/],
  ]
  for (const [text, reason] of refused) assert.throws(() => researchModels(text, 'm.json'), stops(reason))
})

test('research CLI: a --models file retains valid thinking settings', async () => {
  const { repo } = notebook()
  const models = join(mkdtempSync(join(tmpdir(), 'factory-research-models-')), 'models.json')
  const choices = {
    intake: { provider: 'claude', model: 'm', thinking: 'low' },
    surveyor: { provider: 'codex', model: 'm', thinking: 'high' },
    generators: [{ provider: 'codex', model: 'm', thinking: 'medium' }, { provider: 'claude', model: 'm', thinking: 'high' }],
    preregistrar: { provider: 'claude', model: 'm', thinking: 'high' },
    builder: { provider: 'claude', model: 'm', thinking: 'medium' },
    skeptic: { provider: 'claude', model: 'm', thinking: 'high' },
    lateSkeptic: { provider: 'codex', model: 'm', thinking: 'low' },
    analyst: { provider: 'codex', model: 'm', thinking: 'high' },
    writer: { provider: 'claude', model: 'm', thinking: 'low' },
  }
  writeFileSync(models, JSON.stringify(choices))
  const { input } = await newInput({ repo, program: 'p', models })
  assert.deepEqual(input.models, { ...defaultResearchModels, ...choices })
})

test('research CLI: parseWait refuses a wait that is not a number of 0 or more minutes', () => {
  assert.equal(parseWait('1.5'), 90_000)
  assert.equal(parseWait('0'), 0)
  for (const text of ['1h', 'abc', '', '-1', 'Infinity']) assert.throws(() => parseWait(text), stops(/^--wait must be a number of minutes of 0 or more/))
})

test('research CLI: a resume of a part 1 run fills in the new roles with the default models', () => {
  const dir = runsDir()
  const sol = { provider: 'codex' as const, model: 'gpt-6.1-sol' }
  const { intake, generators, preregistrar } = defaultResearchModels
  const models = { intake, surveyor: sol, generators, preregistrar }
  mkdirSync(join(dir, 'r1'))
  writeFileSync(join(dir, 'r1', 'state.json'), JSON.stringify({ input: { runId: 'r1', program: 'p', base: 'b', baseRef: 'main', source: 's', models }, repo: '/notebook' }))
  const { input, repo } = resumeInput(dir, 'r1')
  assert.equal(repo, '/notebook')
  assert.deepEqual(input.models, { ...defaultResearchModels, surveyor: sol })
})

test('research CLI: a new run keeps --budget as the budget before the intake, so the intake recommends it and its cap replaces it', async () => {
  const { repo } = notebook()
  const { input } = await newInput({ repo, program: 'Find quiet dwarf galaxies in the deep fields.' }, 10)
  assert.equal(input.budget, 10)
  assert.equal(input.budgetOverride, undefined)
  const { channel, posted } = memoryChannel({ intake: '/answer\nQ1: a\nQ2: 40', pick: '/answer\nQ1: None' })
  const { deps, result } = await runResearch(repo, runsDir(), input, { channel, dispatch: scriptedDispatch(researchScript(), []) })
  assert.equal(result.status, 'stopped', result.report)
  assert.ok(posted[0]!.questions.some((question) => question.recommendation === '10 USD'))
  assert.equal(deps.ledger.get<{ limit: number }>('budget')?.limit, 40)
})
