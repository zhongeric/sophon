import type { Contracts } from 'nanocode-ts'
import type { CheckResult, RepoConfig } from '../checks.ts'
import { assignIds, type Finding } from '../findings.ts'
import { acceptRejection, findingQuestion, gate, rejectionQuestion, settle, type GateResult } from '../gate.ts'
import { step, type Ledger } from '../ledger.ts'
import type { AgentStore, Checker, Files, Frozen, Guides, Repo } from '../platform.ts'
import { isLight, profilesById, staticFindings, triage, triageLine, type Triage } from '../profiles.ts'
import type { Credentials, Provider } from '../providers.ts'
import { asker, decisions, type Answer, type Channel } from '../questions.ts'
import { roles, type ModelChoice } from '../roles.ts'
import { askQuestions, intent, light, patch, review, type LightLog, type PatchLog, type PatchOutcome, type Range, type RunContext, type Verdict } from '../steps.ts'
import { StopError } from '../stop.ts'

export type LoopModels = {
  step1: Record<'minimize' | 'rules' | 'bugs' | 'anti-slop' | 'patch' | 'questions', ModelChoice>
  step2: Record<'late-minimize' | 'late-rules' | 'late-bugs' | 'patch' | 'intent', ModelChoice>
  /** The one reviewer and fixer of the light loop. */
  light: ModelChoice
}

/** The models that a run accepts when the host sets no ALLOWED_MODELS: Fable, Opus 5.5 and Sol. The default models use only these. */
export const defaultAllowedModels = ['claude-fable-5-2', 'claude-opus-5-5', 'gpt-6.1-sol']

