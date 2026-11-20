import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitHubError, type GitHub } from '../src/cloudflare/github.ts'
import { addLabel, workLabels } from '../src/cloudflare/labels.ts'

const api = '/repos/acme/app'

/** A GitHub stub with the labels of the repository. `fail` gives the HTTP status for a call, or undefined for success. */
function labelStub(setup: { labels: string[]; fail?: (call: string) => number | undefined }) {
  const calls: { call: string; body: unknown }[] = []
  const gh: GitHub = {
    async json<T>(method: string, path: string, body?: unknown): Promise<T> {
      const call = `${method} ${path}`
      calls.push({ body, call })
      const status = setup.fail?.(call)
      if (status !== undefined) throw new GitHubError(status, `GitHub ${call} answered HTTP ${status}`)
      if (method === 'GET' && path.startsWith(`${api}/labels/`)) {
        const name = decodeURIComponent(path.slice(`${api}/labels/`.length))
        if (!setup.labels.includes(name)) throw new GitHubError(404, 'Not Found')
        return { name } as T
      }
      if (call === `POST ${api}/labels`) return { name: (body as { name: string }).name } as T
      if (call === `POST ${api}/issues/7/labels`) return [] as T
      throw new Error(`stub has no route ${call}`)
    },
    raw: () => Promise.reject(new Error('no raw calls')),
    graphql: () => Promise.reject(new Error('no GraphQL calls')),
  }
  const logged: unknown[] = []
  const add = () => addLabel({ gh, log: (error) => logged.push(error), name: workLabels.review, number: 7, owner: 'acme', repo: 'app' })
  return { add, calls, logged }
}

test('labels: an existing label is only added to the issue or PR', async () => {
  const stub = labelStub({ labels: ['agent-review'] })
  await stub.add()
  assert.deepEqual(stub.calls, [
    { body: undefined, call: `GET ${api}/labels/agent-review` },
    { body: { labels: ['agent-review'] }, call: `POST ${api}/issues/7/labels` },
  ])
  assert.deepEqual(stub.logged, [])
})

test('labels: a missing label is made, then added', async () => {
  const stub = labelStub({ labels: [] })
  await stub.add()
  assert.deepEqual(
    stub.calls.map((entry) => entry.call),
    [`GET ${api}/labels/agent-review`, `POST ${api}/labels`, `POST ${api}/issues/7/labels`],
  )
  const made = stub.calls[1]!.body as { name: string; color: string }
  assert.equal(made.name, 'agent-review')
  assert.match(made.color, /^[0-9a-f]{6}$/)
  assert.deepEqual(stub.logged, [])
})

test('labels: a 422 on the create means that the label exists, so the label is still added', async () => {
  const stub = labelStub({ fail: (call) => (call === `POST ${api}/labels` ? 422 : undefined), labels: [] })
  await stub.add()
  assert.equal(stub.calls.at(-1)!.call, `POST ${api}/issues/7/labels`)
  assert.deepEqual(stub.logged, [])
})

test('labels: a failure of any call is logged without a throw', async () => {
  const failures: [string, number][] = [
    [`GET ${api}/labels/agent-review`, 500],
    [`POST ${api}/labels`, 403],
    [`POST ${api}/issues/7/labels`, 403],
  ]
  for (const [failing, status] of failures) {
    const stub = labelStub({ fail: (call) => (call === failing ? status : undefined), labels: [] })
    await stub.add()
    assert.equal(stub.logged.length, 1, failing)
    assert.ok(stub.logged[0] instanceof GitHubError && stub.logged[0].status === status, failing)
    // After a failed GET or create, the host does not add the label.
    if (failing !== `POST ${api}/issues/7/labels`) assert.ok(!stub.calls.some((entry) => entry.call === `POST ${api}/issues/7/labels`), failing)
  }
})
