import type { Comments, PrComment } from '../core/questions.ts'
import type { GitHub } from './github.ts'

const pageSize = 100

/** The comments of one PR through the GitHub REST API. */
export function githubComments(gh: GitHub, owner: string, repo: string, pr: number): Comments {
  const path = `/repos/${owner}/${repo}/issues/${pr}/comments`
  return {
    async post(body) {
      const comment = await gh.json<{ html_url: string; created_at: string }>('POST', path, { body })
      return { url: comment.html_url, at: comment.created_at }
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
