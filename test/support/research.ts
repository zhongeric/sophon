import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Contracts } from 'nanocode-ts'
import { coreSections } from '../../src/core/prereg.ts'
import type { Channel } from '../../src/core/questions.ts'
import type { Prices } from '../../src/core/usage.ts'
import { defaultResearchModels, research, type ResearchInput } from '../../src/core/workflows/research.ts'
import { nodeResearch } from '../../src/node/platform.ts'
import { credentials, module } from './fixture.ts'
import type { Script, Turn } from './scripted-model.ts'

export const holdoutPrefix = 'https://archive.example.org/holdout/'
export const lenses = ['literature', 'catalogs']
export const earlierPrereg = '# Prereg hyp-001 v1\n\nFrozen by an earlier run.\n'

export const researchConfig = {
  egress: ['archive.example.org'],
  holdout: 'research/holdout.json',
  lenses: { survey: lenses, skeptic: ['systematics'] },
  guides: 'research/guides',
  checklist: 'research/checklist.md',
  prereg_sections: ['Holdout'],
  commands: { known: 'make known PREREG={prereg}', inject: 'make inject PREREG={prereg}', evaluate: 'make evaluate PREREG={prereg}', reproduce: 'make reproduce PREREG={prereg}' },
  credentials: { 'archive.example.org': { header: 'x-api-key', secret: 'ARCHIVE_TOKEN' } },
}

export const prices: Prices = {
  'claude-opus-5-5': { input: 1000, cached_input: 100, cache_write: 1000, output: 1000 },
  'gpt-6.1-sol': { input: 1000, cached_input: 100, cache_write: 1000, output: 1000 },
}

/**
 * A notebook with a research config on main, a bare origin with main, and prereg/hyp-001-v1.md from an earlier run.
 * The working copy has an uncommitted holdout without a refuse list, and the files of `uncommitted`.
 * `config` replaces the config on main.
 */
export function notebook(options: { config?: Record<string, unknown>; uncommitted?: Record<string, string> } = {}): { repo: string; origin: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-notebook-'))
  const origin = join(dir, 'origin.git')
  const repo = join(dir, 'repo')
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(repo, path, '..'), { recursive: true })
      writeFileSync(join(repo, path), text)
    }
  }
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  mkdirSync(repo)
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString()
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'Test')
  run('config', 'commit.gpgsign', 'false')
  write({
    '.agent-factory.json': JSON.stringify(options.config ?? { checks: { smoke: 'true' }, research: researchConfig }),
    'research/holdout.json': JSON.stringify({ refuse: [holdoutPrefix], targets: ['ngc-1234'] }),
    'research/checklist.md': '- Check the known set\n- Check the holdout\n',
    'research/guides/method.md': 'METHOD GUIDE: cite the archive.\n',
    'prereg/hyp-001-v1.md': earlierPrereg,
  })
  run('add', '-A')
  run('commit', '-q', '-m', 'notebook')
  run('remote', 'add', 'origin', origin)
  run('push', '-q', 'origin', 'main')
  write({ 'research/holdout.json': JSON.stringify({ refuse: [], targets: ['changed-target'] }), ...options.uncommitted })
  return { repo, origin, base: run('rev-parse', 'HEAD').trim() }
}

export const pageText = (path: string) => `Archive page ${path}: dwarf galaxies stay quiet in the deep fields.`

/** The archive: a fetch that records each URL with its x-api-key header, and answers with a text page. */
export function archive() {
  const fetched: { url: string; key: string | null }[] = []
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    fetched.push({ url: request.url, key: request.headers.get('x-api-key') })
    return new Response(pageText(new URL(request.url).pathname), { headers: { 'content-type': 'text/plain' } })
  }
  return { fetch: fetcher as typeof fetch, fetched }
}

const intake = { title: 'Quiet dwarf galaxies', summary: 'Search the deep fields for quiet dwarf galaxies.', slug: 'quiet-dwarfs', questions: [] }

const hypothesis = (title: string, data: string, test: string) => ({
  title,
  statement: `${title} exist in the deep fields.`,
  why_missed: 'Past searches cut faint sources.',
  data,
  test,
  kill_criterion: 'No excess over the calibrated null.',
  cost: 'One day of compute.',
})

/** The list of each generator family. The second item of codex has the data and the test of the first item of claude. */
export const generated = {
  claude: [hypothesis('Quiet dwarfs', 'the deep field catalog', 'a stacked light curve test'), hypothesis('Old streams', 'the stream catalog', 'a velocity test')],
  codex: [hypothesis('Hidden pairs', 'the pair catalog', 'a separation test'), hypothesis('Quiet dwarf galaxies', 'The deep field  catalog', 'A stacked light curve test')],
}

