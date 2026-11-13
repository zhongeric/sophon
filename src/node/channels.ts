import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { letter, parseAnswers, render, type Channel, type Comments } from '../core/questions.ts'

export type Gh = (args: string[], input?: string) => Promise<string>

/** Runs the gh CLI in `cwd`, with `input` on stdin. */
export function gh(cwd: string): Gh {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile('gh', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
        error ? reject(new Error(`gh ${args.slice(0, 2).join(' ')}: ${stderr || error.message}`)) : resolve(stdout),
      )
      child.stdin?.end(input ?? '')
    })
}

/** The comments of a PR through the gh CLI. */
export function ghComments(run: Gh, pr: number): Comments {
  return {
    async post(body) {
      const at = new Date().toISOString()
      const url = (await run(['pr', 'comment', String(pr), '--body-file', '-'], body)).trim()
      return { url, at }
    },
    async list() {
      type Raw = { author: { login: string }; body: string; createdAt: string }
      const { comments } = JSON.parse(await run(['pr', 'view', String(pr), '--json', 'comments'])) as { comments: Raw[] }
      return comments.map((comment) => ({ author: comment.author.login, body: comment.body, createdAt: comment.createdAt }))
    },
  }
}

/** Questions as a file in the run directory, answered by writing a `/answer` reply to a second file. */
export function fileChannel(dir: string): Channel {
  const answersPath = (batch: string) => join(dir, `answers-${batch}.md`)
  return {
    async post(runId, batch, questions) {
      const ref = join(dir, `questions-${batch}.md`)
      writeFileSync(ref, `${render(runId, batch, questions)}\nWrite your reply to ${answersPath(batch)}.\n`)
      return { batch, ref, at: new Date().toISOString() }
    },
    async answers(posted, questions) {
      const path = answersPath(posted.batch)
      return existsSync(path) ? parseAnswers(readFileSync(path, 'utf8'), questions) : null
    },
    where: (posted) => `${posted.ref} (reply in ${answersPath(posted.batch)})`,
  }
}

/** Questions in the terminal. The user answers each one in place, so the run never pauses. */
export function terminalChannel(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Channel {
  return {
    async post(runId, batch, questions) {
      output.write(`\n${render(runId, batch, questions).split('\n').slice(1).join('\n')}\n`)
      return { batch, ref: 'terminal', at: new Date().toISOString() }
    },
    async answers(_posted, questions) {
      const prompt = createInterface({ input, output })
      try {
        const lines: string[] = ['/answer']
        for (const question of questions) {
          const options = question.options.map((option, index) => `  ${letter(index)}) ${option}${option === question.recommendation ? ' (recommended)' : ''}`)
          const reply = (await prompt.question(`\n${question.id}. ${question.question}\n${options.join('\n')}\nAnswer (Enter = recommended): `)).trim()
          if (reply) lines.push(`${question.id}: ${reply}`)
        }
        return parseAnswers(lines.join('\n'), questions)
      } finally {
        prompt.close()
      }
    },
    where: () => 'the terminal',
  }
}
