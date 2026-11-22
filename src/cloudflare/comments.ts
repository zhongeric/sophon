import type { Comments, PrComment } from '../core/questions.ts'
import type { GitHub } from './github.ts'

const pageSize = 100

/** The comments of one issue or PR on Cloudflare: a post also gives the comment ID, so that the run can edit its status comment (D21). */
export type StatusComments = Omit<Comments, 'post'> & {
  post(body: string): Promise<{ url: string; at: string; id: number }>
  edit(id: number, body: string): Promise<void>
}

/** The comments of one PR through the GitHub REST API. */
export function githubComments(gh: GitHub, owner: string, repo: string, pr: number): StatusComments {
  const path = `/repos/${owner}/${repo}/issues/${pr}/comments`
  return {
    async post(body) {
      const comment = await gh.json<{ id: number; html_url: string; created_at: string }>('POST', path, { body })
      return { url: comment.html_url, at: comment.created_at, id: comment.id }
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
