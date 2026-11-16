import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { StopError } from '../core/stop.ts'
import { optionalSetting, parseTarget, setting } from './remote.ts'

const usage = `Usage: npm run metrics -- [<number>...] [options]

Prints the CPU, memory, disk and network of each build container of the deployed Worker, with the run of its
issue. The numbers come from the Cloudflare GraphQL Analytics API.

Options:
  --since <time>   The time window, for example 30m, 3h or 2d (default 1h)
  --detail         Also print one line for each container and each time bucket
  --app <name>     The container application (default agent-factory-developmentruns)

<number> is owner/repo#123, or a GitHub PR or issue URL. Without it, the command prints each container that
sent metrics in the time window.

Environment: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or the same keys in .secrets/cloudflare.env.
When FACTORY_URL and ADMIN_TOKEN are also set, each container shows the latest run of its issue.`

const api = 'https://api.cloudflare.com/client/v4'
const defaultApp = 'agent-factory-developmentruns'

type Application = { id: string; name: string; max_instances: number; configuration: { vcpu: number; memory_mib: number; disk?: { size_mb: number } } }
type Rollout = { id: string; status: string }
type Group = {
  dimensions: { durableObjectId: string; bucket?: string }
  max: { cpuUtilization: number; memory: number; diskUsage: number }
  quantiles: { cpuUtilizationP50: number; cpuUtilizationP90: number }
  sum: { rxBytes: number; txBytes: number }
}

/** The time window of --since in milliseconds, for example 30m, 3h or 2d. */
export function parseSince(text: string): number {
  const match = /^(\d+)([mhd])$/.exec(text.trim())
  if (!match || Number(match[1]) === 0) throw new StopError(`--since ${text} is not a time like 30m, 3h or 2d`)
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[match[2] as 'd' | 'h' | 'm']
  return Number(match[1]) * unit
}

/** The bucket of the timeline: small enough to show one build step, and few enough rows for the API limit. */
export function bucketOf(windowMs: number): { field: string; label: string } {
  if (windowMs <= 2 * 3_600_000) return { field: 'datetimeMinute', label: '1-minute' }
  if (windowMs <= 2 * 86_400_000) return { field: 'datetimeFiveMinutes', label: '5-minute' }
  return { field: 'datetimeHour', label: '1-hour' }
}

/** Cloudflare gives CPU as a ratio of the allocated vCPU, so a container that bursts goes over 100%. */
export const percent = (ratio: number) => `${Math.round(ratio * 100)}%`
const gib = (bytes: number) => (bytes / 2 ** 30).toFixed(1)
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`

/** Pads each column to its widest cell. */
export function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)))
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd()).join('\n')
}

const messages = (errors: { message: string }[] | null | undefined) => errors?.map((error) => error.message).join('; ')

async function rest<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${api}${path}`, { headers: { authorization: `Bearer ${token}` } })
  const body = (await response.json()) as { success: boolean; errors?: { message: string }[]; result: T }
  if (!response.ok || !body.success) throw new StopError(`GET ${path} failed (${messages(body.errors) || response.status}). The token needs Containers Read.`)
  return body.result
}

