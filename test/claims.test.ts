import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assignObjectionIds,
  checkDossier,
  checkHypotheses,
  checkObjections,
  checkResponses,
  checkSurvey,
  mergeHypotheses,
  submitDossier,
  submitHypotheses,
  submitObjections,
  submitResponses,
  submitSurvey,
} from '../src/core/claims.ts'
import { memoryArtifacts } from './support/artifacts.ts'

const store = memoryArtifacts()
const encode = (value: string) => new TextEncoder().encode(value)
const meta = { source: { command: 'python analysis/fit.py' }, media_type: 'text/plain' }
const report = ['row 1: header', 'the recovered fraction is 0.92 at snr 10', 'row 3: false positive rate 0.01'].join('\n')
const reportId = await store.put(encode(report), meta)
const binaryId = await store.put(new Uint8Array([0xff, 0xfe, 0x00, 0x01]), meta)
const unknownId = '0'.repeat(64)
const notebook = ['import numpy as np', 'threshold = 5.0  # sigma cut', 'candidates = select(table, threshold)'].join('\n')
const sources = { read: async (path: string) => (path === 'analysis/fit.py' ? notebook : null), artifact: (id: string) => store.get(id) }

const artifactClaim = { statement: 'The search recovers most injected objects', location: `artifact:${reportId}:2`, evidence: 'the recovered fraction is 0.92' }
const notebookClaim = { statement: 'The cut is at 5 sigma', location: 'analysis/fit.py:2', evidence: 'threshold = 5.0  # sigma cut' }

/** The lines of the one rejection of a check. */
async function problems(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise
  } catch (error) {
    return (error as Error).message.split('\n')
  }
  return assert.fail('the check accepted the input')
}

test('the tools have their names', () => {
  const names = [submitSurvey, submitHypotheses, submitObjections, submitResponses, submitDossier].map((tool) => tool.name)
  assert.deepEqual(names, ['submit_survey', 'submit_hypotheses', 'submit_objections', 'submit_responses', 'submit_dossier'])
  assert.equal(JSON.stringify(submitObjections.parameters).includes('needs_decision'), false)
})

test('a survey with quotes from an artifact and a notebook passes', async () => {
  const survey = { summary: 'Two claims', claims: [artifactClaim, notebookClaim, { ...artifactClaim, location: `artifact:${reportId}`, evidence: 'false positive rate 0.01' }] }
  assert.deepEqual(await checkSurvey(survey, sources), survey)
})

test('one survey rejection lists every missing field and every bad quote, location and artifact', async () => {
  const { statement: _statement, ...noStatement } = artifactClaim
  const survey = {
    summary: ' ',
    claims: [
      noStatement,
      { statement: 'no location' },
      { ...artifactClaim, evidence: 'the recovered fraction is 0.5' },
      { ...notebookClaim, evidence: 'threshold = 3.0' },
      { ...artifactClaim, location: `artifact:${unknownId}` },
      { ...artifactClaim, location: `artifact:${binaryId}` },
      { ...notebookClaim, location: 'analysis/gone.py:1' },
      'not a claim',
    ],
  }
  assert.deepEqual(await problems(checkSurvey(survey, sources)), [
    'missing summary',
    'claims[0]: missing statement',
    'claims[1]: missing location, evidence',
    `claims[2]: evidence "the recovered fraction is 0.5" is not in artifact ${reportId} near line 2. Quote text that you read.`,
    'claims[3]: evidence "threshold = 3.0" is not in analysis/fit.py near line 2, or in its diff. Quote code that you read.',
    `claims[4]: location "artifact:${unknownId}": artifact ${unknownId} does not exist in the run store`,
    `claims[5]: location "artifact:${binaryId}": artifact ${binaryId} is binary, and the evidence check reads only UTF-8 text`,
    'claims[6]: location "analysis/gone.py:1": analysis/gone.py does not exist in the reviewed tree',
    'claims[7]: missing statement, location, evidence',
  ])
})

test('a survey needs at least one claim', async () => {
  assert.deepEqual(await problems(checkSurvey({ summary: 'Nothing', claims: [] }, sources)), ['claims is empty: give at least one claim'])
  assert.deepEqual(await problems(checkSurvey({ summary: 'Nothing' }, sources)), ['claims must be an array'])
})

const hypothesis = {
  title: 'Faint companions',
  statement: 'Faint companions hide below the old cut',
  why_missed: 'Past searches cut at 7 sigma',
  data: 'Survey DR3 light curves',
  test: 'Box least squares at 5 sigma',
  kill_criterion: 'No excess over the injection false-positive rate',
  cost: 'Two hours of compute',
}

test('a list of hypotheses passes, and so does an empty list', async () => {
  assert.deepEqual(await checkHypotheses({ hypotheses: [hypothesis] }), { hypotheses: [hypothesis] })
  assert.deepEqual(await checkHypotheses({ hypotheses: [] }), { hypotheses: [] })
})

