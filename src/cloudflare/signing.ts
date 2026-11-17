import type { Signing } from '../core/platform.ts'
import { commitMode, readSignatureRules, type GitHubAnswer } from '../core/signing.ts'
import { StopError } from '../core/stop.ts'
import { GitHubError, type GitHub } from './github.ts'

/** The signing check of the Cloudflare host. Its commits go through the Git Data API and are unsigned, so a rule that requires signatures stops the run. */
export function githubSigning(gh: GitHub, owner: string, repo: string): Signing {
  const get = async (path: string): Promise<GitHubAnswer> => {
    try {
      return { body: await gh.json<unknown>('GET', path), status: 200 }
    } catch (error) {
      // A rate limit rejects the request, so the run loop tries again.
      if (error instanceof GitHubError && !error.rateLimited) return { body: null, status: error.status }
      throw error
    }
  }
  return {
    async check(branches) {
      const rules = await readSignatureRules(get, `/repos/${owner}/${repo}`, branches)
      // A classic 403 alone continues unsigned: the decision of the user.
      return { branches: rules, mode: commitMode(rules, { signUnknown: false }), origin: true }
    },
    async apply(record) {
      if (record.mode !== 'signed') return
      const required = record.branches.filter((rule) => rule.rulesets.length > 0 || rule.classic === 'required')
      const labels = [...new Set(required.flatMap((rule) => [...rule.rulesets, ...(rule.classic === 'required' ? ['classic protection'] : [])]))]
      throw new StopError(
        `Branch ${required.map((rule) => rule.branch).join(', ')} requires signed commits (${labels.join(', ')}). The Cloudflare host commits through the Git Data API, and these commits are unsigned. Run with the local host, or change the rule.`,
      )
    },
  }
}
