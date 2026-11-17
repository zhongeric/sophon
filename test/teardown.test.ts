import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mockServices } from './support/mock-services.ts'
import { groupAlive, stopGroup } from './support/wrangler.ts'

/** The error code of a connection to the port, or 'connected'. */
const attempt = (port: number) =>
  new Promise<string>((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.on('connect', () => {
      socket.destroy()
      resolve('connected')
    })
    socket.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? String(error)))
  })

test('stopGroup ends a process group that ignores SIGTERM, and resolves after the whole group is gone', { timeout: 20_000 }, async () => {
  // The shell and its sleep child ignore SIGTERM, so only the SIGKILL after the grace time ends them.
  const child = spawn('sh', ['-c', 'trap "" TERM; sleep 600 & echo ready; wait'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()))
  const pid = child.pid
  assert.ok(pid)
  assert.ok(groupAlive(pid))
  await stopGroup(child, 300)
  assert.ok(!groupAlive(pid))
  assert.ok(child.stdout.destroyed && child.stderr.destroyed)
  // A call after the group exited resolves without an error.
  await stopGroup(child, 300)
})

test('mock close resolves while a client holds an open keep-alive connection, and then the port refuses connections', { timeout: 20_000 }, async () => {
  const repo = mkdtempSync(join(tmpdir(), 'factory-teardown-'))
  const mock = await mockServices(repo, {
    botLogin: 'factory-bot',
    name: 'app',
    owner: 'acme',
    script: () => {
      throw new Error('no model call is expected')
    },
  })
  const port = Number(new URL(mock.url).port)
  const socket = connect(port, '127.0.0.1')
  try {
    const answered = new Promise<void>((resolve) => socket.once('data', () => resolve()))
    const ended = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    // One full request on a keep-alive connection, then a request that waits for its body.
    socket.write('GET /repos/acme/app/installation HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n')
    await answered
    socket.write('POST /machine HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const closing = mock.close()
    assert.ok(closing instanceof Promise)
    await closing
    await ended
    assert.equal(await attempt(port), 'ECONNREFUSED')
  } finally {
    socket.destroy()
    await mock.close()
    rmSync(repo, { force: true, recursive: true })
  }
})
