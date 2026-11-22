import type { Contracts } from 'nanocode-ts'
import type { FileSystem } from 'nanocode-ts/bash'
import { runTurn, submitOnce, type AgentHost, type AgentSpec, type HostTools } from './agent.ts'
import { callRunTests, checkTails, failureText, isProtected, runChecksTool, runTestsTool, targetedTests, type CheckResult, type RepoConfig } from './checks.ts'
import { assignIds, checkFindings, parseLocation, submitFindings, type Finding } from './findings.ts'
import { step } from './ledger.ts'
import { maxTaskTurns, minCommandMs, PlannedStop, settleAll } from './planned-stop.ts'
import type { Checker, Frozen, Guides, Repo } from './platform.ts'
import { checkQuestions, decisionsFile, decisionsLine, submitQuestions, type Question } from './questions.ts'
import { instructions, reviewRoles, type ModelChoice, type Role } from './roles.ts'
import { bugsShards, diffFiles, diffOf, fileOwners, patchGroups, type PatchGroup } from './split.ts'
import { allowFiles, createWorkspace, fileHash, guard, readOnly, recordEdits } from './workspace.ts'

/** What every step of one review run shares. */
export type RunContext = {
  host: AgentHost
  repo: Repo
  frozen: Frozen
  config: RepoConfig
  ask: string
  stack: string
  /** The guides of the profiles that govern the changed files. */
  stackGuides: string[]
  guides: Guides
  tests: Checker['tests']
  /** The run_checks of the editing agents, where the platform has a machine for agents. */
  agentChecks?: Checker['agentChecks']
  /** The ci commands of the submit gates, where the config has them and the platform has a machine (D15). */
  ci?: Checker['ci']
}

export type Range = { from: string; to: string }

function testTools(context: RunContext, role: Role): HostTools {
  const run = context.tests
  if (!role.tests || !context.config.tests || !run) return {}
  return { run_tests: { definition: runTestsTool, call: (input) => callRunTests(context.repo, context.config, run, input) } }
}

/** Said to an agent whose role runs tests when the run has no test runner, as on Cloudflare, where CI is the only test run. */
export const noTestRunner =
  'This run has no run_tests tool. CI runs the tests after the host commits your change. Do not try to run tests in the shell: it cannot run them. A test that you add or change must follow the setup and the patterns of the tests around it, because nothing runs it before CI.'

function spec(context: RunContext, id: string, role: Role, model: ModelChoice, workspace: Contracts.WorkspaceHost, tools: HostTools): AgentSpec {
  const tests = testTools(context, role)
  const base = instructions(role, { read: context.guides.read, stackGuides: context.stackGuides })
  return {
    id,
    ...model,
    instructions: role.tests && !tests.run_tests ? `${base}\n\n${noTestRunner}` : base,
    tools: { ...tools, ...tests },
    workspace,
    turnMs: role.turnMs,
  }
}

/** The start of the reviewed changes: `from` when a pass reviews only the changes after an earlier pass (D22). */
export const reviewedFrom = (frozen: Frozen) => frozen.from ?? frozen.base

async function reviewInputs(context: RunContext, range: Range) {
  const patch = await context.repo.diff(range.from, range.to)
  const changed = await context.repo.changedFiles(range.from, range.to)
  const files = { '/ask.md': context.ask, '/diff.patch': patch, '/changed-files.txt': changed.join('\n'), ...decisionsFile(context.host.ledger) }
  return { patch, changed, files }
}

/** Reviewers read the tree as it is, through the same rails as their workspace. */
const reviewTree = (context: RunContext) => readOnly(guard(context.repo.tree))

function treeReader(context: RunContext) {
  const fs = reviewTree(context)
  return async (path: string) => {
    try {
      return new TextDecoder().decode(await fs.read(`/${path}`))
    } catch {
      return null
    }
  }
}

/** The files of one reviewer when the host splits a review, and the count of files in the whole diff. */
export type Share = { files: string[]; of: number }

/**
 * One read-only reviewer on one diff, or on its share of the files of the diff. Returns the findings that passed
 * the evidence check. The check accepts quotes from the whole diff, because a bug can be in how two files work together.
 */
