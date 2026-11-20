import type { Contracts } from 'nanocode-ts'
import type { Ledger } from './ledger.ts'

/** The kinds of choice that only the user can make (D11). */
export const rules = ['scope', 'capability', 'spend', 'decision'] as const
export type Rule = (typeof rules)[number]
export const isRule = (value: unknown): value is Rule => rules.some((rule) => rule === value)

/**
 * A decision with the options and the host's recommendation. A `user` question goes to the user and names its rule.
 * The host takes the recommendation of a `run` question at once (D11).
 */
export type Question = {
  id: string
  question: string
  why: string
  options: string[]
  recommendation: string
  level: 'user' | 'run'
  rule?: Rule
}

/** `decidedBy` is absent when the user decided, also in a ledger from before D11. */
export type Answer = { id: string; question: string; answer: string; recommended: boolean; decidedBy?: 'run' }

/** A question from a ledger before D11 has no level, so it counts as a user question. */
const isUser = (question: Question) => question.level !== 'run'

/** Keep the decisions of the user separate from the decisions that the run made. */
function splitDecisions(answers: Answer[]): { user: Answer[]; run: Answer[] } {
  return { user: answers.filter((answer) => answer.decidedBy !== 'run'), run: answers.filter((answer) => answer.decidedBy === 'run') }
}

/**
 * The decisions of the user, then the decisions that the run made, as two Markdown lists under their titles. One renderer for
 * the frozen ask, the PR body and the reports, so that their lines do not drift. A list without decisions shows its `empty`
 * line, or no section when the caller gives no `empty` line.
 */
export function decisionLists(
  answers: Answer[],
  titles: { user: string; run: string },
  options: { empty?: { user: string; run: string }; recommended?: boolean } = {},
): string[] {
  const { user, run } = splitDecisions(answers)
  const line = (answer: Answer) => `- ${answer.question} **${answer.answer}**${options.recommended && answer.recommended ? ' (recommended)' : ''}`
  const section = (title: string, list: Answer[], empty?: string) => {
    const lines = list.length > 0 ? list.map(line) : empty ? [empty] : []
    return lines.length > 0 ? [title, '', ...lines, ''] : []
  }
  return [...section(titles.user, user, options.empty?.user), ...section(titles.run, run, options.empty?.run)]
}

const runAnswer = (question: Question): Answer => ({ id: question.id, question: question.question, answer: question.recommendation, recommended: true, decidedBy: 'run' })

/** Where a batch of questions went, so that a resumed run reads its answers from the same place. */
export type Posted = { batch: string; ref: string; at: string }

/** A place where the user reads questions and answers them. */
export type Channel = {
  post(runId: string, batch: string, questions: Question[]): Promise<Posted>
  /** The answers, or null when the user did not answer yet. */
  answers(posted: Posted, questions: Question[]): Promise<Answer[] | null>
  /** Where the user answers, for the pause message. */
  where(posted: Posted): string
  /** Gives the user information that needs no answer, for example the notice at the cost budget. */
  notice?(runId: string, text: string): Promise<void>
}

/** The run waits for the user. Resume it with the same run ID after the user answers. */
export class PausedError extends Error {
  override name = 'PausedError'
}

const marker = (runId: string, batch: string) => `<!-- agent-factory:questions run=${runId} batch=${batch} -->`
export const letter = (index: number) => String.fromCharCode(97 + index)

export function render(runId: string, batch: string, questions: Question[]): string {
  return [
    marker(runId, batch),
    'Reply with a `/answer` comment and one `Q<n>: <letter or your own words>` line for each question. A question that you leave out takes the recommendation. `/answer recommended` takes all recommendations.',
    '',
    ...questions.flatMap((question) => [
      `**${question.id}.** ${question.question}`,
      '',
      question.why,
      '',
      ...question.options.map((option, index) => `- ${letter(index)}) ${option}${option === question.recommendation ? ' (recommended)' : ''}`),
      '',
    ]),
  ].join('\n')
}

/** Reads a `/answer` reply. An option letter selects that option; other text is the answer as written. */
export function parseAnswers(body: string, questions: Question[]): Answer[] | null {
  const lines = body.trim().split('\n').map((line) => line.trim())
  if (!/^\/answer\b/i.test(lines[0] ?? '')) return null
  const recommendedOnly = /^\/answer\s+recommended\s*$/i.test(lines[0]!)
  const given = new Map<string, string>()
  if (!recommendedOnly)
    for (const line of lines.slice(1)) {
      const match = /^(Q\d+)\s*[:.)]\s*(.+)$/i.exec(line)
      if (match) given.set(match[1]!.toUpperCase(), match[2]!.trim())
    }
  return questions.map((question) => {
    const text = given.get(question.id.toUpperCase())
    if (text === undefined) return { id: question.id, question: question.question, answer: question.recommendation, recommended: true }
    const byLetter = /^[a-z]\)?$/i.test(text) ? question.options[text.toLowerCase().charCodeAt(0) - 97] : undefined
    const answer = byLetter ?? text
    return { id: question.id, question: question.question, answer, recommended: answer === question.recommendation }
  })
}

