import { Sql } from 'nanocode-ts/cloudflare'
import module from 'nanocode-ts/nanocode_wasm.wasm'
import { parseRepoConfig, repoConfigFile, type RepoConfig } from '../core/checks.ts'
import type { Ledger } from '../core/ledger.ts'
import { commentChannel, cutComment, type Comments } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { codeReviewLoop, mergeModels, providersOf, type LoopInput, type LoopModels, type LoopResult } from '../core/workflows/code-review-loop.ts'
import { ciChecker } from './checker.ts'
import { GitHubError, type GitHub } from './github.ts'
import { bundledGuides } from './guides.ts'
import { githubRepo, type PullRequest } from './repo.ts'
import type { ReviewOutcome } from './review.ts'
import { answerersOf, credentialsFor, defaultCiTimeoutMinutes, objectName, Runs } from './runs.ts'
import { sqlFiles, sqlLedger } from './storage.ts'

export { allowedUsers, type Env } from './runs.ts'

/** `ask` replaces the PR title and body as the original ask, for a review that the development workflow starts. */
export type StartRequest = PullRequest & { ship: boolean; by: string; full?: boolean; ask?: string }

/** A finished review as the development workflow needs it: the fixes as a commit on GitHub. */
export type { ReviewOutcome } from './review.ts'

/** The rails of a repository from its base branch, so that a PR or a run cannot change its own. */
export async function baseConfig(gh: GitHub, owner: string, repo: string, ref: string): Promise<RepoConfig> {
  let text: string
  try {
    text = await (await gh.raw(`/repos/${owner}/${repo}/contents/${repoConfigFile}?ref=${encodeURIComponent(ref)}`, 'application/vnd.github.raw')).text()
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404)
      throw new StopError(`add ${repoConfigFile} to ${ref} first. The run reads its rails from the base branch, so a PR cannot change its own.`)
    throw error
  }
  return { ...parseRepoConfig(text, `${repoConfigFile} on ${ref}`), guides: {} }
}

const linkKey = 'development-issue'

/** The review runs of one PR. */
export class PullRequestRuns extends Runs<StartRequest> {
  protected number(request: StartRequest) {
    return request.pr
  }

  /** Records the issue whose development run opened this PR, so that CI webhooks and the end of a review run wake that run. */
  async link(issue: number): Promise<void> {
    await this.ctx.storage.put(linkKey, issue)
  }

  /** The issue whose development run opened this PR, or null. */
  async linkedIssue(): Promise<number | null> {
    return (await this.ctx.storage.get<number>(linkKey)) ?? null
  }

  /** The ask that started this review run. */
  ask(run: string): string | undefined {
    const row = this.row(run)
    return row ? (JSON.parse(row.request) as StartRequest).ask : undefined
  }

  /** The development run that opened this PR waits for its review run, so the end of a review run wakes it. */
  protected override async ended(request: StartRequest): Promise<void> {
    const issue = await this.linkedIssue()
    if (issue !== null) await this.env.DEVELOPMENT_RUNS.get(this.env.DEVELOPMENT_RUNS.idFromName(objectName(request.owner, request.repo, issue))).resume()
  }

  protected runName(request: StartRequest, stamp: string) {
    return `pr-${request.pr}-${stamp}`
  }

  protected announcement(run: string, request: StartRequest) {
    return `agent-factory started review run \`${run}\` for @${request.by}. Questions for you will appear here; answer them with a \`/answer\` comment.`
  }

