import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { coreSections, freezePrereg } from '../src/core/prereg.ts'
import { StopError } from '../src/core/stop.ts'
import { defaultResearchModels, research } from '../src/core/workflows/research.ts'
import { worktreePath } from '../src/node/git.ts'
import { nodeResearch } from '../src/node/platform.ts'
import { fakePulls } from './support/develop.ts'
import { credentials, memoryChannel, module } from './support/fixture.ts'
import { archive, earlierPrereg, holdoutPrefix, notebook, prices, researchConfig, researchInput, researchScript, runResearch } from './support/research.ts'
import { scriptedDispatch, type Turn } from './support/scripted-model.ts'

const runsDir = () => mkdtempSync(join(tmpdir(), 'factory-research-runs-'))
const gitIn = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString()
const stops = (pattern: RegExp) => (error: unknown) => error instanceof StopError && pattern.test(error.message)
// The builder submits a blocked log, so these runs end at stage 5 before any push.
const blocked = researchScript({ blockBuilder: true })

test('research: each clean box is a new checkout at a new path, and only the last one stays', async () => {
  const { repo, base } = notebook()
  gitIn(repo, 'commit', '--allow-empty', '-m', 'next head')
  const head = gitIn(repo, 'rev-parse', 'HEAD').trim()
  const { channel } = memoryChannel()
  const deps = await nodeResearch({
    channel,
    credentials,
    input: researchInput(base, 'clean-box'),
    log: () => {},
    module,
    pulls: fakePulls().pulls,
    repo,
    reviewChannel: async () => channel,
    runsDir: runsDir(),
  })
  const first = await deps.cleanBox(base, 'calibrate.hyp-001.1')
  const location = await first.run('pwd', { env: [], timeoutMs: 10_000 })
  assert.equal(location.exit_code, 0)
  let tree = location.output.trim()

  for (const commit of [base, head, head]) {
    writeFileSync(join(tree, 'research/checklist.md'), 'changed\n')
    writeFileSync(join(tree, '.gitignore'), 'ignored\n')
    writeFileSync(join(tree, 'ignored'), 'output\n')
    writeFileSync(join(tree, 'untracked'), 'output\n')
    // The local platform ignores the key: the same key two times also gives a new checkout.
    const box = await deps.cleanBox(commit, `reproduce.${commit}`)
    assert.notEqual(box.id, first.id)
    const next = await box.run('pwd', { env: [], timeoutMs: 10_000 })
    assert.equal(next.exit_code, 0)
    // A new path, so that an output that depends on the path does not reproduce. The earlier checkout is gone.
    assert.notEqual(next.output.trim(), tree)
    assert.equal(existsSync(tree), false)
    tree = next.output.trim()
    assert.equal(gitIn(tree, 'rev-parse', 'HEAD').trim(), commit)
    assert.equal(gitIn(tree, 'status', '--porcelain', '--ignored'), '')
    // Real paths, because a temporary directory can be behind a symlink, as /var is on macOS.
    const worktrees = gitIn(repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))
    assert.deepEqual(worktrees.map((line) => realpathSync(line.slice('worktree '.length))).sort(), [realpathSync(repo), realpathSync(tree)].sort())
  }
})