test('one hypotheses rejection lists every missing field of every item', async () => {
  const { why_missed: _why, ...noWhy } = hypothesis
  assert.deepEqual(await problems(checkHypotheses({ hypotheses: [{}, { ...hypothesis, test: '  ' }, noWhy] })), [
    'hypotheses[0]: missing title, statement, why_missed, data, test, kill_criterion, cost',
    'hypotheses[1]: missing test',
    'hypotheses[2]: missing why_missed',
  ])
  assert.deepEqual(await problems(checkHypotheses({})), ['hypotheses must be an array'])
})

test('the merge keeps the first hypothesis of each normalized data and test, and numbers the result without gaps', () => {
  const second = { ...hypothesis, title: 'Long periods', data: 'Survey DR3 light curves', test: 'Periodogram up to 100 days' }
  const duplicate = { ...hypothesis, title: 'Same test again', data: '  survey   DR3\nlight curves ', test: 'BOX LEAST SQUARES at 5 sigma' }
  const third = { ...hypothesis, title: 'Other data', data: 'Archive photometry' }
  const merged = mergeHypotheses([[hypothesis, second], [duplicate, third, { ...second, title: 'Repeat' }]])
  assert.deepEqual(
    merged.map(({ id, title }) => [id, title]),
    [
      ['hyp-001', 'Faint companions'],
      ['hyp-002', 'Long periods'],
      ['hyp-003', 'Other data'],
    ],
  )
  assert.deepEqual(merged[0], { id: 'hyp-001', ...hypothesis })
  assert.deepEqual(mergeHypotheses([[], []]), [])
})

const lenses = ['systematics', 'contamination']
const objection = {
  lens: 'systematics',
  location: `artifact:${reportId}:3`,
  title: 'Measure the false positives on real noise',
  trigger: 'the injections use white noise',
  impact: 'the false-positive rate is too low',
  severity: 'high',
  evidence: 'false positive rate 0.01',
  recommendation: 'inject into real light curves',
}

test('valid objections pass, and the host numbers them in the submitted order', async () => {
  const second = { ...objection, lens: 'contamination', location: 'analysis/fit.py:3', evidence: 'candidates = select(table, threshold)' }
  const checked = await checkObjections({ objections: [objection, second] }, sources, lenses)
  assert.deepEqual(checked, { objections: [objection, second] })
  assert.deepEqual(assignObjectionIds(checked.objections), [
    { id: 'obj-001', ...objection },
    { id: 'obj-002', ...second },
  ])
  assert.deepEqual(await checkObjections({ objections: [] }, sources, lenses), { objections: [] })
})

test('one objections rejection lists missing fields, unknown lenses, bad severities and bad quotes', async () => {
  const { lens: _lens, ...noLens } = objection
  const input = {
    objections: [
      noLens,
      { ...objection, lens: 'vibes', severity: 'urgent', evidence: 'false positive rate 0.5' },
      { ...objection, location: 'analysis/fit.py:2', evidence: 'threshold = 9.9' },
      { ...objection, location: `artifact:${binaryId}` },
    ],
  }
  assert.deepEqual(await problems(checkObjections(input, sources, lenses)), [
    'objections[0]: missing lens',
    'objections[1]: severity must be one of critical, high, medium, low, info',
    'objections[1]: lens "vibes" is not one of systematics, contamination',
    `objections[1]: evidence "false positive rate 0.5" is not in artifact ${reportId} near line 3. Quote text that you read.`,
    'objections[2]: evidence "threshold = 9.9" is not in analysis/fit.py near line 2, or in its diff. Quote code that you read.',
    `objections[3]: location "artifact:${binaryId}": artifact ${binaryId} is binary, and the evidence check reads only UTF-8 text`,
  ])
})

const objections = [{ id: 'obj-001' }, { id: 'obj-002' }, { id: 'obj-003' }]

test('responses that list each objection one time pass', async () => {
  const responses = {
    addressed: [{ id: 'obj-001', change: 'Injected into real light curves', artifacts: [reportId] }],
    conceded: [
      { id: 'obj-002', reason: 'The archive has no other data' },
      { id: 'obj-003', reason: 'Out of the budget' },
    ],
  }
  assert.deepEqual(await checkResponses(responses, objections, sources), responses)
})

test('one responses rejection lists bad artifact IDs, missing text, and unknown, repeated and missing objections', async () => {
  const responses = {
    addressed: [
      { id: 'obj-001', change: 'Reran', artifacts: [] },
      { id: 'obj-002', change: ' ', artifacts: ['report.txt', unknownId] },
      { id: 'obj-009', change: 'Reran', artifacts: [reportId] },
    ],
    conceded: [{ id: 'obj-001', reason: '' }],
  }
  assert.deepEqual(await problems(checkResponses(responses, objections, sources)), [
    'addressed[0]: artifacts needs at least one artifact ID',
    'addressed[1]: missing change',
    'addressed[1]: artifacts[0]: "report.txt" is not an artifact ID',
    `addressed[1]: artifacts[1]: artifact ${unknownId} does not exist in the run store`,
    'conceded[0]: missing reason',
    'unknown objections: obj-009',
    'listed more than one time: obj-001',
    'missing objections: obj-003',
  ])
  assert.deepEqual(await problems(checkResponses({ addressed: [] }, objections, sources)), ['addressed and conceded must be arrays'])
})

