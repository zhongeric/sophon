import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { MemoryFileSystem, type FileSystem } from 'nanocode-ts/bash'
import { checkoutCommit } from '../src/cloudflare/branches.ts'
import { treeGit } from '../src/cloudflare/trees.ts'
import { mockServices } from './support/mock-services.ts'
import { holdoutPrefix, notebook, pageText, researchConfig, researchScript } from './support/research.ts'
import { sendWebhook, startWorker, until } from './support/wrangler.ts'

const read = async (tree: FileSystem.FileSystem, path: string) => new TextDecoder().decode(await tree.read(path))
const exists = async (tree: FileSystem.FileSystem, path: string) => Boolean(await tree.stat(path).catch(() => null))

test('checkoutCommit copies only the files of the commit, without the uncommitted files of the tree', async () => {
  const from = MemoryFileSystem.create({ files: { '/kept.txt': 'one', '/gone.txt': 'tracked', '/dir/edit.txt': 'committed' } })
  const git = treeGit(from)
  await git('init', '-q')
  await git('add', '-A')
  await git('commit', '-q', '-m', 'one')
  const commit = (await git('rev-parse', 'HEAD')).trim()
  await from.write('/later.txt', new TextEncoder().encode('later'))
  await git('add', '-A')
  await git('commit', '-q', '-m', 'two')
  // The same size as the committed text, so that only the content tells the change.
  await from.write('/dir/edit.txt', new TextEncoder().encode('work-copy'))
  await from.remove('/gone.txt')
  await from.write('/new.txt', new TextEncoder().encode('untracked'))
  const to = MemoryFileSystem.create()
  await checkoutCommit(from, to, commit)
  assert.deepEqual([await read(to, '/kept.txt'), await read(to, '/gone.txt'), await read(to, '/dir/edit.txt')], ['one', 'tracked', 'committed'])
  assert.deepEqual([await exists(to, '/later.txt'), await exists(to, '/new.txt')], [false, false])
  // The source tree keeps its uncommitted work.
  assert.equal(await read(from, '/dir/edit.txt'), 'work-copy')
})

const secret = 'webhook-secret'
const adminToken = 'admin-7f3k9q'
const repository = { full_name: 'acme/app' }
const headers = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }
const free = { input: 0, cached_input: 0, cache_write: 0, output: 0 }
const program = { title: 'Quiet dwarf galaxies', body: 'Find quiet dwarf galaxies in the deep fields.' }
type Status = { runs: { run: string; state: string; note: string }[] }