export async function review(context: RunContext, id: string, role: Role, model: ModelChoice, range: Range, note: string, share?: Share): Promise<Finding[]> {
  if (!role.findings) throw new Error(`${role.id} is not a reviewer`)
  const { track, prefix } = role.findings
  const inputs = await reviewInputs(context, range)
  const files = share ? { ...inputs.files, '/diff.patch': diffOf(inputs.patch, share.files), '/full-diff.patch': inputs.patch } : inputs.files
  const workspace = await createWorkspace({ repo: reviewTree(context), review: files, guides: context.guides.mounts })
  const read = treeReader(context)
  const tools = submitOnce(context.host, `output:${id}`, submitFindings, async (input) => {
    const checked = await checkFindings(input, { read, diff: inputs.patch })
    if (checked.errors.length > 0) throw new Error(`rejected:\n${checked.errors.join('\n')}`)
    return assignIds(checked.findings, track, prefix)
  })
  const prompt = [
    'Review this change.',
    '',
    '- Original ask: /review/ask.md',
    ...decisionsLine(inputs.files),
    `- Diff: /review/diff.patch, from ${range.from.slice(0, 12)} to ${range.to.slice(0, 12)}`,
    `- Changed files: /review/changed-files.txt (${inputs.changed.length} files)`,
    ...(share
      ? [
          `- Your files, ${share.files.length} of the ${share.of} files of the change: ${share.files.join(', ')}. /review/diff.patch holds only these files.`,
          '- Other reviewers of your track review the other files at the same time. The whole diff is in /review/full-diff.patch: read it only where your files use other changed code.',
        ]
      : []),
    `- Stack: ${context.stack}`,
    ...(note ? ['', note] : []),
    '',
    'Call submit_findings one time with every finding, or with an empty list. Then reply "done".',
  ].join('\n')
  return runTurn(context.host, spec(context, id, role, model, workspace, tools), prompt, 'submit_findings')
}

/**
 * A review that the host splits across reviewers of one role when the diff is large (`bugsShards`). The reviewers
 * run at the same time, each on its share of the files, and the host numbers their findings as one list. A small
 * diff gets one reviewer.
 */
export async function splitReview(context: RunContext, id: string, role: Role, model: ModelChoice, range: Range, note: string): Promise<Finding[]> {
  if (!role.findings) throw new Error(`${role.id} is not a reviewer`)
  const diff = await context.repo.diff(range.from, range.to)
  const shares = bugsShards(diff)
  if (shares.length === 1) return review(context, id, role, model, range, note)
  const of = diffFiles(diff).length
  context.host.log(`${id}: ${shares.length} reviewers at the same time, with ${shares.map((files) => files.length).join(', ')} files`)
  const found = await settleAll(
    shares.map((files, index) => step(context.host.ledger, `${id}.${index + 1}`, () => review(context, `${id}.${index + 1}`, role, model, range, note, { files, of }))),
  )
  const { track, prefix } = role.findings
  return assignIds(
    found.flat().map(({ id: _id, track: _track, ...finding }) => finding),
    track,
    prefix,
  )
}

export type PatchLog = { applied: { id: string; change: string }[]; skipped: { id: string; reason: string }[] }
/** The log of one patch agent among several: a finding that needs a file of another agent waits for one more agent. */
export type GroupLog = PatchLog & { deferred: { id: string; reason: string }[] }
export type PatchOutcome<Log extends PatchLog = PatchLog> = {
  before: string
  after: string
  changed: boolean
  log: Log | null
  outOfScope: string[]
  /** When the host split the findings: the count of patch agents that worked at the same time, and the findings that waited for one more agent. */
  split?: { agents: number; deferred: string[] }
  /** For the report, when the targeted tests of an agent did not run at its submit, or when its gate ran again after a cut (D12). */
  note?: string
}

const editsKey = (id: string) => `edits:${id}`
const originalsKey = (id: string) => `originals:${id}`
const untestedKey = (id: string) => `untested:${id}`
const cutKey = (id: string, turn: number) => `cut:${id}:${turn}`
const regatedKey = (id: string) => `regated:${id}`

const setupFailedNote = 'targeted tests did not run: the setup failed'
const regateNote = 'the gate ran again after the end of a call stopped it'

