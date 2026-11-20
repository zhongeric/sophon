import type { Comments, PrComment } from '../core/questions.ts'
import type { GitHub } from './github.ts'

const pageSize = 100

/** The comments of a Worker run: the core Comments, and a post that keeps the comment ID, so that the run can edit the comment later. */
export type RunComments = Comments & {
  create(body: string): Promise<{ id: number; url: string }>
  edit(id: number, body: string): Promise<void>
}

/** The comments of one PR through the GitHub REST API. */
export function githubComments(gh: GitHub, owner: string, repo: string, pr: number): RunComments {
  const path = `/repos/${owner}/${repo}/issues/${pr}/comments`
  return {
    async post(body) {
      const comment = await gh.json<{ html_url: string; created_at: string }>('POST', path, { body })
      return { url: comment.html_url, at: comment.created_at }
    },
    async create(body) {
      const comment = await gh.json<{ id: number; html_url: string }>('POST', path, { body })
      return { id: comment.id, url: comment.html_url }
    },
    async edit(id, body) {
      await gh.json('PATCH', `/repos/${owner}/${repo}/issues/comments/${id}`, { body })
    },
    async list() {
      type Raw = { user: { login: string }; body: string; created_at: string; updated_at: string }
      const comments: PrComment[] = []
      for (let page = 1; ; page++) {
        const batch = await gh.json<Raw[]>('GET', `${path}?per_page=${pageSize}&page=${page}`)
        comments.push(
          ...batch.map((comment) => ({ author: comment.user.login, body: comment.body, createdAt: comment.created_at, edited: comment.updated_at !== comment.created_at })),
        )
        if (batch.length < pageSize) return comments
      }
    },
  }
}
