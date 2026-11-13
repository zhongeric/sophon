import type { Contracts } from 'nanocode-ts'
import { runTurn, submitOnce, type AgentHost, type AgentSpec, type HostTools } from './agent.ts'
import { callRunTests, isProtected, runTestsTool, type RepoConfig } from './checks.ts'
import { assignIds, checkFindings, parseLocation, submitFindings, type Finding } from './findings.ts'
import { step } from './ledger.ts'
import type { Checker, Frozen, Guides, Repo } from './platform.ts'
import { checkQuestions, decisionsFile, decisionsLine, submitQuestions, type Question } from './questions.ts'
import { instructions, roles, type ModelChoice, type Role } from './roles.ts'
import { bugsShards, diffFiles, diffOf, fileOwners, patchGroups, type PatchGroup } from './split.ts'
import { allowFiles, createWorkspace, guard, readOnly } from './workspace.ts'

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
  }
}

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
  const found = await Promise.all(
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
    ...kept.map((finding) => parseLocation(finding.location)!.path),
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
  if (groups.length === 1) return commitEdits(context, before, await patchTurn(context, id, model, kept, gateLog, before, { kind: 'all' }), kept, message)

  const { ledger } = context.host
  const owners = fileOwners(groups, { ...ledger.get<Record<string, number>>(`claims:${id}`) }, (claims) => ledger.put(`claims:${id}`, claims))
  context.host.log(`${id}: ${groups.length} patch agents at the same time, with ${groups.map((group) => group.findings.length).join(', ')} findings`)
  const logs = await Promise.all(
    groups.map((group, index) =>
      patchTurn<GroupLog>(context, `${id}.${index + 1}`, model, group.findings, gateLog, before, {
        kind: 'share',
        files: group.files,
        others: groups.flatMap((other, at) => (at === index ? [] : other.files)),
        allow: owners(index),
      }),
    ),
  )
  const deferred = logs.flatMap((log) => log.deferred)
  const waited =
    deferred.length > 0
      ? await patchTurn(context, `${id}.deferred`, model, deferred.map((entry) => kept.find((finding) => finding.id === entry.id)!), gateLog, before, { kind: 'deferred', notes: deferred })
      : { applied: [], skipped: [] }
  const log = checkPatchLog({ applied: [...logs.flatMap((entry) => entry.applied), ...waited.applied], skipped: [...logs.flatMap((entry) => entry.skipped), ...waited.skipped] }, kept)
  return { ...(await commitEdits(context, before, log, kept, message)), split: { agents: groups.length, deferred: deferred.map((entry) => entry.id) } }
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
): Promise<Log> {
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
  const workspace = await createWorkspace({ repo: mode.kind === 'share' ? allowFiles(tree, mode.allow) : tree, review, guides: context.guides.mounts })
  const tools =
    mode.kind === 'share'
      ? submitOnce(context.host, `output:${id}`, submitSharePatchLog, async (input) => checkPatchLog(input, findings, true))
      : submitOnce(context.host, `output:${id}`, submitPatchLog, async (input) => checkPatchLog(input, findings))
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
          'A test can fail because another patch agent is in the middle of an edit. Fix only the failures in your files.',
        ]
      : []),
    '',
    'Edit the files in /repo. Then call submit_patch_log one time.',
  ].join('\n')
  return runTurn<Log>(context.host, spec(context, id, roles.patch, model, workspace, tools), prompt, 'submit_patch_log')
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
  const range = { from: context.frozen.base, to: context.frozen.head }
  const inputs = await reviewInputs(context, range)
  const review = { ...inputs.files, '/host-findings.json': JSON.stringify(options.kept, null, 2), '/gate-log.txt': options.gateLog.join('\n') }
  const repo = allowFiles(guard(context.repo.tree, (path) => isProtected(context.config, path)), options.allow)
  const workspace = await createWorkspace({ repo, review, guides: context.guides.mounts })
  const tools = submitOnce(context.host, `output:${id}`, submitLightLog, async (input) => {
    const log = checkPatchLog(input, options.kept) as LightLog
    if (!Array.isArray(log.fixes) || log.fixes.some((fix) => typeof fix?.location !== 'string' || typeof fix.change !== 'string'))
      throw new Error('fixes must be an array of { location, change }')
    return log
  })
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
    'Edit the files in /repo. Then call submit_light_log one time.',
  ].join('\n')
  const log = await runTurn<LightLog>(context.host, spec(context, id, roles.light, model, workspace, tools), prompt, 'submit_light_log')
  return commitEdits(context, before, log, options.kept, options.message)
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
  return runTurn(context.host, spec(context, id, roles.intent, model, workspace, tools), prompt, 'submit_verdict')
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
  return runTurn(context.host, spec(context, id, roles.questions, model, workspace, tools), prompt, 'submit_questions')
}
