import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PausedError } from '../src/core/questions.ts'
import { developRepo, developScript, fakePulls, runDevelop, scriptedReview } from './support/develop.ts'
import { scriptedDispatch, type Turn } from './support/scripted-model.ts'

const runsDir = () => mkdtempSync(join(tmpdir(), 'factory-runs-'))
const repairRounds = (turns: Turn[]) =>
  turns.filter((turn) => turn.role === 'builder' && turn.output === null).flatMap((turn) => [...turn.request.matchAll(/Repair round (\d+) of/g)].at(-1)?.[1] ?? [])
const flakySmoke = { name: 'smoke', command: 'node -e "process.exit(0)"', output: 'EADDRINUSE: address already in use' }

test('develop: when a push gives a new commit, as on the Worker, a fixer that blocks still gets a rerun of the failed box check', { timeout: 240_000 }, async () => {
  const { repo } = developRepo(undefined, { merge: 'squash' })
  const github = fakePulls([true])
  const intentGap = { name: 'Intent reviewer affirms the original ask', ok: false, detail: 'no test checks mul(2, 3)' }
  const review = scriptedReview([{ failed: [intentGap], checks: [flakySmoke] }, []], [])
  const turns: Turn[] = []
  const result = await runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(developScript({ blockRepair: 1 }), turns), pulls: github.pulls, review, runId: 'blocked-remote', remoteCommits: true })

  assert.equal(result.status, 'ready', result.report)
  assert.deepEqual(repairRounds(turns), ['1', '2'])
  const head = (github.state.shas[0] ?? '').slice(0, 12)
  assert.match(result.report, new RegExp(`^## Reruns\n\n- smoke on ${head}: flaky$`, 'm'))
})

test('develop: a resume after a rerun request without a response reads the new attempt and sends no second request', { timeout: 240_000 }, async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  const github = fakePulls([false], { rerun: ['pass'] })
  // GitHub starts the new attempt, but the host stops before it gets the response.
  const pulls = {
    ...github.pulls,
    async rerunFailedJobs(run: number): Promise<never> {
      await github.pulls.rerunFailedJobs(run)
      throw new PausedError('the response of the rerun request is lost')
    },
  }
  await assert.rejects(runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls, review: scriptedReview([[]], []), runId: 'rerun-lost' }), PausedError)
  assert.deepEqual(github.state.reruns, [1])

  const turns: Turn[] = []
  const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), turns), pulls, review: scriptedReview([[]], []), runId: 'rerun-lost' })
  assert.equal(result.status, 'ready', result.report)
  assert.deepEqual(github.state.reruns, [1])
  assert.deepEqual(repairRounds(turns), [])
  assert.match(result.report, /^- CI \(pull_request\) on [0-9a-f]{12}: flaky$/m)
})
