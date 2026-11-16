import { StopError } from './stop.ts'

/** The signature rules of one branch. `rulesets` holds the label of each ruleset with a `required_signatures` rule on the branch. */
export type BranchRule = { branch: string; rulesets: string[]; classic: 'required' | 'none' | 'unreadable' }

export type CommitMode = 'signed' | 'unsigned'

/** The ledger entry of the signing check. `origin` is false when the repository has no GitHub origin. */
export type SigningRecord = { origin: boolean; branches: BranchRule[]; mode: CommitMode }

/** An HTTP answer of GitHub, also for an error status. */
export type GitHubAnswer = { status: number; body: unknown }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * Reads the rulesets and the classic protection that require signed commits on each branch. `api` is the
 * repository's API path, as readCi takes it. `get` resolves for every HTTP answer and rejects only when there is no answer.
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
    const rulesPath = `${api}/rules/branches/${name}`
    const rules = await ask(get, rulesPath, branch)
    if (rules.status !== 200) throw failed(branch, rulesPath, `answered ${rules.status}`)
    if (!Array.isArray(rules.body)) throw failed(branch, rulesPath, 'answered 200 without an array of rules')
    const ids = new Set<number>()
    for (const rule of rules.body) {
      if (isObject(rule) && rule.type === 'required_signatures' && typeof rule.ruleset_id === 'number') ids.add(rule.ruleset_id)
    }
    const rulesets = [...new Set(await Promise.all([...ids].map(label)))]
    const classicPath = `${api}/branches/${name}/protection/required_signatures`
    const classic = await ask(get, classicPath, branch)
    if (classic.status === 200) result.push({ branch, rulesets, classic: isObject(classic.body) && classic.body.enabled === true ? 'required' : 'none' })
    else if (classic.status === 404) result.push({ branch, rulesets, classic: 'none' })
    // Decision of the user: the endpoint needs Administration read, so a 403 is an unknown answer, not a stop.
    else if (classic.status === 403) result.push({ branch, rulesets, classic: 'unreadable' })
    else throw failed(branch, classicPath, `answered ${classic.status}`)
  }
  return result
}

async function ask(get: (path: string) => Promise<GitHubAnswer>, path: string, branch: string): Promise<GitHubAnswer> {
  try {
    return await get(path)
  } catch (error) {
    throw failed(branch, path, `gave no answer: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function failed(branch: string, path: string, problem: string): StopError {
  return new StopError(`Cannot read the signature rules of branch ${branch}: GET ${path} ${problem}`)
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
