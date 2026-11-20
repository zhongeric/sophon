import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { hasConflictMarkers } from '../src/core/merge.ts'
import type { Signing } from '../src/core/platform.ts'
import { PausedError, type Channel } from '../src/core/questions.ts'
import { StopError } from '../src/core/stop.ts'
import { BudgetStop, recordUsage, zeroTokens, type Prices } from '../src/core/usage.ts'
import { develop, type ReviewRequest } from '../src/core/workflows/develop.ts'
import { git, gitBranches, worktreePath } from '../src/node/git.ts'
import { ghPullRequests } from '../src/node/github.ts'
import { fileLedger } from '../src/node/ledger.ts'
import { nodeDevelop } from '../src/node/platform.ts'
import { developInput, developScript, developRepo, fakePulls, mergeCommit, pauseAtCi, plan, pushBase, runDevelop, scopeQuestion, scriptedReview, sources } from './support/develop.ts'
import { parents } from './support/base-merge.ts'
import { credentials, memoryChannel, module, withoutKey } from './support/fixture.ts'
import { probeNetwork, scriptedDispatch, webSearch, type Turn } from './support/scripted-model.ts'
import { visible, visibleLines, visibleWords } from './support/visible.ts'

const runsDir = () => mkdtempSync(join(tmpdir(), 'factory-runs-'))

