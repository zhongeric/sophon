import { readRepoConfig, type RepoConfig } from '../core/checks.ts'
import type { RootFiles } from '../core/profiles.ts'
import type { GitHub } from './github.ts'

/** The files at the root of a commit on GitHub: one listing, then a read of each file that a profile needs. */
export async function rootAt(gh: GitHub, owner: string, repo: string, ref: string): Promise<RootFiles> {
  const api = `/repos/${owner}/${repo}/contents`
  const query = `?ref=${encodeURIComponent(ref)}`
  const listing = await gh.json<{ name: string; type: string }[]>('GET', `${api}${query}`)
  const files = new Set(listing.filter((entry) => entry.type === 'file').map((entry) => entry.name))
  return {
    exists: async (name) => files.has(name),
    read: async (name) => (files.has(name) ? (await gh.raw(`${api}/${encodeURIComponent(name)}${query}`, 'application/vnd.github.raw')).text() : null),
  }
}

/**
 * The rails of a repository from its base branch, so that a PR or a run cannot change its own: the defaults of the
 * profiles whose markers are on the branch, and its .agent-factory.json, when it has one.
 */
export async function baseConfig(gh: GitHub, owner: string, repo: string, ref: string): Promise<RepoConfig> {
  return { ...(await readRepoConfig(await rootAt(gh, owner, repo, ref), `on ${ref}`)), guides: {} }
}