const checklist = ['known objects recovered', 'instrument artifacts', 'selection bias']
const dossier = {
  outcome: 'candidate',
  summary: 'One candidate above the cut',
  claims: [artifactClaim],
  checklist: [
    { item: 'known objects recovered', status: 'ruled_out', location: 'analysis/fit.py:2', evidence: 'threshold = 5.0' },
    { item: 'instrument artifacts', status: 'open' },
    { item: 'selection bias', status: 'not_tested' },
  ],
  completeness: [reportId],
  false_positives: [reportId],
  coverage: 'All DR3 fields north of the plane',
  trials: 3,
  reproduce: 'python analysis/fit.py --seed 1',
}

test('a candidate dossier passes, and so does a null dossier without claims', async () => {
  assert.deepEqual(await checkDossier(dossier, sources, checklist), dossier)
  const empty = { ...dossier, outcome: 'null', claims: [] }
  assert.deepEqual(await checkDossier(empty, sources, checklist), empty)
})

test('a candidate dossier needs at least one claim', async () => {
  assert.deepEqual(await problems(checkDossier({ ...dossier, claims: [] }, sources, checklist)), ['a candidate needs at least one claim'])
})

test('one dossier rejection lists every problem of the fields, the claims, the checklist and the artifacts', async () => {
  const input = {
    outcome: 'maybe',
    summary: '',
    claims: [{ ...artifactClaim, evidence: 'the recovered fraction is 0.5' }],
    checklist: [
      { item: 'known objects recovered', status: 'ruled_out' },
      { item: 'instrument artifacts', status: 'open' },
      { item: 'instrument artifacts', status: 'not_tested' },
      { item: 'cosmic rays', status: 'open' },
      { item: '', status: 'done' },
    ],
    completeness: [],
    false_positives: ['nope', unknownId],
    trials: 0,
  }
  assert.deepEqual(await problems(checkDossier(input, sources, checklist)), [
    'missing summary, coverage, reproduce',
    'outcome must be one of candidate, null',
    `claims[0]: evidence "the recovered fraction is 0.5" is not in artifact ${reportId} near line 2. Quote text that you read.`,
    'checklist[0]: ruled_out needs location and evidence',
    'checklist[3]: unknown checklist item "cosmic rays"',
    'checklist[4]: missing item',
    'checklist[4]: status must be one of ruled_out, open, not_tested',
    'checklist item "instrument artifacts" is listed more than one time',
    'checklist item "selection bias" has no status',
    'completeness needs at least one artifact ID',
    'false_positives[0]: "nope" is not an artifact ID',
    `false_positives[1]: artifact ${unknownId} does not exist in the run store`,
    'trials must be an integer of 1 or more',
  ])
})

test('a ruled_out item needs evidence that passes the check', async () => {
  const [ruledOut, ...rest] = dossier.checklist
  const check = (entry: object) => problems(checkDossier({ ...dossier, checklist: [entry, ...rest] }, sources, checklist))
  assert.deepEqual(await check({ ...ruledOut, evidence: '' }), ['checklist[0]: ruled_out needs evidence'])
  assert.deepEqual(await check({ ...ruledOut, evidence: 'threshold = 9.9' }), [
    'checklist[0]: evidence "threshold = 9.9" is not in analysis/fit.py near line 2, or in its diff. Quote code that you read.',
  ])
  assert.deepEqual(await check({ ...ruledOut, location: `artifact:${unknownId}` }), [
    `checklist[0]: location "artifact:${unknownId}": artifact ${unknownId} does not exist in the run store`,
  ])
})

test('trials must be an integer of 1 or more', async () => {
  for (const trials of [0, -1, 1.5, '3', null]) {
    assert.deepEqual(await problems(checkDossier({ ...dossier, trials }, sources, checklist)), ['trials must be an integer of 1 or more'], String(trials))
  }
  assert.equal((await checkDossier({ ...dossier, trials: 1 }, sources, checklist)).trials, 1)
})

test('the completeness and false-positive artifacts must be valid IDs in the store', async () => {
  const input = { ...dossier, completeness: [binaryId, reportId.toUpperCase()], false_positives: 'not a list' }
  assert.deepEqual(await problems(checkDossier(input, sources, checklist)), [
    `completeness[1]: "${reportId.toUpperCase()}" is not an artifact ID`,
    'false_positives needs at least one artifact ID',
  ])
})