/** The JSON schema of a list of questions, for every submit tool that raises questions. */
export const questionsSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'One decision, as a question' },
      why: { type: 'string', description: 'Why the answer changes the work, with the file or the part of the ask' },
      options: { type: 'array', items: { type: 'string' } },
      recommendation: { type: 'string', description: 'The option that you recommend, word for word' },
      level: {
        type: 'string',
        enum: ['user', 'run'],
        description:
          'D11: user only when the choice (1) removes or adds scope compared with the ask (a reading of an unclear ask that keeps its intent does not), (2) changes capabilities across workflows ' +
          '(network and web search, protected paths, secrets, allowed models, blinding), (3) commits spend over the budget or an irreversible or public action, ' +
          'or (4) departs from a recorded D or RD row. Every other question is run: the host takes your recommendation at once and does not ask the user.',
      },
      rule: { type: 'string', enum: [...rules], description: 'With level user: the D11 rule that makes it a question for the user' },
    },
    required: ['question', 'why', 'options', 'recommendation', 'level'],
    additionalProperties: false,
  },
}

export const submitQuestions: Contracts.HostTool = {
  name: 'submit_questions',
  description:
    'Submit your open questions, one time. Submit an empty list when the ask settles everything. ' +
    'Give each question a level by D11: only a user question goes to the user, and it needs its rule. The host takes the recommendation of a run question at once. ' +
    'Each question needs at least two options, and the recommendation must be one of the options, word for word.',
  parameters: { type: 'object', properties: { questions: questionsSchema }, required: ['questions'], additionalProperties: false },
}

export function checkQuestions(input: unknown): Question[] {
  const list = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(list)) throw new Error('questions must be an array')
  const problems: string[] = []
  const questions = list.map((item: Partial<Question>, index): Question => {
    if (!item.question?.trim() || !item.why?.trim()) problems.push(`questions[${index}]: question and why are required`)
    if (!Array.isArray(item.options) || item.options.length < 2) problems.push(`questions[${index}]: give at least two options`)
    else if (!item.options.includes(item.recommendation ?? '')) problems.push(`questions[${index}]: the recommendation must be one of the options`)
    if (item.level !== 'user' && item.level !== 'run') problems.push(`questions[${index}]: level must be user or run`)
    else if (item.level === 'user' && !isRule(item.rule)) problems.push(`questions[${index}]: a user question needs a rule: ${rules.join(', ')}`)
    const question = { id: `Q${index + 1}`, question: item.question ?? '', why: item.why ?? '', options: item.options ?? [], recommendation: item.recommendation ?? '' }
    // A run question takes its recommendation, so a rule on it has no use.
    return item.level === 'user' && isRule(item.rule) ? { ...question, level: 'user', rule: item.rule } : { ...question, level: 'run' }
  })
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return questions
}

/**
 * Posts the user questions of each batch one time, and records the answers of all its questions in the ledger.
 * A batch with only run questions takes its recommendations at once, with no post (D11). A posted batch without answers pauses the run. The resumed run reads the answers from where the batch went.
 * With `decisions` false, the answers do not go into the decisions of the run, which the agents read, for example the answers about the cost budget.
 * With `recommend`, each batch takes its recommendations at once, also for user questions, and posts nothing (a hotfix, or standing answers).
 */
export function asker(ledger: Ledger, channel: Channel, runId: string, log: (line: string) => void, options: { decisions?: boolean; recommend?: boolean } = {}) {
  const post = async (batch: string, questions: Question[]) => {
    if (ledger.get(`answers:${batch}`)) return
    if (options.recommend) {
      recommend(batch, questions)
      return
    }
    // A batch keeps its questions, also when it is from before D11.
    questions = ledger.get<Question[]>(`questions:${batch}`) ?? questions
    ledger.put(`questions:${batch}`, questions)
    if (!ledger.get(`run-answers:${batch}`)) {
      const run = questions.filter((question) => !isUser(question)).map(runAnswer)
      ledger.put('decisions', [...decisions(ledger), ...run])
      ledger.put(`run-answers:${batch}`, run)
    }
    if (ledger.get(`posted:${batch}`)) return
    const user = questions.filter(isUser)
    if (user.length === 0) {
      if (questions.length > 0) record(batch, questions.map(runAnswer))
      return
    }
    const posted = await channel.post(runId, batch, user)
    ledger.put(`posted:${batch}`, posted)
    log(`asked ${user.length} questions (${batch}) at ${channel.where(posted)}`)
  }
  /** The answers of every question of the batch, in the order of the questions. */
  const wait = async (batch: string): Promise<Answer[]> => {
    const recorded = ledger.get<Answer[]>(`answers:${batch}`)
    if (recorded) return recorded
    const questions = ledger.get<Question[]>(`questions:${batch}`) ?? []
    const posted = ledger.get<Posted>(`posted:${batch}`)
    if (questions.length === 0 || !posted) return []
    const user = questions.filter(isUser)
    const answers = await channel.answers(posted, user)
    if (!answers) throw new PausedError(`waiting for your answers at ${channel.where(posted)}`)
    const all = questions.map((question) => {
      if (!isUser(question)) return runAnswer(question)
      const answer = answers.find((entry) => entry.id === question.id)
      if (!answer) throw new Error(`the channel gave no answer for ${question.id} of ${batch}`)
      return answer
    })
    return record(batch, all)
  }
  const record = (batch: string, answers: Answer[]) => {
    const run = ledger.get<Answer[]>(`run-answers:${batch}`) ?? []
    ledger.put(`answers:${batch}`, answers)
    if (options.decisions !== false) ledger.put('decisions', [...decisions(ledger), ...answers.filter((answer) => !run.some((entry) => entry.id === answer.id))])
    return answers
  }
  /** Takes every recommendation without asking, when the user said so for this run. */
  const recommend = (batch: string, questions: Question[]): Answer[] =>
    ledger.get<Answer[]>(`answers:${batch}`) ??
    record(
      batch,
      questions.map((question) =>
        isUser(question) ? { id: question.id, question: question.question, answer: question.recommendation, recommended: true } : runAnswer(question),
      ),
    )
  return { post, wait, recommend }
}