let mock: Awaited<ReturnType<typeof mockServices>>
let worker: Awaited<ReturnType<typeof startWorker>>
const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => [c.issue, c.body.slice(0, 160)]))}\nworker:\n${worker.output().slice(-4000)}`
const status = async (number: number) => (await (await fetch(`${worker.url}/runs/acme/app/${number}`, { headers })).json()) as Status
const on = (number: number) => mock.state.comments.filter((entry) => entry.issue === number)
const issuePayload = (number: number) => ({ number, ...(mock.state.pulls.has(number) ? { pull_request: {} } : {}) })
const say = async (number: number, body: string) => {
  mock.comment('maintainer', body, number)
  return sendWebhook(worker.url, secret, 'issue_comment', { action: 'created', comment: { body, user: { login: 'maintainer' } }, issue: issuePayload(number), repository })
}

before(async () => {
  const { repo } = notebook()
  const branch = (name: string, config: Record<string, unknown>) => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
    git('stash', '-q')
    git('checkout', '-q', '-b', name)
    writeFileSync(join(repo, '.agent-factory.json'), JSON.stringify(config))
    git('commit', '-q', '-a', '-m', `config of ${name}`)
    git('checkout', '-q', 'main')
    git('stash', 'pop', '-q')
  }
  // A notebook config whose credential names a setting of the Worker.
  branch('admin-credential', { checks: { smoke: 'true' }, research: { ...researchConfig, credentials: { 'archive.example.org': { header: 'x-api-key', secret: 'ADMIN_TOKEN' } } } })
  branch('no-checks', {})
  const issues = { 5: program, 9: program, 10: program, 11: program }
  mock = await mockServices(repo, { botLogin: 'factory-bot', issues, name: 'app', owner: 'acme', pages: pageText, pr: 7, script: researchScript() })
  try {
    worker = await startWorker({
      ADMIN_TOKEN: adminToken,
      ALLOWED_USERS: 'Maintainer',
      ANTHROPIC_API_KEY: 'anthropic-key',
      ANTHROPIC_URL: `${mock.url}/v1/messages`,
      ARCHIVE_TOKEN: 'archive-token',
      EGRESS_URL: `${mock.url}/egress`,
      GITHUB_API_URL: mock.url,
      GITHUB_TOKEN: 'github-token',
      GITHUB_WEBHOOK_SECRET: secret,
      MACHINE_URL: `${mock.url}/machine`,
      MODEL_PRICES: JSON.stringify({ 'claude-opus-5-5': free, 'gpt-6.1-sol': free }),
      OPENAI_API_KEY: 'openai-key',
      OPENAI_URL: `${mock.url}/v1`,
      PAUSE_POLL_SECONDS: '2',
    })
  } catch (error) {
    await mock.close()
    throw error
  }
})

after(async () => {
  await worker?.stop()
  await mock?.close()
})

test('on Cloudflare, /research runs the research workflow on an issue and opens the dossier PR', { timeout: 600_000 }, async () => {
  const started = (await (await say(5, '/research --parallel 2')).json()) as { run: string; started: boolean }
  assert.equal(started.started, true)
  assert.match(started.run, /^research-5-/)
  // Each question batch of the run and of its review pass gets one answer: the pick of hyp-001, else the recommendations.
  const answered = new Set<number>()
  const result = await until(
    async () => {
      for (const asked of mock.state.comments.filter((entry) => entry.user.login === 'factory-bot' && entry.body.includes('agent-factory:questions'))) {
        if (answered.has(asked.id)) continue
        answered.add(asked.id)
        await say(asked.issue, /batch=pick /.test(asked.body) ? '/answer\nQ1: a' : '/answer recommended')
      }
      return on(5).find((entry) => entry.body.startsWith('# Research run:'))
    },
    540_000,
    describe,
  )
  assert.match(result.body, /^# Research run: READY/, describe())
  assert.ok(on(5).some((entry) => entry.body.startsWith(`agent-factory started research run \`${started.run}\``)))
  const dossier = [...mock.state.pulls.values()].find((pull) => pull.head.startsWith(`factory/research-${started.run}`))
  assert.ok(dossier, describe())
  assert.equal((await status(5)).runs[0]?.state, 'passed')
  // The calibration and the reproduction ran on clean checkouts, each in a new directory.
  const domainDirs = new Set(mock.state.commands.filter((command) => command.argv.join(' ').includes('research/run.mjs')).map((command) => command.cwd))
  assert.ok(domainDirs.size > 1 && [...domainDirs].every((dir) => dir.startsWith(`clean/${started.run}/`)), JSON.stringify([...domainDirs]))
  // The surveyors fetched the archive through the egress, with the key from the Worker secret, and never the holdout.
  assert.ok(mock.state.egress.length > 0, describe())
  assert.ok(mock.state.egress.every((entry) => entry.key === 'archive-token'), JSON.stringify(mock.state.egress))
  assert.ok(!mock.state.egress.some((entry) => entry.url.startsWith(holdoutPrefix)), JSON.stringify(mock.state.egress))
})

test('on Cloudflare, the research route checks its input, and status shows the issue object with the latest run', { timeout: 120_000 }, async () => {
  assert.equal((await fetch(`${worker.url}/research/acme/app/11`, { body: JSON.stringify({ budget: -1 }), headers, method: 'POST' })).status, 400)
  assert.equal((await fetch(`${worker.url}/research/acme/app/11`, { headers })).status, 405)
  assert.equal((await fetch(`${worker.url}/research/acme/app/11`, { method: 'POST' })).status, 401)

  // A PR is not a program issue.
  assert.equal((await fetch(`${worker.url}/research/acme/app/7`, { body: '{}', headers, method: 'POST' })).status, 202)
  const pr = await until(async () => ((await status(7)).runs[0]?.state === 'error' ? (await status(7)).runs[0] : undefined), 60_000, describe)
  assert.match(pr.note, /#7 is a PR\. .*\/review/)

  // A credential that names a Worker setting stops the run with the name, never the value.
  assert.equal((await fetch(`${worker.url}/research/acme/app/10`, { body: JSON.stringify({ base: 'admin-credential' }), headers, method: 'POST' })).status, 202)
  const stopped = await until(async () => ((await status(10)).runs[0]?.state === 'error' ? (await status(10)).runs[0] : undefined), 60_000, describe)
  assert.match(stopped.note, /ADMIN_TOKEN/)
  assert.ok(!stopped.note.includes(adminToken))
  assert.ok(!on(10).some((entry) => entry.body.includes(adminToken)), describe())

  // A development run that stops, then a research run from the label: status shows the research run, which started last.
  assert.equal((await fetch(`${worker.url}/develop/acme/app/9`, { body: JSON.stringify({ base: 'no-checks' }), headers, method: 'POST' })).status, 202)
  await until(async () => ((await status(9)).runs[0]?.state === 'error' ? true : undefined), 60_000, describe)
  const labeled = { action: 'labeled', issue: { number: 9 }, label: { name: 'agent-research' }, repository, sender: { login: 'maintainer' } }
  const fromLabel = (await (await sendWebhook(worker.url, secret, 'issues', labeled)).json()) as { run: string; started: boolean }
  assert.equal(fromLabel.started, true)
  assert.match(fromLabel.run, /^research-9-/)
  assert.equal((await status(9)).runs[0]?.run, fromLabel.run)
})