test('develop: intake, plan, parallel builders on their own branches, draft PR, a CI repair, the review loop, a ready PR', { timeout: 120_000 }, async () => {
  const { repo, origin } = developRepo()
  const turns: Turn[] = []
  const { channel, posted } = memoryChannel()
  const github = fakePulls([false, true])
  const prices = { 'claude-opus-5-5': { input: 1000, cached_input: 100, cache_write: 1000, output: 1000 }, 'gpt-6.1-sol': { input: 1000, cached_input: 100, cache_write: 1000, output: 1000 } }
  const result = await runDevelop(repo, runsDir(), { channel, dispatch: scriptedDispatch(probeNetwork(developScript(), 'builder'), turns), prices, pulls: github.pulls, runId: 'dev' })

  assert.equal(result.status, 'ready', result.report)
  assert.equal(result.branch, 'factory/dev-add-sub-mul')

  // The intake agent raised no user question, so the run took its recommendations for the ask and the route, and asked nothing (D11).
  assert.deepEqual(posted, [])
  const first = (role: string) => turns.findIndex((turn) => turn.role === role)
  assert.ok(first('intake') < first('planner') && first('planner') < first('builder'))
  // The development and review roles have no egress: the cell fetch and the shell of a builder fail, and no model request
  // has the web search tool.
  const probes = turns.filter((turn) => turn.role === 'builder' && turn.output).map((turn) => turn.output).join('\n')
  assert.match(probes, /cell fetch: .*network access is off/)
  assert.match(probes, /shell fetch: .*network access is off/)
  assert.ok(!turns.some((turn) => webSearch.test(turn.request)))

  // sub and mul built in the same wave, the tests after both. Each builder could write only its own files.
  const builds = turns.filter((turn) => turn.role === 'builder' && turn.output === null).map((turn) => /Build task ([a-z]+)|Repair round/.exec(turn.request)?.[1] ?? 'repair')
  assert.deepEqual(builds.slice(0, 2).sort(), ['mul', 'sub'])
  assert.deepEqual(builds.slice(2), ['tests', 'repair'])
  const outputs = turns.filter((turn) => turn.role === 'builder' && turn.output).map((turn) => turn.output).join('\n')
  assert.match(outputs, /scope refused: .*EACCES/)
  assert.match(outputs, /checkpoint refused:.*test\/run.log:1: Remove test\/run.log from the change/)
  assert.doesNotMatch(outputs, /SCOPE WRITE ALLOWED|LOG COMMITTED/)
  // The host ran the targeted tests at submit and refused the log with the wrong expectation, with the end of the failed output.
  assert.match(outputs, /submit refused: .*the targeted tests failed \(test\/ops\.test\.ts\).*--- tests \(exit code 1\) ---.*sub and mul/)
  assert.doesNotMatch(outputs, /FAILING LOG ACCEPTED/)

  // The PR is the run's branch, pushed without force. The first CI was red, the repair made it green.
  const show = (path: string) => execFileSync('git', ['--git-dir', origin, 'show', `factory/dev-add-sub-mul:${path}`]).toString()
  assert.deepEqual([show('src/sub.ts'), show('src/mul.ts'), show('test/ops.test.ts')], [sources.sub, sources.mul, sources.test(6)])
  assert.throws(() => execFileSync('git', ['--git-dir', origin, 'cat-file', '-e', 'factory/dev-add-sub-mul:test/run.log'], { stdio: 'pipe' }))
  assert.equal(github.state.opened.length, 1)
  assert.equal(github.state.opened[0]!.title, 'Add sub and mul')
  assert.match(github.state.opened[0]!.body, /<details><summary>.*<\/summary>\n\nagent-factory run `dev` .* opened this draft PR\.[\s\S]*# Ask\n\n> Add sub and mul next to add, with tests\.[\s\S]*## Done looks like[\s\S]*<\/details>$/)
  assert.equal(visible(github.state.opened[0]!.body).trim(), plan.smallest_change)
  assert.ok(visibleWords(github.state.opened[0]!.body) <= 150)
  assert.equal(github.state.shas.length, 2)
  assert.deepEqual(github.state.ready, [9])

  // The review loop reviewed the frozen package: the ask, the decisions and the plan.
  assert.ok(turns.some((turn) => turn.role === 'intent'))
  const review = JSON.parse(readFileSync(join(result.dir, '..', 'dev-review-1', 'state.json'), 'utf8')) as { input: { ask: string } }
  assert.match(review.input.ask, /^Add sub and mul next to add, with tests\.\n\n## Decisions the run made\n\n- Is this the ask\?[\s\S]*## Non-goals\n\n- No division/)
  assert.match(github.state.opened[0]!.body, /# Decisions the run made\n\n- Is this the ask\? Correct it in your own words if it is not\. \*\*Yes, go on\*\*/)
  assert.doesNotMatch(github.state.opened[0]!.body, /# Decisions of the user/)

  assert.match(result.report, /^# Development run: READY/)
  // origin is a local bare repository, so the host commits unsigned, also without a usable key.
  assert.match(result.report, /^- Commits: unsigned \(no GitHub origin\)$/m)
  assert.ok(visibleLines(result.report).length <= 10, result.report)
  assert.match(visible(result.report), /^PR: \S+$/m)
  assert.doesNotMatch(visible(result.report), /^- \[/m)
  assert.match(result.report, /^- \[x\] Every task built: sub, mul, tests$/m)
  assert.doesNotMatch(result.report, /- \[ \]/)
  assert.match(result.report, /- Pass 1: PASS, `TRIAGE path=full reason=not-docs-or-tests/)
  assert.match(result.report, /^- \[x\] Ask confirmed: the run took the recommendations of the intake agent/m)
  assert.match(result.report, /## Your decisions\n\n- none asked\n\n## Decisions the run made\n\n- Is this the ask\? Correct it in your own words if it is not\. \*\*Yes, go on\*\* \(recommended\)/)
  assert.equal(github.state.comments.length, 1)

  // Without the merge permission, the host does not merge and does not delete the branch.
  assert.match(result.report, /^Ready for your review\. You merge\.$/m)
  assert.deepEqual(github.state.merges, [])
  assert.equal(result.merge, null)
  assert.doesNotMatch(github.state.opened[0]!.body, /Closes/)
  await git(origin, 'rev-parse', '--verify', 'refs/heads/factory/dev-add-sub-mul')

  // The open PR keeps the development branch. The task branches and the review fix branch are gone, and so are the worktrees.
  await git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/factory/dev-add-sub-mul')
  assert.equal(existsSync(worktreePath(join(result.dir, 'branches'), 'factory/dev-add-sub-mul')), false)
  for (const name of ['factory/task-dev-sub', 'factory/task-dev-mul', 'factory/task-dev-tests', 'factory/dev-review-1'])
    await assert.rejects(git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`), name)
  assert.match(result.report, /^- deleted factory\/dev-review-1 \(applied\)$/m)
  assert.doesNotMatch(result.report, /deleted factory\/dev-add-sub-mul/)

  // The Usage section: the development agents, the review pass with the USD of all its agents, and the total.
  assert.match(result.report, /^## Usage$/m)
  assert.match(result.report, /^\| intake \| claude-opus-5-5 \| [1-9]\d* \| 0 \| 0 \| [1-9]\d* \| \$0\.\d{4} \|$/m)
  assert.match(result.report, /^\| review\.1 \| review loop \| [1-9]\d* \| 0 \| 0 \| [1-9]\d* \| \$0\.\d{4} \|$/m)
  assert.match(result.report, /^\| \*\*Total\*\* \| {2}\| [1-9]\d* \| 0 \| 0 \| [1-9]\d* \| \$\d+\.\d+ \|$/m)
  assert.doesNotMatch(result.report, /^Budget:/m)
})

test('develop: with the merge permission, the host merges the ready PR at the checked head and deletes the branches of the run', { timeout: 120_000 }, async () => {
  const { repo, origin } = developRepo(undefined, { merge: 'squash' })
  const dir = runsDir()
  // The prune deletes the local branch after the merge, so the head is read at the merge.
  let head = ''
  const github = fakePulls([false, true], {
    merge: () => {
      head = execFileSync('git', ['rev-parse', 'refs/heads/factory/dev-add-sub-mul'], { cwd: repo }).toString().trim()
      return { merged: true, sha: mergeCommit }
    },
  })
  const input = await developInput(repo, 'merged', { issue: 12 })
  const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), input, pulls: github.pulls, runId: 'merged' })

  assert.equal(result.status, 'ready', result.report)
  assert.deepEqual(github.state.ready, [9])
  assert.equal(github.state.shas.at(-1), head)
  assert.deepEqual(github.state.merges, [{ pr: 9, method: 'squash', sha: head }])
  assert.match(github.state.opened[0]!.body, /^Closes #12\n\n/)
  assert.match(github.state.opened[0]!.body, /<details><summary>.*<\/summary>\n\nagent-factory run `merged` .* opened this draft PR\. .*\n\n# Ask\n/)
  assert.deepEqual(result.merge, { method: 'squash', sha: mergeCommit })
  assert.match(result.report, new RegExp(`^Merged by the host \\(squash\\): ${mergeCommit}\\.$`, 'm'))
  assert.equal(github.state.comments.length, 1)
  assert.ok(github.state.comments[0]!.includes(`Merged by the host (squash): ${mergeCommit}.`))
  assert.deepEqual(fileLedger(join(result.dir, 'state.json')).get('result'), { status: 'ready', pr: result.pr, branch: result.branch, merge: result.merge })
  // The remote branch and the local branches of the run are gone. The Branches section in the details lists each one time.
  await assert.rejects(git(origin, 'rev-parse', '--verify', 'refs/heads/factory/dev-add-sub-mul'))
  for (const name of ['factory/dev-add-sub-mul', 'factory/merged-review-1', 'factory/task-merged-sub', 'factory/task-merged-mul', 'factory/task-merged-tests'])
    await assert.rejects(git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`), name)
  assert.match(result.report, /^- deleted factory\/dev-add-sub-mul \(merged\)$/m)
  assert.match(result.report, /^- deleted factory\/merged-review-1 \(applied\)$/m)
  assert.equal(result.report.match(/factory\/dev-add-sub-mul \(merged\)/g)?.length, 1)
  assert.ok(result.report.indexOf('<details>') < result.report.indexOf('## Branches'), result.report)
  assert.ok(result.report.indexOf('## Branches') < result.report.indexOf('</details>'), result.report)

  // A resumed run does not merge again and posts no new comment.
  const again = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), input, pulls: github.pulls, runId: 'merged' })
  assert.equal(again.report, result.report)
  assert.deepEqual(again.merge, result.merge)
  assert.equal(github.state.merges.length, 1)
  assert.equal(github.state.comments.length, 1)
})

test('develop: a refused merge and a merge error leave the PR ready with the reason, and a resumed run does not merge again', { timeout: 240_000 }, async () => {
  const cases = [
    { reason: 'Pull Request is not mergeable', merge: () => ({ merged: false as const, reason: 'Pull Request is not mergeable', kind: 'other' as const }) },
    {
      reason: 'socket hang up',
      merge: () => {
        throw new Error('socket hang up')
      },
    },
  ]
  for (const { reason, merge } of cases) {
    const { repo, origin } = developRepo(undefined, { merge: 'rebase' })
    const dir = runsDir()
    const github = fakePulls([false, true], { merge })
    const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'refused' })
    assert.equal(result.status, 'ready', result.report)
    assert.deepEqual(github.state.ready, [9])
    assert.equal(github.state.merges.length, 1)
    assert.equal(github.state.merges[0]!.method, 'rebase')
    assert.equal(result.merge, null)
    assert.match(result.report, new RegExp(`^Not merged: ${reason}\\. The PR stays ready for your review\\. You merge\\.$`, 'm'))
    await git(origin, 'rev-parse', '--verify', 'refs/heads/factory/dev-add-sub-mul')

    const again = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'refused' })
    assert.equal(again.report, result.report)
    assert.equal(github.state.merges.length, 1, reason)
    assert.equal(github.state.comments.length, 1, reason)
  }
})

test('develop: a merge whose branch delete fails keeps the run merged and notes the branch', { timeout: 120_000 }, async () => {
  const { repo } = developRepo(undefined, { merge: 'merge' })
  const github = fakePulls([false, true], {
    merge: () => {
      // origin goes away after the merge, so the branch delete fails.
      execFileSync('git', ['remote', 'set-url', 'origin', join(repo, 'absent.git')], { cwd: repo })
      return { merged: true, sha: mergeCommit }
    },
  })
  const result = await runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'undeleted' })
  assert.equal(result.status, 'ready', result.report)
  assert.deepEqual(result.merge, { method: 'merge', sha: mergeCommit })
  assert.match(result.report, new RegExp(`^Merged by the host \\(merge\\): ${mergeCommit}\\. The host did not delete the branch factory/dev-add-sub-mul: .+\\.$`, 'm'))
  // The prune cannot reach origin either: each failed delete is a line of the Branches section, and the note does not repeat in it.
  assert.match(result.report, /^- not deleted factory\/undeleted-review-1: .+$/m)
  assert.doesNotMatch(result.report, /deleted factory\/dev-add-sub-mul/)
})

/** The rounds of the repair turns, in order. A repair turn is the first request of a turn with a repair prompt. */
const repairRounds = (turns: Turn[]) =>
  turns.filter((turn) => turn.role === 'builder' && turn.output === null).flatMap((turn) => [...turn.request.matchAll(/Repair round (\d+) of/g)].at(-1)?.[1] ?? [])
/** What the fixer read in /review/repair.txt, in order. */
const repairTexts = (turns: Turn[]) => turns.filter((turn) => turn.role === 'builder' && turn.output?.includes('repair.txt: ')).map((turn) => turn.output ?? '')

test('develop: CI red two times gets two repair rounds, then a review pass, and a resume in the middle repeats no round', { timeout: 240_000 }, async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  const github = fakePulls([false, false, true])
  // The run pauses at the CI of the first repair.
  const first: Turn[] = []
  await assert.rejects(runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), first), pulls: pauseAtCi(github.pulls, 2), runId: 'red-ci' }), PausedError)
  assert.deepEqual(repairRounds(first), ['1'])
  assert.ok(!first.some((turn) => turn.role === 'intent'))
  assert.match(repairTexts(first)[0] ?? '', /# CI failed on [0-9a-f]{12}.*- CI \(pull_request\): https:\/\/ci\.example\//s)

  const second: Turn[] = []
  const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), second), pulls: github.pulls, runId: 'red-ci' })
  assert.equal(result.status, 'ready', result.report)
  // The resumed run did not repeat the build or round 1. No review pass ran while CI was red.
  assert.deepEqual(repairRounds(second), ['2'])
  assert.ok(!second.some((turn) => /Build task/.test(turn.request)))
  assert.ok(second.some((turn) => turn.role === 'intent'))
  assert.equal(github.state.shas.length, 3)
  const ledger = fileLedger(join(dir, 'red-ci', 'state.json'))
  for (const key of ['step:repair.1', 'step:repair.2', 'ci:ci.repair.1', 'ci:ci.repair.2', 'step:review.1']) assert.ok(ledger.get(key), key)
  for (const key of ['step:repair.3', 'step:review.2']) assert.equal(ledger.get(key), undefined, key)
  assert.match(result.report, /^- Round 1, CI: CI \(pull_request\) failed on [0-9a-f]{12}\. repair 1: mul\(2, 3\) is 6$/m)
  assert.match(result.report, /^- Round 2, CI: CI \(pull_request\) failed on [0-9a-f]{12}\. repair 2: mul\(2, 3\) is 6$/m)
  assert.match(result.report, /^- \[x\] Review loop PASS on the head, at least 1 pass: pass 1: PASS$/m)
  assert.ok(visibleLines(result.report).length <= 10, result.report)
})

test('develop: a failed intent check gets a repair round and a second review pass, and a resume in the middle repeats no round', { timeout: 240_000 }, async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  const github = fakePulls([true])
  const requests: ReviewRequest[] = []
  const intentGap = { name: 'Intent reviewer affirms the original ask', ok: false, detail: 'no test checks mul(2, 3)' }
  const review = scriptedReview([[intentGap], []], requests)
  // The run pauses at the CI of the repair, after review pass 1 and repair round 1.
  const first: Turn[] = []
  await assert.rejects(runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), first), pulls: pauseAtCi(github.pulls, 2), review, runId: 'intent' }), PausedError)
  assert.deepEqual(repairRounds(first), ['1'])
  assert.deepEqual(requests.map((request) => request.runId), ['intent-review-1'])
  const read = repairTexts(first)[0] ?? ''
  assert.match(read, /# Review pass 1 failed on [0-9a-f]{12}.*- Intent reviewer affirms the original ask: no test checks mul\(2, 3\)/s)
  assert.doesNotMatch(read, /Checks green/)
  assert.ok(!first.some((turn) => turn.role === 'builder' && /The CI logs: \/review\/ci-failure\.txt/.test(turn.request)))

  const second: Turn[] = []
  const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), second), pulls: github.pulls, review, runId: 'intent' })
  assert.equal(result.status, 'ready', result.report)
  assert.deepEqual(repairRounds(second), [])
  // The second pass reviewed the head of the repair.
  assert.deepEqual(requests.map((request) => request.runId), ['intent-review-1', 'intent-review-2'])
  assert.notEqual(requests[1]!.head, requests[0]!.head)
  assert.equal(requests[1]!.head, github.state.shas.at(-1))
  const ledger = fileLedger(join(dir, 'intent', 'state.json'))
  for (const key of ['step:repair.1', 'ci:ci.repair.1', 'step:review.2']) assert.ok(ledger.get(key), key)
  for (const key of ['step:repair.2', 'ci:ci.repair.2']) assert.equal(ledger.get(key), undefined, key)
  assert.match(result.report, /^- \[x\] Review loop PASS on the head, at least 1 pass: pass 1: FAIL, pass 2: PASS$/m)
  assert.match(result.report, /^- Round 1, review pass 1: failed: Intent reviewer affirms the original ask\. repair 1: mul\(2, 3\) is 6$/m)
  assert.deepEqual(github.state.ready, [9])
})

test('develop: a review that fails 6 times ends failed after 5 repair rounds, does not merge, and a resume starts no round 6', { timeout: 300_000 }, async () => {
  const { repo } = developRepo(undefined, { merge: 'squash' })
  const dir = runsDir()
  const github = fakePulls([true])
  const requests: ReviewRequest[] = []
  const failing = (pass: number) => [{ name: 'Checks green', ok: false, detail: `failed: tests (pass ${pass})` }]
  const review = scriptedReview([1, 2, 3, 4, 5, 6].map(failing), requests)
  // The run pauses at the CI of repair round 3.
  const first: Turn[] = []
  await assert.rejects(runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), first), pulls: pauseAtCi(github.pulls, 4), review, runId: 'failing' }), PausedError)
  assert.deepEqual(repairRounds(first), ['1', '2', '3'])
  assert.equal(requests.length, 3)

  const second: Turn[] = []
  const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), second), pulls: github.pulls, review, runId: 'failing' })
  assert.equal(result.status, 'failed', result.report)
  assert.deepEqual(repairRounds(second), ['4', '5'])
  assert.deepEqual(requests.map((request) => request.runId), [1, 2, 3, 4, 5, 6].map((pass) => `failing-review-${pass}`))
  assert.match(repairTexts(second)[1] ?? '', /- Checks green: failed: tests \(pass 5\)/)
  const ledger = fileLedger(join(dir, 'failing', 'state.json'))
  for (const key of ['step:repair.5', 'ci:ci.repair.5', 'step:review.6']) assert.ok(ledger.get(key), key)
  for (const key of ['step:repair.6', 'ci:ci.repair.6', 'step:review.7']) assert.equal(ledger.get(key), undefined, key)
  assert.match(result.report, /^The run used its 5 repair rounds\. The last cause: review pass 6, failed: Checks green\. The PR stays draft\.$/m)
  assert.match(result.report, /^- Round 5, review pass 5: failed: Checks green\. repair 5: mul\(2, 3\) is 6$/m)
  assert.doesNotMatch(result.report, /^- Round 6/m)
  // A failed run with the merge permission is not ready and does not merge.
  assert.ok(visibleLines(result.report).length <= 10, result.report)
  assert.match(visible(result.report), /^- \[ \] Review loop PASS on the head, at least 1 pass: pass 1: FAIL, .*pass 6: FAIL$/m)
  assert.doesNotMatch(visible(result.report), /^- \[x\]/m)
  assert.deepEqual(github.state.merges, [])
  assert.deepEqual(github.state.ready, [])
  assert.equal(result.merge, null)

  // A resume after the end starts no round 6 and runs no review pass.
  const third: Turn[] = []
  const again = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), third), pulls: github.pulls, review, runId: 'failing' })
  assert.equal(again.status, 'failed', again.report)
  assert.equal(again.report, result.report)
  assert.ok(!third.some((turn) => turn.role === 'builder'))
  assert.equal(requests.length, 6)
  assert.equal(fileLedger(join(dir, 'failing', 'state.json')).get('step:repair.6'), undefined)
  assert.deepEqual(github.state.merges, [])
})

test('develop: a refused rejection of a high finding goes to the fixer with the report of the review pass', { timeout: 240_000 }, async () => {
  const { repo } = developRepo()
  const github = fakePulls([true])
  const requests: ReviewRequest[] = []
  const refused = { name: 'No critical or high finding left unapplied without your OK', ok: false, detail: 'the rejection of bugs-001 is not accepted' }
  const skipped = '- bugs-001 (high): mul(2, 3) is not tested, test/ops.test.ts:1. Expect 6 from mul(2, 3). Skipped: out of scope.'
  const scripted = scriptedReview([[refused], []], requests)
  const review: typeof scripted = async (request) => ({ ...(await scripted(request)), report: `- Triage: \`TRIAGE path=full\`\n\n## Skipped\n\n${skipped}\n` })
  // The fixer also reads /review/review-report.md before its repair.
  const script = developScript()
  const turns: Turn[] = []
  const dispatch = scriptedDispatch((turn) => {
    const reply = script(turn)
    if (turn.role !== 'builder' || turn.output !== null || !/Repair round/.test(turn.request) || !('cell' in reply)) return reply
    return { cell: `text('review-report.md: ' + await tools.Read({ file_path: '/review/review-report.md' }))\n${reply.cell}` }
  }, turns)
  const result = await runDevelop(repo, runsDir(), { dispatch, pulls: github.pulls, review, runId: 'refused-rejection' })
  assert.equal(result.status, 'ready', result.report)
  assert.deepEqual(repairRounds(turns), ['1'])
  const read = repairTexts(turns)[0] ?? ''
  assert.match(read, /- No critical or high finding left unapplied without your OK: the rejection of bugs-001 is not accepted/)
  assert.doesNotMatch(read, /The report of the pass: \/review\/review-report\.md/)
  assert.match(read, /review-report\.md: .*bugs-001 \(high\): mul\(2, 3\) is not tested, test\/ops\.test\.ts:1\. Expect 6 from mul\(2, 3\)\. Skipped: out of scope\./s)
  assert.ok(turns.some((turn) => turn.role === 'builder' && /The report of the review pass, with the findings that the patch agents skipped: \/review\/review-report\.md/.test(turn.request)))
  assert.equal(requests.length, 2)
})

test('develop: a base that moves without a conflict gets a merge commit and CI again, no new review pass, and the run merges the new head', { timeout: 240_000 }, async () => {
  const { repo, origin } = developRepo(undefined, { merge: 'squash' })
  const dir = runsDir()
  const github = fakePulls([true])
  const requests: ReviewRequest[] = []
  const review = scriptedReview([[]], requests)
  const input = await developInput(repo, 'base-clean')
  const base = pushBase(origin, { 'docs/base.md': '# Base\n' })
  // The run pauses at the CI of the base merge. The resume replays the base check and merges the base no second time.
  await assert.rejects(runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), input, pulls: pauseAtCi(github.pulls, 2), review, runId: 'base-clean' }), PausedError)
  const turns: Turn[] = []
  const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), turns), input, pulls: github.pulls, review, runId: 'base-clean' })
  assert.equal(result.status, 'ready', result.report)
  assert.deepEqual(turns, [])

  // One base merge with two parents, CI on its head, and the merge at that head. The merge brought no file of the change.
  assert.equal(github.state.shas.length, 2)
  const [built, head] = github.state.shas as [string, string]
  assert.deepEqual(parents(origin, head), [built, base])
  assert.deepEqual(github.state.merges, [{ pr: 9, method: 'squash', sha: head }])
  assert.deepEqual(result.merge, { method: 'squash', sha: mergeCommit })
  assert.deepEqual(requests.map((request) => [request.head, request.base]), [[built, input.base]])
  const ledger = fileLedger(join(dir, 'base-clean', 'state.json'))
  assert.deepEqual(ledger.get('step:base-check.1'), { result: { point: 'ready', base, moved: true, merge: { files: ['docs/base.md'], conflicts: [], change: ['src/mul.ts', 'src/sub.ts', 'test/ops.test.ts'] } } })
  for (const key of ['step:base-check.2', 'step:base-check.3', 'ci:ci.base.1']) assert.ok(ledger.get(key), key)
  assert.equal(ledger.get('step:base-check.4'), undefined)
  assert.match(result.report, new RegExp(`^## Base merges\\n\\n- Before ready: ${base.slice(0, 12)}, clean\\. Files: docs/base\\.md\\n`, 'm'))
  assert.match(result.report, new RegExp(`^## Merge tries\\n\\n- Try 1: merged as ${mergeCommit}\\n`, 'm'))
  assert.match(result.report, /^- \[x\] CI green on the head: /m)

  // A resume of the finished run makes no new base merge and no new merge call, also when the base moved again.
  pushBase(origin, { 'docs/later.md': '# Later\n' })
  const again = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), input, pulls: github.pulls, review, runId: 'base-clean' })
  assert.equal(again.report, result.report)
  assert.equal(github.state.merges.length, 1)
  assert.equal(github.state.shas.length, 2)
})

