import type { Contracts } from 'nanocode-ts'
import type { FileSystem } from 'nanocode-ts/bash'
import { runTurn, submitOnce, type AgentHost, type AgentSpec, type HostTools } from './agent.ts'
import { baseName, callRunTests, checkTails, failureText, isProtected, protectedEntries, runChecksTool, runTestsTool, targetedTests, type CheckResult, type RepoConfig } from './checks.ts'
import { checkIntake, checkPlan, checkSpec, inScope, submitIntake, submitPlan, submitSpec, type Intake, type Plan, type Spec } from './plan.ts'
import { maxTaskTurns, minCommandMs } from './planned-stop.ts'
import type { Branch, Checker, Guides } from './platform.ts'
import { staticFindings, type Profile } from './profiles.ts'
import { decisionsFile, decisionsLine } from './questions.ts'
import { developRoles, instructions, type ModelChoice, type Role } from './roles.ts'
import { diffFiles } from './split.ts'
import { allowFiles, createWorkspace, fileHash, guard, readOnly } from './workspace.ts'

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

function agent(context: DevelopContext, id: string, role: Role, model: ModelChoice, workspace: Contracts.WorkspaceHost, tools: HostTools): AgentSpec {
  return {
    id,
    ...model,
    instructions: instructions(role, { read: context.guides.read, stackGuides: context.stackGuides }),
    tools,
    workspace,
    subagents: role.subagents,
    turnMs: role.turnMs,
  }
}

/** A read-only workspace on the base tree, for the agents that read before anyone writes. */
const readerWorkspace = (context: DevelopContext, tree: FileSystem.FileSystem, review: Record<string, string>) =>
  createWorkspace({ repo: readOnly(guard(tree)), review: { '/ask.md': context.ask, ...decisionsFile(context.host.ledger), ...review }, guides: context.guides.mounts })

/** The agent ID of the planner session. The plan turn keeps the ID and the key of the planner before D19, so that its ledgers resume. */
const plannerId = 'plan'

/** A submit tool of the other turn of the planner session. It stays in the tool list of the session, and refuses each call. */
const otherTurn = (definition: Contracts.HostTool, correct: string): HostTools => ({
  [definition.name]: {
    definition,
    async call() {
      throw new Error(`this turn submits with ${correct}, not with ${definition.name}`)
    },
  },
})

/**
 * The intake turn of the planner session (D19): it reads the ask and the repository, and returns its summary, the route and its
 * questions. Both turns get both submit tools, so that the tool list of the session does not change.
 */
export async function intake(context: DevelopContext, model: ModelChoice, tree: FileSystem.FileSystem): Promise<Intake> {
  const workspace = await readerWorkspace(context, tree, {})
  const turn = { request: 'intake', key: `output:${plannerId}.intake` }
  const tools = { ...submitOnce(context.host, turn.key, submitIntake, async (input) => checkIntake(input)), ...otherTurn(submitPlan, 'submit_intake') }
  const prompt = [
    'Read this new ask and the repository. Nobody has planned or written code yet.',
    '',
    '- The ask: /review/ask.md',
    '- The repository: /repo, at the base commit',
    '',
    'This is the intake turn. The plan turn comes after the answers to your questions, in this session.',
    'Call submit_intake one time.',
  ].join('\n')
  return runTurn(context.host, agent(context, plannerId, developRoles.planner, model, workspace, tools), prompt, 'submit_intake', turn)
}

/** A read-only agent that writes the spec of the ask, and the decisions that the user can overrule. */
export async function writeSpec(context: DevelopContext, id: string, model: ModelChoice, tree: FileSystem.FileSystem): Promise<Spec> {
  const workspace = await readerWorkspace(context, tree, {})
  const tools = submitOnce(context.host, `output:${id}`, submitSpec, async (input) => checkSpec(input))
  const prompt = [
    'Write the spec of this confirmed ask.',
    '',
    '- The ask: /review/ask.md',
    '- Decisions: /review/decisions.md',
    '- The repository: /repo, at the base commit',
    '',
    'Call submit_spec one time.',
  ].join('\n')
  return runTurn(context.host, agent(context, id, developRoles.spec, model, workspace, tools), prompt, 'submit_spec')
}

