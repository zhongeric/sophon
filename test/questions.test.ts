import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Ledger } from '../src/core/ledger.ts'
import {
  asker,
  checkQuestions,
  commentChannel,
  decisions,
  decisionsFile,
  parseAnswers,
  PausedError,
  render,
  type Channel,
  type PrComment,
  type Question,
} from '../src/core/questions.ts'
import { fileChannel } from '../src/node/channels.ts'

const questions: Question[] = [
  { id: 'Q1', question: 'Round down or up?', why: 'src/fee.ts', options: ['down', 'up'], recommendation: 'down', level: 'user', rule: 'scope' },
  { id: 'Q2', question: 'Keep the old event?', why: 'src/Vault.sol', options: ['yes', 'no'], recommendation: 'yes', level: 'user', rule: 'decision' },
]

const memoryLedger = (entries: Record<string, unknown> = {}): Ledger => {
  const map = new Map(Object.entries(entries))
  return { get: <T>(key: string) => map.get(key) as T | undefined, put: (key, value) => void map.set(key, value) }
}

/** A channel that records each post and each read, and answers with `reply`, or not yet when it is null. */
const recordingChannel = (reply: string | null = '/answer recommended') => {
  const posted: { batch: string; questions: Question[] }[] = []
  const read: Question[][] = []
  const channel: Channel = {
    async post(_runId, batch, list) {
      posted.push({ batch, questions: list })
      return { batch, ref: `memory:${batch}`, at: '2026-11-16T10:00:00Z' }
    },
    async answers(_posted, list) {
      read.push(list)
      return reply === null ? null : parseAnswers(reply, list)
    },
    where: (where) => where.ref,
  }
  return { channel, posted, read }
}

const ask = (id: string, level: 'user' | 'run'): Question => ({
  id,
  question: `${id}?`,
  why: 'src/fee.ts',
  options: ['a', 'b'],
  recommendation: 'a',
  level,
  ...(level === 'user' ? { rule: 'scope' as const } : {}),
})

test('a reply selects options by letter, keeps free text, and leaves out questions at the recommendation', () => {
  assert.deepEqual(parseAnswers('/answer\nQ1: b', questions), [
    { id: 'Q1', question: 'Round down or up?', answer: 'up', recommended: false },
    { id: 'Q2', question: 'Keep the old event?', answer: 'yes', recommended: true },
  ])
  assert.equal(parseAnswers('/answer\nq2) rename it to Withdrawn', questions)?.[1]?.answer, 'rename it to Withdrawn')
  assert.deepEqual(parseAnswers('/answer recommended', questions)?.map((answer) => answer.answer), ['down', 'yes'])
  assert.equal(parseAnswers('looks good to me', questions), null)
})

test('questions need two options and a recommendation from them', () => {
  assert.deepEqual(checkQuestions({ questions: [{ question: 'a?', why: 'b', options: ['x', 'y'], recommendation: 'y', level: 'run' }] })[0]?.id, 'Q1')
  assert.throws(() => checkQuestions({ questions: [{ question: 'a?', why: 'b', options: ['x'], recommendation: 'x', level: 'run' }] }), /at least two options/)
  assert.throws(() => checkQuestions({ questions: [{ question: 'a?', why: 'b', options: ['x', 'y'], recommendation: 'z', level: 'run' }] }), /one of the options/)
})

test('questions need a level, and a user question needs a D11 rule', () => {
  const base = { question: 'a?', why: 'b', options: ['x', 'y'], recommendation: 'y' }
  assert.throws(
    () => checkQuestions({ questions: [base, { ...base, level: 'later' }, { ...base, level: 'user' }, { ...base, level: 'user', rule: 'taste' }] }),
    (error: Error) => {
      assert.equal(
        error.message,
        [
          'questions[0]: level must be user or run',
          'questions[1]: level must be user or run',
          'questions[2]: a user question needs a rule: scope, capability, spend, decision',
          'questions[3]: a user question needs a rule: scope, capability, spend, decision',
        ].join('\n'),
      )
      return true
    },
  )
  assert.deepEqual(
    checkQuestions({ questions: [{ ...base, level: 'run', rule: 'scope' }, { ...base, level: 'user', rule: 'spend' }] }),
    [
      { id: 'Q1', ...base, level: 'run' },
      { id: 'Q2', ...base, level: 'user', rule: 'spend' },
    ],
  )
})

