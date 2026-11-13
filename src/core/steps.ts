import type { Contracts } from 'nanocode-ts'
import { openAgent, type AgentHost, type AgentSpec, type HostTools } from './agent.ts'
import { callRunTests, isProtected, runTestsTool, type RepoConfig } from './checks.ts'
import { assignIds, checkFindings, parseLocation, submitFindings, type Finding } from './findings.ts'
import type { Checker, Frozen, Guides, Repo } from './platform.ts'
import { checkQuestions, decisions, submitQuestions, type Question } from './questions.ts'
import { instructions, roles, type ModelChoice, type Role } from './roles.ts'
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

/**
 * Runs one agent turn to its submit tool. The submit handler writes the output to the ledger,
 * so a resumed run returns it even when the SDK replays the tool call from its receipt.
 */
async function runTask<T>(context: RunContext, spec: AgentSpec, prompt: string, tool: string): Promise<T> {
  const key = `output:${spec.id}`
  const recorded = context.host.ledger.get<T>(key)
  if (recorded !== undefined) return recorded
  const agent = await openAgent(spec, context.host)
  try {
    const report = await agent.ask('task', prompt)
    if (context.host.ledger.get(key) === undefined) {
      if (report.status !== 'completed') throw new Error(`${spec.id}: turn ${report.status}: ${JSON.stringify(report.error ?? null)}`)
      await agent.ask('nudge', `You ended the turn without calling ${tool}. Call tools.${tool} now.`)
    }
  } finally {
    await agent.close()
  }
  const output = context.host.ledger.get<T>(key)
  if (output === undefined) throw new Error(`${spec.id} did not call ${tool}`)
  return output
}

/** A submit tool that only the root agent may call, one time, after `check` accepts the input. */
function submitTool(context: RunContext, id: string, definition: Contracts.HostTool, check: (input: unknown) => Promise<unknown>): HostTools {
  const key = `output:${id}`
  return {
    [definition.name]: {
      definition,
      async call(input, call) {
        if (call.subagent) throw new Error('only the root agent submits')
        if (context.host.ledger.get(key) !== undefined) throw new Error(`${definition.name} was already accepted`)
        const output = await check(input)
        context.host.ledger.put(key, output)
        return { accepted: true }
      },
    },
  }
}

function testTools(context: RunContext, role: Role): HostTools {
  const run = context.tests
  if (!role.tests || !context.config.tests || !run) return {}
  return { run_tests: { definition: runTestsTool, call: (input) => callRunTests(context.repo, context.config, run, input) } }
}

function spec(context: RunContext, id: string, role: Role, model: ModelChoice, workspace: Contracts.WorkspaceHost, tools: HostTools): AgentSpec {
  return {
    id,
    ...model,
    instructions: instructions(role, { read: context.guides.read, stackGuides: context.stackGuides }),
    tools: { ...tools, ...testTools(context, role) },
    workspace,
  }
}

/** The user's answers so far, as /review/decisions.md, for every agent that runs after them. */
function decisionFiles(context: RunContext): Record<string, string> {
  const answers = decisions(context.host.ledger)
  if (answers.length === 0) return {}
  const lines = answers.map((answer) => `- ${answer.question}\n  Answer: ${answer.answer}`)
  return { '/decisions.md': `# Decisions of the user\n\nThese answers settle open points of the ask. Follow them.\n\n${lines.join('\n')}\n` }
}

const decisionsLine = (files: Record<string, string>) => ('/decisions.md' in files ? ['- Decisions of the user: /review/decisions.md'] : [])