async function treeFiles(tree: FileSystem.FileSystem, dir: string): Promise<string[]> {
  const files: string[] = []
  for (const name of await tree.list(dir)) {
    if (name === '.git') continue
    const path = `${dir.replace(/\/+$/, '')}/${name}`
    const stat = tree.lstat ? await tree.lstat(path) : await tree.stat(path)
    if (stat?.kind === 'directory') files.push(...(await treeFiles(tree, path)).map((file) => `${name}/${file}`))
    else if (stat) files.push(name)
  }
  return files
}

/**
 * The targeted tests of the files of a task on the base tree, which is a commit, so its files are the committed files.
 * An entry gives the files inside it. An entry without files is a new file.
 * It skips paths with an empty base name, such as .gitignore, because an empty base name selects all tests.
 */
export function baseTargetedTests(config: RepoConfig, tree: FileSystem.FileSystem): (entries: string[]) => Promise<string[]> {
  let listed: Promise<string[]> | null = null
  // A failed listing is not kept, so the next submit lists again.
  const committedFiles = () =>
    (listed ??= treeFiles(tree, '/').catch((error: unknown) => {
      listed = null
      throw error
    }))
  return async (entries) => {
    const files = await committedFiles()
    const changed = entries
      .flatMap((entry) => {
        const inside = files.filter((path) => inScope(path, [entry]))
        return inside.length > 0 ? inside : [entry]
      })
      .filter((path) => baseName(path) !== '')
    return targetedTests({ tree, committedFiles }, config, changed)
  }
}

/**
 * The plan turn of the planner session: one read-only agent writes the four plan parts, the profile sections and the tasks (D7).
 * It follows the intake turn (D19). The prompt names every input, because a session from before D19 has no intake turn.
 */
export async function plan(context: DevelopContext, model: ModelChoice, tree: FileSystem.FileSystem, sections: string[], spec: string | null): Promise<Plan> {
  const review = { '/plan-sections.txt': sections.join('\n'), ...(spec ? { '/spec.md': spec } : {}) }
  const workspace = await readerWorkspace(context, tree, review)
  const targeted = baseTargetedTests(context.config, tree)
  const tools = {
    ...otherTurn(submitIntake, 'submit_plan'),
    ...submitOnce(context.host, `output:${plannerId}`, submitPlan, async (input) => checkPlan(input, sections, (path) => isProtected(context.config, path), targeted)),
  }
  const prompt = [
    'Plan this confirmed ask. This is the plan turn.',
    '',
    '- The ask: /review/ask.md',
    '- Decisions: /review/decisions.md',
    ...(spec ? ['- The spec: /review/spec.md'] : []),
    `- Required sections: /review/plan-sections.txt (${sections.length ? sections.join(', ') : 'none'})`,
    `- Protected paths, which no task may write: ${protectedEntries(context.config).join(', ')}`,
    '- The repository: /repo, at the base commit',
    '',
    'Call submit_plan one time.',
  ].join('\n')
  return runTurn(context.host, agent(context, plannerId, developRoles.planner, model, workspace, tools), prompt, 'submit_plan')
}

export type BuildLog = {
  summary: string
  changes: { path: string; why: string }[]
  tests: string[]
  blocked: string
  /** What is left of the task when the alarm call ran out of time. A new turn of the same session continues the task (D12). */
  remaining?: string
}

const checkpointTool: Contracts.HostTool = {
  name: 'checkpoint',
  description:
    'Commit your changes. The host first checks that every changed path is in the files of the task, the lines that you added against the static rules of the stack, and the paths against the paths that no change may commit. ' +
    'It refuses the commit and lists each problem when one fails. Fix them and call again. A new test file runs with run_tests only after a checkpoint.',
  parameters: { type: 'object', properties: { message: { type: 'string', description: 'What this commit does, in a few words' } }, required: ['message'], additionalProperties: false },
}

