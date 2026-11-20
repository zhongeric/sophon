import { GitHubError, type GitHub } from './github.ts'

/** The kinds of work that a label starts. This module has no Worker types, so that the Node tests import it. */
export type WorkKind = 'review' | 'develop' | 'research'

export const workLabels: Record<WorkKind, string> = {
  develop: 'agent-develop',
  research: 'agent-research',
  review: 'agent-review',
}

/** The color of a label that the host makes. */
const labelColor = '5319e7'

/**
 * Adds the label `name` to issue or PR `number`, and makes the label first when the repository has no such label.
 * It never throws: on an error it gives the error to `log` and returns false.
 */
export async function addLabel(options: { gh: GitHub; owner: string; repo: string; number: number; name: string; log: (error: unknown) => void }): Promise<boolean> {
  const { gh, name } = options
  const api = `/repos/${options.owner}/${options.repo}`
  try {
    try {
      await gh.json('GET', `${api}/labels/${encodeURIComponent(name)}`)
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 404)) throw error
      try {
        await gh.json('POST', `${api}/labels`, { color: labelColor, name })
      } catch (created) {
        // A 422 tells that the label exists, for example because another run made it after the GET.
        if (!(created instanceof GitHubError && created.status === 422)) throw created
      }
    }
    await gh.json('POST', `${api}/issues/${options.number}/labels`, { labels: [name] })
    return true
  } catch (error) {
    options.log(error)
    return false
  }
}