/** The writable tree of one editing agent, which records the paths that the agent changes and their first content. */
const editTree = (context: RunContext, id: string, tree: FileSystem.FileSystem) => recordEdits(tree, context.host.ledger, editsKey(id), originalsKey(id))

/** The recorded edits of an agent whose content is not the content before its first change. */
async function netEdits(context: RunContext, id: string): Promise<string[]> {
  const kept = context.host.ledger.get<Record<string, string | null>>(originalsKey(id)) ?? {}
  const paths: string[] = []
  for (const path of context.host.ledger.get<string[]>(editsKey(id)) ?? [])
    if (!(path in kept) || (await fileHash(context.repo.tree, `/${path}`)) !== kept[path]) paths.push(path)
  return paths
}

/** The recorded edits of an agent that still exist in the tree. */
async function existingEdits(context: RunContext, id: string): Promise<string[]> {
  const paths: string[] = []
  for (const path of context.host.ledger.get<string[]>(editsKey(id)) ?? []) if ((await context.repo.tree.stat(`/${path}`)) !== null) paths.push(path)
  return paths
}

/** run_checks for an editing agent: the files changed since the freeze base, and the edits of the agent. */
function checkTools(context: RunContext, id: string): HostTools {
  const run = context.agentChecks
  if (!run) return {}
  return {
    run_checks: {
      definition: runChecksTool('the files that the change and your edits changed'),
      async call() {
        const { repo, frozen } = context
        const changed = [...new Set([...(await repo.changedFiles(frozen.base, await repo.head())), ...(await existingEdits(context, id))])]
        return checkTails(await run(changed))
      },
    },
  }
}

/** The gate text of the prompt of an editing agent, when its submit runs the targeted tests or the ci commands. */
function gateText(context: RunContext): string[] {
  const tests = context.tests !== null && Boolean(context.config.tests)
  if (!tests && !context.ci) return []
  const runs = [...(tests ? ['the targeted tests of the files that you changed'] : []), ...(context.ci ? ['the ci commands of the repository'] : [])]
  return [`When you submit, the host runs ${runs.join(', then ')}, and refuses the log while one fails.`]
}

const gateFix = 'Fix the cause and submit again. When you cannot fix it, revert your edit and list the finding in skipped with the reason.'

/** The result of the gate of an editing agent. A cut is a stop at the end of the alarm call, not a failure (D12). */
type SubmitGate = { status: 'pass' } | { status: 'cut'; what: string } | { status: 'fail'; text: string }

/**
 * The gate at the submit of an editing agent: the targeted tests of only the files that this agent changed, also its
 * new test files, then the ci commands on these files (D15). A reverted edit does not count. A failed setup runs no
 * command, so the host accepts the log and records the note. With `cuts`, a command with no exit code while the call
 * has less than `minCommandMs` left is a cut. The re-gate runs without `cuts`, so there it is a failure.
 */
async function testGate(context: RunContext, id: string, cuts: boolean): Promise<SubmitGate> {
  const { tests, config, ci } = context
  const pass: SubmitGate = { status: 'pass' }
  const edits = await netEdits(context, id)
  if (edits.length === 0) return pass
  const existing: string[] = []
  for (const path of edits) if ((await context.repo.tree.stat(`/${path}`)) !== null) existing.push(path)
  const recordUntested = (failed: CheckResult[]) => {
    if (!failed.some((result) => result.name === 'setup')) return false
    context.host.ledger.put(untestedKey(id), true)
    return true
  }
  const cut = (failed: CheckResult[]) => {
    const left = cuts ? context.host.ledger.timeLeft?.() : undefined
    return left !== undefined && left < minCommandMs && failed.some((result) => result.exit_code === null)
  }
  if (tests && config.tests) {
    const pattern = new RegExp(config.tests.pattern)
    const added = existing.filter((path) => pattern.test(path))
    const targeted = [...new Set([...(await targetedTests(context.repo, config, edits)), ...added])]
    const failed = targeted.length === 0 ? [] : (await tests(targeted)).filter((result) => result.status !== 'pass')
    if (cut(failed)) return { status: 'cut', what: 'the targeted tests' }
    if (recordUntested(failed)) return pass
    if (failed.length > 0) return { status: 'fail', text: [`the targeted tests of your edits failed (${targeted.join(', ')}). ${gateFix}`, ...failureText(failed)].join('\n') }
  }
  if (!ci) return pass
  // A skipped {files} command is not a failure.
  const failed = (await ci(existing)).filter((result) => result.status === 'fail')
  if (failed.length === 0) return pass
  if (cut(failed)) return { status: 'cut', what: 'the ci commands' }
  if (recordUntested(failed)) return pass
  return { status: 'fail', text: [`the ci commands failed (${failed.map((result) => result.name).join(', ')}). ${gateFix}`, ...failureText(failed)].join('\n') }
}

