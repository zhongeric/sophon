import type { Contracts } from 'nanocode-ts'
import type { FileSystem } from 'nanocode-ts/bash'
import { runTurn, submitOnce, type AgentHost, type AgentSpec, type HostTools } from './agent.ts'
import { callRunTests, isProtected, runTestsTool, type RepoConfig } from './checks.ts'
import { checkIntake, checkPlan, checkSpec, inScope, submitIntake, submitPlan, submitSpec, type Intake, type Plan, type Spec } from './plan.ts'
import type { Branch, Checker, Guides } from './platform.ts'
import { staticFindings, type Profile } from './profiles.ts'
import { decisionsFile, decisionsLine } from './questions.ts'
import { instructions, roles, type ModelChoice, type Role } from './roles.ts'
import { allowFiles, createWorkspace, guard, readOnly } from './workspace.ts'

/** What every agent of one development run shares. */
export type DevelopContext = {
  host: AgentHost
  config: RepoConfig
  guides: Guides
  /** The guides of the profiles of the repository. */
  stackGuides: string[]
  /** The ask, verbatim. */
  ask: string
}

const toolOutputTailChars = 4_000

function agent(context: DevelopContext, id: string, role: Role, model: ModelChoice, workspace: Contracts.WorkspaceHost, tools: HostTools, subagents = false): AgentSpec {
  return { id, ...model, instructions: instructions(role, { read: context.guides.read, stackGuides: context.stackGuides }), tools, workspace, subagents }
}

/** A read-only workspace on the base tree, for the agents that read before anyone writes. */
const readerWorkspace = (context: DevelopContext, tree: FileSystem.FileSystem, review: Record<string, string>) =>
  createWorkspace({ repo: readOnly(guard(tree)), review: { '/ask.md': context.ask, ...decisionsFile(context.host.ledger), ...review }, guides: context.guides.mounts })

/** One read-only agent on the base tree. It reads the files in `lines`, and calls `tool` one time with output that `check` accepts. */
type Reader<T> = { role: Role; tool: Contracts.HostTool; check: (input: unknown) => T; lines: string[]; review?: Record<string, string> }

async function reader<T>(context: DevelopContext, id: string, model: ModelChoice, tree: FileSystem.FileSystem, spec: Reader<T>): Promise<T> {
  const workspace = await readerWorkspace(context, tree, spec.review ?? {})
  const tools = submitOnce(context.host, `output:${id}`, spec.tool, async (input) => spec.check(input))
  const prompt = [...spec.lines, '- The repository: /repo, at the base commit', '', `Call ${spec.tool.name} one time.`].join('\n')
  return runTurn(context.host, agent(context, id, spec.role, model, workspace, tools), prompt, spec.tool.name)
}

/** A read-only agent that reads the ask and the repository, and returns its summary, the route and its questions. */
export const intake = (context: DevelopContext, id: string, model: ModelChoice, tree: FileSystem.FileSystem): Promise<Intake> =>
  reader(context, id, model, tree, {
    role: roles.intake,
    tool: submitIntake,
    check: checkIntake,
    lines: ['Read this new ask and the repository. Nobody has planned or written code yet.', '', '- The ask: /review/ask.md'],
  })

/** A read-only agent that writes the spec of a larger change, and the decisions that the user can overrule. */
export const writeSpec = (context: DevelopContext, id: string, model: ModelChoice, tree: FileSystem.FileSystem): Promise<Spec> =>
  reader(context, id, model, tree, {
    role: roles.spec,
    tool: submitSpec,
    check: checkSpec,
    lines: ['Write the spec of this confirmed ask.', '', '- The ask: /review/ask.md', '- Decisions of the user: /review/decisions.md'],
  })

