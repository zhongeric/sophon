import type { Contracts } from 'nanocode-ts'
import type { CheckResult, RepoConfig } from '../checks.ts'
import type { Finding } from '../findings.ts'
import { findingQuestion, gate, settle, type GateResult, type Jev, type Policy } from '../gate.ts'
import { step, type Ledger } from '../ledger.ts'
import type { AgentStore, Checker, Files, Frozen, Guides, Repo } from '../platform.ts'
import type { Credentials, Provider } from '../providers.ts'
import { asker, decisions, type Answer, type Channel } from '../questions.ts'
import { roles, type ModelChoice } from '../roles.ts'
import { askQuestions, intent, patch, review, type PatchOutcome, type RunContext, type Verdict } from '../steps.ts'
import { StopError } from '../stop.ts'

export type LoopModels = {
  step1: Record<'minimize' | 'rules' | 'bugs' | 'anti-slop' | 'patch' | 'questions', ModelChoice>
  step2: Record<'late-minimize' | 'late-rules' | 'late-bugs' | 'patch' | 'intent', ModelChoice>
}

export const defaultModels: LoopModels = {
  step1: {
    minimize: { provider: 'claude', model: 'claude-fable-5-5' },
    rules: { provider: 'claude', model: 'claude-sonnet-5-5' },
    bugs: { provider: 'claude', model: 'claude-fable-5-5', thinking: 'high' },
    'anti-slop': { provider: 'claude', model: 'claude-sonnet-5-5' },
    patch: { provider: 'claude', model: 'claude-opus-5-5', thinking: 'high' },
    questions: { provider: 'claude', model: 'claude-sonnet-5-5' },
  },
  step2: {
    'late-minimize': { provider: 'codex', model: 'gpt-6.1-sol' },
    'late-rules': { provider: 'codex', model: 'gpt-6.1-sol' },
    'late-bugs': { provider: 'codex', model: 'gpt-6.1-sol', thinking: 'high' },
    patch: { provider: 'codex', model: 'gpt-6.1-sol', thinking: 'high' },
    intent: { provider: 'codex', model: 'gpt-6.1-sol' },
  },
}

/** The model-swap rule: every step 2 agent uses another model family than its step 1 counterpart. */
export function checkFamilySwap(models: LoopModels): void {
  const pairs = [
    ['late-minimize', 'minimize'],
    ['late-rules', 'rules'],
    ['late-bugs', 'bugs'],
    ['patch', 'patch'],
  ] as const
  const same = pairs.filter(([late, early]) => models.step2[late].provider === models.step1[early].provider)
  if (same.length > 0)
    throw new StopError(
      `step 2 must swap model families: ${same.map(([late, early]) => `step 2 ${late} and step 1 ${early} both use ${models.step1[early].provider}`).join('; ')}`,
    )
}

export function providersOf(models: LoopModels): Provider[] {
  return [...new Set([...Object.values(models.step1), ...Object.values(models.step2)].map((choice) => choice.provider))]
}

export type LoopInput = {
  /** What is under review, for the report, for example a path and refs, or owner/repo#pr. */
  source: string
  ask: string
  stack?: string
  runId: string
  config: RepoConfig
  models: LoopModels
  policy: Policy
  /** The PR under review, when there is one. Questions go to it. */
  pr?: number
  /** On PASS, push the fixes to the PR branch (fast-forward only) and mark the PR ready. */
  ship?: { pr: number; headRef: string }
}

/** What the platform supplies: a Node host on a laptop, or a Durable Object on Cloudflare. */
export type LoopDeps = {
  module: WebAssembly.Module
  ledger: Ledger
  repo: Repo
  checker: Checker
  /** Where the user answers questions. */
  channel: Channel
  files: Files
  store: AgentStore
  guides: Guides
  credentials: Credentials
  jev: Jev
  dispatch?: Contracts.RuntimeOptions['dispatch']
  log(line: string): void
}

export type Criterion = { name: string; ok: boolean; detail: string }
export type LoopResult = { pass: boolean; criteria: Criterion[]; branch: string; final: string; report: string }