/** The prompt of a turn after the re-gate of the last turn failed. */
const regatePrompt = (failure: string, tool: string) =>
  [
    'The end of the last alarm call stopped the gate of your submit. The host ran the gate again in this call, and it failed:',
    '',
    failure,
    '',
    `Edit the files in /repo. Then call ${tool} one time.`,
  ].join('\n')

/** One editing agent: its spec with a submit tool, the submit tool, the check of a log before the gate, and the first prompt. */
type EditAgent = { spec(submit: HostTools): AgentSpec; tool: Contracts.HostTool; check(input: unknown): unknown; prompt: string }

/**
 * The turns of one editing agent in one session (D12). When the end of the call cuts the gate of a submit, the host
 * accepts the log and records the cut, and `cut` tells the step to commit and stop the call. The next call runs the gate
 * again as a host step. A failure gives the agent one more turn, at most `maxTaskTurns` turns. The latest log counts.
 */
async function editTurns<Log>(context: RunContext, id: string, agent: EditAgent): Promise<{ log: Log; cut: boolean }> {
  const { ledger } = context.host
  // Only a cut in this call stops the call. After a crash restart, a recorded cut runs the re-gate.
  let cut = false
  let prompt = agent.prompt
  for (let turn = 1; ; turn++) {
    // The first turn keeps the request ID and the key of earlier runs, so that their journals and ledgers resume.
    const keys = turn === 1 ? { request: 'task', key: `output:${id}` } : { request: `task-${turn}`, key: `output:${id}:${turn}` }
    const submit = submitOnce(context.host, keys.key, agent.tool, async (input) => {
      const log = agent.check(input)
      const gate = await testGate(context, id, true)
      if (gate.status === 'fail') throw new Error(gate.text)
      if (gate.status === 'cut') {
        cut = true
        if (ledger.get(cutKey(id, turn)) === undefined) {
          ledger.put(cutKey(id, turn), true)
          context.host.log(`${id}: the end of the call stopped ${gate.what} of turn ${turn}. The host accepts the log and runs the gate again in the next call`)
        }
      }
      return log
    })
    const log = await runTurn<Log>(context.host, agent.spec(submit), prompt, agent.tool.name, keys)
    if (cut || ledger.get(cutKey(id, turn)) === undefined) return { log, cut }
    const failure = await step(ledger, `regate:${id}:${turn}`, async () => {
      ledger.put(regatedKey(id), true)
      const gate = await testGate(context, id, false)
      const text = gate.status === 'fail' ? gate.text : null
      context.host.log(`${id}: the gate of turn ${turn} ran again after the cut: ${text === null ? 'pass' : 'fail'}`)
      return text
    })
    if (failure === null) return { log, cut }
    if (turn === maxTaskTurns) throw new Error(`${id}: the gate failed after ${maxTaskTurns} turns\n${failure}`)
    prompt = regatePrompt(failure, agent.tool.name)
  }
}

/** Commits the edits of a step whose gate the end of the call cut, and stops the call. The next call runs the gate again (D12). */
async function stopAfterCut(context: RunContext, id: string, message: string): Promise<never> {
  await context.repo.commit(message)
  throw new PlannedStop(`${id}: the end of the call stopped the gate of a submit`)
}

/** The report notes of a step: the gate of one of its agents did not run its tests, or ran again after a cut. */
function gateNote(context: RunContext, ids: string[]): { note?: string } {
  const flagged = (key: (id: string) => string) => ids.some((id) => context.host.ledger.get(key(id)) === true)
  const notes = [...(flagged(untestedKey) ? [setupFailedNote] : []), ...(flagged(regatedKey) ? [regateNote] : [])]
  return notes.length > 0 ? { note: notes.join('; ') } : {}
}

