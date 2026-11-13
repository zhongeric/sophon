import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzip, untar } from '../src/cloudflare/tar.ts'

test('GitHub-style tarballs read back with long non-ASCII paths, symlinks and modes', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'factory-tar-'))
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo })
  const long = `${'とても長いファイルの名前'.repeat(4)}.md`
  run('init', '-q', '-b', 'main')
  run('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, long), 'long name\n')
  writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  symlinkSync(long, join(repo, 'link.md'))
  run('add', '-A')
  run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x')
  const archive = execFileSync('git', ['archive', '--format=tar.gz', '--prefix=acme-app-1234567/', 'HEAD'], { cwd: repo })
  const entries = untar(await gunzip(new Blob([archive]).stream()), 1)
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  assert.equal(new TextDecoder().decode(byPath.get(long)?.data), 'long name\n')
  assert.deepEqual([byPath.get('link.md')?.type, byPath.get('link.md')?.target], ['symlink', long])
  assert.equal((byPath.get('run.sh')!.mode & 0o111) !== 0, true)
})