/**
 * The code review loop of the code-review-loop skill, with its order and hard rules in code:
 * freeze, four read-only reviewers, Jev Gate, patch, a model-swapped second pass on the new diff,
 * a late bugs pass, checks, an intent check, and the PASS criteria. Every step is in the ledger,
 * so the same run ID resumes after a crash without repeating finished steps.
 */
export async function codeReviewLoop(input: LoopInput, deps: LoopDeps): Promise<LoopResult> {
  checkFamilySwap(input.models)
  const missing = providersOf(input.models).filter((provider) => !deps.credentials[provider])
  if (missing.length > 0) throw new StopError(`no credential for ${missing.join(', ')}`)

  const { ledger, repo } = deps
  ledger.put('input', input)
  const frozen = await step(ledger, 'freeze', () => repo.freeze())
  const stack = input.stack ?? input.config.stack
  const frozenChanges = await repo.changedFiles(frozen.base, frozen.head)
  const context: RunContext = {
    host: { module: deps.module, store: deps.store, ledger, credentials: deps.credentials, dispatch: deps.dispatch, log: deps.log },
    repo,
    frozen,
    config: input.config,
    ask: input.ask,
    stack,
    solidity: /solidity|foundry/i.test(stack) || frozenChanges.some((path) => path.endsWith('.sol')),
    guides: deps.guides,
    tests: deps.checker.tests,
  }
  deps.log(`froze ${frozen.head.slice(0, 12)} over base ${frozen.base.slice(0, 12)}: ${frozenChanges.length} files, ${frozen.location}`)

  const questions = asker(ledger, deps.channel, input.runId, deps.log)
  const gateLog = 'gate-log.txt'
  const runGate = async (name: string, header: string, findings: Finding[]): Promise<GateResult> => {
    const userDecisions = decisions(ledger).map(({ question, answer }) => ({ question, answer }))
    const judged = await step(ledger, name, () => gate(findings, input.ask, userDecisions, deps.jev, input.policy))
    let result = judged
    if (judged.held.length > 0) {
      // A held finding depends on a decision that only the user can make: ask before it reaches a patch agent.
      await questions.post(name, judged.held.map((finding, index) => findingQuestion(finding, `Q${index + 1}`)))
      const answers = await questions.wait(name)
      result = settle(judged, answers.map((answer, index) => ({ id: judged.held[index]!.id, answer: answer.answer })))
    }
    if (!ledger.get(`logged:${name}`)) {
      deps.files.append(gateLog, [header, ...result.log, ''].join('\n'))
      ledger.put(`logged:${name}`, true)
    }
    deps.log(`${name}: kept ${result.kept.length} of ${findings.length} findings`)
    return result
  }

  // Step 1: four read-only reviewers in parallel on the frozen change.
  const step1Range = { from: frozen.base, to: frozen.head }
  const step1Roles = ['minimize', 'rules', 'bugs', 'anti-slop'] as const
  const asked = step(ledger, 'step1.questions', () => askQuestions(context, 'step1.questions', input.models.step1.questions, step1Range)).then((list) =>
    questions.post('ask', list),
  )
  const step1 = await Promise.all(
    step1Roles.map((id) => step(ledger, `step1.${id}`, () => review(context, `step1.${id}`, roles[id], input.models.step1[id], step1Range, ''))),
  )
  await asked
  await questions.wait('ask')
  const gate1 = await runGate('step1.gate', familyHeader('Step 1', input.models.step1), step1.flat())
  const patch1 = await step(ledger, 'step1.patch', () =>
    patch(context, 'step1.patch', input.models.step1.patch, gate1.kept, gate1.log, `agent-factory: apply step 1 review fixes (${input.runId})`),
  )

  // Step 2: swapped model family, on the new diff only.
  let gate2: GateResult | null = null
  let patch2: PatchOutcome | null = null
  if (patch1.changed) {
    const range = { from: frozen.head, to: patch1.after }
    const note = 'This is the step 2 pass. The diff is the patch that the step 1 patch agent applied, not the original change.'
    const late = await Promise.all(
      (['late-minimize', 'late-rules'] as const).map((id) =>
        step(ledger, `step2.${id}`, () => review(context, `step2.${id}`, roles[id], input.models.step2[id], range, note)),
      ),
    )
    gate2 = await runGate('step2.gate', familyHeader('Step 2', input.models.step2), late.flat())
    patch2 = await step(ledger, 'step2.patch', () =>
      patch(context, 'step2.patch', input.models.step2.patch, gate2!.kept, gate2!.log, `agent-factory: apply step 2 review fixes (${input.runId})`),
    )
  }

  // Late bugs pass over every fix since the freeze.
  let current = patch2?.after ?? patch1.after
  let gate3: GateResult | null = null
  let patch3: PatchOutcome | null = null
  if (current !== frozen.head) {
    const range = { from: frozen.head, to: current }
    const note =
      'This is the late bugs pass. The diff holds every fix that the patch agents applied after the review froze the change. Check that each fix is correct and breaks nothing around it.'
    const bugs = await step(ledger, 'step2.late-bugs', () =>
      review(context, 'step2.late-bugs', roles['late-bugs'], input.models.step2['late-bugs'], range, note),
    )
    gate3 = await runGate('step2.late-bugs-gate', familyHeader('Step 2 late bugs', { 'late-bugs': input.models.step2['late-bugs'] }), bugs)
    patch3 = await step(ledger, 'step2.late-bugs-patch', () =>
      patch(context, 'step2.late-bugs-patch', input.models.step2.patch, gate3!.kept, gate3!.log, `agent-factory: apply late bugs fixes (${input.runId})`),
    )
    current = patch3.after
  }

  const finalChanges = await repo.changedFiles(frozen.base, current)
  deps.log(`running checks on ${finalChanges.length} changed files`)
  const checks = await step(ledger, 'checks', () => deps.checker.checks(finalChanges))
  const verdict = await step(ledger, 'intent', () => intent(context, 'intent', input.models.step2.intent, { from: frozen.base, to: current }))

  const patches = [patch1, patch2, patch3].filter((outcome): outcome is PatchOutcome => outcome !== null)
  const criteria = evaluate({ gateLog: deps.files.exists(gateLog), checks, verdict, patches, step2Ran: patch1.changed })
  const pass = criteria.every((criterion) => criterion.ok)
  if (pass && input.ship) {
    const { pr, headRef } = input.ship
    await step(ledger, 'ship', () => repo.ship({ pr, headRef }))
    criteria.push({ name: 'PR is ready, not draft', ok: true, detail: `pushed to ${headRef} and marked #${pr} ready` })
  }

  const report = renderReport({
    input,
    frozen,
    current,
    pass,
    criteria,
    step1,
    gates: { gate1, gate2, gate3 },
    patches: { patch1, patch2, patch3 },
    checks,
    verdict,
    decisions: decisions(ledger),
  })
  deps.files.write('report.md', report)
  ledger.put('result', { pass, criteria, final: current })
  return { pass, criteria, branch: frozen.branch, final: current, report }
}