const submitPatchLog: Contracts.HostTool = {
  name: 'submit_patch_log',
  description: 'Record what you did. List every kept finding ID exactly one time: in applied, with the change, or in skipped, with the reason.',
  parameters: {
    type: 'object',
    properties: {
      applied: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string' }, change: { type: 'string' } }, required: ['id', 'change'], additionalProperties: false },
      },
      skipped: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'], additionalProperties: false },
      },
    },
    required: ['applied', 'skipped'],
    additionalProperties: false,
  },
}

/** Checks that a patch log lists every kept finding one time. With `deferred`, the log of one patch agent among several. */
export function checkPatchLog(input: unknown, kept: Finding[], deferred = false): PatchLog {
  const log = input as GroupLog
  if (!Array.isArray(log?.applied) || !Array.isArray(log?.skipped)) throw new Error('applied and skipped must be arrays')
  if (deferred && !Array.isArray(log.deferred)) throw new Error('deferred must be an array')
  const listed = [...log.applied, ...log.skipped, ...(deferred ? log.deferred : [])].map((entry) => entry.id)
  const expected = new Set(kept.map((finding) => finding.id))
  const unknown = listed.filter((id) => !expected.has(id))
  const repeated = listed.filter((id, index) => listed.indexOf(id) !== index)
  const missing = [...expected].filter((id) => !listed.includes(id))
  const problems = [
    ...(unknown.length ? [`not kept findings: ${unknown.join(', ')}`] : []),
    ...(repeated.length ? [`listed more than one time: ${repeated.join(', ')}`] : []),
    ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
  ]
  if (problems.length > 0) throw new Error(problems.join('; '))
  return log
}

/** The commit that an editing step starts from, recorded so that a resumed step compares against the same commit. */
async function editBase(context: RunContext, id: string): Promise<string> {
  const key = `before:${id}`
  const before = context.host.ledger.get<string>(key) ?? (await context.repo.head())
  context.host.ledger.put(key, before)
  return before
}

/** Commits what the editing agents changed, and lists the files that they touched outside the change and the findings. */
async function commitEdits<Log extends PatchLog>(context: RunContext, before: string, log: Log, kept: Finding[], message: string): Promise<PatchOutcome<Log>> {
  const { repo } = context
  await repo.commit(message)
  const after = await repo.head()
  const touched = after === before ? [] : await repo.changedFiles(before, after)
  const allowed = new Set([
    ...(await repo.changedFiles(context.frozen.base, context.frozen.head)),
    ...kept.flatMap((finding) => {
      const location = parseLocation(finding.location)
      return location && 'path' in location ? [location.path] : []
    }),
  ])
  return { before, after, changed: after !== before, log, outOfScope: touched.filter((path) => !allowed.has(path)) }
}

/**
 * Fresh patch agents that may edit /repo, except protected files, to apply only the kept findings. When the
 * findings are in several files, the host splits them (`patchGroups`) across agents that work at the same time.
 * Each agent writes only its own files and the files that it writes first. A finding that needs a file of another
 * agent waits, and one more agent applies the waiting findings after the others. The host commits one time.
 */