  /** The result of a review run, with its fixes as a commit on GitHub, or what the run waits for. */
  outcome(run: string): ReviewOutcome {
    const row = this.row(run)
    if (!row) return { waiting: `no review run ${run}` }
    if (row.state === 'error') return { waiting: `review run ${run} stopped: ${row.note}. Resume it with npm run remote -- resume.` }
    if (row.state !== 'passed' && row.state !== 'failed') return { waiting: `review run ${run} is ${row.state}${row.note ? `: ${row.note}` : ''}` }
    const ledger = sqlLedger(this.ctx.storage.sql, run)
    const result = ledger.get<{ pass: boolean; criteria: LoopResult['criteria']; final: string }>('result')!
    const published = ledger.get<{ local: string; sha: string }>('published')
    const headSha = ledger.get<{ headSha: string }>('snapshot')!.headSha
    return {
      branch: `factory/${run}`,
      criteria: result.criteria,
      final: published?.local === result.final ? published.sha : headSha,
      pass: result.pass,
      report: sqlFiles(this.ctx.storage.sql, run).read('report.md') ?? '',
    }
  }

  protected async execute(run: string, request: StartRequest, ledger: Ledger, gh: GitHub, comments: Comments) {
    const recorded = ledger.get<LoopInput>('input')
    // A run that started before a model role existed has no choice for it: use the default.
    const input = recorded ? { ...recorded, models: mergeModels(recorded.models) } : await this.input(run, request, gh)
    const pull = { owner: request.owner, pr: request.pr, repo: request.repo }
    const branch = `factory/${run}`
    const log = (line: string) => console.log(`[${request.owner}/${request.repo}#${request.pr} ${run}] ${line}`)
    const sql = Sql.create(this.ctx.storage)
    const repo = githubRepo({ branch, gh, ledger, log, pull, runId: run, sql })
    const result = await codeReviewLoop(input, {
      channel: commentChannel({ answerers: answerersOf(this.env, input.config.answerers), comments, pollMs: 0, waitMs: 0 }),
      checker: ciChecker({ branch, gh, ledger, pull, repo, timeoutMs: Number(this.env.CI_TIMEOUT_MINUTES ?? defaultCiTimeoutMinutes) * 60_000 }),
      credentials: credentialsFor(this.env, providersOf(input.models)),
      files: sqlFiles(this.ctx.storage.sql, run),
      guides: bundledGuides,
      ledger,
      log,
      module,
      repo,
      store: { record: () => {}, scope: (agent) => `${run}/${agent}`, sql },
    })
    return { passed: result.pass, summary: summary(run, result) }
  }

  /** The run's input. The checks and rails come from the base branch, so a PR cannot change its own. */
  private async input(run: string, request: StartRequest, gh: GitHub): Promise<LoopInput> {
    const api = `/repos/${request.owner}/${request.repo}`
    type Side = { ref: string; repo: { full_name: string } | null }
    const view = await gh.json<{ title: string; body: string | null; base: Side; head: Side }>('GET', `${api}/pulls/${request.pr}`)
    if (view.head.repo?.full_name.toLowerCase() !== view.base.repo?.full_name.toLowerCase())
      throw new StopError(
        'fork PRs are not supported: the fixes would go to a branch of this repository, where push CI runs the fork code with the repository secrets',
      )
    const config = await baseConfig(gh, request.owner, request.repo, view.base.ref)
    const overrides = this.env.MODELS ? (JSON.parse(this.env.MODELS) as Partial<LoopModels>) : {}
    return {
      ask: request.ask ?? `${view.title}\n\n${view.body ?? ''}`.trim(),
      config,
      models: mergeModels(overrides),
      pr: request.pr,
      runId: run,
      source: `${request.owner}/${request.repo}#${request.pr}`,
      ...(request.ship ? { ship: { headRef: view.head.ref, pr: request.pr } } : {}),
      ...(request.full ? { full: true } : {}),
    }
  }
}

function summary(run: string, result: LoopResult): string {
  const report = cutComment(result.report, 'cut')
  return [
    `### agent-factory: ${result.pass ? 'PASS' : 'FAIL'} (run \`${run}\`)`,
    '',
    ...result.criteria.map((criterion) => `- [${criterion.ok ? 'x' : ' '}] ${criterion.name}`),
    '',
    `Fixes: \`${result.branch}\` at \`${result.final.slice(0, 12)}\``,
    '',
    '<details><summary>Full report</summary>',
    '',
    report,
    '',
    '</details>',
  ].join('\n')
}
