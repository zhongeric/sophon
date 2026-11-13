import type { Finding, Severity } from './findings.ts'

/**
 * What happens to a finding after the evidence check: the patch agents get it (`keep`), the user decides
 * it first (`ask`), or the user decided against it (`drop`).
 */
export type Decision = {
  finding: Finding
  action: 'keep' | 'drop' | 'ask'
  reason: 'needs_decision' | 'user_decision' | null
  note?: string
}

export type GateResult = { kept: Finding[]; held: Finding[]; decisions: Decision[]; log: string[] }

/** What the user answered about one held finding. */
export type UserDecision = { id: string; answer: string }

export const fixOption = 'Fix it'
export const skipOption = 'Do not fix it'

const severityRank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

/**
 * Orders the findings by severity and holds the ones that a reviewer marked as the user's decision. Every finding
 * here already passed the evidence check, so the patch agents get the rest, and they apply or reject each one.
 */
export function gate(findings: Finding[]): GateResult {
  const ordered = [...findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
  return summarize(
    ordered.map((finding): Decision => (finding.needs_decision ? { finding, action: 'ask', reason: 'needs_decision' } : { finding, action: 'keep', reason: null })),
  )
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
    why: `${finding.decision ?? 'The right fix depends on a decision that the ask leaves open.'} Trigger: ${finding.trigger}. Impact: ${finding.impact}. Suggested fix: ${finding.recommendation}.`,
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

export const acceptRejection = 'Accept the rejection'
export const refuseRejection = 'Do not accept'

/** Asks the user about a critical or high finding that a patch agent did not apply. */
export function rejectionQuestion(finding: Finding, reason: string, id: string) {
  return {
    id,
    question: `The patch agent did not apply ${finding.id} (${finding.severity}) at ${finding.location}: ${finding.title}. Accept that?`,
    why: `The patch agent's reason: ${reason}. Trigger: ${finding.trigger}. Impact: ${finding.impact}.`,
    options: [acceptRejection, refuseRejection],
    recommendation: refuseRejection,
  }
}

export function formatDecision({ finding, action, reason, note }: Decision): string {
  return [
    `FINDING ${finding.id}`,
    `track=${finding.track}`,
    `severity=${finding.severity}`,
    `ACTION=${action}${reason ? ` reason=${reason}` : ''}${note ? ` note=${JSON.stringify(note)}` : ''}`,
  ].join(' | ')
}