function familyHeader(label: string, models: Record<string, ModelChoice>): string {
  const families = [...new Set(Object.values(models).map((choice) => choice.provider))].join('+')
  const list = Object.entries(models).map(([role, choice]) => `${role}=${choice.model}`).join(' ')
  return `# ${label} | model_family=${families} | ${list}`
}

function evaluate(run: { gateLog: boolean; checks: CheckResult[]; verdict: Verdict; patches: PatchOutcome[]; step2Ran: boolean }): Criterion[] {
  const failed = run.checks.filter((check) => check.status === 'fail')
  const skipped = run.patches.flatMap((outcome) => outcome.log?.skipped ?? [])
  return [
    {
      name: 'Step 1 and Step 2 ran with context-free reviewers',
      ok: true,
      detail: run.step2Ran ? 'each reviewer ran in a new session' : 'step 2 had no new diff: the step 1 patch changed nothing',
    },
    { name: 'Step 2 used another model family', ok: true, detail: 'checked before the run started, recorded in the gate log' },
    { name: 'Gate log written', ok: run.gateLog, detail: 'gate-log.txt' },
    {
      name: 'Checks green',
      ok: failed.length === 0,
      detail: failed.length === 0 ? run.checks.map((check) => `${check.name}=${check.status}`).join(', ') : `failed: ${failed.map((check) => check.name).join(', ')}`,
    },
    { name: 'Intent reviewer affirms the original ask', ok: run.verdict.satisfied, detail: run.verdict.satisfied ? run.verdict.summary : run.verdict.gaps.join('; ') },
    {
      name: 'No remaining kept criticals',
      ok: skipped.length === 0,
      detail: skipped.length === 0 ? 'the patch agents applied every kept finding' : `skipped: ${skipped.map((entry) => entry.id).join(', ')}`,
    },
  ]
}