export async function patch(context: RunContext, id: string, model: ModelChoice, kept: Finding[], gateLog: string[], message: string): Promise<PatchOutcome> {
  const before = await editBase(context, id)
  if (kept.length === 0) return { before, after: before, changed: false, log: null, outOfScope: [] }
  // A step that one agent started before the host split patches stays with that agent.
  const groups = context.host.ledger.get(`session:${id}`) === undefined ? recordedGroups(context, id, kept) : [{ findings: kept, files: [] }]
  if (groups.length === 1) {
    const { log, cut } = await patchTurn(context, id, model, kept, gateLog, before, { kind: 'all' })
    if (cut) await stopAfterCut(context, id, message)
    return { ...(await commitEdits(context, before, log, kept, message)), ...gateNote(context, [id]) }
  }

  const { ledger } = context.host
  const owners = fileOwners(groups, { ...ledger.get<Record<string, number>>(`claims:${id}`) }, (claims) => ledger.put(`claims:${id}`, claims))
  context.host.log(`${id}: ${groups.length} patch agents at the same time, with ${groups.map((group) => group.findings.length).join(', ')} findings`)
  const turns = await settleAll(
    groups.map((group, index) =>
      patchTurn<GroupLog>(context, `${id}.${index + 1}`, model, group.findings, gateLog, before, {
        kind: 'share',
        files: group.files,
        others: groups.flatMap((other, at) => (at === index ? [] : other.files)),
        allow: owners(index),
      }),
    ),
  )
  if (turns.some((turn) => turn.cut)) await stopAfterCut(context, id, message)
  const logs = turns.map((turn) => turn.log)
  const deferred = logs.flatMap((log) => log.deferred)
  const last =
    deferred.length > 0
      ? await patchTurn(context, `${id}.deferred`, model, deferred.map((entry) => kept.find((finding) => finding.id === entry.id)!), gateLog, before, { kind: 'deferred', notes: deferred })
      : { log: { applied: [], skipped: [] }, cut: false }
  if (last.cut) await stopAfterCut(context, id, message)
  const waited = last.log
  const log = checkPatchLog({ applied: [...logs.flatMap((entry) => entry.applied), ...waited.applied], skipped: [...logs.flatMap((entry) => entry.skipped), ...waited.skipped] }, kept)
  const ids = [...groups.map((_, index) => `${id}.${index + 1}`), `${id}.deferred`]
  return { ...(await commitEdits(context, before, log, kept, message)), split: { agents: groups.length, deferred: deferred.map((entry) => entry.id) }, ...gateNote(context, ids) }
}

/** The patch groups of a step, recorded so that a resumed step keeps the same agents. */
function recordedGroups(context: RunContext, id: string, kept: Finding[]): PatchGroup[] {
  const key = `groups:${id}`
  const recorded = context.host.ledger.get<{ ids: string[]; files: string[] }[]>(key)
  if (recorded) return recorded.map((group) => ({ files: group.files, findings: group.ids.map((findingId) => kept.find((finding) => finding.id === findingId)!) }))
  const groups = patchGroups(kept)
  context.host.ledger.put(key, groups.map((group) => ({ ids: group.findings.map((finding) => finding.id), files: group.files })))
  return groups
}

type PatchMode =
  | { kind: 'all' }
  | { kind: 'share'; files: string[]; others: string[]; allow(path: string): boolean }
  | { kind: 'deferred'; notes: GroupLog['deferred'] }

/** One patch agent: all the kept findings, one share of them beside other agents, or the findings that waited. */
async function patchTurn<Log extends PatchLog = PatchLog>(
  context: RunContext,
  id: string,
  model: ModelChoice,
  findings: Finding[],
  gateLog: string[],
  before: string,
  mode: PatchMode,
): Promise<{ log: Log; cut: boolean }> {
  const review = {
    '/ask.md': context.ask,
    '/kept-findings.json': JSON.stringify(findings, null, 2),
    '/gate-log.txt': gateLog.join('\n'),
    '/diff.patch': await context.repo.diff(context.frozen.base, before),
    ...decisionsFile(context.host.ledger),
    ...(mode.kind === 'share' ? { '/other-agents-files.txt': mode.others.join('\n') } : {}),
    ...(mode.kind === 'deferred' ? { '/deferred.json': JSON.stringify(mode.notes, null, 2) } : {}),
  }
  const tree = guard(context.repo.tree, (path) => isProtected(context.config, path))
  const workspace = await createWorkspace({ repo: editTree(context, id, mode.kind === 'share' ? allowFiles(tree, mode.allow) : tree), review, guides: context.guides.mounts })
  const prompt = [
    ...patchIntro(mode, findings.map((finding) => finding.id).join(', ')),
    "- Gate log: /review/gate-log.txt. A note on a finding is the user's instruction for its fix.",
    '- Original ask: /review/ask.md',
    ...decisionsLine(review),
    '- The change so far: /review/diff.patch',
    ...(mode.kind === 'share'
      ? [
          '',
          'When a fix needs a file that the host refuses, do not put the change in another place. List the finding in deferred, with the file and the work that is left. One more patch agent applies the deferred findings after the others finish.',
          'A test or a ci command can fail because another patch agent is in the middle of an edit. Fix only the failures in your files.',
        ]
      : []),
    '',
    ...gateText(context),
    'Edit the files in /repo. Then call submit_patch_log one time.',
  ].join('\n')
  return editTurns<Log>(context, id, {
    spec: (submit) => spec(context, id, reviewRoles.patch, model, workspace, { ...checkTools(context, id), ...submit }),
    tool: mode.kind === 'share' ? submitSharePatchLog : submitPatchLog,
    check: (input) => checkPatchLog(input, findings, mode.kind === 'share'),
    prompt,
  })
}