async function reviewInputs(context: RunContext, range: Range) {
  const patch = await context.repo.diff(range.from, range.to)
  const changed = await context.repo.changedFiles(range.from, range.to)
  const files = { '/ask.md': context.ask, '/diff.patch': patch, '/changed-files.txt': changed.join('\n'), ...decisionFiles(context) }
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

/** One read-only reviewer on one diff. Returns the findings that passed the evidence check. */
export async function review(context: RunContext, id: string, role: Role, model: ModelChoice, range: Range, note: string): Promise<Finding[]> {
  if (!role.findings) throw new Error(`${role.id} is not a reviewer`)
  const { track, prefix } = role.findings
  const inputs = await reviewInputs(context, range)
  const workspace = await createWorkspace({ repo: reviewTree(context), review: inputs.files, guides: context.guides.mounts })
  const read = treeReader(context)
  const tools = submitTool(context, id, submitFindings, async (input) => {
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
    `- Stack: ${context.stack}`,
    ...(note ? ['', note] : []),
    '',
    'Call submit_findings one time with every finding, or with an empty list. Then reply "done".',
  ].join('\n')
  return runTask(context, spec(context, id, role, model, workspace, tools), prompt, 'submit_findings')
}

export type PatchLog = { applied: { id: string; change: string }[]; skipped: { id: string; reason: string }[] }
export type PatchOutcome<Log extends PatchLog = PatchLog> = { before: string; after: string; changed: boolean; log: Log | null; outOfScope: string[] }

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

export function checkPatchLog(input: unknown, kept: Finding[]): PatchLog {
  const log = input as PatchLog
  if (!Array.isArray(log?.applied) || !Array.isArray(log?.skipped)) throw new Error('applied and skipped must be arrays')
  const listed = [...log.applied.map((entry) => entry.id), ...log.skipped.map((entry) => entry.id)]
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

/** Runs one editing agent to its submit tool, commits its changes, and lists the files that it touched outside the change and the findings. */
async function edit<Log extends PatchLog>(context: RunContext, before: string, agent: AgentSpec, prompt: string, tool: string, kept: Finding[], message: string): Promise<PatchOutcome<Log>> {
  const { repo } = context
  const log = await runTask<Log>(context, agent, prompt, tool)
  await repo.commit(message)
  const after = await repo.head()
  const touched = after === before ? [] : await repo.changedFiles(before, after)
  const allowed = new Set([
    ...(await repo.changedFiles(context.frozen.base, context.frozen.head)),
    ...kept.map((finding) => parseLocation(finding.location)!.path),
  ])
  return { before, after, changed: after !== before, log, outOfScope: touched.filter((path) => !allowed.has(path)) }
}

/** A fresh patch agent that may edit /repo, except protected files, to apply only the kept findings. The host commits. */
export async function patch(context: RunContext, id: string, model: ModelChoice, kept: Finding[], gateLog: string[], message: string): Promise<PatchOutcome> {
  const before = await editBase(context, id)
  if (kept.length === 0) return { before, after: before, changed: false, log: null, outOfScope: [] }

  const review = {
    '/ask.md': context.ask,
    '/kept-findings.json': JSON.stringify(kept, null, 2),
    '/gate-log.txt': gateLog.join('\n'),
    '/diff.patch': await context.repo.diff(context.frozen.base, before),
    ...decisionFiles(context),
  }
  const workspace = await createWorkspace({ repo: guard(context.repo.tree, (path) => isProtected(context.config, path)), review, guides: context.guides.mounts })
  const tools = submitTool(context, id, submitPatchLog, async (input) => checkPatchLog(input, kept))
  const prompt = [
    'Apply the kept findings.',
    '',
    `- Kept findings: /review/kept-findings.json (${kept.map((finding) => finding.id).join(', ')})`,
    "- Gate log: /review/gate-log.txt. A note on a finding is the user's instruction for its fix.",
    '- Original ask: /review/ask.md',
    ...decisionsLine(review),
    '- The change so far: /review/diff.patch',
    '',
    'Edit the files in /repo. Then call submit_patch_log one time.',
  ].join('\n')
  return edit(context, before, spec(context, id, roles.patch, model, workspace, tools), prompt, 'submit_patch_log', kept, message)
}

export type LightLog = PatchLog & { fixes: { location: string; change: string }[] }

const entries = (fields: string[]) => ({
  type: 'array',
  items: { type: 'object', properties: Object.fromEntries(fields.map((field) => [field, { type: 'string' }])), required: fields, additionalProperties: false },
})

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
  const tools = submitTool(context, id, submitLightLog, async (input) => {
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
  return edit(context, before, spec(context, id, roles.light, model, workspace, tools), prompt, 'submit_light_log', options.kept, options.message)
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
  const tools = submitTool(context, id, submitVerdict, async (input) => {
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
  return runTask(context, spec(context, id, roles.intent, model, workspace, tools), prompt, 'submit_verdict')
}

/** A read-only agent that finds the decisions that only the user can make. Runs beside the step 1 reviewers. */
export async function askQuestions(context: RunContext, id: string, model: ModelChoice, range: Range): Promise<Question[]> {
  const inputs = await reviewInputs(context, range)
  const workspace = await createWorkspace({ repo: reviewTree(context), review: inputs.files, guides: context.guides.mounts })
  const tools = submitTool(context, id, submitQuestions, async (input) => checkQuestions(input))
  const prompt = [
    'Find the decisions in this change that only the user can make.',
    '',
    '- Original ask: /review/ask.md',
    `- Diff: /review/diff.patch, from ${range.from.slice(0, 12)} to ${range.to.slice(0, 12)}`,
    `- Stack: ${context.stack}`,
    '',
    'Call submit_questions one time, with an empty list when the ask settles everything.',
  ].join('\n')
  return runTask(context, spec(context, id, roles.questions, model, workspace, tools), prompt, 'submit_questions')
}