type ReportInput = {
  input: LoopInput
  frozen: Frozen
  current: string
  pass: boolean
  criteria: Criterion[]
  step1: Finding[][]
  gates: Record<'gate1' | 'gate2' | 'gate3', GateResult | null>
  patches: Record<'patch1' | 'patch2' | 'patch3', PatchOutcome | null>
  checks: CheckResult[]
  verdict: Verdict
  decisions: Answer[]
}

function renderReport(run: ReportInput): string {
  const short = (sha: string) => sha.slice(0, 12)
  const gateLine = (label: string, result: GateResult | null) =>
    result ? `- ${label}: kept ${result.kept.length} of ${result.decisions.length}${result.kept.length ? ` (${result.kept.map((finding) => finding.id).join(', ')})` : ''}` : `- ${label}: did not run`
  const patchLine = (label: string, outcome: PatchOutcome | null) => {
    if (!outcome) return `- ${label}: did not run`
    if (!outcome.log) return `- ${label}: nothing to apply`
    const applied = outcome.log.applied.map((entry) => `${entry.id} (${entry.change})`).join('; ') || 'none'
    const skipped = outcome.log.skipped.map((entry) => `${entry.id} (${entry.reason})`).join('; ') || 'none'
    const scope = outcome.outOfScope.length ? `; edits outside the change and the findings: ${outcome.outOfScope.join(', ')}` : ''
    return `- ${label}: ${outcome.changed ? `commit ${short(outcome.after)}` : 'no commit'}; applied: ${applied}; skipped: ${skipped}${scope}`
  }
  return [
    `# Code review loop: ${run.pass ? 'PASS' : 'FAIL'}`,
    '',
    `- Run: ${run.input.runId}`,
    `- Source: ${run.input.source}`,
    `- Reviewed: ${short(run.frozen.base)}..${short(run.frozen.head)}`,
    `- Fixes: branch ${run.frozen.branch} at ${short(run.current)} (${run.frozen.location})`,
    '',
    '## Criteria',
    '',
    ...run.criteria.map((criterion) => `- [${criterion.ok ? 'x' : ' '}] ${criterion.name}: ${criterion.detail}`),
    '',
    '## Steps',
    '',
    `- Step 1 findings: ${(['minimize', 'rules', 'bugs', 'anti-slop'] as const).map((id, index) => `${id}=${run.step1[index]?.length ?? 0}`).join(', ')}`,
    gateLine('Step 1 gate', run.gates.gate1),
    patchLine('Step 1 patch', run.patches.patch1),
    gateLine('Step 2 gate', run.gates.gate2),
    patchLine('Step 2 patch', run.patches.patch2),
    gateLine('Late bugs gate', run.gates.gate3),
    patchLine('Late bugs patch', run.patches.patch3),
    '',
    '## Checks',
    '',
    ...run.checks.map((check) => `- ${check.name}: ${check.status}${check.command ? ` (\`${check.command}\`)` : ''}`),
    '',
    '## Intent',
    '',
    run.verdict.summary,
    ...run.verdict.gaps.map((gap) => `- gap: ${gap}`),
    '',
    '## Your decisions',
    '',
    ...(run.decisions.length > 0 ? run.decisions.map((answer) => `- ${answer.question} **${answer.answer}**${answer.recommended ? ' (recommended)' : ''}`) : ['- none asked']),
    '',
  ].join('\n')
}