test('research: intake with a cap, surveys through the egress, two generators, the pick, an approval with a rejection, and the freeze', { timeout: 120_000 }, async () => {
  const { repo, origin, base } = notebook()
  const runs = runsDir()
  const turns: Turn[] = []
  const web = archive()
  const { channel, posted } = memoryChannel({
    intake: '/answer\nQ1: a\nQ2: 40',
    pick: '/answer\nQ1: a, c',
    'approve.1': '/answer\nQ1: a\nQ2: The decision rules need a trials factor.',
  })
  const input = researchInput(base, 'r1')
  const { result, deps } = await runResearch(repo, runs, input, { channel, dispatch: scriptedDispatch(blocked, turns), fetch: web.fetch })

  assert.equal(result.status, 'blocked', result.report)
  assert.equal(result.branch, 'factory/research-r1')
  assert.deepEqual(
    posted.map((batch) => batch.batch),
    ['intake', 'pick', 'approve.1', 'approve.2'],
  )
  // The user confirmed the program and set the cap at intake.
  assert.equal(deps.ledger.get<{ limit: number }>('budget')?.limit, 40)

  // The surveyors fetched through the egress with the secret of the config. The holdout of the base commit refused the
  // holdout URL, although the working copy has a holdout without a refuse list.
  const surveyed = turns.filter((turn) => turn.role === 'surveyor' && turn.output !== null).map((turn) => turn.output).join('\n')
  assert.match(surveyed, /holdout refused: /)
  assert.doesNotMatch(surveyed, /HOLDOUT FETCHED/)
  assert.deepEqual(web.fetched.map((entry) => entry.url).sort(), ['https://archive.example.org/papers/catalogs', 'https://archive.example.org/papers/literature'])
  assert.ok(web.fetched.every((entry) => entry.key === 'token-1'))
  assert.ok(!web.fetched.some((entry) => entry.url.startsWith(holdoutPrefix)))
  // The literature surveyor fixed its rejected survey on the second try, and cites the artifact with a quote.
  assert.match(surveyed, /survey refused: /)
  assert.equal(deps.ledger.get('rejected:survey.1'), 1)
  assert.equal(deps.ledger.get('rejected:survey.2'), undefined)
  const literature = deps.ledger.get<{ result: { lens: string; claims: { location: string; evidence: string }[] } }>('step:survey.1')?.result
  assert.equal(literature?.lens, 'literature')
  assert.match(literature?.claims[0]?.location ?? '', /^artifact:[0-9a-f]{64}$/)
  assert.equal(literature?.claims[0]?.evidence, 'dwarf galaxies stay quiet')
  // The domain guide follows the role guide in the instructions.
  assert.match(turns.find((turn) => turn.role === 'surveyor')!.request, /METHOD GUIDE/)

  // The generators ran on two families. The merge removed the duplicate of codex.
  assert.deepEqual(turns.filter((turn) => turn.role === 'generator' && turn.output === null).map((turn) => turn.provider).sort(), ['claude', 'codex'])
  assert.deepEqual(posted[1]!.questions[0]!.options, ['hyp-001: Quiet dwarfs', 'hyp-002: Old streams', 'hyp-003: Hidden pairs', 'None'])

  // One preregistrar for each pick. The rejected prereg went back to its agent with the reason, in a new turn.
  const drafts = turns.filter((turn) => turn.role === 'preregistrar' && turn.output === null)
  assert.equal(drafts.length, 3)
  assert.match(drafts[2]!.request, /The user rejected your prereg of hyp-003\. Write it again\. The reason of the user: The decision rules need a trials factor\./)
  assert.ok(!drafts.some((turn) => turn.request.includes('prereg of hyp-002')))

  // The frozen files are on the run branch. hyp-001-v1.md existed, so hyp-001 got v2. The ledger has the hashes.
  assert.deepEqual(
    result.frozen.map((entry) => [entry.path, entry.version]),
    [
      ['prereg/hyp-001-v2.md', 2],
      ['prereg/hyp-003-v1.md', 1],
    ],
  )
  assert.equal(gitIn(repo, 'show', 'factory/research-r1:prereg/hyp-001-v1.md'), earlierPrereg)
  for (const entry of result.frozen) {
    const text = gitIn(repo, 'show', `${entry.commit}:${entry.path}`)
    assert.equal(createHash('sha256').update(text).digest('hex'), entry.sha256)
    assert.match(text, new RegExp(`## Holdout\n\nHoldout of ${entry.hypothesis}\\.`))
  }
  assert.equal(gitIn(repo, 'rev-parse', 'factory/research-r1'), `${result.frozen[1]!.commit}\n`)
  assert.deepEqual(deps.ledger.get('frozen'), result.frozen)

  // No push, and the working copy stays on main with its uncommitted holdout.
  assert.equal(execFileSync('git', ['--git-dir', origin, 'for-each-ref', '--format=%(refname)']).toString(), 'refs/heads/main\n')
  assert.equal(gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main\n')
  assert.equal(gitIn(repo, 'rev-parse', 'HEAD'), `${base}\n`)
  assert.equal(gitIn(repo, 'status', '--porcelain'), ' M research/holdout.json\n')

  // The blocked builder of hyp-001 ends the run at stage 5.
  assert.deepEqual([...new Set(turns.map((turn) => turn.role))].sort(), ['builder', 'generator', 'intake', 'preregistrar', 'surveyor'])
  assert.equal(turns.at(-1)!.role, 'builder')
  assert.match(result.report, /The analysis of hyp-001 is blocked: the analysis needs a catalog/)
  assert.match(result.report, /factory\/research-r1 \(local, not pushed\)/)
  assert.match(result.report, /prereg\/hyp-001-v2\.md: SHA-256 [0-9a-f]{64}/)
  assert.equal(readFileSync(join(deps.dir, 'report.md'), 'utf8'), result.report)

  // The same run ID resumes from the ledger and makes no model call.
  const again: Turn[] = []
  const second = await runResearch(repo, runs, input, { channel, dispatch: scriptedDispatch(blocked, again), fetch: web.fetch })
  assert.equal(again.length, 0)
  assert.deepEqual(second.result.frozen, result.frozen)

  // A frozen file that changed after the freeze stops the next resume before any turn.
  writeFileSync(join(worktreePath(join(deps.dir, 'branches'), 'factory/research-r1'), 'prereg/hyp-003-v1.md'), 'changed\n')
  await assert.rejects(
    runResearch(repo, runs, input, { channel, dispatch: scriptedDispatch(blocked, again), fetch: web.fetch }),
    stops(/the frozen prereg prereg\/hyp-003-v1\.md on factory\/research-r1 changed after the freeze/),
  )
  assert.equal(again.length, 0)
})

test('research: a Drop answer at the approval removes the hypothesis without a freeze or a new round', { timeout: 120_000 }, async () => {
  const { repo, base } = notebook()
  const turns: Turn[] = []
  const { channel, posted } = memoryChannel({ pick: '/answer\nQ1: a, c', 'approve.1': '/answer\nQ1: a\nQ2: c' })
  const { result } = await runResearch(repo, runsDir(), researchInput(base, 'drop'), { channel, dispatch: scriptedDispatch(blocked, turns) })

  assert.equal(result.status, 'blocked', result.report)
  assert.deepEqual(
    posted.map((batch) => batch.batch),
    ['intake', 'pick', 'approve.1'],
  )
  assert.deepEqual(
    result.frozen.map((entry) => entry.path),
    ['prereg/hyp-001-v2.md'],
  )
  assert.equal(turns.filter((turn) => turn.role === 'preregistrar' && turn.output === null).length, 2)
  assert.match(result.report, /Dropped at the approval: hyp-003/)
})

test('research: with the standing answers of the notebook, the run confirms, picks and approves the recommendations and posts no question', { timeout: 120_000 }, async () => {
  const { repo, base } = notebook({ config: { checks: { smoke: 'true' }, questions: 'recommended', research: researchConfig } })
  const { channel, posted } = memoryChannel({ intake: null, pick: null, 'approve.1': null })
  const { result } = await runResearch(repo, runsDir(), researchInput(base, 'standing'), { channel, dispatch: scriptedDispatch(blocked, []) })

  assert.equal(result.status, 'blocked', result.report)
  assert.deepEqual(posted, [])
  assert.deepEqual(
    result.frozen.map((entry) => entry.path),
    ['prereg/hyp-001-v2.md'],
  )
})

test('research: a fresh run creates the next version when the base has an identical prereg', { timeout: 120_000 }, async () => {
  const { repo } = notebook()
  const previous = await freezePrereg({
    hypothesis: 'hyp-001',
    sections: [...coreSections, 'Holdout'].map((name) => ({ name, text: `${name} of hyp-001.` })),
    known_recall: 0.9,
  })
  writeFileSync(join(repo, previous.path), previous.markdown)
  gitIn(repo, 'add', previous.path)
  gitIn(repo, 'commit', '-m', 'freeze earlier prereg')
  const base = gitIn(repo, 'rev-parse', 'HEAD').trim()
  const { channel } = memoryChannel({ pick: '/answer\nQ1: a' })
  const { result, deps } = await runResearch(repo, runsDir(), researchInput(base, 'identical-base'), {
    channel,
    dispatch: scriptedDispatch(blocked, []),
  })

  assert.equal(result.status, 'blocked', result.report)
  assert.equal(result.frozen.length, 1)
  const frozen = result.frozen[0]
  assert.ok(frozen)
  assert.equal(frozen.path, 'prereg/hyp-001-v2.md')
  assert.equal(frozen.version, 2)
  assert.notEqual(frozen.commit, base)
  assert.equal(gitIn(repo, 'rev-parse', `${frozen.commit}^`).trim(), base)
  assert.equal(gitIn(repo, 'show', `${frozen.commit}:${previous.path}`), previous.markdown)
  const text = gitIn(repo, 'show', `${frozen.commit}:${frozen.path}`)
  assert.match(text, /^# Prereg hyp-001 v2\n/)
  assert.equal(createHash('sha256').update(text).digest('hex'), frozen.sha256)
  assert.deepEqual(deps.ledger.get('frozen'), result.frozen)
})

test('research: a resume commits a prereg left in the worktree before it records the freeze', { timeout: 120_000 }, async () => {
  const { repo, base } = notebook()
  const runs = runsDir()
  const input = researchInput(base, 'freeze-interrupted')
  const { channel } = memoryChannel({ pick: '/answer\nQ1: a' })
  const deps = await nodeResearch({
    channel,
    credentials,
    dispatch: scriptedDispatch(blocked, []),
    env: { ARCHIVE_TOKEN: 'token-1' },
    fetch: archive().fetch,
    input,
    log: () => {},
    module,
    prices,
    pulls: fakePulls().pulls,
    repo,
    reviewChannel: async () => memoryChannel().channel,
    runsDir: runs,
  })
  await assert.rejects(
    research(input, {
      ...deps,
      branches: {
        ...deps.branches,
        async branch(name, from) {
          const branch = await deps.branches.branch(name, from)
          return { ...branch, async commit() { throw new Error('interrupted before freeze commit') } }
        },
      },
    }),
    /interrupted before freeze commit/,
  )
  const branch = 'factory/research-freeze-interrupted'
  const path = 'prereg/hyp-001-v2.md'
  const worktree = worktreePath(join(deps.dir, 'branches'), branch)
  const bytes = readFileSync(join(worktree, path))
  assert.equal(gitIn(repo, 'rev-parse', branch).trim(), base)
  assert.equal(deps.ledger.get('step:freeze.hyp-001'), undefined)
  assert.equal(deps.ledger.get('frozen'), undefined)

  const again: Turn[] = []
  const { result } = await runResearch(repo, runs, input, { channel, dispatch: scriptedDispatch(blocked, again) })
  assert.equal(result.status, 'blocked', result.report)
  // The resume makes no model call before the builder of stage 5.
  assert.deepEqual([...new Set(again.map((turn) => turn.role))], ['builder'])
  assert.equal(result.frozen.length, 1)
  const frozen = result.frozen[0]
  assert.ok(frozen)
  assert.equal(frozen.path, path)
  assert.equal(frozen.version, 2)
  assert.notEqual(frozen.commit, base)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), frozen.sha256)
  assert.equal(createHash('sha256').update(gitIn(repo, 'show', `${frozen.commit}:${path}`)).digest('hex'), frozen.sha256)
  assert.equal(gitIn(repo, 'rev-parse', branch).trim(), frozen.commit)
  assert.equal(gitIn(worktree, 'status', '--porcelain'), '')
})