/** The planner: one read-only agent that writes the four plan parts, the profile sections and the tasks (D7). */
export const plan = (context: DevelopContext, id: string, model: ModelChoice, tree: FileSystem.FileSystem, sections: string[], spec: string | null): Promise<Plan> =>
  reader(context, id, model, tree, {
    role: roles.planner,
    tool: submitPlan,
    check: (input) => checkPlan(input, sections, (path) => isProtected(context.config, path)),
    review: { '/plan-sections.txt': sections.join('\n'), ...(spec ? { '/spec.md': spec } : {}) },
    lines: [
      'Plan this confirmed ask.',
      '',
      '- The ask: /review/ask.md',
      '- Decisions of the user: /review/decisions.md',
      ...(spec ? ['- The spec: /review/spec.md'] : []),
      `- Required sections: /review/plan-sections.txt (${sections.length ? sections.join(', ') : 'none'})`,
    ],
  })

export type BuildLog = { summary: string; changes: { path: string; why: string }[]; tests: string[]; blocked: string }

const checkpointTool: Contracts.HostTool = {
  name: 'checkpoint',
  description:
    'Commit your changes. The host first checks that every changed path is in the files of the task, the lines that you added against the static rules of the stack, and the paths against the paths that no change may commit. ' +
    'It refuses the commit and lists each problem when one fails. Fix them and call again. A new test file runs with run_tests only after a checkpoint.',
  parameters: { type: 'object', properties: { message: { type: 'string', description: 'What this commit does, in a few words' } }, required: ['message'], additionalProperties: false },
}

const runChecksTool: Contracts.HostTool = {
  name: 'run_checks',
  description: "Run the repository's configured checks (for example typecheck, lint, build) and its targeted tests on the files that the work changed, on the real machine. Returns each status and the end of its output.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
}

const submitBuildLog: Contracts.HostTool = {
  name: 'submit_build_log',
  description:
    'Submit what you built, one time, after your last checkpoint. List every file that your commits changed, with the reason. ' +
    'When you cannot finish, say why in blocked, and the host reports it to the user. Else blocked is an empty string.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      changes: {
        type: 'array',
        items: { type: 'object', properties: { path: { type: 'string' }, why: { type: 'string' } }, required: ['path', 'why'], additionalProperties: false },
      },
      tests: { type: 'array', items: { type: 'string' }, description: 'The test files that show the work' },
      blocked: { type: 'string' },
    },
    required: ['summary', 'changes', 'tests', 'blocked'],
    additionalProperties: false,
  },
}

export type BuildTask = {
  /** The agent ID. A follow-up turn of the same agent uses the same ID and another `turn`. */
  id: string
  turn: { request: string; key: string }
  model: ModelChoice
  branch: Branch
  /** The files and directories that the builder can write. */
  scope: string[]
  /** The profiles whose static rules gate each checkpoint. */
  active: Profile[]
  checker: Checker
  /** The commit that the work started from, for the files that run_checks checks. */
  base: string
  review: Record<string, string>
  prompt: string
  /** The start of each checkpoint's commit message. */
  label: string
}

/**
 * One builder turn. The agent can write only the files in its scope of the branch.
 * The agent commits through checkpoint, runs the checks and its tests, and submits a build log.
 * The host refuses a checkpoint that breaks a static rule or adds a forbidden path.
 * The host refuses a completed log with uncommitted work. A blocked log can report uncommitted work.
 */
export async function build(context: DevelopContext, task: BuildTask): Promise<BuildLog> {
  const { branch } = task
  const startKey = `start:${task.turn.key}`
  const start = context.host.ledger.get<string>(startKey) ?? (await branch.head())
  context.host.ledger.put(startKey, start)

  const tools = buildTools(context, task, start)
  const repo = allowFiles(guard(branch.tree, (path) => isProtected(context.config, path)), (path) => inScope(path, task.scope))
  const decided = decisionsFile(context.host.ledger)
  const workspace = await createWorkspace({ repo, review: { ...task.review, ...decided }, guides: context.guides.mounts })
  const prompt = [task.prompt, ...decisionsLine(decided)].join('\n')
  return runTurn(context.host, agent(context, task.id, roles.builder, task.model, workspace, tools, true), prompt, 'submit_build_log', task.turn)
}