test('develop: a base merge with a conflict on a file of the change gets a repair round, a new review pass, and the run merges', { timeout: 240_000 }, async () => {
  const { repo, origin } = developRepo(undefined, { merge: 'squash' })
  const dir = runsDir()
  const github = fakePulls([true])
  const requests: ReviewRequest[] = []
  const review = scriptedReview([[], []], requests)
  const theirs = 'export function sub(a: number, b: number): number {\n  return -(b - a)\n}\n'
  const base = pushBase(origin, { 'src/sub.ts': theirs, 'docs/base.md': '# Base\n' })
  const turns: Turn[] = []
  const script = developScript({ resolved: { 'src/sub.ts': sources.sub } })
  const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(script, turns), pulls: github.pulls, review, runId: 'base-conflict' })
  assert.equal(result.status, 'ready', result.report)

  // One repair round of the shared budget, with the base merge as its cause and the files that conflict.
  const at = base.slice(0, 12)
  assert.deepEqual(repairRounds(turns), ['1'])
  assert.ok(turns.some((turn) => turn.role === 'builder' && /The files that conflict: src\/sub\.ts\..*remove the conflict markers/s.test(turn.request)))
  assert.match(repairTexts(turns)[0] ?? '', new RegExp(`# The merge of the base ${at} has conflicts.*- src/sub\\.ts`, 's'))
  assert.match(result.report, new RegExp(`^- Round 1, base merge: ${at} conflicts in src/sub\\.ts\\. repair 1: the conflicts of the base merge are resolved$`, 'm'))
  assert.match(result.report, new RegExp(`^- Before ready: ${at}, conflict in src/sub\\.ts\\. Files: docs/base\\.md, src/sub\\.ts$`, 'm'))

  // The head is the merge commit of the fixer, with two parents and no conflict markers. A new review pass reviewed it from the new merge base.
  assert.equal(github.state.shas.length, 2)
  const [built, head] = github.state.shas as [string, string]
  assert.deepEqual(parents(origin, head), [built, base])
  const show = (path: string) => execFileSync('git', ['--git-dir', origin, 'show', `${head}:${path}`]).toString()
  assert.equal(show('src/sub.ts'), sources.sub)
  assert.equal(hasConflictMarkers(show('src/sub.ts')), false)
  assert.equal(show('docs/base.md'), '# Base\n')
  assert.deepEqual(requests.map((request) => [request.head, request.base]), [[built, (await developInput(repo, 'x')).base], [head, base]])
  assert.match(result.report, /^- \[x\] Review loop PASS on the head, at least 1 pass: pass 1: PASS, pass 2: PASS$/m)
  assert.deepEqual(github.state.merges, [{ pr: 9, method: 'squash', sha: head }])
  assert.deepEqual(result.merge, { method: 'squash', sha: mergeCommit })
})