test('research: the CLI module runs no command when a test imports it', async () => {
  const exit = process.exitCode
  await import('../src/node/research.ts')
  assert.equal(process.exitCode, exit)
})

test('research: the user stops the run at intake, so no surveyor runs and no branch exists', async () => {
  const { repo, base } = notebook()
  const turns: Turn[] = []
  const { channel } = memoryChannel({ intake: '/answer\nQ1: b' })
  const { result } = await runResearch(repo, runsDir(), researchInput(base, 'r2'), { channel, dispatch: scriptedDispatch(blocked, turns) })
  assert.equal(result.status, 'stopped')
  assert.equal(result.branch, null)
  assert.deepEqual([...new Set(turns.map((turn) => turn.role))], ['intake'])
  assert.match(result.report, /You stopped the run at intake\./)
  assert.equal(gitIn(repo, 'branch', '--list', 'factory/*'), '')
})

test('research: a missing egress secret and two generators of one family stop the run before the first turn', async () => {
  const { repo, base } = notebook()
  const turns: Turn[] = []
  const { channel } = memoryChannel()
  const dispatch = scriptedDispatch(blocked, turns)
  await assert.rejects(
    runResearch(repo, runsDir(), researchInput(base, 'r3'), { channel, dispatch, env: {} }),
    stops(/^egress: the secret ARCHIVE_TOKEN for archive\.example\.org is not set$/),
  )
  const opus = defaultResearchModels.intake
  const models = { ...defaultResearchModels, generators: [opus, opus] as [typeof opus, typeof opus] }
  await assert.rejects(runResearch(repo, runsDir(), researchInput(base, 'r4', { models }), { channel, dispatch }), stops(/both use claude/))
  assert.equal(turns.length, 0)
})