/** The submit tool of a builder. `ci` tells whether the submit gate runs the ci commands. */
const submitBuildLog = (ci: boolean): Contracts.HostTool => ({
  name: 'submit_build_log',
  description:
    'Submit what you built, one time, after your last checkpoint. List every file that your commits changed, with the reason. ' +
    'When you cannot finish, say why in blocked, and the host reports it to the user. Else blocked is an empty string. ' +
    `When you submit, the host runs the targeted tests of the changes of the task${ci ? ', then the ci commands of the repository' : ''}, and refuses the log when one fails. A blocked log runs no tests. ` +
    'When the host says that the alarm call has no time left, submit with what is left to do in remaining. The host then runs no tests, and continues the task in a new turn of this session.',
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
      remaining: { type: 'string', description: 'Only when the host says that the alarm call has no time left: what is left to do' },
    },
    required: ['summary', 'changes', 'tests', 'blocked'],
    additionalProperties: false,
  },
})

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
  /** The commit that the work started from, for the files that run_checks checks and the targeted tests at submit. */
  base: string
  /**
   * In a repair round of a base merge with a conflict: the files that the merge brings, without the files that conflict.
   * Checkpoint and submit skip these files when they stay unchanged (D16).
   */
  baseFiles?: string[]
  /** The files of `baseFiles` that the fixer can change for a red CI. Other base files must stay unchanged. */
  editableBaseFiles?: string[]
  review: Record<string, string>
  prompt: string
  /** The start of each checkpoint's commit message. */
  label: string
}

const outOfTime = (leftMs: number) =>
  `the alarm call of this run has ${Math.max(0, Math.round(leftMs / 1000))} s left, so this turn runs no more commands. Call submit_build_log now, with what is left to do in remaining. The host continues the task in a new turn of this session.`

/** What is left when the end of the alarm call cut the tests or the ci commands of a submit. */
const cutGate = (what: string) =>
  `The end of the alarm call stopped ${what} of your submit before they finished. Call submit_build_log again at the start of this turn, so that the host runs them with the time of a new call.`

/** The prompt of a turn that continues a task after the last turn ran out of time. */
const continuePrompt = (remaining: string) =>
  [
    'Your last turn of this task ended because its alarm call ran out of time. Continue the task.',
    '',
    `What is left: ${remaining}`,
    '',
    'When you finish, checkpoint your work and call submit_build_log one time.',
  ].join('\n')

/**
 * One builder task, in one or more turns of one session. The agent can write only the files in its scope of the branch.
 * The agent commits through checkpoint, runs the checks and its tests, and submits a build log.
 * The host refuses a checkpoint that breaks a static rule or adds a forbidden path.
 * The host refuses a completed log with uncommitted work, or when a targeted test or a ci command (D15) on the changes since `base` fails.
 * A blocked log can report uncommitted work, and runs no tests. When the alarm call has less than `minCommandMs` left, the
 * agent submits what is left in `remaining`, and the next turn continues the task (D12). When the end of the call stops
 * the tests or the ci commands of a submit, the host accepts the log with `remaining`, because the stop is not a failure.
 */