export function decisions(ledger: Ledger): Answer[] {
  return ledger.get<Answer[]>('decisions') ?? []
}

/** The decisions so far, as /review/decisions.md, for every agent that runs after them: the user's first, then the run's. */
export function decisionsFile(ledger: Ledger): Record<string, string> {
  const { user, run } = splitDecisions(decisions(ledger))
  if (user.length === 0 && run.length === 0) return {}
  const section = (title: string, note: string, answers: Answer[]) =>
    answers.length > 0 ? ['', `## ${title}`, '', note, '', ...answers.map((answer) => `- ${answer.question}\n  Answer: ${answer.answer}`)] : []
  const text = [
    '# Decisions',
    ...section('Decisions of the user', 'These answers settle open points of the ask. Follow them.', user),
    ...section('Decisions the run made', 'The run took the recommendation for these questions, because they did not need the user (D11). Follow them.', run),
  ]
  return { '/decisions.md': `${text.join('\n')}\n` }
}

export const decisionsLine = (files: Record<string, string>) => ('/decisions.md' in files ? ['- Decisions: /review/decisions.md'] : [])

/** \`edited\` is true when someone changed the comment after it was posted; anyone with write access can. */
export type PrComment = { author: string; body: string; createdAt: string; edited?: boolean }

/** GitHub refuses comments over 65,536 characters. A longer text is cut at this length. */
export const commentLimit = 60_000

/** The comments of one PR, on any platform. `at` is the comment's creation time, from the same clock as the replies. */
export type Comments = {
  post(body: string): Promise<{ url: string; at: string }>
  list(): Promise<PrComment[]>
}

/**
 * Questions as a PR comment. Only later, unedited replies from `answerers` count, because answers reach
 * the patch agents and the gate. `waitMs` keeps polling before the run pauses.
 * The first line mentions each answerer that is not a bot, so that GitHub notifies them.
 */
export function commentChannel(options: { comments: Comments; answerers: string[]; waitMs: number; pollMs: number }): Channel {
  const answerers = new Set(options.answerers.map((login) => login.toLowerCase()))
  const read = async (posted: Posted, questions: Question[]) => {
    const replies = (await options.comments.list()).filter(
      (comment) =>
        comment.createdAt > posted.at && !comment.edited && answerers.has(comment.author.toLowerCase()) && /^\s*\/answer\b/i.test(comment.body),
    )
    const last = replies.at(-1)
    return last ? parseAnswers(last.body, questions) : null
  }
  const mentioned = new Set<string>()
  const mentions = options.answerers.filter((login) => {
    const key = login.toLowerCase()
    if (key.endsWith('[bot]') || mentioned.has(key)) return false
    mentioned.add(key)
    return true
  })
  const mentionLine = mentions.map((login) => `@${login}`).join(' ')
  return {
    async post(runId, batch, questions) {
      const text = render(runId, batch, questions)
      const { url, at } = await options.comments.post(mentionLine ? `${mentionLine}\n\n${text}` : text)
      return { batch, ref: url, at }
    },
    async answers(posted, questions) {
      const deadline = Date.now() + options.waitMs
      for (;;) {
        const answers = await read(posted, questions)
        if (answers || Date.now() >= deadline) return answers
        await new Promise((resolve) => setTimeout(resolve, options.pollMs))
      }
    },
    where: (posted) => posted.ref,
    // A notice needs no answer, so it has no questions marker and no mentions.
    async notice(_runId, text) {
      await options.comments.post(text)
    },
  }
}