test('develop: a base merge whose fixer keeps its side of the conflict gets the merge commit with the tree of the head, and the run merges', { timeout: 240_000 }, async () => {
  const { repo, origin } = developRepo(undefined, { merge: 'squash' })
  const github = fakePulls([true])
  const review = scriptedReview([[], []], [])
  const base = pushBase(origin, { 'src/sub.ts': 'export function sub(a: number, b: number): number {\n  return -(b - a)\n}\n' })
  const script = developScript({ resolved: { 'src/sub.ts': sources.sub } })
  const result = await runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(script, []), pulls: github.pulls, review, runId: 'base-keep' })
  assert.equal(result.status, 'ready', result.report)

  const [built, head] = github.state.shas as [string, string]
  assert.deepEqual(parents(origin, head), [built, base])
  const tree = (sha: string) => execFileSync('git', ['--git-dir', origin, 'rev-parse', `${sha}^{tree}`]).toString().trim()
  assert.equal(tree(head), tree(built))
  assert.deepEqual(github.state.merges, [{ pr: 9, method: 'squash', sha: head }])
})

test('develop: in a base merge with a conflict, the static rules skip the files that the base brings', { timeout: 240_000 }, async () => {
  const { repo, origin } = developRepo(undefined, { merge: 'squash' })
  const github = fakePulls([true])
  const review = scriptedReview([[], []], [])
  // A .log file breaks a static rule. The base brings it, so the checkpoint of the fixer does not refuse it.
  const base = pushBase(origin, { 'src/sub.ts': 'export function sub(a: number, b: number): number {\n  return -(b - a)\n}\n', 'notes/base.log': 'base\n' })
  const script = developScript({ resolved: { 'src/sub.ts': 'export const sub = (a: number, b: number) => a - b\n' } })
  const result = await runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(script, []), pulls: github.pulls, review, runId: 'base-rules' })
  assert.equal(result.status, 'ready', result.report)

  const [built, head] = github.state.shas as [string, string]
  assert.deepEqual(parents(origin, head), [built, base])
  assert.equal(execFileSync('git', ['--git-dir', origin, 'show', `${head}:notes/base.log`]).toString(), 'base\n')
})

test('develop: a merge that GitHub refuses as stale gets a base check, CI again and a second try, and the report lists both tries', { timeout: 240_000 }, async () => {
  const { repo, origin } = developRepo(undefined, { merge: 'squash' })
  const dir = runsDir()
  const stale = 'Base branch was modified. Review and try the merge again.'
  // The base moves at the first merge call, so GitHub refuses it.
  let base = ''
  const github = fakePulls([true], {
    merge: () => {
      if (base) return { merged: true, sha: mergeCommit }
      base = pushBase(origin, { 'docs/base.md': '# Base\n' })
      return { merged: false, reason: stale, kind: 'stale' }
    },
  })
  const requests: ReviewRequest[] = []
  const review = scriptedReview([[]], requests)
  const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, review, runId: 'stale' })
  assert.equal(result.status, 'ready', result.report)
  assert.deepEqual(result.merge, { method: 'squash', sha: mergeCommit })

  assert.equal(github.state.shas.length, 2)
  const [built, head] = github.state.shas as [string, string]
  assert.deepEqual(parents(origin, head), [built, base])
  assert.deepEqual(github.state.merges.map((call) => call.sha), [built, head])
  assert.equal(requests.length, 1)
  const ledger = fileLedger(join(dir, 'stale', 'state.json'))
  for (const key of ['step:merge', 'step:merge.2', 'ci:ci.base.1']) assert.ok(ledger.get(key), key)
  assert.equal((ledger.get<{ result: { point: string } }>('step:base-check.3'))?.result.point, 'merge')
  assert.match(result.report, new RegExp(`^- Before the merge: ${base.slice(0, 12)}, clean\\. Files: docs/base\\.md$`, 'm'))
  assert.match(result.report, new RegExp(`^## Merge tries\\n\\n- Try 1: refused \\(stale\\): ${stale.replace(/\./g, '\\.')}\\n- Try 2: merged as ${mergeCommit}\\n`, 'm'))

  const again = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, review, runId: 'stale' })
  assert.equal(again.report, result.report)
  assert.equal(github.state.merges.length, 2)
})

test('develop: a resume after a review pass with fixes and a base merge replays the head of each push and ends ready', { timeout: 240_000 }, async () => {
  const { repo, origin } = developRepo()
  const dir = runsDir()
  const github = fakePulls([true])
  const requests: ReviewRequest[] = []
  const scripted = scriptedReview([[]], requests)
  // The review pass makes a fix commit on the head, so that ci.final.1 records the head before the base merge.
  const review: typeof scripted = async (request) => {
    const result = await scripted(request)
    const fixed = execFileSync('git', ['commit-tree', '--no-gpg-sign', '-m', 'review fix', '-p', request.head, `${request.head}^{tree}`], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Review', GIT_AUTHOR_EMAIL: 'review@example.com', GIT_COMMITTER_NAME: 'Review', GIT_COMMITTER_EMAIL: 'review@example.com' },
    }).toString().trim()
    return { ...result, final: fixed }
  }
  const input = await developInput(repo, 'base-resume')
  const base = pushBase(origin, { 'docs/base.md': '# Base\n' })
  // The run pauses at the CI of the base merge, the third commit with CI.
  await assert.rejects(runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), input, pulls: pauseAtCi(github.pulls, 3), review, runId: 'base-resume' }), PausedError)
  const turns: Turn[] = []
  const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), turns), input, pulls: github.pulls, review, runId: 'base-resume' })
  assert.equal(result.status, 'ready', result.report)
  assert.deepEqual(turns, [])

  // The resume ran no second review pass and no second base merge. The head is the merge of the fixed head and the base.
  assert.equal(requests.length, 1)
  assert.equal(github.state.shas.length, 3)
  const [built, fixed, head] = github.state.shas as [string, string, string]
  assert.deepEqual(parents(origin, fixed), [built])
  assert.deepEqual(parents(origin, head), [fixed, base])
  const ledger = fileLedger(join(dir, 'base-resume', 'state.json'))
  assert.deepEqual(ledger.get('step:head.review.1'), { result: fixed })
  assert.deepEqual(ledger.get('step:head.base.1'), { result: head })
  assert.deepEqual(github.state.ready, [9])
})