export async function build(context: DevelopContext, task: BuildTask): Promise<BuildLog> {
  const { branch, checker } = task
  const baseFiles = new Set(task.baseFiles)
  const editableBaseFiles = new Set(task.editableBaseFiles)
  const ledger = context.host.ledger
  const startKey = `start:${task.turn.key}`
  const start = ledger.get<string>(startKey) ?? (await branch.head())
  ledger.put(startKey, start)
  const baseHashesKey = `base-files:${task.turn.key}`
  const baseHashes = ledger.get<Record<string, string | null>>(baseHashesKey) ?? Object.fromEntries(
    await Promise.all([...baseFiles].map(async (path) => [path, await fileHash(branch.tree, path)] as const)),
  )
  if (baseFiles.size > 0) ledger.put(baseHashesKey, baseHashes)
  const checkBaseFiles = async (gate: 'checkpoint' | 'submit') => {
    const changed: string[] = []
    const unchanged = new Set<string>()
    for (const path of baseFiles) {
      if (await fileHash(branch.tree, path) === baseHashes[path]) unchanged.add(path)
      else if (!editableBaseFiles.has(path)) changed.push(path)
    }
    if (changed.length > 0)
      throw new Error(`${gate} refused: restore the unchanged files from the base merge: ${changed.join(', ')}`)
    return unchanged
  }
  // The time that the call has left when it is too short for a command, else null. A platform without call limits gives null.
  const shortTime = () => {
    const left = ledger.timeLeft?.()
    return left !== undefined && left < minCommandMs ? left : null
  }
  const command = async <T>(run: () => Promise<T>): Promise<T> => {
    const left = shortTime()
    if (left !== null) throw new Error(outOfTime(left))
    return run()
  }

  const tools = (key: string): HostTools => ({
    checkpoint: {
      definition: checkpointTool,
      async call(input) {
        const unchanged = await checkBaseFiles('checkpoint')
        const pending = await branch.pending()
        if (pending.changed.length === 0 && pending.diff.trim() === '') {
          // A resolved base merge can keep the tree of the head. The host commits the merge after the submit (D16).
          if (task.baseFiles && (await branch.head()) === start) return { commit: null, note: 'the tree is the same as the head, so nothing is committed. Submit, and the host commits the merge.' }
          throw new Error('nothing to commit')
        }
        // A command, for example a test run or the setup, can change files outside the scope of the builder.
        const outside = [...pending.changed, ...pending.removed].filter((path) => !inScope(path, task.scope) && !unchanged.has(path))
        if (outside.length > 0)
          throw new Error(`checkpoint refused: these changes are outside the files of the task, and only the user can commit them: ${outside.join(', ')}. If the task needs them, say so in blocked.`)
        const own = (path: string) => !unchanged.has(path)
        const diff = baseFiles.size === 0 ? pending.diff : diffFiles(pending.diff).filter((file) => own(file.path)).map((file) => file.section).join('')
        const problems = staticFindings(diff, pending.changed.filter(own), task.active).map(
          (finding) => `${finding.location}: ${finding.title}. ${finding.recommendation}. Line: ${finding.evidence}`,
        )
        if (problems.length > 0) throw new Error(`checkpoint refused:\n${problems.join('\n')}`)
        const message = String((input as { message?: unknown }).message ?? '').trim() || 'checkpoint'
        await branch.commit(`${task.label}: ${message}`)
        return { commit: (await branch.head()).slice(0, 12), files: pending.changed }
      },
    },
    run_checks: {
      definition: runChecksTool('the files that the work changed', ' The targeted tests run when you submit. While you work, use run_tests for the test files.'),
      call: () =>
        command(async () => {
          const changed = [...new Set([...(await branch.changedFiles(task.base, await branch.head())), ...(await branch.pending()).changed])]
          return checkTails(await checker.checks(changed, { tests: false }))
        }),
    },
    ...(context.config.tests && checker.tests
      ? { run_tests: { definition: runTestsTool, call: (input: unknown) => command(() => callRunTests(branch, context.config, checker.tests!, input)) } }
      : {}),
    ...submitOnce(context.host, key, submitBuildLog(Boolean(checker.ci)), async (input) => {
      const log = input as BuildLog
      if (!log?.summary?.trim() || !Array.isArray(log.changes) || !Array.isArray(log.tests) || typeof log.blocked !== 'string' || typeof (log.remaining ?? '') !== 'string')
        throw new Error('summary, changes, tests and blocked are required')
      if (log.blocked.trim()) return log
      if (log.remaining?.trim()) {
        if (shortTime() === null) throw new Error('remaining is only for a turn whose alarm call has no time left. Finish the task, or say in blocked why you cannot.')
        return log
      }
      const unchanged = await checkBaseFiles('submit')
      const pending = await branch.pending()
      if (pending.changed.length > 0 || pending.diff.trim() !== '') throw new Error(`checkpoint first: uncommitted changes in ${pending.changed.join(', ') || 'deleted files'}`)
      const head = await branch.head()
      const changed = head === start ? [] : await branch.changedFiles(start, head)
      // In a base merge, the fixer can keep its side of each conflict. finishMerge then commits the merge with the tree of the start.
      if (!task.baseFiles && (head === start || changed.length === 0))
        throw new Error('no commits since the task started: checkpoint your work, or say in blocked why you cannot finish')
      const missing = changed.filter((path) => !unchanged.has(path) && !log.changes.some((change) => change.path.replace(/^\/repo\//, '') === path))
      if (missing.length > 0) throw new Error(`list every changed file in changes: missing ${missing.join(', ')}`)
      const refuse = (cause: string, failed: CheckResult[]) =>
        new Error([`${cause}. Fix the cause, checkpoint and submit again. When you cannot fix it, submit with the reason in blocked.`, ...failureText(failed)].join('\n'))
      const setupFailed = (failed: CheckResult[]) => failed.some(({ name }) => name === 'setup')
      // A command with no exit code, when the call has no time left, is a stop at the end of the call (D12).
      const cut = (failed: CheckResult[]) => shortTime() !== null && failed.some((result) => result.exit_code === null)
      // The CI of the base tested the files that a base merge brings unchanged, so the gate skips them (D16).
      const taskChanges = (await branch.changedFiles(task.base, head)).filter((path) => !unchanged.has(path))
      const runTests = checker.tests
      const tests = runTests ? await targetedTests(branch, context.config, taskChanges) : []
      if (runTests && tests.length > 0) {
        const failed = (await command(() => runTests(tests))).filter((result) => result.status !== 'pass')
        if (cut(failed)) return { ...log, remaining: cutGate('the targeted tests') }
        if (failed.length > 0)
          throw refuse(setupFailed(failed) ? `the setup failed, so the targeted tests (${tests.join(', ')}) did not run` : `the targeted tests failed (${tests.join(', ')})`, failed)
      }
      const ci = checker.ci
      if (!ci) return log
      // A skipped {files} command is not a failure.
      const failed = (await command(() => ci(taskChanges))).filter((result) => result.status === 'fail')
      if (failed.length === 0) return log
      if (cut(failed)) return { ...log, remaining: cutGate('the ci commands') }
      throw refuse(setupFailed(failed) ? 'the setup failed, so the ci commands did not run' : `the ci commands failed (${failed.map(({ name }) => name).join(', ')})`, failed)
    }),
  })
  const repo = allowFiles(guard(branch.tree, (path) => isProtected(context.config, path)), (path) => inScope(path, task.scope))
  const decided = decisionsFile(ledger)
  const workspace = await createWorkspace({ repo, review: { ...task.review, ...decided }, guides: context.guides.mounts })
  let prompt = [task.prompt, ...decisionsLine(decided)].join('\n')
  for (let part = 1; ; part++) {
    // The first turn keeps the request ID and the key of earlier runs, so that their journals and ledgers resume.
    const turn = part === 1 ? task.turn : { request: `${task.turn.request}-${part}`, key: `${task.turn.key}:${part}` }
    const spec = agent(context, task.id, developRoles.builder, task.model, workspace, tools(turn.key))
    const log = await runTurn<BuildLog>(context.host, spec, prompt, 'submit_build_log', turn)
    const remaining = log.remaining?.trim()
    if (!remaining || log.blocked.trim()) return log
    if (part === maxTaskTurns) return { ...log, remaining: '', blocked: `the task did not finish in ${maxTaskTurns} turns. What is left: ${remaining}` }
    prompt = continuePrompt(remaining)
  }
}