function patchIntro(mode: PatchMode, ids: string): string[] {
  switch (mode.kind) {
    case 'all':
      return ['Apply the kept findings.', '', `- Kept findings: /review/kept-findings.json (${ids})`]
    case 'share':
      return [
        'Apply your share of the kept findings. Other patch agents apply the other kept findings at the same time, in other files.',
        '',
        `- Your findings: /review/kept-findings.json (${ids})`,
        `- Your files: ${mode.files.join(', ')}. Only you write them.`,
        '- The files of the other patch agents: /review/other-agents-files.txt. The host refuses your writes to them (EACCES), and to a file that another patch agent wrote first.',
      ]
    case 'deferred':
      return [
        'Apply the deferred findings. Other patch agents applied the other kept findings at the same time. These findings needed a file of another agent, so they waited for you. The edits of the other agents are in /repo, not committed yet.',
        '',
        `- Deferred findings: /review/kept-findings.json (${ids})`,
        '- Why each one waited, and the work that is left: /review/deferred.json',
      ]
  }
}

export type LightLog = PatchLog & { fixes: { location: string; change: string }[] }

const entries = (fields: string[]) => ({
  type: 'array',
  items: { type: 'object', properties: Object.fromEntries(fields.map((field) => [field, { type: 'string' }])), required: fields, additionalProperties: false },
})

const submitSharePatchLog: Contracts.HostTool = {
  name: 'submit_patch_log',
  description:
    'Record what you did. List every finding ID of your share exactly one time: in applied, with the change, in skipped, with the reason, or in deferred, with the file that the host refused and the work that is left.',
  parameters: {
    type: 'object',
    properties: { applied: entries(['id', 'change']), skipped: entries(['id', 'reason']), deferred: entries(['id', 'reason']) },
    required: ['applied', 'skipped', 'deferred'],
    additionalProperties: false,
  },
}

const submitLightLog: Contracts.HostTool = {
  name: 'submit_light_log',
  description:
    'Record what you did. List every host finding ID exactly one time: in applied, with the change, or in skipped, with the reason. List each other fix in fixes, with its location (path:line) and the change.',
  parameters: {
    type: 'object',
    properties: { applied: entries(['id', 'change']), skipped: entries(['id', 'reason']), fixes: entries(['location', 'change']) },
    required: ['applied', 'skipped', 'fixes'],
    additionalProperties: false,
  },
}

/**
 * The light loop for a change that only touches docs and tests: one fresh agent reviews the change and fixes it,
 * and applies or rejects the host findings. The host refuses its writes outside docs and tests, and commits.
 */