/** The ALLOWED_MODELS setting: model IDs, comma-separated. When it is empty, the default list applies. */
export function allowedModelsFrom(setting: string | undefined): string[] {
  const models = (setting ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
  return models.length > 0 ? models : defaultAllowedModels
}

const fable: ModelChoice = { provider: 'claude', model: 'claude-fable-5-2' }
const opus: ModelChoice = { provider: 'claude', model: 'claude-opus-5-5' }
const sol: ModelChoice = { provider: 'codex', model: 'gpt-6.1-sol' }

/** Step 1 spreads the tracks over the three models for variance. Each step 2 role swaps the family of its step 1 counterpart. */
export const defaultModels: LoopModels = {
  step1: {
    minimize: opus,
    rules: sol,
    bugs: { ...fable, thinking: 'high' },
    'anti-slop': opus,
    patch: { ...opus, thinking: 'high' },
    questions: opus,
  },
  step2: {
    'late-minimize': sol,
    'late-rules': fable,
    'late-bugs': { ...sol, thinking: 'high' },
    patch: { ...sol, thinking: 'high' },
    intent: opus,
  },
  light: opus,
}

/** The default models, with the overrides of a models file or of the MODELS setting. */
export function mergeModels(overrides: Partial<LoopModels>): LoopModels {
  return { step1: { ...defaultModels.step1, ...overrides.step1 }, step2: { ...defaultModels.step2, ...overrides.step2 }, light: overrides.light ?? defaultModels.light }
}

const choices = (models: LoopModels) => [...Object.values(models.step1), ...Object.values(models.step2), models.light]

export function checkAllowedModels(models: LoopModels, allowed = defaultAllowedModels): void {
  const used = choices(models).map((choice) => choice.model)
  const refused = [...new Set(used.filter((model) => !allowed.includes(model)))]
  if (refused.length > 0) throw new StopError(`models outside the allowed list (${allowed.join(', ')}): ${refused.join(', ')}`)
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
  return [...new Set(choices(models).map((choice) => choice.provider))]
}

export type LoopInput = {
  /** What is under review, for the report, for example a path and refs, or owner/repo#pr. */
  source: string
  ask: string
  stack?: string
  runId: string
  config: RepoConfig
  models: LoopModels
  /** The models that the run accepts. Default: defaultAllowedModels. */
  allowedModels?: string[]
  /** The PR under review, when there is one. Questions go to it. */
  pr?: number
  /** On PASS, push the fixes to the PR branch (fast-forward only) and mark the PR ready. */
  ship?: { pr: number; headRef: string }
  /** Run the full loop, also when triage allows the light loop. */
  full?: boolean
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
  dispatch?: Contracts.RuntimeOptions['dispatch']
  log(line: string): void
}

export type Criterion = { name: string; ok: boolean; detail: string }
export type LoopResult = { pass: boolean; criteria: Criterion[]; branch: string; final: string; report: string }

/**
 * The code review loop, with its order and hard rules in code. Triage picks the light
 * loop for a docs or tests only change: one fresh reviewer that also fixes. Else the full loop runs: four read-only
 * reviewers, the gate, patch, a model-swapped second pass on the new diff, and a late bugs pass. The static rules of
 * the matched profiles add host findings before each gate. Checks, the intent check of the full loop, and the PASS
 * criteria come last. Every step is in the ledger, so the same run ID resumes after a crash without repeating
 * finished steps.
 */
export async function codeReviewLoop(input: LoopInput, deps: LoopDeps): Promise<LoopResult> {
  checkAllowedModels(input.models, input.allowedModels)
  checkFamilySwap(input.models)
  const missing = providersOf(input.models).filter((provider) => !deps.credentials[provider])
  if (missing.length > 0) throw new StopError(`no credential for ${missing.join(', ')}`)

  const { ledger, repo } = deps
  ledger.put('input', input)
  const frozen = await step(ledger, 'freeze', () => repo.freeze())
  const stack = input.stack ?? input.config.stack
  // Triage also sees deleted files and the old path of each rename, so that a removal of code gets the full loop.
  const touched = await repo.touchedFiles(frozen.base, frozen.head)
  const triaged = await step(ledger, 'triage', () => triage(touched, async (path) => (await repo.tree.stat(`/${path}`)) !== null, input.full === true))
  const active = profilesById(triaged.profiles)
  const context: RunContext = {
    host: { module: deps.module, store: deps.store, ledger, credentials: deps.credentials, dispatch: deps.dispatch, log: deps.log },
    repo,
    frozen,
    config: input.config,
    ask: input.ask,
    stack,
    stackGuides: triaged.guides,
    guides: deps.guides,
    tests: deps.checker.tests,
  }
  deps.log(`froze ${frozen.head.slice(0, 12)} over base ${frozen.base.slice(0, 12)}: ${touched.length} files, ${frozen.location}`)
  deps.log(triageLine(triaged))

  const questions = asker(ledger, deps.channel, input.runId, deps.log)
  const gateLog = 'gate-log.txt'
  if (!ledger.get('logged:triage')) {
    deps.files.append(gateLog, `${triageLine(triaged)}\n\n`)
    ledger.put('logged:triage', true)
  }
  const runGate = async (name: string, header: string, findings: Finding[]): Promise<GateResult> => {
    const judged = await step(ledger, name, async () => gate(findings))
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
    deps.log(`${name}: ${result.kept.length} of ${findings.length} findings go to the patch agent`)
    return result
  }

  const hostCheck = (name: string, range: Range, prefix: string) =>
    step(ledger, name, async () =>
      assignIds(staticFindings(await repo.diff(range.from, range.to), await repo.changedFiles(range.from, range.to), active), 'rules', prefix),
    )

  // A patch agent may reject a finding with a reason. A rejected critical or high finding goes to the user.
  const rejections: { id: string; accepted: boolean }[] = []
  const runPatch = async <Log extends PatchLog>(name: string, result: GateResult, run: () => Promise<PatchOutcome<Log>>): Promise<PatchOutcome<Log>> => {
    const outcome = await step(ledger, name, run)
    const rejected = (outcome.log?.skipped ?? []).flatMap((entry) => {
      const finding = result.kept.find((item) => item.id === entry.id)
      return finding && (finding.severity === 'critical' || finding.severity === 'high') ? [{ finding, reason: entry.reason }] : []
    })
    if (rejected.length > 0) {
      const batch = `${name}.rejections`
      await questions.post(batch, rejected.map(({ finding, reason }, index) => rejectionQuestion(finding, reason, `Q${index + 1}`)))
      const answers = await questions.wait(batch)
      rejections.push(...rejected.map(({ finding }, index) => ({ accepted: answers[index]?.answer === acceptRejection, id: finding.id })))
    }
    return outcome
  }

  // The light loop: host findings, then one agent that reviews the change, fixes it, and applies or rejects them.
  const lightLoop = async () => {
    const found = await hostCheck('light.host', { from: frozen.base, to: frozen.head }, 'host')
    const gated = await runGate('light.gate', familyHeader('Light', { light: input.models.light }), found)
    const outcome = await runPatch('light', gated, () =>
      light(context, 'light', input.models.light, {
        allow: (path) => isLight(path, active),
        gateLog: gated.log,
        kept: gated.kept,
        message: `agent-factory: apply light review fixes (${input.runId})`,
      }),
    )
    return { current: outcome.after, step2Ran: false, steps: [`- Host findings: ${found.length}`, gateLine('Light gate', gated), patchLine('Light review', outcome)] }
  }

  const fullLoop = async () => {
    // Step 1: four read-only reviewers in parallel on the frozen change.
    const step1Range = { from: frozen.base, to: frozen.head }
    const step1Roles = ['minimize', 'rules', 'bugs', 'anti-slop'] as const
    const asked = step(ledger, 'step1.questions', () => askQuestions(context, 'step1.questions', input.models.step1.questions, step1Range)).then((list) =>
      questions.post('ask', list),
    )
    const step1 = await Promise.all(
      step1Roles.map((id) => step(ledger, `step1.${id}`, () => review(context, `step1.${id}`, roles[id], input.models.step1[id], step1Range, ''))),
    )
    const host1 = await hostCheck('step1.host', step1Range, 'host')
    await asked
    await questions.wait('ask')
    const gate1 = await runGate('step1.gate', familyHeader('Step 1', input.models.step1), [...host1, ...step1.flat()])
    const patch1 = await runPatch('step1.patch', gate1, () =>
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
      const host2 = await hostCheck('step2.host', range, 'late-host')
      const gated = await runGate('step2.gate', familyHeader('Step 2', input.models.step2), [...host2, ...late.flat()])
      gate2 = gated
      patch2 = await runPatch('step2.patch', gated, () =>
        patch(context, 'step2.patch', input.models.step2.patch, gated.kept, gated.log, `agent-factory: apply step 2 review fixes (${input.runId})`),
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
      // The step 2 patch is the one commit that no host check saw yet.
      const host3 = patch2?.changed ? await hostCheck('step2.late-bugs-host', { from: patch2.before, to: patch2.after }, 'late-bugs-host') : []
      const gated = await runGate('step2.late-bugs-gate', familyHeader('Step 2 late bugs', { 'late-bugs': input.models.step2['late-bugs'] }), [...host3, ...bugs])
      gate3 = gated
      patch3 = await runPatch('step2.late-bugs-patch', gated, () =>
        patch(context, 'step2.late-bugs-patch', input.models.step2.patch, gated.kept, gated.log, `agent-factory: apply late bugs fixes (${input.runId})`),
      )
      current = patch3.after
    }

    const steps = [
      `- Step 1 findings: host=${host1.length}, ${step1Roles.map((id, index) => `${id}=${step1[index]!.length}`).join(', ')}`,
      gateLine('Step 1 gate', gate1),
      patchLine('Step 1 patch', patch1),
      gateLine('Step 2 gate', gate2),
      patchLine('Step 2 patch', patch2),
      gateLine('Late bugs gate', gate3),
      patchLine('Late bugs patch', patch3),
    ]
    return { current, step2Ran: patch1.changed, steps }
  }

  const { current, step2Ran, steps } = triaged.path === 'light' ? await lightLoop() : await fullLoop()
  const finalChanges = await repo.changedFiles(frozen.base, current)
  deps.log(`running checks on ${finalChanges.length} changed files`)
  const checks = await step(ledger, 'checks', () => deps.checker.checks(finalChanges))
  const verdict =
    triaged.path === 'full' ? await step(ledger, 'intent', () => intent(context, 'intent', input.models.step2.intent, { from: frozen.base, to: current })) : null

  const criteria = evaluate({ checks, gateLog: deps.files.exists(gateLog), rejections, step2Ran, verdict })
  const pass = criteria.every((criterion) => criterion.ok)
  if (pass && input.ship) {
    const { pr, headRef } = input.ship
    await step(ledger, 'ship', () => repo.ship({ pr, headRef }))
    criteria.push({ name: 'PR is ready, not draft', ok: true, detail: `pushed to ${headRef} and marked #${pr} ready` })
  }

  const report = renderReport({ input, frozen, current, pass, criteria, triage: triaged, steps, checks, verdict, decisions: decisions(ledger) })
  deps.files.write('report.md', report)
  ledger.put('result', { pass, criteria, final: current })
  return { pass, criteria, branch: frozen.branch, final: current, report }
}

function familyHeader(label: string, models: Record<string, ModelChoice>): string {
  const families = [...new Set(Object.values(models).map((choice) => choice.provider))].join('+')
  const list = Object.entries(models).map(([role, choice]) => `${role}=${choice.model}`).join(' ')
  return `# ${label} | model_family=${families} | ${list}`
}

/** The PASS criteria. A null verdict means the light loop, which has no second pass and no intent check. */
function evaluate(run: { gateLog: boolean; checks: CheckResult[]; verdict: Verdict | null; rejections: { id: string; accepted: boolean }[]; step2Ran: boolean }): Criterion[] {
  const failed = run.checks.filter((check) => check.status === 'fail')
  const refused = run.rejections.filter((rejection) => !rejection.accepted)
  const passes: Criterion[] = run.verdict
    ? [
        {
          name: 'Step 1 and Step 2 ran with context-free reviewers',
          ok: true,
          detail: run.step2Ran ? 'each reviewer ran in a new session' : 'step 2 had no new diff: the step 1 patch changed nothing',
        },
        { name: 'Step 2 used another model family', ok: true, detail: 'checked before the run started, recorded in the gate log' },
      ]
    : [{ name: 'Light loop on a docs or tests only change', ok: true, detail: 'one context-free reviewer that fixes, with writes limited to docs and tests' }]
  return [
    ...passes,
    { name: 'Gate log written', ok: run.gateLog, detail: 'gate-log.txt' },
    {
      name: 'Checks green',
      ok: failed.length === 0,
      detail: failed.length === 0 ? run.checks.map((check) => `${check.name}=${check.status}`).join(', ') : `failed: ${failed.map((check) => check.name).join(', ')}`,
    },
    ...(run.verdict
      ? [{ name: 'Intent reviewer affirms the original ask', ok: run.verdict.satisfied, detail: run.verdict.satisfied ? run.verdict.summary : run.verdict.gaps.join('; ') }]
      : []),
    {
      name: 'No critical or high finding left unapplied without your OK',
      ok: refused.length === 0,
      detail:
        refused.length > 0
          ? `you did not accept the rejection of ${refused.map((rejection) => rejection.id).join(', ')}`
          : run.rejections.length > 0
            ? `you accepted the rejection of ${run.rejections.map((rejection) => rejection.id).join(', ')}`
            : 'the patch agents applied every critical and high finding',
    },
  ]
}

const short = (sha: string) => sha.slice(0, 12)

function gateLine(label: string, result: GateResult | null): string {
  if (!result) return `- ${label}: did not run`
  const kept = result.kept.length ? ` (${result.kept.map((finding) => finding.id).join(', ')})` : ''
  return `- ${label}: kept ${result.kept.length} of ${result.decisions.length}${kept}`
}

function patchLine(label: string, outcome: PatchOutcome<PatchLog | LightLog> | null): string {
  if (!outcome) return `- ${label}: did not run`
  if (!outcome.log) return `- ${label}: nothing to apply`
  const applied = outcome.log.applied.map((entry) => `${entry.id} (${entry.change})`).join('; ') || 'none'
  const skipped = outcome.log.skipped.map((entry) => `${entry.id} (${entry.reason})`).join('; ') || 'none'
  const fixes = 'fixes' in outcome.log ? `; other fixes: ${outcome.log.fixes.map((fix) => `${fix.location} (${fix.change})`).join('; ') || 'none'}` : ''
  const scope = outcome.outOfScope.length ? `; edits outside the change and the findings: ${outcome.outOfScope.join(', ')}` : ''
  return `- ${label}: ${outcome.changed ? `commit ${short(outcome.after)}` : 'no commit'}; applied: ${applied}; skipped: ${skipped}${fixes}${scope}`
}

type ReportInput = {
  input: LoopInput
  frozen: Frozen
  current: string
  pass: boolean
  criteria: Criterion[]
  triage: Triage
  steps: string[]
  checks: CheckResult[]
  verdict: Verdict | null
  decisions: Answer[]
}

function renderReport(run: ReportInput): string {
  return [
    `# Code review loop${run.triage.path === 'light' ? ' (light)' : ''}: ${run.pass ? 'PASS' : 'FAIL'}`,
    '',
    `- Run: ${run.input.runId}`,
    `- Source: ${run.input.source}`,
    `- Reviewed: ${short(run.frozen.base)}..${short(run.frozen.head)}`,
    `- Fixes: branch ${run.frozen.branch} at ${short(run.current)} (${run.frozen.location})`,
    `- Triage: \`${triageLine(run.triage)}\``,
    '',
    '## Criteria',
    '',
    ...run.criteria.map((criterion) => `- [${criterion.ok ? 'x' : ' '}] ${criterion.name}: ${criterion.detail}`),
    '',
    '## Steps',
    '',
    ...run.steps,
    '',
    '## Checks',
    '',
    ...run.checks.map((check) => `- ${check.name}: ${check.status}${check.command ? ` (\`${check.command}\`)` : ''}`),
    '',
    ...(run.verdict ? ['## Intent', '', run.verdict.summary, ...run.verdict.gaps.map((gap) => `- gap: ${gap}`), ''] : []),
    '## Your decisions',
    '',
    ...(run.decisions.length > 0 ? run.decisions.map((answer) => `- ${answer.question} **${answer.answer}**${answer.recommended ? ' (recommended)' : ''}`) : ['- none asked']),
    '',
  ].join('\n')
}
