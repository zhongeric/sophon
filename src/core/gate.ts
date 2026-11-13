import type { Finding, Severity } from './findings.ts'

/** Thresholds of the Jev Gate. Tune them here, not in the questions to Jev. */
export type Policy = {
  critical: number
  criticalSeverity: number
  allowHigh: boolean
  highSeverity: number
  highCritical: number
  highConfidence: number
  duplicate: number
  needsUser: number
}

export const defaultPolicy: Policy = {
  critical: 0.75,
  criticalSeverity: 3.0,
  allowHigh: false,
  highSeverity: 2.5,
  highCritical: 0.6,
  highConfidence: 0.5,
  duplicate: 0.7,
  needsUser: 0.7,
}

export type Judgment = {
  keep_drop: 'keep' | 'drop'
  confidence: number
  is_critical: number
  severity: number
  duplicate: { id: string; noul: number } | null
  needs_user: number
}

/** `ask` holds a finding that would be kept until the user decides it. */
export type Decision = {
  finding: Finding
  judgment: Judgment
  action: 'keep' | 'drop' | 'ask'
  reason: 'keep_drop' | 'below_bar' | 'duplicate' | 'needs_user' | 'user_decision' | null
  note?: string
}

export type GateResult = { kept: Finding[]; held: Finding[]; decisions: Decision[]; log: string[] }

/** What the user decided on the user-facing question about one held finding. */
export type UserDecision = { id: string; answer: string }

export const fixOption = 'Fix it'
export const skipOption = 'Do not fix it'

type Answer = { type: string; choice?: string; confidence?: number; noul?: number; score?: number }
export type SystemOneResponse = { answers: Record<string, Answer> }

/** Sends one System One request to Jev. */
export type Jev = (request: unknown) => Promise<SystemOneResponse>

const systemOneUrl = 'https://api.typesafe.ai/v1/systemone'
const jevModel = 'jev-latest'
const jevAttempts = 3
const jevBackoffMs = 1_000

