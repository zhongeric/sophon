import { StopError } from './stop.ts'

/** The signature rules of one branch. `rulesets` holds the label of each ruleset with a `required_signatures` rule on the branch. */
export type BranchRule = { branch: string; rulesets: string[]; classic: 'required' | 'none' | 'unreadable' }

export type CommitMode = 'signed' | 'unsigned'

/** The ledger entry of the signing check. `origin` is false when the repository has no GitHub origin. */
export type SigningRecord = { origin: boolean; branches: BranchRule[]; mode: CommitMode }

/** An HTTP answer of GitHub, also for an error status. */
export type GitHubAnswer = { status: number; body: unknown }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const pageSize = 100

/**
 * GitHub's answer for a private repository whose plan has no rulesets and no branch protection. On such a plan no rule
 * can require signatures, so the answer means no rule.
 */
const planLimited = (answer: GitHubAnswer): boolean =>
  answer.status === 403 && isObject(answer.body) && typeof answer.body.message === 'string' && answer.body.message.startsWith('Upgrade to GitHub Pro')

/**
 * Reads the rulesets and the classic protection that require signed commits on each branch. `api` is the
 * repository's API path, as readCi takes it. `get` resolves for every HTTP answer and rejects only when there is no answer.
 * A rejection is not an answer about the rules, so it goes to the caller unchanged and is not a StopError.
 */
export async function readSignatureRules(get: (path: string) => Promise<GitHubAnswer>, api: string, branches: string[]): Promise<BranchRule[]> {
  const labels = new Map<number, Promise<string>>()
  // The label is only for the report, so a failed call gives a fallback label and does not stop the run.
  const label = (id: number): Promise<string> => {
    let found = labels.get(id)
    if (!found) {
      found = get(`${api}/rulesets/${id}`).then(
        (answer) => (answer.status === 200 && isObject(answer.body) && typeof answer.body.name === 'string' ? answer.body.name : `ruleset ${id}`),
        () => `ruleset ${id}`,
      )
      labels.set(id, found)
    }
    return found
  }
  const result: BranchRule[] = []
  for (const branch of branches) {
    const name = encodeURIComponent(branch)
    const ids = new Set<number>()
    for (let page = 1; ; page++) {
      const rulesPath = `${api}/rules/branches/${name}?per_page=${pageSize}&page=${page}`
      const rules = await get(rulesPath)
      if (planLimited(rules)) break
      if (rules.status !== 200) throw failed(branch, rulesPath, `answered ${rules.status}`, rules.status)
      if (!Array.isArray(rules.body)) throw failed(branch, rulesPath, 'answered 200 without an array of rules')
      for (const rule of rules.body) {
        if (!isObject(rule) || typeof rule.type !== 'string') throw failed(branch, rulesPath, 'answered 200 with a rule without a type')
        if (rule.type !== 'required_signatures') continue
        if (typeof rule.ruleset_id !== 'number') throw failed(branch, rulesPath, 'answered 200 with a required_signatures rule without a ruleset_id')
        ids.add(rule.ruleset_id)
      }
      if (rules.body.length < pageSize) break
    }
    const rulesets = [...new Set(await Promise.all([...ids].map(label)))]
    const classicPath = `${api}/branches/${name}/protection/required_signatures`
    const classic = await get(classicPath)
    if (classic.status === 200) {
      if (!isObject(classic.body) || typeof classic.body.enabled !== 'boolean') throw failed(branch, classicPath, 'answered 200 without a boolean enabled')
      result.push({ branch, rulesets, classic: classic.body.enabled ? 'required' : 'none' })
    } else if (classic.status === 404 || planLimited(classic)) result.push({ branch, rulesets, classic: 'none' })
    // Decision of the user: the endpoint needs Administration read, so a 403 is an unknown answer, not a stop.
    else if (classic.status === 403) result.push({ branch, rulesets, classic: 'unreadable' })
    else throw failed(branch, classicPath, `answered ${classic.status}`, classic.status)
  }
  return result
}

/** A 429 or a 5xx can go away, so it is not a StopError: the run loop of the Cloudflare host tries the run again. */
function failed(branch: string, path: string, problem: string, status = 200): Error {
  const message = `Cannot read the signature rules of branch ${branch}: GET ${path} ${problem}`
  return status === 429 || status >= 500 ? new Error(message) : new StopError(message)
}

/** Signed when a ruleset or classic protection requires signatures, or when only an unreadable classic protection is left and `signUnknown` is true. */
export function commitMode(rules: BranchRule[], options: { signUnknown: boolean }): CommitMode {
  if (rules.some((rule) => rule.rulesets.length > 0 || rule.classic === 'required')) return 'signed'
  if (options.signUnknown && rules.some((rule) => rule.classic === 'unreadable')) return 'signed'
  return 'unsigned'
}

/** The Commits line of the report, without a list marker. */
export function signingLine(record: SigningRecord): string {
  if (!record.origin) return 'Commits: unsigned (no GitHub origin)'
  if (record.branches.length === 0) return 'Commits: unsigned (no pushed branch)'
  const labels = [...new Set(record.branches.flatMap((rule) => [...rule.rulesets, ...(rule.classic === 'required' ? ['classic protection'] : [])]))]
  const unreadable = record.branches.some((rule) => rule.classic === 'unreadable')
  const suffix = unreadable ? ', classic protection not readable' : ''
  if (record.mode === 'signed' && labels.length > 0) return `Commits: signed (required by ${labels.join(', ')}${suffix})`
  if (record.mode === 'signed') return 'Commits: signed (classic protection not readable)'
  return `Commits: unsigned (no signature rule${suffix})`
}