async function groups(token: string, account: string, app: string, since: string, bucket: string | null): Promise<Group[]> {
  const dimensions = bucket ? `durableObjectId bucket: ${bucket}` : 'durableObjectId'
  const query = `{ viewer { accounts(filter: { accountTag: "${account}" }) { containersMetricsAdaptiveGroups(limit: 10000, filter: { applicationId: "${app}", datetime_geq: "${since}" }) {
    dimensions { ${dimensions} } max { cpuUtilization memory diskUsage } quantiles { cpuUtilizationP50 cpuUtilizationP90 }
    sum { rxBytes txBytes } } } } }`
  const response = await fetch(`${api}/graphql`, {
    body: JSON.stringify({ query }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  })
  type Data = { viewer: { accounts: { containersMetricsAdaptiveGroups: Group[] }[] } }
  const body = (await response.json()) as { data: Data | null; errors: { message: string }[] | null }
  if (!response.ok || body.errors?.length || !body.data)
    throw new StopError(`the metrics query failed (${messages(body.errors) || response.status}). The token needs Account Analytics Read.`)
  // An object that never started its container reports only zeros.
  return (body.data.viewer.accounts[0]?.containersMetricsAdaptiveGroups ?? []).filter((group) => group.max.memory > 0)
}

/** The latest run of the issue that a container belongs to. A container is named for its issue: owner/repo#123. */
async function runOf(container: string): Promise<{ run: string; state: string }> {
  const factory = optionalSetting('FACTORY_URL')
  const admin = optionalSetting('ADMIN_TOKEN')
  if (!factory || !admin) return { run: '-', state: '-' }
  try {
    const { owner, repo, pr } = parseTarget(container)
    const response = await fetch(`${factory.replace(/\/$/, '')}/runs/${owner}/${repo}/${pr}`, { headers: { authorization: `Bearer ${admin}` } })
    const latest = ((await response.json()) as { runs: { run: string; state: string }[] }).runs[0]
    return latest ? { run: latest.run, state: latest.state } : { run: 'none', state: '-' }
  } catch {
    return { run: '?', state: '?' }
  }
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { app: { type: 'string' }, detail: { type: 'boolean' }, help: { short: 'h', type: 'boolean' }, since: { type: 'string' } },
  })
  if (values.help) {
    console.log(usage)
    return 0
  }
  const wanted = positionals.map((text) => {
    const { owner, repo, pr } = parseTarget(text)
    return `${owner}/${repo}#${pr}`.toLowerCase()
  })
  const windowMs = parseSince(values.since ?? '1h')
  const token = setting('CLOUDFLARE_API_TOKEN')
  const account = setting('CLOUDFLARE_ACCOUNT_ID')
  const appName = values.app ?? defaultApp
  const app = (await rest<Application[]>(token, `/accounts/${account}/containers/applications`)).find((candidate) => candidate.name === appName)
  if (!app) throw new StopError(`the account has no container application ${appName}`)
  const since = new Date(Date.now() - windowMs).toISOString()
  const bucket = bucketOf(windowMs)
  const [rollouts, assigned, summary, timeline] = await Promise.all([
    rest<Rollout[]>(token, `/accounts/${account}/containers/applications/${app.id}/rollouts`),
    rest<{ durable_objects: { id: string; name: string }[] }>(token, `/accounts/${account}/containers/dash/applications/${app.id}/instances`),
    groups(token, account, app.id, since, null),
    groups(token, account, app.id, since, bucket.field),
  ])

  const names = new Map(assigned.durable_objects.map((container) => [container.id, container.name]))
  const nameOf = (group: Group) => names.get(group.dimensions.durableObjectId) ?? group.dimensions.durableObjectId.slice(0, 12)
  const lastSeen = new Map<string, string>()
  for (const group of timeline) {
    const id = group.dimensions.durableObjectId
    const at = group.dimensions.bucket ?? ''
    if (at > (lastSeen.get(id) ?? '')) lastSeen.set(id, at)
  }
  const seen = (group: Group) => lastSeen.get(group.dimensions.durableObjectId) ?? ''
  const shown = summary.filter((group) => wanted.length === 0 || wanted.includes(nameOf(group).toLowerCase())).sort((a, b) => seen(b).localeCompare(seen(a)))

  const { configuration } = app
  const rollout = rollouts[0] ? `. Latest rollout: ${rollouts[0].status}` : ''
  console.log(`${app.name}: ${configuration.vcpu} vCPU, ${configuration.memory_mib / 1024} GiB, ${(configuration.disk?.size_mb ?? 0) / 1000} GB disk, at most ${app.max_instances} instances${rollout}`)
  console.log(`Last ${values.since ?? '1h'}, times in UTC. CPU is a part of the vCPU that the container had. Cloudflare reports metrics some minutes late.\n`)
  for (const target of wanted.filter((name) => !shown.some((group) => nameOf(group).toLowerCase() === name))) console.log(`${target}: no metrics in the time window`)
  if (shown.length === 0) return 0

  const runs = await Promise.all(shown.map((group) => runOf(nameOf(group))))
  const header = ['container', 'run', 'state', 'last seen', 'cpu p50', 'cpu p90', 'cpu max', 'memory max', 'disk max', 'received', 'sent']
  const rows = shown.map((group, index) => [
    nameOf(group),
    runs[index]!.run,
    runs[index]!.state,
    seen(group).slice(11, 16),
    percent(group.quantiles.cpuUtilizationP50),
    percent(group.quantiles.cpuUtilizationP90),
    percent(group.max.cpuUtilization),
    `${gib(group.max.memory)} GiB`,
    `${(group.max.diskUsage / 1e9).toFixed(1)} GB`,
    mb(group.sum.rxBytes),
    mb(group.sum.txBytes),
  ])
  console.log(table([header, ...rows]))

  if (values.detail)
    for (const group of shown) {
      const buckets = timeline.filter((row) => row.dimensions.durableObjectId === group.dimensions.durableObjectId).sort((a, b) => (a.dimensions.bucket ?? '').localeCompare(b.dimensions.bucket ?? ''))
      const lines = buckets.map((row) => [(row.dimensions.bucket ?? '').slice(11, 16), percent(row.quantiles.cpuUtilizationP90), percent(row.max.cpuUtilization), `${gib(row.max.memory)} GiB`, mb(row.sum.rxBytes)])
      console.log(`\n${nameOf(group)}, ${bucket.label} buckets:\n${table([['time', 'cpu p90', 'cpu max', 'memory max', 'received'], ...lines])}`)
    }
  return 0
}

if (fileURLToPath(import.meta.url) === process.argv[1])
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof StopError ? `stop: ${error.message}` : error)
      process.exit(2)
    },
  )
