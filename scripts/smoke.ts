import { resolve } from 'node:path'
import { roles } from '../src/core/roles.ts'
import { review, type RunContext } from '../src/core/steps.ts'
import { credential } from '../src/node/credentials.ts'
import { nodeRun } from '../src/node/platform.ts'
import { fixtureRepo, gitSource, loopInput, module } from '../test/support/fixture.ts'

// Runs one live bugs reviewer on Claude Haiku against the test fixture, signed with the nc Claude login.
const repo = fixtureRepo()
const input = loopInput(repo, `smoke-${Date.now()}`)
const run = await nodeRun({ config: input.config, runId: input.runId, runsDir: resolve('runs'), source: gitSource(repo) })
const frozen = await run.repo.freeze()
const context: RunContext = {
  host: { module, store: run.store, ledger: run.ledger, credentials: { claude: credential('claude', { claudePlan: true }) }, log: (line) => console.log('[log]', line) },
  repo: run.repo,
  frozen,
  config: input.config,
  ask: input.ask,
  stack: 'TypeScript',
  stackGuides: [],
  guides: run.guides,
  tests: run.checker.tests,
}
const started = Date.now()
const findings = await review(context, 'smoke.bugs', roles.bugs, { provider: 'claude', model: 'claude-haiku-5-5', thinking: 'low' }, { from: frozen.base, to: frozen.head }, '')
console.log(JSON.stringify({ seconds: (Date.now() - started) / 1000, findings, report: run.ledger.get('report:smoke.bugs:task') }, null, 1))
