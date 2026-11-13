import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Finding } from '../src/core/findings.ts'
import { decide, defaultPolicy, findingQuestion, formatDecision, gate, settle, skipOption, type Jev, type Judgment } from '../src/core/gate.ts'

const finding = (id: string, severity: Finding['severity']): Finding => ({
  id,
  track: 'bugs',
  location: 'src/Vault.sol:88',
  title: id,
  trigger: 'reenter withdraw',
  impact: 'drain vault',
  severity,
  evidence: 'token.transfer',
  recommendation: 'update first',
})
const judged = (overrides: Partial<Judgment>): Judgment => ({ keep_drop: 'keep', confidence: 0.9, is_critical: 0.9, severity: 3.5, duplicate: null, needs_user: 0, ...overrides })

test('the gate keeps only keep_drop=keep findings over the critical bar', () => {
  const f = finding('bugs-001', 'high')
  assert.equal(decide(f, judged({}), defaultPolicy).action, 'keep')
  assert.equal(decide(f, judged({ keep_drop: 'drop' }), defaultPolicy).reason, 'keep_drop')
  assert.equal(decide(f, judged({ is_critical: 0.5, severity: 2.0 }), defaultPolicy).reason, 'below_bar')
  assert.equal(decide(f, judged({ is_critical: 0.5, severity: 3.0 }), defaultPolicy).action, 'keep')
})

test('high findings pass only with allowHigh and the high bar', () => {
  const f = finding('bugs-001', 'high')
  const high = judged({ is_critical: 0.65, severity: 2.7, confidence: 0.6 })
  assert.equal(decide(f, high, defaultPolicy).reason, 'below_bar')
  assert.equal(decide(f, high, { ...defaultPolicy, allowHigh: true }).action, 'keep')
  assert.equal(decide(f, { ...high, confidence: 0.4 }, { ...defaultPolicy, allowHigh: true }).reason, 'below_bar')
})

test('the gate asks about every kept finding and drops duplicates of earlier kept ones', async () => {
  const asked: string[][] = []
  const jev: Jev = async (request) => {
    const questions = Object.keys((request as { questions: Record<string, unknown> }).questions)
    asked.push(questions)
    const answers: Record<string, { type: string; choice?: string; confidence?: number; noul?: number; score?: number }> = {
      keep_drop: { type: 'choice', choice: 'keep', confidence: 0.9 },
      is_critical: { type: 'noul', noul: 0.9 },
      severity: { type: 'score', score: 3.4 },
      needs_user: { type: 'noul', noul: 0.1 },
    }
    for (const name of questions) if (name.startsWith('same_as_kept_')) answers[name] = { type: 'noul', noul: 0.91 }
    return { answers }
  }
  const result = await gate([finding('min-001', 'low'), finding('bugs-001', 'critical')], 'ask', [], jev, defaultPolicy)
  assert.deepEqual(result.kept.map((f) => f.id), ['bugs-001'])
  assert.deepEqual(asked, [
    ['keep_drop', 'is_critical', 'severity', 'needs_user'],
    ['keep_drop', 'is_critical', 'severity', 'needs_user', 'same_as_kept_0'],
  ])
  assert.deepEqual(result.log, [
    'FINDING bugs-001 | keep_drop=keep conf=0.90 | is_critical=0.90 | severity=3.4 | dup=none | ACTION=keep',
    'FINDING min-001 | keep_drop=keep conf=0.90 | is_critical=0.90 | severity=3.4 | dup=bugs-001@0.91 | ACTION=drop reason=duplicate',
  ])
})

test('the log line follows the skill format', () => {
  const line = formatDecision(decide(finding('anti-022', 'low'), judged({ keep_drop: 'drop', confidence: 0.88, is_critical: 0.12, severity: 0.4 }), defaultPolicy))
  assert.equal(line, 'FINDING anti-022 | keep_drop=drop conf=0.88 | is_critical=0.12 | severity=0.4 | dup=none | ACTION=drop reason=keep_drop')
})

test('a kept finding that needs the user is held, then settled by the answer', async () => {
  const held = decide(finding('bugs-002', 'critical'), judged({ needs_user: 0.8 }), defaultPolicy)
  assert.deepEqual([held.action, held.reason], ['ask', 'needs_user'])
  assert.equal(decide(finding('bugs-003', 'low'), judged({ keep_drop: 'drop', needs_user: 0.9 }), defaultPolicy).action, 'drop')

  const result = { kept: [], held: [held.finding], decisions: [held], log: [] }
  const fixed = settle(result, [{ id: 'bugs-002', answer: 'fix it, but keep the event name' }])
  assert.deepEqual(fixed.kept.map((f) => f.id), ['bugs-002'])
  assert.equal(
    fixed.log[0],
    'FINDING bugs-002 | keep_drop=keep conf=0.90 | is_critical=0.90 | severity=3.5 | dup=none | needs_user=0.80 | ACTION=keep reason=user_decision note="fix it, but keep the event name"',
  )
  assert.deepEqual(settle(result, [{ id: 'bugs-002', answer: skipOption }]).kept, [])
  assert.equal(findingQuestion(held.finding, 'Q1').question, 'bugs-002 at src/Vault.sol:88: bugs-002. Fix it?')
})
