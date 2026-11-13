import type { Contracts } from 'nanocode-ts'
import type { Ledger } from './ledger.ts'

/** A decision that only the user can make, with the options and the host's recommendation. */
export type Question = {
  id: string
  question: string
  why: string
  options: string[]
  recommendation: string
}

export type Answer = { id: string; question: string; answer: string; recommended: boolean }

/** Where a batch of questions went, so that a resumed run reads its answers from the same place. */
export type Posted = { batch: string; ref: string; at: string }

/** A place where the user reads questions and answers them. */
export type Channel = {
  post(runId: string, batch: string, questions: Question[]): Promise<Posted>
  /** The answers, or null when the user did not answer yet. */
  answers(posted: Posted, questions: Question[]): Promise<Answer[] | null>
  /** Where the user answers, for the pause message. */
  where(posted: Posted): string
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
    `### agent-factory needs your input (run \`${runId}\`)`,
    '',
    'Reply with a comment that starts with `/answer`. Give one line for each question that you answer. A question that you leave out takes the recommendation.',
    '',
    '```',
    '/answer',
    `${questions[0]?.id ?? 'Q1'}: b`,
    `${questions[1]?.id ?? 'Q2'}: your own words also work`,
    '```',
    '',
    'Reply `/answer recommended` to take every recommendation.',
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

export const submitQuestions: Contracts.HostTool = {
  name: 'submit_questions',
  description:
    'Submit the questions that only the user can decide, one time. Submit an empty list when the ask settles everything. ' +
    'Each question needs at least two options, and the recommendation must be one of the options, word for word.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'One decision, as a question' },
            why: { type: 'string', description: 'Why the answer changes the review or the fix, with the file or the part of the ask' },
            options: { type: 'array', items: { type: 'string' } },
            recommendation: { type: 'string', description: 'The option that you recommend, word for word' },
          },
          required: ['question', 'why', 'options', 'recommendation'],
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
}

export function checkQuestions(input: unknown): Question[] {
  const list = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(list)) throw new Error('questions must be an array')
  const problems: string[] = []
  const questions = list.map((item: Partial<Question>, index): Question => {
    if (!item.question?.trim() || !item.why?.trim()) problems.push(`questions[${index}]: question and why are required`)
    if (!Array.isArray(item.options) || item.options.length < 2) problems.push(`questions[${index}]: give at least two options`)
    else if (!item.options.includes(item.recommendation ?? '')) problems.push(`questions[${index}]: the recommendation must be one of the options`)
    return { id: `Q${index + 1}`, question: item.question ?? '', why: item.why ?? '', options: item.options ?? [], recommendation: item.recommendation ?? '' }
  })
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return questions
}

/**
 * Posts each batch one time and records its answers in the ledger. A batch without answers
 * pauses the run; the resumed run reads the answers from where the batch went.
 */
export function asker(ledger: Ledger, channel: Channel, runId: string, log: (line: string) => void) {
  const post = async (batch: string, questions: Question[]) => {
    ledger.put(`questions:${batch}`, questions)
    if (questions.length === 0 || ledger.get(`posted:${batch}`)) return
    const posted = await channel.post(runId, batch, questions)
    ledger.put(`posted:${batch}`, posted)
    log(`asked ${questions.length} questions (${batch}) at ${channel.where(posted)}`)
  }
  const wait = async (batch: string): Promise<Answer[]> => {
    const recorded = ledger.get<Answer[]>(`answers:${batch}`)
    if (recorded) return recorded
    const questions = ledger.get<Question[]>(`questions:${batch}`) ?? []
    const posted = ledger.get<Posted>(`posted:${batch}`)
    if (questions.length === 0 || !posted) return []
    const answers = await channel.answers(posted, questions)
    if (!answers) throw new PausedError(`waiting for your answers at ${channel.where(posted)}`)
    ledger.put(`answers:${batch}`, answers)
    ledger.put('decisions', [...decisions(ledger), ...answers])
    return answers
  }
  return { post, wait }
}

export function decisions(ledger: Ledger): Answer[] {
  return ledger.get<Answer[]>('decisions') ?? []
}

/** \`edited\` is true when someone changed the comment after it was posted; anyone with write access can. */
export type PrComment = { author: string; body: string; createdAt: string; edited?: boolean }

/** The comments of one PR, on any platform. `at` is the comment's creation time, from the same clock as the replies. */
export type Comments = {
  post(body: string): Promise<{ url: string; at: string }>
  list(): Promise<PrComment[]>
}

/**
 * Questions as a PR comment. Only later, unedited replies from `answerers` count, because answers reach
 * the patch agents and the gate. `waitMs` keeps polling before the run pauses.
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
  return {
    async post(runId, batch, questions) {
      const { url, at } = await options.comments.post(render(runId, batch, questions))
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
  }
}