test('develop: a resumed run with review passes from before D14 ends failed, does not repair, and does not mark the PR ready or merge', { timeout: 240_000 }, async () => {
  const { repo } = developRepo(undefined, { merge: 'squash' })
  const dir = runsDir()
  const github = fakePulls([false, true])
  const requests: ReviewRequest[] = []
  const review = scriptedReview([[]], requests)
  // The run pauses before the repair loop. The ledger then gets a pre-D14 red CI, a CI-fix round and a PASS.
  const pulls = { ...github.pulls, open: async () => { throw new PausedError('before the repair loop') } }
  await assert.rejects(runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls, review, runId: 'old-ledger' }), PausedError)
  const ledger = fileLedger(join(dir, 'old-ledger', 'state.json'))
  const old = 'a'.repeat(40)
  const job = { name: 'CI (pull_request)', run: 1, url: 'https://ci.example/old', created: new Date().toISOString(), done: true, ok: false }
  ledger.put('ci:ci.build.0', { sha: old, state: 'fail', jobs: [job], failures: 'no test of mul(2, 3)' })
  ledger.put('step:ci-fix.1', { result: { summary: 'mul(2, 3) is 6', changes: [], tests: [], blocked: '' } })
  ledger.put('step:review.1', { result: { pass: true, head: old, final: old, branch: 'factory/review', report: '- Triage: `TRIAGE path=full`', failed: [] } })

  const turns: Turn[] = []
  const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), turns), pulls: github.pulls, review, runId: 'old-ledger' })
  assert.equal(result.status, 'failed', result.report)
  assert.match(result.report, /The review passes of this run are from before D14 and did not review the repair commits\. Start a new run\. The PR stays draft\./)
  assert.deepEqual(repairRounds(turns), [])
  assert.equal(requests.length, 0)
  assert.equal(fileLedger(join(dir, 'old-ledger', 'state.json')).get('step:repair.1'), undefined)
  assert.deepEqual(github.state.ready, [])
  assert.deepEqual(github.state.merges, [])
  assert.equal(result.merge, null)
})

test('develop: a pre-D14 CI-fix without a review enters the repair loop and resumes after a new review', { timeout: 240_000 }, async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  const github = fakePulls([false, true])
  const requests: ReviewRequest[] = []
  const review = scriptedReview([[{ name: 'Checks green', ok: false, detail: 'no test checks mul(2, 3)' }], []], requests)
  const pulls = { ...github.pulls, open: async () => { throw new PausedError('before the repair loop') } }
  await assert.rejects(runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls, review, runId: 'old-ci-fix' }), PausedError)
  const path = join(dir, 'old-ci-fix', 'state.json')
  const ledger = fileLedger(path)
  ledger.put('step:ci-fix.1', { result: { summary: 'mul(2, 3) is 6', changes: [], tests: [], blocked: '' } })
  assert.equal(ledger.get('repair-workflow'), undefined)
  assert.equal(ledger.get('step:review.1'), undefined)

  // The new loop repairs CI, records review pass 1, and pauses at the CI of repair round 2.
  const first: Turn[] = []
  await assert.rejects(runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), first), pulls: pauseAtCi(github.pulls, 3), review, runId: 'old-ci-fix' }), PausedError)
  assert.deepEqual(repairRounds(first), ['1', '2'])
  const paused = fileLedger(path)
  assert.equal(paused.get('repair-workflow'), true)
  for (const key of ['step:ci-fix.1', 'step:repair.1', 'step:review.1', 'step:repair.2']) assert.ok(paused.get(key), key)
  assert.deepEqual(requests.map((request) => request.runId), ['old-ci-fix-review-1'])

  const second: Turn[] = []
  const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), second), pulls: github.pulls, review, runId: 'old-ci-fix' })
  assert.equal(result.status, 'ready', result.report)
  assert.deepEqual(repairRounds(second), [])
  assert.ok(!second.some((turn) => /Build task/.test(turn.request)))
  assert.deepEqual(requests.map((request) => request.runId), ['old-ci-fix-review-1', 'old-ci-fix-review-2'])
  assert.notEqual(requests[1]!.head, requests[0]!.head)
  assert.equal(requests[1]!.head, github.state.shas.at(-1))
  assert.equal(fileLedger(path).get('step:repair.3'), undefined)
  assert.deepEqual(github.state.ready, [9])
})

test('develop: a user question of the intake agent pauses the run, and the run resumes without asking again or repeating the intake', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  const { channel, posted, replies } = memoryChannel({ intake: null })
  const script = developScript({ askScope: true })
  const first: Turn[] = []
  await assert.rejects(
    runDevelop(repo, dir, { channel, dispatch: scriptedDispatch(script, first), pulls: fakePulls().pulls, runId: 'pause' }),
    (error: unknown) => error instanceof PausedError,
  )
  assert.ok(!first.some((turn) => turn.role === 'planner'))
  // The user question goes to the user with the confirmation of the ask. The other route questions are run questions.
  assert.deepEqual(posted.map((entry) => entry.batch), ['intake'])
  assert.deepEqual(posted[0]!.questions.map((question) => [question.id, question.question, question.level, question.rule]), [
    ['Q1', scopeQuestion.question, 'user', 'scope'],
    ['Q2', 'Is this the ask? Correct it in your own words if it is not.', 'user', 'scope'],
  ])
  assert.equal(posted[0]!.questions[1]!.why, 'Adds sub() and mul() next to add(), with tests.')

  replies.intake = '/answer recommended'
  const second: Turn[] = []
  const result = await runDevelop(repo, dir, { channel, dispatch: scriptedDispatch(script, second), pulls: fakePulls().pulls, runId: 'pause' })
  assert.equal(result.status, 'ready', result.report)
  assert.equal(posted.length, 1)
  assert.ok(!second.some((turn) => turn.role === 'intake'))
  assert.match(result.report, /^- \[x\] Ask confirmed: you answered the intake questions$/m)
  assert.match(result.report, /## Your decisions\n\n- Add div too\? \*\*No, only sub and mul\*\* \(recommended\)\n- Is this the ask\? Correct it in your own words if it is not\. \*\*Yes, go on\*\* \(recommended\)\n\n## Decisions the run made\n\n- Write a spec before the plan\?/)
})

test('develop: a hotfix takes the recommendation of every question, and marks only the run questions as decided by the run', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const { channel, posted } = memoryChannel({ intake: null })
  const input = { ...(await developInput(repo, 'hotfix')), hotfix: true }
  const result = await runDevelop(repo, runsDir(), { channel, dispatch: scriptedDispatch(developScript({ askScope: true, blockSub: true }), []), input, pulls: fakePulls().pulls, runId: 'hotfix' })
  assert.equal(result.status, 'blocked', result.report)
  assert.deepEqual(posted, [])
  assert.match(result.report, /## Your decisions\n\n- Add div too\? \*\*No, only sub and mul\*\* \(recommended\)\n- Is this the ask\? Correct it in your own words if it is not\. \*\*Yes, go on\*\* \(recommended\)\n\n## Decisions the run made\n\n- Write a spec before the plan\?/)
})

test('develop: with the standing answers of the repository, the run takes every recommendation and posts no question', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const { channel, posted } = memoryChannel({ intake: null })
  const base = await developInput(repo, 'standing')
  const input = { ...base, config: { ...base.config, questions: 'recommended' as const } }
  const result = await runDevelop(repo, runsDir(), { channel, dispatch: scriptedDispatch(developScript({ askScope: true, blockSub: true }), []), input, pulls: fakePulls().pulls, runId: 'standing' })
  assert.equal(result.status, 'blocked', result.report)
  assert.deepEqual(posted, [])
  assert.match(result.report, /## Your decisions\n\n- Add div too\? \*\*No, only sub and mul\*\* \(recommended\)/)
})

test('develop: CI that another branch ran on the same commit does not count until the push gets CI of its own', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const github = fakePulls([false, true], { stale: true })
  const result = await runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'stale' })
  assert.equal(result.status, 'ready', result.report)
  assert.ok(Object.values(github.state.looks).every((looks) => looks >= 2), JSON.stringify(github.state.looks))
})

test('develop: a run without CI blocks, and the resumed run with CI posts its new report on the PR', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  // The first commit with CI is red and the fix makes it green, as in the first test: the review then passes.
  const github = fakePulls([false, true])
  github.state.noCi = true
  const first = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'no-ci' })
  assert.equal(first.status, 'blocked', first.report)
  assert.ok(first.resume)
  assert.match(first.resume, /^No CI ran on [0-9a-f]{12}\./)
  assert.ok(first.report.includes(first.resume))
  // A resumable stop is not the end of the run: the development branch and its worktree stay.
  await git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/factory/dev-add-sub-mul')
  assert.ok(existsSync(worktreePath(join(first.dir, 'branches'), 'factory/dev-add-sub-mul')))
  assert.doesNotMatch(first.report, /^## Branches$/m)

  github.state.noCi = false
  const second = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'no-ci' })
  assert.equal(second.status, 'ready', second.report)
  assert.equal(second.resume, null)
  assert.deepEqual(
    github.state.comments.map((comment) => comment.split('\n')[0]),
    ['# Development run: BLOCKED', '# Development run: READY'],
  )
  assert.equal(fileLedger(join(second.dir, 'state.json')).get('commented'), second.report)

  const third = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'no-ci' })
  assert.equal(third.report, second.report)
  assert.equal(github.state.comments.length, 2)
})

