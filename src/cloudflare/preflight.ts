import { checkProviders, failedChecksText, type FailedCheck } from '../core/preflight.ts'
import type { Credential, Provider } from '../core/providers.ts'
import type { ModelChoice } from '../core/roles.ts'
import { StopError } from '../core/stop.ts'
import type { LoopModels } from '../core/workflows/code-review-loop.ts'
import { GitHubError, refusedCredential, type GitHub } from './github.ts'
import { githubAccess, type InstallationTokens } from './github-app.ts'
import type { Env } from './runs.ts'

/** What the preflight of a run checks (D17): its models, whether it needs the build container, and the base whose CI it reads. */
export type PreflightNeeds = { models: ModelChoice[]; container: boolean; ciBase: string | null }

/** Each model choice of a review loop. */
export const loopChoices = (models: LoopModels): ModelChoice[] => [...Object.values(models.step1), ...Object.values(models.step2), models.light]

/** A preflight with failed checks. `gh` is undefined when the GitHub access check failed, because then the run cannot post. */
export class PreflightFailed extends Error {
  override name = 'PreflightFailed'
  readonly failed: FailedCheck[]
  readonly gh: GitHub | undefined
  constructor(failed: FailedCheck[], gh: GitHub | undefined) {
    super(`the preflight found failed checks: ${failedChecksText(failed).replace(/\n/g, ' ')}`)
    this.failed = failed
    this.gh = gh
  }
}

type PreflightOptions = {
  env: Env
  owner: string
  repo: string
  tokens: InstallationTokens
  /** True when the object has a Cloudflare Container. */
  container: boolean
  credential: (provider: Provider) => Credential
  needs: (gh: GitHub | undefined) => Promise<PreflightNeeds>
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\.$/, '')

/**
 * Checks the prerequisites of a run before its first turn (D17), and gives the GitHub access of the run. It does all
 * checks. A failed check throws PreflightFailed. Else a check that can pass by itself throws an Error, so that the
 * normal error path starts the run again later (D13).
 */
export async function preflight(options: PreflightOptions): Promise<{ gh: GitHub; app: boolean }> {
  const { env, owner, repo } = options
  const failed: FailedCheck[] = []
  const transient: string[] = []
  let access: { gh: GitHub; app: boolean } | undefined
  try {
    const found = await githubAccess(env, owner, repo, options.tokens)
    await found.gh.json('GET', `/repos/${owner}/${repo}`)
    access = found
  } catch (error) {
    if (error instanceof StopError || refusedCredential(error) || (error instanceof GitHubError && error.status === 404)) {
      const fix = env.GITHUB_APP_ID || env.GITHUB_APP_PRIVATE_KEY ? `install the GitHub App on ${owner}/${repo}` : `give GITHUB_TOKEN read access to ${owner}/${repo}`
      failed.push({ check: 'GitHub access', fix, problem: reason(error) })
    } else transient.push(`GitHub access: ${reason(error)}`)
  }
  // Without GitHub access, the needs skip the checks that read GitHub.
  const needs = await options.needs(access?.gh)
  if (needs.container && !env.MACHINE_URL && !options.container)
    failed.push({ check: 'Build container', fix: 'add the containers section of wrangler.jsonc and deploy again', problem: 'this Worker has no container for builds' })
  if (access && needs.ciBase !== null) {
    const missing = { check: 'CI workflow', fix: `add a workflow file to .github/workflows on ${needs.ciBase}`, problem: `${needs.ciBase} has no workflow file in .github/workflows` }
    try {
      const listing = await access.gh.json<{ type?: unknown }[] | Record<string, unknown>>('GET', `/repos/${owner}/${repo}/contents/.github/workflows?ref=${encodeURIComponent(needs.ciBase)}`)
      if (!Array.isArray(listing) || !listing.some((entry) => entry.type === 'file')) failed.push(missing)
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) failed.push(missing)
      else transient.push(`CI workflow: ${reason(error)}`)
    }
  }
  const providers = await checkProviders(needs.models, options.credential)
  failed.push(...providers.failed)
  transient.push(...providers.transient)
  if (failed.length > 0) throw new PreflightFailed(failed, access?.gh)
  if (transient.length > 0 || !access) throw new Error(`the preflight could not finish: ${transient.join('. ')}`)
  return access
}