export async function light(
  context: RunContext,
  id: string,
  model: ModelChoice,
  options: { kept: Finding[]; gateLog: string[]; message: string; allow(path: string): boolean },
): Promise<PatchOutcome<LightLog>> {
  const before = await editBase(context, id)
  const range = { from: reviewedFrom(context.frozen), to: context.frozen.head }
  const inputs = await reviewInputs(context, range)
  const review = { ...inputs.files, '/host-findings.json': JSON.stringify(options.kept, null, 2), '/gate-log.txt': options.gateLog.join('\n') }
  const repo = allowFiles(guard(context.repo.tree, (path) => isProtected(context.config, path)), options.allow)
  const workspace = await createWorkspace({ repo: editTree(context, id, repo), review, guides: context.guides.mounts })
  const kept = options.kept.map((finding) => finding.id).join(', ')
  const prompt = [
    'Review this change, and fix it.',
    '',
    '- Original ask: /review/ask.md',
    ...decisionsLine(review),
    `- Diff: /review/diff.patch, from ${range.from.slice(0, 12)} to ${range.to.slice(0, 12)}`,
    `- Changed files: /review/changed-files.txt (${inputs.changed.length} files)`,
    `- Host findings: /review/host-findings.json (${kept || 'none'})`,
    '- Gate log: /review/gate-log.txt',
    `- Stack: ${context.stack}`,
    '',
    'Triage: docs or tests only. The host refuses your writes outside docs and tests.',
    '',
    ...gateText(context),
    'Edit the files in /repo. Then call submit_light_log one time.',
  ].join('\n')
  const { log, cut } = await editTurns<LightLog>(context, id, {
    spec: (submit) => spec(context, id, reviewRoles.light, model, workspace, { ...checkTools(context, id), ...submit }),
    tool: submitLightLog,
    check(input) {
      const log = checkPatchLog(input, options.kept) as LightLog
      if (!Array.isArray(log.fixes) || log.fixes.some((fix) => typeof fix?.location !== 'string' || typeof fix.change !== 'string'))
        throw new Error('fixes must be an array of { location, change }')
      return log
    },
    prompt,
  })
  if (cut) await stopAfterCut(context, id, options.message)
  return { ...(await commitEdits(context, before, log, options.kept, options.message)), ...gateNote(context, [id]) }
}

export type Verdict = { satisfied: boolean; gaps: string[]; summary: string }

const submitVerdict: Contracts.HostTool = {
  name: 'submit_verdict',
  description: 'Record whether the final change satisfies the original ask. List each gap; satisfied must be false when there is a gap.',
  parameters: {
    type: 'object',
    properties: {
      satisfied: { type: 'boolean' },
      gaps: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
    },
    required: ['satisfied', 'gaps', 'summary'],
    additionalProperties: false,
  },
}

/** A fresh read-only check that the final diff still satisfies the original ask. */
export async function intent(context: RunContext, id: string, model: ModelChoice, range: Range): Promise<Verdict> {
  const inputs = await reviewInputs(context, range)
  const workspace = await createWorkspace({ repo: reviewTree(context), review: inputs.files, guides: context.guides.mounts })
  const tools = submitOnce(context.host, `output:${id}`, submitVerdict, async (input) => {
    const verdict = input as Verdict
    if (typeof verdict?.satisfied !== 'boolean' || !Array.isArray(verdict.gaps)) throw new Error('satisfied and gaps are required')
    if (verdict.satisfied === verdict.gaps.length > 0) throw new Error('satisfied must be false exactly when there is a gap')
    return verdict
  })
  const prompt = [
    'Check the final change against the original ask.',
    '',
    '- Original ask: /review/ask.md',
    ...decisionsLine(inputs.files),
    `- Final diff: /review/diff.patch, from ${range.from.slice(0, 12)} to ${range.to.slice(0, 12)}`,
    '',
    'Call submit_verdict one time.',
  ].join('\n')
  return runTurn(context.host, spec(context, id, reviewRoles.intent, model, workspace, tools), prompt, 'submit_verdict')
}

/** A read-only agent that finds the decisions that only the user can make. Runs beside the step 1 reviewers. */
export async function askQuestions(context: RunContext, id: string, model: ModelChoice, range: Range): Promise<Question[]> {
  const inputs = await reviewInputs(context, range)
  const workspace = await createWorkspace({ repo: reviewTree(context), review: inputs.files, guides: context.guides.mounts })
  const tools = submitOnce(context.host, `output:${id}`, submitQuestions, async (input) => checkQuestions(input))
  const prompt = [
    'Find the decisions in this change that only the user can make.',
    '',
    '- Original ask: /review/ask.md',
    `- Diff: /review/diff.patch, from ${range.from.slice(0, 12)} to ${range.to.slice(0, 12)}`,
    `- Stack: ${context.stack}`,
    '',
    'Call submit_questions one time, with an empty list when the ask settles everything.',
  ].join('\n')
  return runTurn(context.host, spec(context, id, reviewRoles.questions, model, workspace, tools), prompt, 'submit_questions')
}