test('develop: the planner sees the protected paths, the host refuses a plan that writes them, and the corrected plan runs', { timeout: 120_000 }, async () => {
  const { repo } = developRepo({
    stack: 'TypeScript',
    checks: { smoke: 'node -e "process.exit(0)"' },
    tests: { pattern: '\\.test\\.ts$', command: 'env -u NODE_TEST_CONTEXT node --test {tests}' },
    protect: ['wrangler.jsonc'],
  })
  const turns: Turn[] = []
  const script = developScript()
  const protectedPlan = { ...plan, tasks: plan.tasks.map((task) => (task.id === 'sub' ? { ...task, files: [...task.files, 'wrangler.jsonc', '.agent-factory.json'] } : task)) }
  const result = await runDevelop(repo, runsDir(), {
    runId: 'protected-plan',
    pulls: fakePulls([false, true]).pulls,
    dispatch: scriptedDispatch((turn) => {
      if (turn.role !== 'planner' || turn.output !== null) return script(turn)
      return {
        cell: [
          `try { await tools.submit_plan(${JSON.stringify(protectedPlan)}); text('PROTECTED PLAN ACCEPTED') } catch (error) { text('plan refused: ' + error) }`,
          `await tools.submit_plan(${JSON.stringify(plan)})`,
        ].join('\n'),
      }
    }, turns),
  })
  assert.equal(result.status, 'ready', result.report)
  const planner = turns.filter((turn) => turn.role === 'planner')
  assert.ok(planner[0]!.request.includes('Protected paths, which no task may write: .agent-factory.json, wrangler.jsonc'))
  const output = planner.map((turn) => turn.output ?? '').join('\n')
  // The output is JSON, so the quotes in the refusal can be escaped.
  assert.match(output, /plan refused:.*task \W*sub\W*: \W*wrangler\.jsonc\W* is a protected path/)
  assert.match(output, /task \W*sub\W*: \W*\.agent-factory\.json\W* is a protected path/)
  assert.doesNotMatch(output, /PROTECTED PLAN ACCEPTED/)
})

test('develop: a blocked builder stops the run with the reason, before any PR', { timeout: 120_000 }, async () => {
  const { repo } = developRepo(undefined, { merge: 'squash' })
  const github = fakePulls()
  const result = await runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(developScript({ blockSub: true }), []), pulls: github.pulls, runId: 'blocked' })
  assert.equal(result.status, 'blocked')
  assert.match(result.report, /Task sub is blocked: sub needs a package that is not installed/)
  assert.equal(github.state.opened.length, 0)
  assert.deepEqual(github.state.merges, [])
  // Without a PR, the branches of the blocked run are stranded.
  for (const name of ['factory/dev-add-sub-mul', 'factory/task-blocked-sub', 'factory/task-blocked-mul'])
    await assert.rejects(git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`), name)
  assert.match(result.report, /^- deleted factory\/dev-add-sub-mul \(stranded\)$/m)
  assert.match(result.report, /^- deleted factory\/task-blocked-sub \(stranded\)$/m)
})

test('develop: a signing stop after the plan ends the run before any builder and before any commit on the run branch', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const turns: Turn[] = []
  const checked: string[][] = []
  const signing = (node: Signing): Signing => ({
    check: async (branches) => (checked.push(branches), node.check(branches)),
    apply: async () => {
      throw new StopError('Branch factory/dev-add-sub-mul requires signed commits (required by Protect main)')
    },
  })
  await assert.rejects(
    runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(developScript(), turns), pulls: fakePulls().pulls, runId: 'signing-stop', signing }),
    /requires signed commits \(required by Protect main\)/,
  )
  assert.deepEqual(checked, [['factory/dev-add-sub-mul']])
  assert.ok(turns.some((turn) => turn.role === 'planner'))
  assert.ok(!turns.some((turn) => turn.role === 'builder'))
  await assert.rejects(git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/factory/dev-add-sub-mul'))
})

test('develop: a review pass uses the signing answer of the development branch and does not check again', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  const checked: string[][] = []
  const record = { origin: true, branches: [{ branch: 'factory/dev-add-sub-mul', rulesets: [], classic: 'none' as const }], mode: 'unsigned' as const }
  const signing = (node: Signing): Signing => ({ ...node, check: async (branches) => (checked.push(branches), record) })
  const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls: fakePulls([false, true]).pulls, runId: 'signing-pass', signing })
  assert.equal(result.status, 'ready', result.report)
  assert.deepEqual(checked, [['factory/dev-add-sub-mul']])
  assert.deepEqual(fileLedger(join(dir, 'signing-pass-review-1', 'state.json')).get('step:signing'), { result: record })
})

test('develop: a test command writes outside the task scope, checkpoint refuses, and the builder submits a blocked log', { timeout: 120_000 }, async () => {
  const { repo } = developRepo({
    stack: 'TypeScript',
    checks: { smoke: 'node -e "process.exit(0)"' },
    tests: { pattern: '\\.test\\.ts$', command: `node -e "require('node:fs').writeFileSync('generated.txt', 'from tests')" {tests}` },
  })
  const turns: Turn[] = []
  const script = developScript()
  const github = fakePulls()
  const result = await runDevelop(repo, runsDir(), {
    runId: 'scope',
    keep: true,
    pulls: github.pulls,
    dispatch: scriptedDispatch((turn) => {
      if (turn.role !== 'builder' || turn.output !== null || !turn.request.includes('Build task sub:')) return script(turn)
      return {
        cell: [
          `text(JSON.stringify(await tools.run_tests({ tests: ['test/add.test.ts'] })))`,
          `try { await tools.checkpoint({ message: 'test output' }); text('OUTSIDE COMMITTED') } catch (error) { text(String(error)) }`,
          `try { await tools.submit_build_log({ summary: 'done', changes: [], tests: [], blocked: '' }); text('DIRTY LOG ACCEPTED') } catch (error) { text(String(error)) }`,
          `await tools.submit_build_log({ summary: 'not built', changes: [], tests: ['test/add.test.ts'], blocked: 'The test command wrote generated.txt outside the task scope' })`,
        ].join('\n'),
      }
    }, turns),
  })
  assert.equal(result.status, 'blocked', result.report)
  assert.equal(result.resume, null)
  assert.match(result.report, /Task sub is blocked: The test command wrote generated.txt outside the task scope/)
  assert.equal(github.state.opened.length, 0)
  const output = turns.filter((turn) => turn.role === 'builder').map((turn) => turn.output ?? '').join('\n')
  assert.match(output, /checkpoint refused:.*outside the files of the task.*generated\.txt/)
  assert.match(output, /checkpoint first: uncommitted changes in generated\.txt/)
  assert.doesNotMatch(output, /OUTSIDE COMMITTED|DIRTY LOG ACCEPTED/)
  const tree = worktreePath(join(result.dir, 'branches'), 'factory/task-scope-sub')
  assert.equal(readFileSync(join(tree, 'generated.txt'), 'utf8'), 'from tests')
  await assert.rejects(git(tree, 'cat-file', '-e', 'HEAD:generated.txt'))
})

test('develop: checkpoint refuses an out-of-scope file type change from a test command', { timeout: 120_000 }, async () => {
  const { repo } = developRepo({
    stack: 'TypeScript',
    checks: { smoke: 'node -e "process.exit(0)"' },
    tests: { pattern: '\\.test\\.ts$', command: `node -e "const fs = require('node:fs'); fs.unlinkSync('src/math.ts'); fs.symlinkSync('sub.ts', 'src/math.ts')" {tests}` },
  })
  const original = (await git(repo, 'rev-parse', 'main')).trim()
  const turns: Turn[] = []
  const script = developScript()
  const github = fakePulls()
  const result = await runDevelop(repo, runsDir(), {
    runId: 'type-change',
    keep: true,
    pulls: github.pulls,
    dispatch: scriptedDispatch((turn) => {
      if (turn.role !== 'builder' || turn.output !== null || !turn.request.includes('Build task sub:')) return script(turn)
      return {
        cell: [
          `await tools.Write({ file_path: '/repo/src/sub.ts', content: ${JSON.stringify(sources.sub)} })`,
          `text(JSON.stringify(await tools.run_tests({ tests: ['test/add.test.ts'] })))`,
          `try { await tools.checkpoint({ message: 'add sub' }); text('TYPE CHANGE COMMITTED') } catch (error) { text(String(error)) }`,
          `await tools.submit_build_log({ summary: 'not built', changes: [], tests: ['test/add.test.ts'], blocked: 'The test command changed the type of src/math.ts outside the task scope' })`,
        ].join('\n'),
      }
    }, turns),
  })
  assert.equal(result.status, 'blocked', result.report)
  assert.match(result.report, /Task sub is blocked: The test command changed the type of src\/math\.ts outside the task scope/)
  assert.equal(github.state.opened.length, 0)
  const output = turns.filter((turn) => turn.role === 'builder').map((turn) => turn.output ?? '').join('\n')
  assert.match(output, /checkpoint refused:.*outside the files of the task.*src\/math\.ts/)
  assert.doesNotMatch(output, /TYPE CHANGE COMMITTED/)
  const tree = worktreePath(join(result.dir, 'branches'), 'factory/task-type-change-sub')
  assert.equal(readlinkSync(join(tree, 'src/math.ts')), 'sub.ts')
  assert.equal((await git(tree, 'rev-parse', 'HEAD')).trim(), original)
  assert.equal(await git(tree, 'show', 'HEAD:src/math.ts'), readFileSync(join(repo, 'src/math.ts'), 'utf8'))
  await assert.rejects(git(tree, 'cat-file', '-e', 'HEAD:src/sub.ts'))
})

test('develop: a branch that exists only on origin gets a new suffix', { timeout: 120_000 }, async () => {
  const { repo, origin } = developRepo()
  const original = (await git(repo, 'rev-parse', 'main')).trim()
  await git(repo, 'push', 'origin', 'main:refs/heads/factory/dev-add-sub-mul')
  await assert.rejects(git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/factory/dev-add-sub-mul'))
  const github = fakePulls([false, true])
  const result = await runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'remote-branch' })
  assert.equal(result.status, 'ready', result.report)
  assert.equal(result.branch, 'factory/dev-add-sub-mul-2')
  assert.equal(github.state.opened[0]?.head, result.branch)
  assert.equal((await git(origin, 'rev-parse', 'refs/heads/factory/dev-add-sub-mul')).trim(), original)
  assert.equal((await git(origin, 'show', 'factory/dev-add-sub-mul-2:src/sub.ts')), sources.sub)
})

const budgetPrices = {
  'claude-opus-5-5': { input: 1000, cached_input: 100, cache_write: 1000, output: 1000 },
  'gpt-6.1-sol': { input: 1000, cached_input: 100, cache_write: 1000, output: 1000 },
}

/** A review pass that the test gives: it spends `usd` and stops at its budget when `stopped`. */
type ScriptedPass = { usd: number; stopped: boolean }

/** Runs the development workflow with a budget, and with review passes that the test gives in place of the review loop. */
async function runBudget(
  repo: string,
  runsDir: string,
  options: { runId: string; budget: number; channel: Channel; passes: ScriptedPass[]; requests: ReviewRequest[]; prices?: Prices; hotfix?: boolean },
) {
  withoutKey(repo)
  const github = fakePulls([true])
  const input = { ...(await developInput(repo, options.runId)), budget: options.budget, ...(options.hotfix ? { hotfix: true } : {}) }
  const deps = await nodeDevelop({
    channel: options.channel,
    ci: { pollMs: 10, startMs: 1_000, waitMs: 5_000 },
    credentials,
    dispatch: scriptedDispatch(developScript(), []),
    input,
    log: () => {},
    module,
    prices: options.prices ?? budgetPrices,
    pulls: github.pulls,
    repo,
    reviewChannel: async () => memoryChannel().channel,
    runsDir,
  })
  const review = async (request: ReviewRequest) => {
    options.requests.push(request)
    const pass = options.passes.shift()
    if (!pass) throw new Error('no scripted review pass left')
    const usage = { tokens: zeroTokens(), usd: pass.usd, unpriced: [] }
    const report = '- Triage: `TRIAGE path=full`'
    return { pass: !pass.stopped, criteria: [], branch: 'factory/review', final: request.head, report, usage, stopped: pass.stopped }
  }
  return { ...(await develop(input, { ...deps, review })), github }
}

test('develop: at twice the budget, the run posts the notice, asks with the run totals, and a stop ends it before the PR', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const { channel, posted, notices, events } = memoryChannel({ 'budget.1': '/answer\nQ1: stop' })
  const requests: ReviewRequest[] = []
  const result = await runBudget(repo, runsDir(), { runId: 'budget-stop', budget: 0.001, channel, passes: [], requests })
  assert.equal(result.status, 'stopped', result.report)
  const asked = posted.find((entry) => entry.batch.startsWith('budget.'))
  assert.ok(asked, JSON.stringify(posted.map((entry) => entry.batch)))
  assert.match(asked.questions[0]!.question, /of its budget of \$0\.0010\. Raise the budget or stop the run\?/)
  assert.match(asked.questions[0]!.recommendation, /^Raise the budget to \$0\.\d{2}$/)
  // The first agent turn spent more than twice the budget: the notice comes first, then one question.
  assert.deepEqual(events, ['notice', `post ${asked.batch}`])
  assert.match(notices[0] ?? '', /of its budget of \$0\.0010\. The run continues\./)
  assert.match(result.report, /Reason: cost budget\./)
  assert.match(result.report, /^Budget: \$0\.0010\. Spent: \$0\.\d{4}\.$/m)
  assert.equal(result.github.state.opened.length, 0)
  assert.equal(requests.length, 0)
})

test('develop: a stop in a build wave waits for a delayed task branch before pruning', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const input = await developInput(repo, 'wave-stop')
  const github = fakePulls()
  const deps = await nodeDevelop({
    channel: memoryChannel().channel,
    ci: { pollMs: 10, startMs: 1_000, waitMs: 5_000 },
    credentials,
    dispatch: scriptedDispatch(developScript(), []),
    input,
    log: () => {},
    module,
    pulls: github.pulls,
    repo,
    reviewChannel: async () => memoryChannel().channel,
    runsDir: runsDir(),
  })
  const created: string[] = []
  const probed: string[] = []
  let release = () => {}
  const createSibling = new Promise<void>((resolve) => { release = resolve })
  let stopped = () => {}
  const firstStopped = new Promise<void>((resolve) => { stopped = resolve })
  const running = develop(input, {
    ...deps,
    branches: {
      ...deps.branches,
      async branch(name, from) {
        if (name === 'factory/task-wave-stop-mul') await createSibling
        const branch = await deps.branches.branch(name, from)
        if (!name.startsWith('factory/task-wave-stop-')) return branch
        created.push(name)
        if (name === 'factory/task-wave-stop-sub') {
          stopped()
          throw new BudgetStop('stopped in a build wave')
        }
        throw new Error('sibling failed after the budget stop')
      },
      async exists(name) {
        if (name.startsWith('factory/task-wave-stop-')) probed.push(name)
        return deps.branches.exists(name)
      },
    },
  })
  await firstStopped
  await new Promise<void>((resolve) => setImmediate(resolve))
  const prematureProbes = [...probed]
  release()
  const result = await running

  assert.deepEqual(prematureProbes, [])
  assert.equal(result.status, 'stopped', result.report)
  assert.equal(result.pr, null)
  assert.deepEqual(created.sort(), ['factory/task-wave-stop-mul', 'factory/task-wave-stop-sub'])
  for (const task of ['sub', 'mul']) {
    const name = `factory/task-wave-stop-${task}`
    assert.equal(deps.ledger.get(`step:build.${task}`), undefined)
    await assert.rejects(git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`), name)
    assert.ok(result.report.includes(`- deleted ${name} (stranded)`), result.report)
  }
  assert.doesNotMatch(result.report, /deleted factory\/task-wave-stop-tests/)
  assert.equal(github.state.opened.length, 0)
})