test('a batch of run questions never posts, and wait gives the recommendations as decisions of the run', async () => {
  const ledger = memoryLedger()
  const { channel, posted, read } = recordingChannel(null)
  const questions = asker(ledger, channel, 'run-1', () => {})
  await questions.post('intake', [ask('Q1', 'run'), ask('Q2', 'run')])
  const answers = await questions.wait('intake')
  assert.deepEqual(posted, [])
  assert.deepEqual(read, [])
  assert.deepEqual(answers, [
    { id: 'Q1', question: 'Q1?', answer: 'a', recommended: true, decidedBy: 'run' },
    { id: 'Q2', question: 'Q2?', answer: 'a', recommended: true, decidedBy: 'run' },
  ])
  assert.deepEqual(decisions(ledger), answers)
})

test('a mixed batch posts only the user questions with their IDs, and wait gives every answer in order, one time', async () => {
  const ledger = memoryLedger()
  const { channel, posted, read } = recordingChannel(null)
  const batch = [ask('Q1', 'run'), ask('Q2', 'user'), ask('Q3', 'run'), ask('Q4', 'user')]
  const first = asker(ledger, channel, 'run-1', () => {})
  await first.post('spec', batch)
  assert.deepEqual(posted, [{ batch: 'spec', questions: [batch[1], batch[3]] }])
  const run = [
    { id: 'Q1', question: 'Q1?', answer: 'a', recommended: true, decidedBy: 'run' },
    { id: 'Q3', question: 'Q3?', answer: 'a', recommended: true, decidedBy: 'run' },
  ]
  assert.deepEqual(decisions(ledger), run)
  await assert.rejects(first.wait('spec'), PausedError)
  assert.deepEqual(decisions(ledger), run)
  const file = decisionsFile(ledger)['/decisions.md'] ?? ''
  assert.match(file, /## Decisions the run made/)
  assert.match(file, /- Q1\?\n  Answer: a/)
  assert.match(file, /- Q3\?\n  Answer: a/)
  assert.doesNotMatch(file, /Q2\?|Q4\?|Decisions of the user/)

  await first.post('spec', batch)
  assert.deepEqual(decisions(ledger), run)
  assert.equal(posted.length, 1)

  // The resumed run posts and waits again: no second post, and no decision twice.
  const { channel: answered, posted: reposted, read: reread } = recordingChannel('/answer\nQ4: b')
  const second = asker(ledger, answered, 'run-1', () => {})
  await second.post('spec', batch)
  assert.deepEqual(decisions(ledger), run)
  const answers = await second.wait('spec')
  assert.deepEqual(reposted, [])
  assert.deepEqual(reread, [[batch[1], batch[3]]])
  assert.deepEqual(answers.map((answer) => [answer.id, answer.answer, answer.decidedBy]), [
    ['Q1', 'a', 'run'],
    ['Q2', 'a', undefined],
    ['Q3', 'a', 'run'],
    ['Q4', 'b', undefined],
  ])
  await second.post('spec', batch)
  assert.deepEqual(await second.wait('spec'), answers)
  assert.deepEqual(decisions(ledger), [...run, answers[1], answers[3]])
  assert.equal(read.length, 1)
})

test('a run-only batch records its decisions one time, also when the run posts it again', async () => {
  const ledger = memoryLedger()
  const { channel } = recordingChannel()
  const questions = asker(ledger, channel, 'run-1', () => {})
  await questions.post('intake', [ask('Q1', 'run')])
  await questions.wait('intake')
  await questions.post('intake', [ask('Q1', 'run')])
  await questions.wait('intake')
  assert.equal(decisions(ledger).length, 1)
})

test('a batch from before D11 has no levels, so its questions post, and its recorded answers stay', async () => {
  const { level: _level, rule: _rule, ...legacy } = ask('Q1', 'user')
  const ledger = memoryLedger()
  const { channel, posted } = recordingChannel('/answer\nQ1: b')
  const questions = asker(ledger, channel, 'run-1', () => {})
  await questions.post('ask', [legacy as Question])
  assert.deepEqual(posted, [{ batch: 'ask', questions: [legacy] }])
  assert.deepEqual(await questions.wait('ask'), [{ id: 'Q1', question: 'Q1?', answer: 'b', recommended: false }])

  // A resumed run of an old ledger: the batch posted without levels, and the new code gives run questions.
  const old = memoryLedger({ 'questions:intake': [legacy], 'posted:intake': { batch: 'intake', ref: 'memory:intake', at: '2026-11-16T10:00:00Z' } })
  const resumed = recordingChannel('/answer\nQ1: b')
  const again = asker(old, resumed.channel, 'run-1', () => {})
  await again.post('intake', [ask('Q1', 'run')])
  assert.deepEqual(resumed.posted, [])
  assert.equal((await again.wait('intake'))[0]?.answer, 'b')

  const recorded = [{ id: 'Q1', question: 'Q1?', answer: 'b', recommended: false }]
  const done = asker(memoryLedger({ 'answers:intake': recorded }), resumed.channel, 'run-1', () => {})
  await done.post('intake', [ask('Q1', 'run')])
  assert.deepEqual(await done.wait('intake'), recorded)
})

test('with --hotfix, every question takes its recommendation, and run questions are marked', () => {
  const ledger = memoryLedger()
  const { channel, posted } = recordingChannel()
  const answers = asker(ledger, channel, 'run-1', () => {}).recommend('intake', [ask('Q1', 'user'), ask('Q2', 'run')])
  assert.deepEqual(posted, [])
  assert.deepEqual(answers, [
    { id: 'Q1', question: 'Q1?', answer: 'a', recommended: true },
    { id: 'Q2', question: 'Q2?', answer: 'a', recommended: true, decidedBy: 'run' },
  ])
})

test('an asker that recommends posts nothing and answers each batch with its recommendations, also a batch posted before', async () => {
  const { channel, posted } = recordingChannel()
  const ledger = memoryLedger({ 'questions:old': [ask('Q1', 'user')], 'posted:old': { batch: 'old', ref: 'memory', at: 'now' } })
  const questions = asker(ledger, channel, 'run-1', () => {}, { recommend: true })
  await questions.post('intake', [ask('Q1', 'user'), ask('Q2', 'run')])
  assert.deepEqual(posted, [])
  assert.deepEqual(await questions.wait('intake'), [
    { id: 'Q1', question: 'Q1?', answer: 'a', recommended: true },
    { id: 'Q2', question: 'Q2?', answer: 'a', recommended: true, decidedBy: 'run' },
  ])
  // A batch that waited for the user before the standing answers takes the recommendation on the next post.
  await questions.post('old', [ask('Q1', 'user')])
  assert.deepEqual(await questions.wait('old'), [{ id: 'Q1', question: 'Q1?', answer: 'a', recommended: true }])
  assert.deepEqual(posted, [])
})

test("decisions.md lists the user's decisions, then the decisions that the run made", () => {
  assert.deepEqual(decisionsFile(memoryLedger()), {})
  const user = { id: 'Q1', question: 'Cut the CLI?', answer: 'No', recommended: false }
  const run = { id: 'Q2', question: 'How many passes?', answer: 'One pass', recommended: true, decidedBy: 'run' as const }
  const file = decisionsFile(memoryLedger({ decisions: [run, user] }))['/decisions.md'] ?? ''
  assert.match(file, /^# Decisions\n\n## Decisions of the user\n\nThese answers settle open points of the ask\. Follow them\.\n\n- Cut the CLI\?\n  Answer: No\n\n## Decisions the run made\n\n/)
  assert.match(file, /took the recommendation/)
  assert.match(file, /- How many passes\?\n  Answer: One pass\n$/)
  const runOnly = decisionsFile(memoryLedger({ decisions: [run] }))['/decisions.md'] ?? ''
  assert.match(runOnly, /^# Decisions\n\n## Decisions the run made\n\n/)
  assert.doesNotMatch(runOnly, /Decisions of the user/)
})

test('the PR channel posts one comment and reads only later, unedited /answer replies from the answerers, in any case', async () => {
  const bodies: string[] = []
  let comments: PrComment[] = []
  const channel = commentChannel({
    answerers: ['maintainer'],
    comments: {
      async post(body) {
        bodies.push(body)
        return { url: 'https://github.com/o/r/pull/7#issuecomment-1', at: '2026-11-13T10:00:00Z' }
      },
      list: async () => comments,
    },
    pollMs: 1,
    waitMs: 0,
  })
  const posted = await channel.post('run-1', 'ask', questions)
  assert.deepEqual(bodies, [`@maintainer\n\n${render('run-1', 'ask', questions)}`])
  assert.equal(channel.where(posted), 'https://github.com/o/r/pull/7#issuecomment-1')

  const later = '2026-11-13T10:05:00Z'
  comments = [
    { author: 'maintainer', body: '/answer\nQ1: b', createdAt: '2026-11-13T09:00:00Z' },
    { author: 'someone', body: '/answer\nQ1: b', createdAt: later },
    { author: 'maintainer', body: 'thinking about it', createdAt: later },
  ]
  assert.equal(await channel.answers(posted, questions), null)
  comments.push({ author: 'mallory', body: '/answer\nQ2: b', createdAt: later })
  comments.push({ author: 'Maintainer', body: '/answer\nQ1: b', createdAt: later, edited: true })
  assert.equal(await channel.answers(posted, questions), null)
  comments.push({ author: 'Maintainer', body: '/answer\nQ2: no', createdAt: later })
  assert.deepEqual((await channel.answers(posted, questions))?.map((answer) => answer.answer), ['down', 'no'])
})

test('the PR channel mentions each answerer one time, without bots, before the questions', async () => {
  const post = async (answerers: string[]) => {
    const bodies: string[] = []
    const comments = {
      async post(body: string) {
        bodies.push(body)
        return { url: 'https://github.com/o/r/pull/7#issuecomment-1', at: '2026-11-13T10:00:00Z' }
      },
      list: async () => [],
    }
    await commentChannel({ answerers, comments, pollMs: 1, waitMs: 0 }).post('run-1', 'ask', questions)
    return bodies
  }
  const text = render('run-1', 'ask', questions)
  assert.deepEqual(await post(['maintainer', 'sophon-factory[bot]', 'Other', 'MAINTAINER']), [`@maintainer @Other\n\n${text}`])
  assert.deepEqual(await post([]), [text])
  assert.deepEqual(await post(['sophon-factory[bot]', 'Dependabot[BOT]']), [text])
})

test('the file channel writes the questions and reads the reply file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-questions-'))
  const channel = fileChannel(dir)
  const posted = await channel.post('run-1', 'ask', questions)
  assert.equal(await channel.answers(posted, questions), null)
  writeFileSync(join(dir, 'answers-ask.md'), '/answer\nQ1: up')
  assert.equal((await channel.answers(posted, questions))?.[0]?.answer, 'up')
})

test('the PR channel posts a notice as one comment, without the questions marker and without mentions', async () => {
  const bodies: string[] = []
  const comments = {
    async post(body: string) {
      bodies.push(body)
      return { url: 'https://github.com/o/r/pull/7#issuecomment-2', at: '2026-11-13T10:00:00Z' }
    },
    list: async () => [],
  }
  await commentChannel({ answerers: ['maintainer'], comments, pollMs: 1, waitMs: 0 }).notice?.('run-1', 'The run spent about $10.00 of its budget of $10.00.')
  assert.deepEqual(bodies, ['The run spent about $10.00 of its budget of $10.00.'])
})

test('the file channel writes each notice to notices.md in the run directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-questions-'))
  const channel = fileChannel(dir)
  await channel.notice?.('run-1', 'first notice')
  await channel.notice?.('run-1', 'second notice')
  assert.equal(readFileSync(join(dir, 'notices.md'), 'utf8'), 'first notice\n\nsecond notice\n\n')
})
