import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PausedError } from '../src/core/questions.ts'
import { research, type ResearchDeps } from '../src/core/workflows/research.ts'
import { worktreePath } from '../src/node/git.ts'
import { nodeResearch } from '../src/node/platform.ts'
import { fakePulls } from './support/develop.ts'
import { credentials, memoryChannel, module } from './support/fixture.ts'
import { archive, notebook, prices, researchConfig, researchInput, researchScript, runResearch, type ResearchScriptOptions } from './support/research.ts'
import { scriptedDispatch, type Turn } from './support/scripted-model.ts'

const runsDir = () => mkdtempSync(join(tmpdir(), 'factory-research-runs-'))
const refs = (origin: string) => execFileSync('git', ['--git-dir', origin, 'for-each-ref', '--format=%(refname)']).toString()
const outputs = (turns: Turn[], role: string) =>
  turns
    .filter((turn) => turn.role === role && turn.output !== null)
    .map((turn) => turn.output)
    .join('\n')
const firstTurns = (turns: Turn[], role: string) => turns.filter((turn) => turn.role === role && turn.output === null)

/** One run on a notebook with the pick of hyp-001 only. `replies` adds channel replies. `files` gives the fixes of a review pass. */
async function dossierRun(runId: string, options: ResearchScriptOptions = {}, replies: Record<string, string> = {}, files?: Record<string, string>) {
  const { repo, origin, base } = notebook()
  const runs = runsDir()
  const turns: Turn[] = []
  const channel = memoryChannel({ pick: '/answer\nQ1: a', ...replies })
  const input = researchInput(base, runId)
  const run = await runResearch(repo, runs, input, {
    channel: channel.channel,
    dispatch: scriptedDispatch(researchScript(options), turns),
    ...(files ? { review: fixingReview(repo, files) } : {}),
  })
  return { ...run, repo, origin, runs, input, turns, channel }
}

/** A review pass that passes with one fix commit of `files` on a branch from the PR head. */
function fixingReview(repo: string, files: Record<string, string>): ResearchDeps['review'] {
  return async ({ runId, head }) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'factory-review-fix-')), 'tree')
    const branch = `factory/${runId}`
    execFileSync('git', ['worktree', 'add', '-q', '-b', branch, dir, head], { cwd: repo, stdio: 'pipe' })
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString()
    git('add', '-A')
    git('commit', '-q', '-m', 'review fix')
    const usage = { tokens: { input: 0, cached: 0, cache_write: 0, output: 0 }, usd: 0, unpriced: [] }
    return { pass: true, criteria: [], branch, final: git('rev-parse', 'HEAD').trim(), report: '- Triage: full', usage, stopped: false }
  }
}

const analyzeModule = (recall: number, rows: string) => `export const recall = ${recall}\nexport const rows = (command) => command + ' ${rows}'\n`