test('research: the run reads the config and the holdout from the base commit, not from the working copy', async () => {
  const uncommitted = { 'research/new-holdout.json': JSON.stringify({ refuse: [holdoutPrefix], targets: ['t'] }) }
  const moved = notebook({ config: { checks: { smoke: 'true' }, research: { ...researchConfig, holdout: 'research/new-holdout.json' } }, uncommitted })
  const { channel } = memoryChannel()
  const turns: Turn[] = []
  const dispatch = scriptedDispatch(blocked, turns)
  await assert.rejects(runResearch(moved.repo, runsDir(), researchInput(moved.base, 'r5'), { channel, dispatch }), stops(/^research\/new-holdout\.json at main: the file does not exist$/))
  const plain = notebook({ config: { checks: { smoke: 'true' } }, uncommitted: { '.agent-factory.json': JSON.stringify({ research: researchConfig }) } })
  await assert.rejects(runResearch(plain.repo, runsDir(), researchInput(plain.base, 'r6'), { channel, dispatch }), stops(/^\.agent-factory\.json at main has no research field$/))
  assert.equal(turns.length, 0)
})

test('research: a surveyor that fails the claim check two times stops the run and names its lens', async () => {
  const { repo, base } = notebook()
  const turns: Turn[] = []
  const { channel } = memoryChannel()
  await assert.rejects(
    runResearch(repo, runsDir(), researchInput(base, 'r7'), { channel, dispatch: scriptedDispatch(researchScript({ failLens: 'catalogs' }), turns) }),
    stops(/^the survey of lens "catalogs" failed its claim check 2 times$/),
  )
  assert.ok(!turns.some((turn) => turn.role === 'generator'))
  // The run stops at the second rejection, so no nudge turn asks for a survey that the host refuses.
  assert.ok(!turns.some((turn) => turn.request.includes('You ended the turn without calling submit_survey')))
})

