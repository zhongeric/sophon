import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultBudgetSeconds } from '../src/cloudflare/alarm.ts'
import { profiles } from '../src/core/profiles.ts'
import { developRoles, guideFiles, researchRoles, reviewRoles, type Role } from '../src/core/roles.ts'

const tables: Record<string, Record<string, Role>> = { review: reviewRoles, develop: developRoles, research: researchRoles }
const shape = (role: Role) => ({ guides: role.guides, stackGuides: role.stackGuides, findings: role.findings, tests: role.tests, egress: role.egress })
const ids = (table: Record<string, Role>, pick: (role: Role) => boolean) => Object.values(table).filter(pick).map((role) => role.id).sort()

test('in each table, each key is the id of its role', () => {
  for (const [name, table] of Object.entries(tables)) {
    for (const [key, role] of Object.entries(table)) assert.equal(role.id, key, `${name}.${key}`)
  }
})

test('each turn time is at least a minute, and fits in a call of the default budget with a minute to spare (D12)', () => {
  for (const [name, table] of Object.entries(tables)) {
    for (const role of Object.values(table)) {
      assert.ok(role.turnMs >= 60_000, `${name}.${role.id}`)
      assert.ok(role.turnMs <= defaultBudgetSeconds * 1_000 - 60_000, `${name}.${role.id}`)
    }
  }
})

test('the review and development roles keep their guides and rails, and get no egress', () => {
  const reviewer = ['shared/factory.md', 'shared/reviewer.md']
  assert.deepEqual(Object.fromEntries(Object.entries(reviewRoles).map(([id, role]) => [id, shape(role)])), {
    minimize: { guides: [...reviewer, 'minimize.md'], stackGuides: false, findings: { track: 'minimize', prefix: 'min' }, tests: false, egress: false },
    rules: { guides: [...reviewer, 'rules.md', 'shared/ste.md'], stackGuides: true, findings: { track: 'rules', prefix: 'rules' }, tests: false, egress: false },
    bugs: { guides: [...reviewer, 'bugs.md'], stackGuides: true, findings: { track: 'bugs', prefix: 'bugs' }, tests: true, egress: false },
    'anti-slop': { guides: [...reviewer, 'anti-slop.md', 'shared/ste.md'], stackGuides: false, findings: { track: 'anti-slop', prefix: 'anti' }, tests: false, egress: false },
    cleanup: {
      guides: [...reviewer, 'minimize.md', 'anti-slop.md', 'shared/ste.md'],
      stackGuides: false,
      findings: { track: 'cleanup', prefix: 'clean' },
      tests: false,
      egress: false,
    },
    'late-minimize': { guides: [...reviewer, 'minimize.md', 'late-pass.md'], stackGuides: false, findings: { track: 'minimize', prefix: 'late-min' }, tests: false, egress: false },
    'late-rules': {
      guides: [...reviewer, 'rules.md', 'late-pass.md', 'shared/ste.md'],
      stackGuides: true,
      findings: { track: 'rules', prefix: 'late-rules' },
      tests: false,
      egress: false,
    },
    'late-bugs': { guides: [...reviewer, 'bugs.md', 'late-pass.md'], stackGuides: true, findings: { track: 'bugs', prefix: 'late-bugs' }, tests: true, egress: false },
    patch: { guides: ['shared/factory.md', 'patch.md', 'shared/ste.md'], stackGuides: true, findings: undefined, tests: true, egress: false },
    intent: { guides: ['shared/factory.md', 'intent.md'], stackGuides: false, findings: undefined, tests: false, egress: false },
    questions: { guides: ['shared/factory.md', 'questions.md'], stackGuides: false, findings: undefined, tests: false, egress: false },
    light: { guides: ['shared/factory.md', 'light.md', 'anti-slop.md', 'shared/ste.md'], stackGuides: true, findings: undefined, tests: true, egress: false },
  })
  assert.deepEqual(Object.fromEntries(Object.entries(developRoles).map(([id, role]) => [id, shape(role)])), {
    spec: { guides: ['shared/factory.md', 'spec.md', 'shared/ste.md'], stackGuides: false, findings: undefined, tests: false, egress: false },
    planner: { guides: ['shared/factory.md', 'intake.md', 'planner.md', 'shared/ste.md'], stackGuides: true, findings: undefined, tests: false, egress: false },
    builder: { guides: ['shared/factory.md', 'builder.md', 'shared/ste.md'], stackGuides: true, findings: undefined, tests: true, egress: false },
  })
})

test('the research table has its nine roles, and only four of them may get the egress', () => {
  assert.deepEqual(Object.keys(researchRoles).sort(), ['analyst', 'builder', 'generator', 'intake', 'late-skeptic', 'preregistrar', 'skeptic', 'surveyor', 'writer'])
  assert.deepEqual(ids(researchRoles, (role) => role.egress), ['analyst', 'generator', 'intake', 'surveyor'])
  assert.deepEqual(ids(researchRoles, (role) => role.stackGuides), ['analyst', 'builder'])
  assert.deepEqual(ids(researchRoles, (role) => role.tests), ['analyst', 'builder'])
  assert.deepEqual(ids(researchRoles, (role) => role.findings !== undefined), [])
  for (const role of Object.values(researchRoles)) assert.equal(role.guides[0], 'shared/factory.md', role.id)
  assert.deepEqual(ids(researchRoles, (role) => role.guides.includes('shared/ste.md')), ['analyst', 'builder', 'preregistrar', 'writer'])
  assert.deepEqual(researchRoles['late-skeptic'].guides, ['shared/factory.md', 'research/skeptic.md', 'research/late-skeptic.md'])
  assert.equal(researchRoles.builder, developRoles.builder)
  assert.deepEqual(researchRoles.intake.guides, ['shared/factory.md', 'research/intake.md'])
})

test('surveyor and analyst get bounded subagents, both builders get unlimited ones, and the other roles get none', () => {
  const limit = { concurrent: 3, perTurn: 6, tokens: 2_000_000 }
  assert.deepEqual(researchRoles.surveyor.subagents, limit)
  assert.deepEqual(researchRoles.analyst.subagents, limit)
  assert.equal(developRoles.builder.subagents, 'unlimited')
  assert.equal(researchRoles.builder.subagents, 'unlimited')
  for (const table of Object.values(tables)) {
    assert.deepEqual(ids(table, (role) => role.subagents !== undefined), ids(table, (role) => ['analyst', 'builder', 'surveyor'].includes(role.id)))
  }
})

test('guideFiles holds each guide of each table and profile one time', () => {
  assert.equal(new Set(guideFiles).size, guideFiles.length)
  const all = [...Object.values(tables).flatMap((table) => Object.values(table).flatMap((role) => role.guides)), ...profiles.flatMap((profile) => profile.guides)]
  for (const file of all) assert.ok(guideFiles.includes(file), file)
  // The develop table has no intake role, but the planner reads intake.md for its intake turn (D19).
  assert.ok(guideFiles.includes('intake.md'))
})
