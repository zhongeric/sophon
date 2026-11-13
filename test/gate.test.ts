import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Finding } from '../src/core/findings.ts'
import { findingQuestion, gate, rejectionQuestion, settle, skipOption } from '../src/core/gate.ts'

const finding = (id: string, severity: Finding['severity'], extra: Partial<Finding> = {}): Finding => ({
  id,
  track: 'bugs',
  location: 'src/Vault.sol:88',
  title: id,
  trigger: 'reenter withdraw',
  impact: 'drain vault',
  severity,
  evidence: 'token.transfer',
  recommendation: 'update first',
  ...extra,
})

test('the gate orders findings by severity, keeps them for the patch agent, and holds the ones that need the user', () => {
  const result = gate([
    finding('min-001', 'low'),
    finding('bugs-002', 'high', { decision: 'Should withdraw pause during an upgrade?', needs_decision: true }),
    finding('bugs-001', 'critical'),
  ])
  assert.deepEqual(result.kept.map((f) => f.id), ['bugs-001', 'min-001'])
  assert.deepEqual(result.held.map((f) => f.id), ['bugs-002'])
  assert.deepEqual(result.log, [
    'FINDING bugs-001 | track=bugs | severity=critical | ACTION=keep',
    'FINDING bugs-002 | track=bugs | severity=high | ACTION=ask reason=needs_decision',
    'FINDING min-001 | track=bugs | severity=low | ACTION=keep',
  ])
  assert.match(findingQuestion(result.held[0]!, 'Q1').why, /^Should withdraw pause during an upgrade\? Trigger: reenter withdraw/)
})

test("the user's answers settle the held findings", () => {
  const result = gate([finding('bugs-002', 'high', { decision: 'Pause?', needs_decision: true })])
  const fixed = settle(result, [{ id: 'bugs-002', answer: 'fix it, but keep the event name' }])
  assert.deepEqual(fixed.kept.map((f) => f.id), ['bugs-002'])
  assert.equal(fixed.log[0], 'FINDING bugs-002 | track=bugs | severity=high | ACTION=keep reason=user_decision note="fix it, but keep the event name"')
  assert.deepEqual(settle(result, [{ id: 'bugs-002', answer: skipOption }]).kept, [])
})

test('a rejected finding becomes a question that defaults to not accepting', () => {
  const question = rejectionQuestion(finding('bugs-001', 'critical'), 'callers depend on it', 'Q1')
  assert.equal(question.recommendation, 'Do not accept')
  assert.match(question.question, /did not apply bugs-001 \(critical\)/)
})
