import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzip, tar, untar } from '../src/cloudflare/tar.ts'

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

test('archives for the build container read back in GNU tar, with long paths, symlinks and modes', () => {
  const long = `${'very-long-directory-name/'.repeat(6)}とても長い名前.ts`
  const text = (value: string) => new TextEncoder().encode(value)
  const archive = tar([
    { data: text('long\n'), mode: 0o644, path: long, target: '', type: 'file' },
    { data: text('#!/bin/sh\n'), mode: 0o755, path: 'run.sh', target: '', type: 'file' },
    { data: new Uint8Array(), mode: 0o777, path: 'link.ts', target: long, type: 'symlink' },
  ])
  const dir = mkdtempSync(join(tmpdir(), 'factory-untar-'))
  execFileSync('tar', ['-x', '-f', '-', '-C', dir], { input: archive })
  assert.equal(execFileSync('cat', [join(dir, long)]).toString(), 'long\n')
  assert.equal(execFileSync('cat', [join(dir, 'link.ts')]).toString(), 'long\n')
  assert.ok(statSync(join(dir, 'run.sh')).mode & 0o100)
  assert.deepEqual(untar(archive, 0).map((entry) => [entry.path, entry.type]), [[long, 'file'], ['run.sh', 'file'], ['link.ts', 'symlink']])
})
