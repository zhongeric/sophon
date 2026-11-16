import { readRepoConfig, type RepoConfig } from '../core/checks.ts'
import type { RootFiles } from '../core/profiles.ts'
import { loadResearchDomain, type ResearchConfig, type ResearchDomain, type ResearchFiles } from '../core/research.ts'
import { GitHubError, type GitHub } from './github.ts'
import { encodePath } from './trees.ts'

/** The files at the root of a commit on GitHub: one listing, then a read of each file that a profile needs. */
export async function rootAt(gh: GitHub, owner: string, repo: string, ref: string): Promise<RootFiles> {
  const api = `/repos/${owner}/${repo}/contents`
  const query = `?ref=${encodeURIComponent(ref)}`
  const listing = await gh.json<{ name: string; type: string }[]>('GET', `${api}${query}`)
  const files = new Set(listing.filter((entry) => entry.type === 'file').map((entry) => entry.name))
  return {
    exists: async (name) => files.has(name),
    list: async () => [...files],
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

/**
 * The files of a commit on GitHub at nested paths. A file is read only when the listing of its parent shows it as a
 * file, as in rootAt. The reader keeps each listing, so a directory is listed one time.
 */
function filesAt(gh: GitHub, owner: string, repo: string, ref: string): ResearchFiles {
  const api = `/repos/${owner}/${repo}/contents`
  const query = `?ref=${encodeURIComponent(ref)}`
  const url = (path: string) => `${api}${path ? `/${encodePath(path)}` : ''}${query}`
  const listings = new Map<string, string[] | null>()
  const fetchListing = async (dir: string): Promise<string[] | null> => {
    try {
      // A directory gives an array of entries. A file or a symlink gives one object.
      const entries = await gh.json<{ name: string; type: string }[] | Record<string, unknown>>('GET', url(dir))
      return Array.isArray(entries) ? entries.filter((entry) => entry.type === 'file').map((entry) => entry.name) : null
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null
      throw error
    }
  }
  const list = async (dir: string) => {
    if (!listings.has(dir)) listings.set(dir, await fetchListing(dir))
    return listings.get(dir) ?? null
  }
  return {
    list,
    async read(path) {
      const slash = path.lastIndexOf('/')
      const files = await list(slash === -1 ? '' : path.slice(0, slash))
      return files?.includes(path.slice(slash + 1)) ? (await gh.raw(url(path), 'application/vnd.github.raw')).text() : null
    },
  }
}

/** The research domain from a commit on GitHub, so that a run cannot change its own holdout, checklist or guides. */
export async function baseResearch(gh: GitHub, owner: string, repo: string, ref: string, research: ResearchConfig): Promise<ResearchDomain> {
  return loadResearchDomain(research, filesAt(gh, owner, repo, ref), `on ${ref}`)
}