/** The tools of one builder turn share one command queue. */
export function buildTools(context: Pick<DevelopContext, 'host' | 'config'>, task: BuildTask, start: string) {
  const { branch, checker } = task
  // The tools that read or change the index of the branch, or run commands in its tree, run one at a time.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work)
    queue = next.catch(() => undefined)
    return next
  }
  const rootOnly = (name: string, call: { subagent: unknown }) => {
    if (call.subagent) throw new Error(`only the root agent calls ${name}`)
  }

  const tools = {
    checkpoint: {
      definition: checkpointTool,
      async call(input: unknown, call: { subagent: unknown }) {
        rootOnly('checkpoint', call)
        return serial(async () => {
          const pending = await branch.pending()
          if (pending.changed.length === 0 && pending.diff.trim() === '') throw new Error('nothing to commit')
          // A command, for example a test run or the setup, can change files outside the scope of the builder, or protected files.
          const touched = [...pending.changed, ...pending.removed]
          const locked = touched.filter((path) => isProtected(context.config, path))
          if (locked.length > 0)
            throw new Error(`checkpoint refused: these files are protected, and only the user can change them: ${locked.join(', ')}. If the task needs them, say so in blocked.`)
          const outside = touched.filter((path) => !inScope(path, task.scope))
          if (outside.length > 0)
            throw new Error(`checkpoint refused: these changes are outside the files of the task, and only the user can commit them: ${outside.join(', ')}. If the task needs them, say so in blocked.`)
          const problems = staticFindings(pending.diff, pending.changed, task.active).map(
            (finding) => `${finding.location}: ${finding.title}. ${finding.recommendation}. Line: ${finding.evidence}`,
          )
          if (problems.length > 0) throw new Error(`checkpoint refused:\n${problems.join('\n')}`)
          const message = String((input as { message?: unknown }).message ?? '').trim() || 'checkpoint'
          await branch.commit(`${task.label}: ${message}`)
          return { commit: (await branch.head()).slice(0, 12), files: pending.changed }
        })
      },
    },
    run_checks: {
      definition: runChecksTool,
      async call(_input: unknown, call: { subagent: unknown }) {
        rootOnly('run_checks', call)
        return serial(async () => {
          const changed = [...new Set([...(await branch.changedFiles(task.base, await branch.head())), ...(await branch.pending()).changed])]
          const results = await checker.checks(changed)
          return results.map(({ name, status, exit_code, output }) => ({ name, status, exit_code, output: output.slice(-toolOutputTailChars) }))
        })
      },
    },
    ...(context.config.tests && checker.tests
      ? { run_tests: { definition: runTestsTool, call: (input: unknown) => serial(() => callRunTests(branch, context.config, checker.tests!, input)) } }
      : {}),
    ...submitOnce(context.host, task.turn.key, submitBuildLog, (input) => serial(async () => {
      const log = input as BuildLog
      if (!log?.summary?.trim() || !Array.isArray(log.changes) || !Array.isArray(log.tests) || typeof log.blocked !== 'string')
        throw new Error('summary, changes, tests and blocked are required')
      if (log.blocked.trim()) return log
      const pending = await branch.pending()
      if (pending.changed.length > 0 || pending.diff.trim() !== '') throw new Error(`checkpoint first: uncommitted changes in ${pending.changed.join(', ') || 'deleted files'}`)
      const head = await branch.head()
      const changed = head === start ? [] : await branch.changedFiles(start, head)
      if (changed.length === 0) throw new Error('no commits since the task started: checkpoint your work, or say in blocked why you cannot finish')
      const missing = changed.filter((path) => !log.changes.some((change) => change.path.replace(/^\/repo\//, '') === path))
      if (missing.length > 0) throw new Error(`list every changed file in changes: missing ${missing.join(', ')}`)
      return log
    })),
  }
  return tools
}
