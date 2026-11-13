import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkQuestions, commentChannel, parseAnswers, render, type PrComment, type Question } from '../src/core/questions.ts'
import { fileChannel } from '../src/node/channels.ts'

const questions: Question[] = [
  { id: 'Q1', question: 'Round down or up?', why: 'src/fee.ts', options: ['down', 'up'], recommendation: 'down' },
  { id: 'Q2', question: 'Keep the old event?', why: 'src/Vault.sol', options: ['yes', 'no'], recommendation: 'yes' },
]

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
  assert.deepEqual(checkQuestions({ questions: [{ question: 'a?', why: 'b', options: ['x', 'y'], recommendation: 'y' }] })[0]?.id, 'Q1')
  assert.throws(() => checkQuestions({ questions: [{ question: 'a?', why: 'b', options: ['x'], recommendation: 'x' }] }), /at least two options/)
  assert.throws(() => checkQuestions({ questions: [{ question: 'a?', why: 'b', options: ['x', 'y'], recommendation: 'z' }] }), /one of the options/)
})

test('the PR channel posts one comment and reads only later, unedited /answer replies from the answerers, in any case', async () => {
  const bodies: string[] = []
  let comments: PrComment[] = []
  const channel = commentChannel({
    answerers: ['eric'],
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
  assert.deepEqual(bodies, [render('run-1', 'ask', questions)])
  assert.equal(channel.where(posted), 'https://github.com/o/r/pull/7#issuecomment-1')

  const later = '2026-11-13T10:05:00Z'
  comments = [
    { author: 'eric', body: '/answer\nQ1: b', createdAt: '2026-11-13T09:00:00Z' },
    { author: 'someone', body: '/answer\nQ1: b', createdAt: later },
    { author: 'eric', body: 'thinking about it', createdAt: later },
  ]
  assert.equal(await channel.answers(posted, questions), null)
  comments.push({ author: 'mallory', body: '/answer\nQ2: b', createdAt: later })
  comments.push({ author: 'Eric', body: '/answer\nQ1: b', createdAt: later, edited: true })
  assert.equal(await channel.answers(posted, questions), null)
  comments.push({ author: 'Eric', body: '/answer\nQ2: no', createdAt: later })
  assert.deepEqual((await channel.answers(posted, questions))?.map((answer) => answer.answer), ['down', 'no'])
})

test('the file channel writes the questions and reads the reply file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-questions-'))
  const channel = fileChannel(dir)
  const posted = await channel.post('run-1', 'ask', questions)
  assert.equal(await channel.answers(posted, questions), null)
  writeFileSync(join(dir, 'answers-ask.md'), '/answer\nQ1: up')
  assert.equal((await channel.answers(posted, questions))?.[0]?.answer, 'up')
})
