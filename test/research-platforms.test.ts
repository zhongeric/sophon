import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { baseResearch } from '../src/cloudflare/config.ts'
import { github } from '../src/cloudflare/github.ts'
import type { ResearchConfig } from '../src/core/research.ts'
import { StopError } from '../src/core/stop.ts'
import { loadRepoConfig, loadResearch } from '../src/node/platform.ts'
import { mockServices } from './support/mock-services.ts'

const research: ResearchConfig = {
  egress: ['archive.example.org'],
  holdout: 'research/holdout.json',
  lenses: { survey: ['literature'], skeptic: ['systematics'] },
  guides: 'research/guides',
  checklist: 'research/checklist.md',
  prereg_sections: ['Holdout'],
  commands: { known: 'k {prereg}', inject: 'i {prereg}', evaluate: 'e {prereg}', reproduce: 'r {prereg}' },
}

const holdout = (target: string) => JSON.stringify({ refuse: ['https://archive.example.org/objects/'], targets: [target] })

/** Writes files into a directory, with the directories that they need. */
function write(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

/** The research files of main, plus files that the domain must not include: a note, a nested guide and a symlink. */
const mainFiles = {
  'research/holdout.json': holdout('main-target'),
  'research/checklist.md': '# Checklist\n\n- Check the known set\n- Check the holdout\n',
  'research/guides/method.md': 'method on main\n',
  'research/guides/sources.md': 'sources\n',
  'research/guides/notes.txt': 'not a guide\n',
  'research/guides/old/legacy.md': 'nested, not a guide\n',
}

function researchRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'factory-research-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  write(repo, mainFiles)
  symlinkSync('method.md', join(repo, 'research/guides/link.md'))
  git('add', '-A')
  git('commit', '-q', '-m', 'research on main')
  git('checkout', '-q', '-b', 'feature')
  write(repo, {
    'research/holdout.json': holdout('feature-target'),
    'research/guides/method.md': 'method on feature\n',
    'research/feature-holdout.json': holdout('feature-only'),
    'research/feature-guides/extra.md': 'feature only\n',
  })
  git('add', '-A')
  git('commit', '-q', '-m', 'change the rails on feature')
  git('checkout', '-q', 'main')
  return repo
}

async function stops(promise: Promise<unknown>, message: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof StopError, String(error))
    assert.equal(error.message, message)
    return true
  })
}

test('on Cloudflare, the research domain comes from the base branch through the contents API', async () => {
  const repo = researchRepo()
  const mock = await mockServices(repo, {
    botLogin: 'factory-bot',
    name: 'app',
    owner: 'acme',
    script: () => {
      throw new Error('no model call is expected')
    },
  })
  try {
    const gh = github('token', mock.url)
    const domain = await baseResearch(gh, 'acme', 'app', 'main', research)
    assert.deepEqual(domain, {
      config: research,
      holdout: { refuse: ['https://archive.example.org/objects/'], targets: ['main-target'] },
      checklist: ['Check the known set', 'Check the holdout'],
      guides: { 'method.md': 'method on main\n', 'sources.md': 'sources\n' },
    })
    // Each directory is listed one time.
    const listings = mock.state.requests.filter((route) => route === 'GET /repos/acme/app/contents/research')
    assert.equal(listings.length, 1)

    const feature = await baseResearch(gh, 'acme', 'app', 'feature', research)
    assert.deepEqual([feature.holdout.targets, feature.guides['method.md']], [['feature-target'], 'method on feature\n'])

    await stops(baseResearch(gh, 'acme', 'app', 'main', { ...research, holdout: 'research/feature-holdout.json' }), 'research/feature-holdout.json on main: the file does not exist')
    await stops(baseResearch(gh, 'acme', 'app', 'main', { ...research, holdout: 'nowhere/holdout.json' }), 'nowhere/holdout.json on main: the file does not exist')
    await stops(baseResearch(gh, 'acme', 'app', 'main', { ...research, holdout: 'research/guides' }), 'research/guides on main: the file does not exist')
    await stops(baseResearch(gh, 'acme', 'app', 'main', { ...research, checklist: 'research/missing.md' }), 'research/missing.md on main: the file does not exist')
    await stops(baseResearch(gh, 'acme', 'app', 'main', { ...research, guides: 'research/feature-guides' }), 'research/feature-guides on main: the directory does not exist')
    await stops(baseResearch(gh, 'acme', 'app', 'main', { ...research, guides: 'research/holdout.json' }), 'research/holdout.json on main: the directory does not exist')
  } finally {
    mock.close()
    rmSync(repo, { force: true, recursive: true })
  }
})

test('locally, the research paths resolve against the repository root, also with a config file in another directory', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'factory-research-'))
  write(repo, mainFiles)
  symlinkSync('method.md', join(repo, 'research/guides/link.md'))
  symlinkSync('missing.md', join(repo, 'research/guides/gone.md'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'factory-config-'))
  write(elsewhere, { 'research/holdout.json': holdout('elsewhere-target'), 'research/guides/method.md': 'elsewhere\n' })
  const path = join(elsewhere, 'config.json')
  writeFileSync(path, JSON.stringify({ checks: { smoke: 'true' }, research }))
  try {
    const config = await loadRepoConfig(repo, path)
    assert.ok(config.research)
    const domain = await loadResearch(repo, config.research)
    assert.deepEqual(domain, {
      config: research,
      holdout: { refuse: ['https://archive.example.org/objects/'], targets: ['main-target'] },
      checklist: ['Check the known set', 'Check the holdout'],
      // A symlink counts by its target. A symlink without a target is not a file.
      guides: { 'link.md': 'method on main\n', 'method.md': 'method on main\n', 'sources.md': 'sources\n' },
    })

    const source = `in ${repo}`
    await stops(loadResearch(repo, { ...research, holdout: 'research/missing.json' }), `research/missing.json ${source}: the file does not exist`)
    await stops(loadResearch(repo, { ...research, holdout: 'research/guides' }), `research/guides ${source}: the file does not exist`)
    await stops(loadResearch(repo, { ...research, checklist: 'nowhere/checklist.md' }), `nowhere/checklist.md ${source}: the file does not exist`)
    await stops(loadResearch(repo, { ...research, guides: 'research/missing' }), `research/missing ${source}: the directory does not exist`)
    await stops(loadResearch(repo, { ...research, guides: 'research/checklist.md' }), `research/checklist.md ${source}: the directory does not exist`)
  } finally {
    rmSync(repo, { force: true, recursive: true })
    rmSync(elsewhere, { force: true, recursive: true })
  }
})