const submit = (tool: string, input: unknown) => `await tools.${tool}(${JSON.stringify(input)})\ntext('submitted')`

/**
 * The cell of a surveyor: it fetches the page of its lens through the egress, tries the holdout, and submits a survey
 * for each quote, in order or with `parallel` all at once. A rejected submit shows in the output.
 */
function surveyCell(lens: string, quotes: string[], parallel = false): string {
  return [
    `const response = await fetch('https://archive.example.org/papers/${lens}')`,
    `const id = response.headers.get('x-artifact-id')`,
    `try { await fetch('${holdoutPrefix}targets.csv'); text('HOLDOUT FETCHED') } catch (error) { text('holdout refused: ' + error) }`,
    `const survey = (evidence) => ({ summary: 'The archive of ${lens} says that dwarf galaxies stay quiet.', claims: [{ statement: 'Dwarf galaxies stay quiet.', location: 'artifact:' + id, evidence }] })`,
    ...(parallel
      ? [
          `const results = await Promise.allSettled(${JSON.stringify(quotes)}.map((quote) => tools.submit_survey(survey(quote))))`,
          `for (const result of results) text(result.status === 'fulfilled' ? 'survey accepted' : 'survey refused: ' + result.reason)`,
        ]
      : quotes.map((quote) => `try { await tools.submit_survey(survey(${JSON.stringify(quote)})); text('survey accepted') } catch (error) { text('survey refused: ' + error) }`)),
  ].join('\n')
}

const badQuote = 'a quote that the page does not have'
const goodQuote = 'dwarf galaxies stay quiet'

/**
 * The research roles. The literature surveyor fixes a rejected survey on its second try. The surveyor of `failLens`
 * submits a bad quote two times. The surveyor of `parallelLens` submits two bad quotes and a good quote at once.
 * With `noHypotheses`, both generators submit an empty list.
 */
export function researchScript(options: { failLens?: string; parallelLens?: string; noHypotheses?: boolean } = {}): Script {
  return (turn: Turn) => {
    if (turn.output !== null) return { text: 'done' }
    if (turn.role === 'intake') return { cell: submit('submit_research_intake', intake) }
    if (turn.role === 'surveyor') {
      const lens = /Survey the lens \\"([a-z-]+)\\"/.exec(turn.request)?.[1] ?? 'unknown'
      if (lens === options.parallelLens) return { cell: surveyCell(lens, [badQuote, badQuote, goodQuote], true) }
      const quotes = lens === options.failLens ? [badQuote, badQuote] : lens === 'literature' ? [badQuote, goodQuote] : [goodQuote]
      return { cell: surveyCell(lens, quotes) }
    }
    if (turn.role === 'generator') {
      const list = options.noHypotheses ? [] : turn.provider === 'claude' ? generated.claude : generated.codex
      return { cell: submit('submit_hypotheses', { hypotheses: list }) }
    }
    if (turn.role === 'preregistrar') {
      const id = /prereg of (hyp-\d+)/.exec(turn.request)?.[1] ?? 'unknown'
      const sections = [...coreSections, 'Holdout'].map((name) => ({ name, text: `${name} of ${id}.` }))
      return { cell: submit('submit_prereg', { hypothesis: id, sections, known_recall: 0.9 }) }
    }
    return { text: 'done' }
  }
}

export function researchInput(base: string, runId: string, overrides: Partial<ResearchInput> = {}): ResearchInput {
  return { runId, program: 'Find quiet dwarf galaxies in the deep fields.', base, baseRef: 'main', source: 'notebook on main', models: defaultResearchModels, ...overrides }
}

/** Runs the research workflow on the notebook with the archive fetch, the prices and the archive secret. */
export async function runResearch(
  repo: string,
  runsDir: string,
  input: ResearchInput,
  options: { channel: Channel; dispatch: Contracts.RuntimeOptions['dispatch']; fetch?: typeof fetch; env?: Record<string, string> },
) {
  const deps = await nodeResearch({
    channel: options.channel,
    credentials,
    dispatch: options.dispatch,
    env: options.env ?? { ARCHIVE_TOKEN: 'token-1' },
    fetch: options.fetch ?? archive().fetch,
    input,
    log: () => {},
    module,
    prices,
    repo,
    runsDir,
  })
  return { deps, result: await research(input, deps) }
}