test('develop: a review pass that stops at its budget is not recorded, and a resume with a higher budget runs it again', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  const { channel, posted, notices } = memoryChannel({ 'budget.1': '/answer\nQ1: stop' })
  const requests: ReviewRequest[] = []
  // The pass spends $250 of the remaining budget of about $200, up to twice the run budget. The development gate then
  // posts the notice and asks with the run totals.
  const first = await runBudget(repo, dir, { runId: 'budget-review', budget: 100, channel, passes: [{ usd: 250, stopped: true }], requests })
  assert.equal(first.status, 'stopped', first.report)
  assert.match(first.report, /^The run stopped at the cost budget: spent \$25\d\.\d{2} of \$100\.00\. Reason: cost budget\./m)
  assert.match(first.report, /^\| review\.1 \| review loop \| 0 \| 0 \| 0 \| 0 \| \$250\.00 \|$/m)
  const asked = posted.filter((entry) => entry.batch.startsWith('budget.'))
  assert.equal(asked.length, 1)
  assert.match(asked[0]!.questions[0]!.question, /^The run spent about \$25\d\.\d{2} of its budget of \$100\.00\./)
  assert.equal(notices.length, 1)
  assert.match(notices[0] ?? '', /The most expensive steps: review\.1 \$250\.00, /)
  // The review loop got what remains up to twice the run budget after the development agents.
  const firstBudget = requests[0]!.budget!
  assert.ok(firstBudget > 199 && firstBudget < 200, String(firstBudget))
  assert.equal(fileLedger(join(dir, 'budget-review', 'state.json')).get('step:review.1'), undefined)

  // The resumed run gets a higher budget. The same pass runs again, and its stopped attempt does not count two times.
  const second = await runBudget(repo, dir, { runId: 'budget-review', budget: 1000, channel, passes: [{ usd: 260, stopped: false }], requests })
  assert.equal(second.status, 'ready', second.report)
  assert.equal(requests.length, 2)
  assert.equal(requests[1]!.runId, requests[0]!.runId)
  assert.ok(Math.abs(requests[1]!.budget! - firstBudget - 1800) < 1e-6, String(requests[1]!.budget))
  assert.match(second.report, /^\| review\.1 \| review loop \| 0 \| 0 \| 0 \| 0 \| \$260\.00 \|$/m)
  assert.match(second.report, /^Budget: \$1000\.00\. Spent: \$26\d\.\d{2}\.$/m)
  assert.equal(posted.filter((entry) => entry.batch.startsWith('budget.')).length, 1)
  assert.equal(notices.length, 1)
})