export function jevClient(apiKey: string, fetcher: typeof fetch = fetch, url = systemOneUrl): Jev {
  return async (request) => {
    for (let attempt = 1; ; attempt++) {
      const response = await fetcher(url, {
        body: JSON.stringify(request),
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        method: 'POST',
      })
      if (response.ok) return (await response.json()) as SystemOneResponse
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt === jevAttempts)
        throw new Error(`Jev answered HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
      await new Promise((resolve) => setTimeout(resolve, jevBackoffMs * attempt))
    }
  }
}

const severityRank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

/**
 * Gates every finding through Jev, strongest claimed severity first, so that a duplicate
 * of an already kept (or held) finding is dropped in favor of the earlier one.
 */
export async function gate(findings: Finding[], originalAsk: string, userDecisions: { question: string; answer: string }[], jev: Jev, policy: Policy): Promise<GateResult> {
  const ordered = [...findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
  const candidates: Finding[] = []
  const decisions: Decision[] = []
  for (const finding of ordered) {
    const response = await jev(gateRequest(finding, originalAsk, userDecisions, candidates))
    const judgment = readJudgment(response, candidates)
    const decision = decide(finding, judgment, policy)
    if (decision.action !== 'drop') candidates.push(finding)
    decisions.push(decision)
  }
  return summarize(decisions)
}

function summarize(decisions: Decision[]): GateResult {
  const pick = (action: Decision['action']) => decisions.filter((decision) => decision.action === action).map((decision) => decision.finding)
  return { kept: pick('keep'), held: pick('ask'), decisions, log: decisions.map(formatDecision) }
}

/** The question that asks the user to decide one held finding. */
export function findingQuestion(finding: Finding, id: string) {
  return {
    id,
    question: `${finding.id} at ${finding.location}: ${finding.title}. Fix it?`,
    why: `Trigger: ${finding.trigger}. Impact: ${finding.impact}. Suggested fix: ${finding.recommendation}. The right fix depends on a decision that the ask leaves open.`,
    options: [fixOption, skipOption],
    recommendation: fixOption,
  }
}

/** Applies the user's answers to the held findings. Any answer other than "Do not fix it" keeps the finding, with the answer as a note. */
export function settle(result: GateResult, answers: UserDecision[]): GateResult {
  const decisions = result.decisions.map((decision): Decision => {
    if (decision.action !== 'ask') return decision
    const answer = answers.find((entry) => entry.id === decision.finding.id)
    if (!answer) throw new Error(`no answer for held finding ${decision.finding.id}`)
    const skip = answer.answer === skipOption || /^(skip|no|do not|don't)\b/i.test(answer.answer)
    return { ...decision, action: skip ? 'drop' : 'keep', reason: 'user_decision', ...(answer.answer === fixOption ? {} : { note: answer.answer }) }
  })
  return summarize(decisions)
}

function gateRequest(finding: Finding, originalAsk: string, userDecisions: { question: string; answer: string }[], kept: Finding[]) {
  const questions: Record<string, unknown> = {
    keep_drop: {
      type: 'choice',
      instructions:
        'Should the coding agent act on `finding` before ship? Prefer drop for style-only or speculative items without clear trigger and impact.',
      criteria: {
        keep: 'Real defect or mandatory rule break with clear trigger and impact; must fix before PR',
        drop: 'Noise, preference, duplicate, or lacks trigger/impact/evidence',
      },
    },
    is_critical: {
      type: 'noul',
      instructions: 'Is `finding` critical to fix before merge?',
      criteria: {
        true: 'Correctness bug, security issue, broken ask, or will fail CI/review bot',
        false: 'Cosmetic, optional cleanup, or deferred nicety',
      },
    },
    severity: {
      type: 'score',
      instructions: 'How severe is `finding` for shipping this change?',
      criteria: [
        'Informational or pure style; safe to ignore for this PR',
        'Low: minor quality issue; no user harm',
        'Medium: real defect or rule break with limited blast radius',
        'High: significant incorrect behavior, funds risk, or broken ask',
        'Critical: exploitability, data loss, or blockers for merge',
      ],
    },
    needs_user: {
      type: 'noul',
      instructions:
        'Does the right action on `finding` depend on a product or design decision that only the user can make, such as intended behavior, API shape, or scope, which `original_ask` and `user_decisions` leave open?',
      criteria: {
        true: 'The fix, or whether to fix, depends on a choice that the ask and the decisions leave open',
        false: 'The ask, the decisions, or the code settle what to do',
      },
    },
  }
  for (const [index, existing] of kept.entries())
    questions[`same_as_kept_${index}`] = {
      type: 'noul',
      instructions: {
        candidate_existing: { id: existing.id, location: existing.location, title: existing.title, trigger: existing.trigger, impact: existing.impact },
        question: 'Is `finding` the same underlying issue as `candidate_existing` (same root cause and fix locus)?',
      },
      criteria: { true: 'One fix would resolve both; same root cause', false: 'Distinct issues needing separate fixes' },
    }
  const { severity, ...claimed } = finding
  return {
    model: jevModel,
    state: {
      original_ask: originalAsk,
      user_decisions: userDecisions,
      finding: { ...claimed, severity_claimed: severity },
      already_kept: kept.map(({ id, location, title }) => ({ id, location, title })),
    },
    questions,
  }
}

function readJudgment(response: SystemOneResponse, kept: Finding[]): Judgment {
  const answer = (name: string) => {
    const value = response.answers[name]
    if (!value) throw new Error(`Jev returned no answer for ${name}`)
    return value
  }
  const keepDrop = answer('keep_drop')
  if (keepDrop.choice !== 'keep' && keepDrop.choice !== 'drop') throw new Error(`Jev keep_drop choice is ${keepDrop.choice}`)
  let duplicate: Judgment['duplicate'] = null
  for (const [index, existing] of kept.entries()) {
    const noul = answer(`same_as_kept_${index}`).noul ?? 0
    if (!duplicate || noul > duplicate.noul) duplicate = { id: existing.id, noul }
  }
  return {
    keep_drop: keepDrop.choice,
    confidence: keepDrop.confidence ?? 0,
    is_critical: answer('is_critical').noul ?? 0,
    severity: answer('severity').score ?? 0,
    duplicate,
    needs_user: answer('needs_user').noul ?? 0,
  }
}

export function decide(finding: Finding, judgment: Judgment, policy: Policy): Decision {
  const drop = (reason: Decision['reason']): Decision => ({ finding, judgment, action: 'drop', reason })
  if (judgment.keep_drop !== 'keep') return drop('keep_drop')
  const critical = judgment.is_critical >= policy.critical || judgment.severity >= policy.criticalSeverity
  const high =
    policy.allowHigh &&
    judgment.severity >= policy.highSeverity &&
    judgment.is_critical >= policy.highCritical &&
    judgment.confidence >= policy.highConfidence
  if (!critical && !high) return drop('below_bar')
  if (judgment.duplicate && judgment.duplicate.noul >= policy.duplicate) return drop('duplicate')
  if (judgment.needs_user >= policy.needsUser) return { finding, judgment, action: 'ask', reason: 'needs_user' }
  return { finding, judgment, action: 'keep', reason: null }
}

export function formatDecision({ finding, judgment, action, reason, note }: Decision): string {
  const dup = reason === 'duplicate' && judgment.duplicate ? `${judgment.duplicate.id}@${judgment.duplicate.noul.toFixed(2)}` : 'none'
  const asked = reason === 'needs_user' || reason === 'user_decision'
  return [
    `FINDING ${finding.id}`,
    `keep_drop=${judgment.keep_drop} conf=${judgment.confidence.toFixed(2)}`,
    `is_critical=${judgment.is_critical.toFixed(2)}`,
    `severity=${judgment.severity.toFixed(1)}`,
    `dup=${dup}`,
    ...(asked ? [`needs_user=${judgment.needs_user.toFixed(2)}`] : []),
    `ACTION=${action}${reason ? ` reason=${reason}` : ''}${note ? ` note=${JSON.stringify(note)}` : ''}`,
  ].join(' | ')
}