test('research: build, calibration with a fix round, vet, dossier, reproduction, push, PR and review', { timeout: 300_000 }, async () => {
  const run = await dossierRun('d1')
  const { result, deps, turns, origin, pulls } = run
  assert.equal(result.status, 'ready', result.report)
  const branch = 'factory/research-d1'

  // The first calibration failed (recall 0.5, threshold 0.9). The fix turn of the builder read the reason and the end of the output.
  assert.equal(firstTurns(turns, 'builder').length, 2)
  const built = outputs(turns, 'builder')
  assert.match(built, /0\.5/)
  assert.match(built, /known of hyp-001 in /)
  // The analyst cannot write outside analysis/hyp-001/.
  assert.match(outputs(turns, 'analyst'), /analyst write refused: /)
  assert.doesNotMatch(outputs(turns, 'analyst'), /ANALYST WRITE ALLOWED/)
  // One skeptic for each skeptic lens on claude, and the late skeptics on another family.
  assert.deepEqual(firstTurns(turns, 'skeptic').map((turn) => turn.provider), ['claude'])
  assert.deepEqual(firstTurns(turns, 'late-skeptic').map((turn) => turn.provider), ['codex'])
  // The conceded high objection went to the user before the dossier.
  const held = run.channel.posted.find((batch) => batch.batch === 'held.hyp-001.1')
  assert.deepEqual(held?.questions[0]?.options, ['Accept and continue', 'Stop the run'])

  // Each domain command output is in the run store with its command line as the source. The store keeps equal outputs one time.
  const commands = (await deps.egress.artifacts.list()).filter(({ meta }) => meta.labels?.hypothesis === 'hyp-001')
  assert.deepEqual(new Set(commands.map(({ meta }) => meta.labels?.command)), new Set(['known', 'inject', 'reproduce']))
  for (const { meta } of commands) assert.deepEqual(meta.source, { command: `node research/run.mjs ${meta.labels?.command} 'prereg/hyp-001-v2.md'` })
  // The reproduction ran on a clean checkout, not in the worktree of the run branch, and matched the calibration.
  const reproduce = commands.find(({ meta }) => meta.labels?.command === 'reproduce')
  const reproduced = new TextDecoder().decode((await deps.egress.artifacts.get(reproduce?.id ?? '')) ?? new Uint8Array())
  const cwd = /reproduce of hyp-001 in (.+)/.exec(reproduced)?.[1]
  assert.ok(cwd)
  assert.notEqual(cwd, worktreePath(join(deps.dir, 'branches'), branch))
  assert.match(result.report, /Reproduction at [0-9a-f]{12} \(output artifact [0-9a-f]{64}\): PASS/)

  // The pushed branch has the analysis, the analyst note and the dossier.
  const show = (path: string) => execFileSync('git', ['--git-dir', origin, 'show', `${branch}:${path}`]).toString()
  assert.match(show('analysis/hyp-001/analyze.mjs'), /export const recall = 0\.95/)
  assert.match(show('analysis/hyp-001/notes.md'), /known set only/)
  assert.match(show('dossier/hyp-001.md'), /hyp-001/)
  const measurement = commands.find(({ meta }) => meta.labels?.path === 'out/hyp-001/inject.txt')
  assert.ok(measurement)
  assert.equal(new TextDecoder().decode(await deps.egress.artifacts.get(measurement.id) ?? new Uint8Array()), 'inject rows')
  assert.match(show('dossier/hyp-001.md'), new RegExp(`artifact:${measurement.id}: "inject rows"`))
  assert.match(outputs(turns, 'skeptic'), /inject rows/)
  assert.match(outputs(turns, 'writer'), /inject rows/)
  // The output files of the domain commands stay out of the run branch.
  assert.doesNotMatch(execFileSync('git', ['--git-dir', origin, 'ls-tree', '-r', '--name-only', branch]).toString(), /^out\//m)

  // One draft PR, one review loop pass, then ready for review. The user merges.
  assert.equal(pulls.opened.length, 1)
  assert.equal(pulls.opened[0]?.head, branch)
  assert.equal(pulls.opened[0]?.title, 'Quiet dwarf galaxies')
  assert.match(pulls.opened[0]?.body ?? '', /dossier\/hyp-001\.md/)
  assert.match(pulls.opened[0]?.body ?? '', /\(RG1\)[\s\S]*\(RG10\)/)
  assert.equal(deps.ledger.get<{ result: { pass: boolean } }>('step:review.1')?.result.pass, true)
  assert.deepEqual(pulls.ready, [9])
  assert.deepEqual(pulls.merges, [])
  const report = readFileSync(join(deps.dir, 'report.md'), 'utf8')
  assert.equal(report, result.report)
  assert.match(report, /\(RG1\)[\s\S]*\(RG10\)/)
  assert.match(report, /https:\/\/github\.com\/acme\/app\/pull\/9/)

  // The same run ID resumes from the ledger and makes no model call.
  const again: Turn[] = []
  const second = await runResearch(run.repo, run.runs, run.input, { channel: run.channel.channel, dispatch: scriptedDispatch(researchScript(), again) })
  assert.equal(second.result.status, 'ready', second.result.report)
  assert.equal(again.length, 0)
})

for (const phase of ['analyst', 'dossier'] as const) {
  test(`research: a resume skips completed ${phase} scope checks and checks each unfinished commit`, { timeout: 600_000 }, async () => {
    const { repo, base } = notebook()
    const input = researchInput(base, `${phase}-interrupted`)
    const commitKey = (id: string) => phase === 'analyst' ? `step:commit.${id}.1` : `step:dossier.${id}`
    const turns: Turn[] = []
    const { channel } = memoryChannel({ pick: '/answer\nQ1: a, b' })
    const pulls = fakePulls()
    const deps = await nodeResearch({
      channel,
      credentials,
      dispatch: scriptedDispatch(researchScript(), turns),
      env: { ARCHIVE_TOKEN: 'token-1' },
      fetch: archive().fetch,
      input,
      log: () => {},
      module,
      prices,
      pulls: pulls.pulls,
      repo,
      reviewChannel: async () => memoryChannel().channel,
      runsDir: runsDir(),
    })
    await assert.rejects(
      research(input, {
        ...deps,
        branches: {
          ...deps.branches,
          async branch(name, from) {
            const branch = await deps.branches.branch(name, from)
            return {
              ...branch,
              async commit(message) {
                if (message.includes(phase === 'analyst' ? 'analyst changes to hyp-002' : 'dossier hyp-002')) throw new Error(`interrupted before ${phase} commit`)
                return branch.commit(message)
              },
            }
          },
        },
      }),
      new RegExp(`interrupted before ${phase} commit`),
    )
    const committed = deps.ledger.get(commitKey('hyp-001'))
    assert.ok(committed)
    assert.equal(deps.ledger.get(commitKey('hyp-002')), undefined)
    const branch = await deps.branches.branch(`factory/research-${input.runId}`, base)
    assert.deepEqual((await branch.pending()).changed, [phase === 'analyst' ? 'analysis/hyp-002/notes.md' : 'dossier/hyp-002.md'])

    const outside = join(worktreePath(join(deps.dir, 'branches'), branch.name), 'analysis/hyp-001/unexpected.md')
    writeFileSync(outside, 'An unrelated change.\n')
    const blocked = await research(input, deps)
    assert.equal(blocked.status, 'blocked', blocked.report)
    assert.match(blocked.report, phase === 'analyst'
      ? /After the analyst round 1 of hyp-002, changes outside analysis\/hyp-002\/ are uncommitted: analysis\/hyp-001\/unexpected\.md/
      : /Before the dossier of hyp-002, the run branch has uncommitted changes: analysis\/hyp-001\/unexpected\.md/)
    assert.equal(deps.ledger.get(commitKey('hyp-002')), undefined)
    assert.deepEqual(pulls.state.opened, [])
    rmSync(outside)

    const result = await research(input, deps)
    assert.equal(result.status, 'ready', result.report)
    assert.deepEqual(deps.ledger.get(commitKey('hyp-001')), committed)
    assert.ok(deps.ledger.get(commitKey('hyp-002')))
    assert.equal(firstTurns(turns, 'analyst').length, 2)
    assert.equal(firstTurns(turns, 'writer').length, 2)
    assert.deepEqual(await branch.pending(), { diff: '', changed: [], removed: [] })
    assert.deepEqual(pulls.state.ready, [9])
  })
}

test('research: a second failed calibration blocks the run before the push', { timeout: 120_000 }, async () => {
  const { result, origin, pulls, turns } = await dossierRun('d2', { lowRecall: true })
  assert.equal(result.status, 'blocked', result.report)
  assert.match(result.report, /Calibration round 2 of hyp-001 failed \(known recall 0\.6, threshold 0\.9\)/)
  assert.match(result.report, /\(local, not pushed\)/)
  assert.ok(!turns.some((turn) => turn.role === 'skeptic'))
  assert.equal(refs(origin), 'refs/heads/main\n')
  assert.deepEqual(pulls.opened, [])
})

test('research: a reproduction that gives other hashes blocks the run before the push', { timeout: 120_000 }, async () => {
  const { result, origin, pulls } = await dossierRun('d3', { unstable: true })
  assert.equal(result.status, 'blocked', result.report)
  assert.match(result.report, /The reproduction on a clean checkout of [0-9a-f]{12} failed/)
  assert.match(result.report, /out\/hyp-001\/known\.txt: expected [0-9a-f]{64}, reproduce gave [0-9a-f]{64}/)
  assert.equal(refs(origin), 'refs/heads/main\n')
  assert.deepEqual(pulls.opened, [])
})

test('research: the user stops the run at a conceded objection, so no dossier exists', { timeout: 120_000 }, async () => {
  const { result, origin, turns } = await dossierRun('d4', {}, { 'held.hyp-001.1': '/answer\nQ1: b' })
  assert.equal(result.status, 'stopped', result.report)
  assert.match(result.report, /You stopped the run at the conceded objections obj-001 of hyp-001, before the dossier\./)
  assert.ok(!turns.some((turn) => turn.role === 'writer'))
  assert.equal(refs(origin), 'refs/heads/main\n')
})

test('research: the host asks again when the answer to a held objection chooses no option', { timeout: 120_000 }, async () => {
  const replies = { 'held.hyp-001.1': '/answer\nQ1: do not continue', 'held.hyp-001.1.obj-001.2': '/answer\nQ1: b' }
  const { result, channel, turns } = await dossierRun('d5', {}, replies)
  assert.equal(result.status, 'stopped', result.report)
  assert.ok(channel.posted.some((batch) => batch.batch === 'held.hyp-001.1.obj-001.2'))
  assert.ok(!turns.some((turn) => turn.role === 'writer'))
})

test('research: review fixes in analysis/ get a new calibration and reproduction, then the PR is ready', { timeout: 300_000 }, async () => {
  const { result, pulls, origin } = await dossierRun('d6', {}, {}, { 'analysis/hyp-001/README.md': 'The analysis of hyp-001.\n' })
  assert.equal(result.status, 'ready', result.report)
  assert.match(result.report, /fixes from factory\/d6-review-1/)
  assert.match(result.report, /Calibration round 4 at [0-9a-f]{12}: PASS/)
  assert.equal(result.report.match(/Reproduction at [0-9a-f]{12} \(output artifact [0-9a-f]{64}\): PASS/g)?.length, 2)
  assert.match(execFileSync('git', ['--git-dir', origin, 'show', 'factory/research-d6:analysis/hyp-001/README.md']).toString(), /hyp-001/)
  assert.deepEqual(pulls.ready, [9])
})

const heldStopCases: [string, Record<string, string>, string[]][] = [
  ['batch stop', { 'held.hyp-001.1': '/answer\nQ1: invalid\nQ2: b' }, []],
  ['first stop', { 'held.hyp-001.1': '/answer\nQ1: b\nQ2: invalid' }, []],
  ['retry stop', { 'held.hyp-001.1': '/answer\nQ1: invalid\nQ2: invalid', 'held.hyp-001.1.obj-001.2': '/answer\nQ1: b' }, ['held.hyp-001.1.obj-001.2']],
]
for (const [name, replies, retries] of heldStopCases) {
  test(`research: ${name} ends the run before other held-answer retries`, { timeout: 120_000 }, async () => {
    const { result, channel, turns, pulls } = await dossierRun(name.replaceAll(' ', '-'), { twoObjections: true }, replies)
    assert.equal(result.status, 'stopped', result.report)
    assert.deepEqual(channel.posted.filter(({ batch }) => batch.startsWith('held.hyp-001.1.')).map(({ batch }) => batch), retries)
    assert.ok(!turns.some((turn) => turn.role === 'writer'))
    assert.deepEqual(pulls.opened, [])
  })
}

for (const change of ['remove', 'replace'] as const) {
  test(`research: calibration fails when a command ${change}s its declared output`, { timeout: 120_000 }, async () => {
    const command = change === 'remove' ? 'rm out/hyp-001/inject.txt' : 'printf changed > out/hyp-001/inject.txt'
    const { repo, origin, base } = notebook({ config: {
      checks: { smoke: 'true' },
      research: { ...researchConfig, commands: { ...researchConfig.commands, inject: `${researchConfig.commands.inject}; ${command}` } },
    } })
    const { channel } = memoryChannel({ pick: '/answer\nQ1: a' })
    const { result, pulls } = await runResearch(repo, runsDir(), researchInput(base, `output-${change}`), {
      channel,
      dispatch: scriptedDispatch(researchScript(), []),
    })
    assert.equal(result.status, 'blocked', result.report)
    assert.match(result.report, /Calibration round 2 of hyp-001 failed/)
    assert.match(result.report, /inject output out\/hyp-001\/inject\.txt:/)
    assert.match(result.report, change === 'remove' ? /No such file or directory/ : /the file does not match SHA-256/)
    assert.deepEqual(pulls.opened, [])
    assert.equal(refs(origin), 'refs/heads/main\n')
  })
}

test('research: a calibration that pauses on inject keeps the known outputs of the earlier call', { timeout: 300_000 }, async () => {
  const { repo, base } = notebook()
  const input = researchInput(base, 'paused-inject')
  const deps = await nodeResearch({
    channel: memoryChannel({ pick: '/answer\nQ1: a' }).channel,
    credentials,
    dispatch: scriptedDispatch(researchScript(), []),
    env: { ARCHIVE_TOKEN: 'token-1' },
    fetch: archive().fetch,
    input,
    log: () => {},
    module,
    prices,
    pulls: fakePulls().pulls,
    repo,
    reviewChannel: async () => memoryChannel().channel,
    runsDir: runsDir(),
  })
  // As the job ledger on Cloudflare: a replay gets the recorded result of a command and does not run it again.
  const jobs = new Map<string, { exit_code: number | null; output: string }>()
  let paused = false
  const cleanBox = deps.cleanBox.bind(deps)
  deps.cleanBox = async (commit, key) => {
    const box = await cleanBox(commit, key)
    return {
      ...box,
      copyId: key,
      async run(command, options) {
        const recorded = jobs.get(`${key} ${command}`)
        if (recorded) return recorded
        if (key === 'calibrate.hyp-001.2' && command.includes(' inject ') && !paused) {
          paused = true
          // inject changes the known output, and the call ends before inject does.
          await box.run('printf changed > out/hyp-001/known.txt', options)
          throw new PausedError('waiting for the inject job')
        }
        const result = await box.run(command, options)
        jobs.set(`${key} ${command}`, result)
        return result
      },
    }
  }
  await assert.rejects(research(input, deps), PausedError)
  const result = await research(input, deps)
  assert.equal(result.status, 'ready', result.report)
  assert.ok(paused)
  assert.doesNotMatch(result.report, /does not match SHA-256|No such file/)
  assert.match(result.report, /Calibration round 2 at [0-9a-f]{12}: PASS/)
})

test('research: a replacement checkout reruns known before inject consumes its output', { timeout: 300_000 }, async () => {
  const { repo, base } = notebook({ config: {
    research: { ...researchConfig, commands: {
      ...researchConfig.commands,
      inject: `test -f out/hyp-001/known.txt && ${researchConfig.commands.inject}`,
    } },
  } })
  const input = researchInput(base, 'replaced-inject')
  const deps = await nodeResearch({
    channel: memoryChannel({ pick: '/answer\nQ1: a' }).channel,
    credentials,
    dispatch: scriptedDispatch(researchScript(), []),
    env: { ARCHIVE_TOKEN: 'token-1' },
    fetch: archive().fetch,
    input,
    log: () => {},
    module,
    prices,
    pulls: fakePulls().pulls,
    repo,
    reviewChannel: async () => memoryChannel().channel,
    runsDir: runsDir(),
  })
  const jobs = new Map<string, { exit_code: number | null; output: string }>()
  let generation = 0
  let knownRuns = 0
  const cleanBox = deps.cleanBox.bind(deps)
  deps.cleanBox = async (commit, key) => {
    const box = await cleanBox(commit, key)
    const copyId = `${key}@${generation}`
    return {
      ...box,
      copyId,
      async run(command, options) {
        const jobKey = `${copyId} ${command}`
        const recorded = jobs.get(jobKey)
        if (recorded) return recorded
        if (key === 'calibrate.hyp-001.2') {
          if (command.includes(' known ')) knownRuns++
          if (command.includes(' inject ') && generation === 0) throw new PausedError('waiting for the inject job')
        }
        const result = await box.run(command, options)
        jobs.set(jobKey, result)
        return result
      },
    }
  }
  await assert.rejects(research(input, deps), PausedError)
  assert.equal(knownRuns, 1)
  generation++
  const result = await research(input, deps)
  assert.equal(result.status, 'ready', result.report)
  assert.equal(knownRuns, 2)
  assert.match(result.report, /Calibration round 2 at [0-9a-f]{12}: PASS/)
})

test('research: a review fix outside analysis/ fails the run and the PR stays draft', { timeout: 300_000 }, async () => {
  const { result, pulls } = await dossierRun('d7', {}, {}, { 'research/run.mjs': 'process.exit(1)\n' })
  assert.equal(result.status, 'failed', result.report)
  assert.match(result.report, /The review loop changed paths outside analysis\/: research\/run\.mjs/)
  assert.deepEqual(pulls.ready, [])
})

test('research: a failed calibration after the review fixes fails the run and the PR stays draft', { timeout: 300_000 }, async () => {
  const { result, pulls } = await dossierRun('d8', {}, {}, { 'analysis/hyp-001/analyze.mjs': analyzeModule(0.1, 'rows') })
  assert.equal(result.status, 'failed', result.report)
  assert.match(result.report, /Calibration round 4 of hyp-001 failed \(known recall 0\.1, threshold 0\.9\).* after the review fixes/)
  assert.deepEqual(pulls.ready, [])
})

test('research: review fixes that change the outputs of the dossier keep the PR draft', { timeout: 300_000 }, async () => {
  const { result, pulls } = await dossierRun('d9', {}, {}, { 'analysis/hyp-001/analyze.mjs': analyzeModule(0.95, 'new rows') })
  assert.equal(result.status, 'failed', result.report)
  assert.match(result.report, /the calibration of hyp-001 gives another known recall or other output hashes than dossier\/hyp-001\.md cites/)
  assert.deepEqual(pulls.ready, [])
})

test('research: a recall-only review fix keeps the PR draft on resume', { timeout: 300_000 }, async () => {
  const { result, pulls, input, deps, turns } = await dossierRun('recall-resume', {}, {}, { 'analysis/hyp-001/analyze.mjs': analyzeModule(0.96, 'rows') })
  assert.equal(result.status, 'failed', result.report)
  assert.match(result.report, /another known recall or other output hashes/)
  const count = turns.length
  const calibration = deps.ledger.get('step:calibrate.hyp-001.4')
  assert.ok(calibration)

  const resumed = await research(input, deps)
  assert.equal(resumed.status, 'failed', resumed.report)
  assert.match(resumed.report, /another known recall or other output hashes/)
  assert.deepEqual(deps.ledger.get('step:calibrate.hyp-001.4'), calibration)
  assert.equal(deps.ledger.get('step:calibrate.hyp-001.5'), undefined)
  assert.equal(turns.length, count)
  assert.deepEqual(pulls.ready, [])
})