test('develop: a hotfix run raises the budget at twice the budget with a notice, runs a stopped pass again, and ends ready', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const { channel, posted, notices } = memoryChannel()
  const requests: ReviewRequest[] = []
  const passes = [{ usd: 100, stopped: true }, { usd: 150, stopped: false }]
  const result = await runBudget(repo, runsDir(), { runId: 'budget-hotfix', budget: 0.01, channel, passes, requests, hotfix: true })
  assert.equal(result.status, 'ready', result.report)
  assert.equal(posted.filter((entry) => entry.batch.startsWith('budget.')).length, 0)
  // The development agents passed twice the first budget, and the stopped pass passed twice the raised budget.
  assert.match(notices.find((text) => /takes every recommendation/.test(text)) ?? '', /^The run spent about \$0\.0\d{3} of its budget of \$0\.0100\. The run takes every recommendation, so the host raised the budget to \$0\.0\d{3}, and the run continues\./)
  assert.match(notices.at(-1) ?? '', /^The run spent about \$10\d\.\d{2} of its budget of \$[\d.]+\. The run takes every recommendation, so the host raised the budget to \$20\d\.\d{2}, and the run continues\. The most expensive steps: review\.1 \$100\.00, /)
  assert.equal(requests.length, 2)
  assert.equal(requests[1]!.runId, requests[0]!.runId)
  assert.ok(requests[1]!.budget! > 300, String(requests[1]!.budget))
  assert.match(result.report, /^Budget: \$20\d\.\d{2}\. Spent: \$15\d\.\d{2}\.$/m)
})

test('develop: a budget with a configured model without a price stops the run before any work', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const requests: ReviewRequest[] = []
  await assert.rejects(
    runBudget(repo, runsDir(), { runId: 'budget-unpriced', budget: 5, channel: memoryChannel().channel, passes: [], requests, prices: { 'claude-opus-5-5': budgetPrices['claude-opus-5-5'] } }),
    (error: unknown) => error instanceof StopError && /no price for: gpt-6\.1-sol$/.test(error.message),
  )
  assert.equal(requests.length, 0)
})

test('develop: $0.20 of development and $0.70 of review post the notice and pause at a $0.45 budget, then resume after a raise', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  const runId = 'budget-round-off'
  const path = join(dir, runId, 'state.json')
  const free = { input: 0, cached_input: 0, cache_write: 0, output: 0 }
  const prices = { 'claude-opus-5-5': free, 'gpt-6.1-sol': free, prior: { ...free, input: 200_000 } }
  // Record $0.20 of prior development spend. New scripted calls have zero prices.
  recordUsage(fileLedger(path), 'prior', 'prior', [{
    seq: 0,
    request_id: 'prior',
    created_at: 0,
    event: { source: 'agent', event: { request_id: 'prior', seq: 1, type: 'model.call.completed', payload: { usage: { input_tokens: 1 } } } },
  }])
  const { channel, posted, replies, notices, events } = memoryChannel({ 'budget.1': null })
  const requests: ReviewRequest[] = []
  const options = { runId, budget: 0.45, channel, requests, prices }
  await assert.rejects(runBudget(repo, dir, { ...options, passes: [{ usd: 0.7, stopped: true }] }), PausedError)
  const asked = posted.filter((entry) => entry.batch.startsWith('budget.'))
  assert.equal(asked.length, 1)
  const question = asked[0]
  assert.ok(question)
  assert.match(question.questions[0]?.question ?? '', /spent about \$0\.9000 of its budget of \$0\.4500\./)
  assert.equal(question.questions[0]?.recommendation, 'Raise the budget to $1.80')
  // The round-off of $0.20 + $0.70 passes both thresholds in one step: one notice, then one question.
  assert.deepEqual(events, ['notice', `post ${question.batch}`])
  assert.match(notices[0] ?? '', /The most expensive steps: review\.1 \$0\.7000, prior \$0\.2000, /)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.budget, 0.7)
  assert.equal(fileLedger(path).get('step:review.1'), undefined)
  assert.equal(fileLedger(path).get('result'), undefined)
  // A pause is not the end of the run, so the development branch stays.
  assert.equal(fileLedger(path).get('prune'), undefined)
  await git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/factory/dev-add-sub-mul')

  replies[question.batch] = '/answer\nQ1: 1.2'
  const result = await runBudget(repo, dir, { ...options, passes: [{ usd: 0.7, stopped: false }] })
  assert.equal(result.status, 'ready', result.report)
  assert.equal(requests.length, 2)
  const resumed = requests[1]
  assert.ok(resumed && resumed.budget !== undefined)
  assert.ok(Math.abs(resumed.budget - 2.2) < 1e-12)
  assert.match(result.report, /^Budget: \$1\.20\. Spent: \$0\.9000\.$/m)
  assert.equal(posted.filter((entry) => entry.batch.startsWith('budget.')).length, 1)
  assert.equal(notices.length, 1)
})

test('Node branches: an origin error is not an absent branch', async () => {
  const { repo } = developRepo()
  await git(repo, 'remote', 'set-url', 'origin', join(repo, 'absent.git'))
  await assert.rejects(gitBranches(repo, runsDir()).exists('factory/dev-new'))
})

test('Node branches: a merge conflict aborts and leaves a clean worktree at the original head', async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  const branches = gitBranches(repo, dir)
  const target = await branches.branch('target', 'main')
  const source = await branches.branch('source', 'main')
  for (const branch of [target, source]) {
    await branch.tree.write('/src/math.ts', new TextEncoder().encode(`export const name = '${branch.name}'\n`))
    await branch.commit(`change ${branch.name}`)
  }
  const before = await target.head()
  await assert.rejects(target.merge(await source.head(), 'conflict'))
  assert.equal(await target.head(), before)
  const tree = worktreePath(dir, target.name)
  assert.equal(await git(tree, 'status', '--porcelain'), '')
  await assert.rejects(git(tree, 'rev-parse', '--verify', 'MERGE_HEAD'))
  assert.equal(readFileSync(join(tree, 'src/math.ts'), 'utf8'), "export const name = 'target'\n")
})

test('Node GitHub: failureLog returns a link when gh fails', async () => {
  const dir = runsDir()
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "log expired" >&2\nexit 1\n', { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ''}`
  try {
    const pulls = ghPullRequests(dir, 'main')
    const job = { name: 'CI', run: 12, url: 'https://ci.example/12', created: new Date().toISOString(), done: true, ok: false }
    assert.equal(await pulls.failureLog(job), 'No log: see https://ci.example/12 (gh run view: log expired)')
    assert.equal(await pulls.failureLog({ ...job, run: null }), 'No log: see https://ci.example/12')
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
  }
})

test('Node GitHub: merge calls the merge API at the head in one call, and a refusal of gh goes to the core step', async () => {
  const dir = runsDir()
  const calls = join(dir, 'calls')
  const gh = (script: string) => writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho "$*" >> "${calls}"\n${script}\n`, { mode: 0o755 })
  const logged = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean)
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ''}`
  try {
    const pulls = ghPullRequests(dir, 'main')
    gh(`printf '%s' '{"sha":"abc123","merged":true,"message":"Pull Request successfully merged"}'`)
    assert.deepEqual(await pulls.merge(9, { method: 'squash', sha: 'f00d' }), { merged: true, sha: 'abc123' })
    // The answer gives the merge commit, so no later call can turn a merged PR into a refusal.
    assert.deepEqual(logged(), ['api repos/{owner}/{repo}/pulls/9/merge --method PUT -f merge_method=squash -f sha=f00d'])

    gh(`printf '%s' '{"merged":false,"message":"Pull Request is not mergeable"}'`)
    assert.deepEqual(await pulls.merge(9, { method: 'merge', sha: 'f00d' }), { merged: false, reason: 'Pull Request is not mergeable', kind: 'other' })

    // gh gives the HTTP status only in its error text. A 409 is a stale refusal, a result and not an error.
    gh(`printf 'gh: Conflict (HTTP 409)' >&2\nexit 1`)
    assert.deepEqual(await pulls.merge(9, { method: 'merge', sha: 'f00d' }), {
      merged: false,
      reason: 'gh api repos/{owner}/{repo}/pulls/9/merge: gh: Conflict (HTTP 409)',
      kind: 'stale',
    })

    // A base branch that requires a merge queue: the API refuses, and the host never calls gh pr merge, which can queue the PR.
    gh(`printf 'gh: Changes must be made through the merge queue (HTTP 405)' >&2\nexit 1`)
    await assert.rejects(pulls.merge(9, { method: 'rebase', sha: 'f00d' }), {
      message: 'gh api repos/{owner}/{repo}/pulls/9/merge: gh: Changes must be made through the merge queue (HTTP 405)',
    })
    assert.deepEqual(logged().filter((line) => !line.startsWith('api ')), [])

    // A resumed run: GitHub refuses the merge of a PR that it already merged at the head, and the host reads the merge.
    gh(`case "$*" in *merge*) printf 'gh: Pull Request is not mergeable (HTTP 405)' >&2; exit 1;; esac
printf '%s' '{"merged":true,"merge_commit_sha":"abc123","head":{"sha":"f00d"}}'`)
    assert.deepEqual(await pulls.merge(9, { method: 'squash', sha: 'f00d' }), { merged: true, sha: 'abc123' })
    assert.deepEqual(logged().slice(-2), ['api repos/{owner}/{repo}/pulls/9/merge --method PUT -f merge_method=squash -f sha=f00d', 'api repos/{owner}/{repo}/pulls/9'])
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
  }
})