test('research: parallel submits of a surveyor get no more than two tries', async () => {
  const { repo, base } = notebook()
  const turns: Turn[] = []
  const { channel } = memoryChannel()
  await assert.rejects(
    runResearch(repo, runsDir(), researchInput(base, 'r7p'), { channel, dispatch: scriptedDispatch(researchScript({ parallelLens: 'catalogs' }), turns) }),
    stops(/^the survey of lens "catalogs" failed its claim check 2 times$/),
  )
  assert.ok(!turns.some((turn) => turn.role === 'generator'))
})

test('research: the intake cap replaces --budget, and an unreadable cap or pick answer gets its question again', { timeout: 120_000 }, async () => {
  const { repo, base } = notebook()
  const { channel, posted } = memoryChannel({
    intake: '/answer\nQ1: a\nQ2: lots',
    'cap.2': '/answer\nQ1: 40',
    pick: '/answer\nQ1: I pick a and c',
    'pick.2': '/answer\nQ1: a',
  })
  const { result, deps } = await runResearch(repo, runsDir(), researchInput(base, 'r10', { budgetOverride: 100 }), { channel, dispatch: scriptedDispatch(blocked, []) })
  assert.equal(result.status, 'blocked', result.report)
  assert.deepEqual(
    posted.map((batch) => batch.batch),
    ['intake', 'cap.2', 'pick', 'pick.2', 'approve.1'],
  )
  assert.equal(posted[0]!.questions[1]!.recommendation, '100 USD')
  assert.match(posted[1]!.questions[0]!.why, /budget must be a positive number of USD, not "lots"/)
  assert.match(posted[3]!.questions[0]!.why, /names no hypothesis of this run: option i/)
  assert.equal(deps.ledger.get<{ limit: number }>('budget')?.limit, 40)
  assert.deepEqual(
    result.frozen.map((entry) => entry.hypothesis),
    ['hyp-001'],
  )

  const uncapped = memoryChannel({ intake: '/answer\nQ2: No cap', pick: '/answer\nQ1: None' })
  const second = await runResearch(repo, runsDir(), researchInput(base, 'r11', { budgetOverride: 100 }), { channel: uncapped.channel, dispatch: scriptedDispatch(blocked, []) })
  assert.equal(second.result.status, 'stopped')
  assert.equal(second.deps.ledger.get<{ limit?: number }>('budget')?.limit, undefined)
})

test('research: with no pick, or with no hypothesis, the run stops before any preregistrar', async () => {
  const { repo, base } = notebook()
  const turns: Turn[] = []
  const none = memoryChannel({ pick: '/answer\nQ1: None' })
  const picked = await runResearch(repo, runsDir(), researchInput(base, 'r8'), { channel: none.channel, dispatch: scriptedDispatch(blocked, turns) })
  assert.equal(picked.result.status, 'stopped')
  assert.match(picked.result.report, /You picked no hypothesis, so the run stopped after stage 3\./)
  const empty = memoryChannel()
  const generated = await runResearch(repo, runsDir(), researchInput(base, 'r9'), { channel: empty.channel, dispatch: scriptedDispatch(researchScript({ noHypotheses: true }), turns) })
  assert.equal(generated.result.status, 'stopped')
  assert.ok(!empty.posted.some((batch) => batch.batch === 'pick'))
  assert.ok(!turns.some((turn) => turn.role === 'preregistrar'))
  assert.equal(gitIn(repo, 'branch', '--list', 'factory/*'), '')
})
