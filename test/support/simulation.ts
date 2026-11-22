// A seeded simulation of the alarm calls of the Cloudflare runs. It runs the engine in-process, with a fake clock, fake
// Durable Object state, a fake box and the mock GitHub, and it injects the faults of a seed. See test/simulation.test.ts.
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { Box, BoxResult, JobState } from '../../src/cloudflare/box.ts'
import type { Clock } from '../../src/core/clock.ts'
import { mockServices } from './mock-services.ts'
import type { Script } from './scripted-model.ts'

// Module hooks: the engine imports Worker modules that Node does not have. They apply before the first engine import.
const repoRoot = new URL('../../', import.meta.url).href
const workersStub = `data:text/javascript,${encodeURIComponent(
  ['DurableObject', 'WorkerEntrypoint', 'WorkflowEntrypoint', 'RpcTarget']
    .map((name) => `export class ${name} { constructor(ctx, env) { this.ctx = ctx; this.env = env } }`)
    .concat('export const env = {}')
    .join('\n'),
)}`
// Workers import a wasm file as its compiled module. Each file compiles one time for each thread, and each generation of the engine modules uses it.
const wasmKey = Symbol.for('agent-factory.simulation.wasm')
const wasmModules = new Map<string, WebAssembly.Module>()
Reflect.set(globalThis, wasmKey, wasmModules)
type Resolve = Parameters<NonNullable<Parameters<typeof registerHooks>[0]['resolve']>>
/** Resolves a specifier. Wrangler bundles the Worker, so a package can import a relative path without its extension. */
function resolveFile(specifier: string, context: Resolve[1], nextResolve: Resolve[2]) {
  try {
    return nextResolve(specifier, context)
  } catch (error) {
    if (!specifier.startsWith('.') || !context.parentURL?.includes('/node_modules/')) throw error
    return nextResolve(`${specifier}.js`, context)
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { shortCircuit: true, url: workersStub }
    const resolved = resolveFile(specifier, context, nextResolve)
    // A deploy is a new generation of the engine modules: each repository module of a generation imports the same generation.
    const deploy = context.parentURL?.startsWith(repoRoot) ? new URL(context.parentURL).searchParams.get('deploy') : null
    if (deploy && resolved.url.startsWith(repoRoot) && !resolved.url.includes('/node_modules/')) {
      const url = new URL(resolved.url)
      url.searchParams.set('deploy', deploy)
      return { ...resolved, url: url.href }
    }
    return resolved
  },
  load(url, context, nextLoad) {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:' && parsed.pathname.endsWith('.wasm')) {
      const path = fileURLToPath(parsed)
      if (!wasmModules.has(path)) wasmModules.set(path, new WebAssembly.Module(readFileSync(path)))
      return { format: 'module', shortCircuit: true, source: `export default globalThis[Symbol.for('agent-factory.simulation.wasm')].get(${JSON.stringify(path)})` }
    }
    if (parsed.protocol !== 'file:' || !/\.(md|txt)$/.test(parsed.pathname)) return nextLoad(url, context)
    // Wrangler bundles the guides as text modules. A deploy generation changes each guide, so that a prompt changes.
    const deploy = parsed.searchParams.get('deploy')
    const text = readFileSync(fileURLToPath(parsed), 'utf8') + (deploy ? `\n<!-- deploy ${deploy} -->\n` : '')
    return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(text)}` }
  },
})

/** The methods of PullRequestRuns and DevelopmentRuns that the simulation calls. Local, because test/ typechecks without the Worker types. */
type RunsObject = {
  clock: Clock
  alarm(): Promise<void>
  start(request: Record<string, unknown>): Promise<{ run: string; started: boolean }>
}
type ObjectContext = { storage: ObjectStorage; id: { name: string }; container: undefined }
type RunsClass = new (ctx: ObjectContext, env: Record<string, unknown>) => RunsObject
type Engine = { review: RunsClass; develop: RunsClass }

function runsClass(module: unknown, name: string): RunsClass {
  const value: unknown = typeof module === 'object' && module !== null ? Reflect.get(module, name) : undefined
  if (typeof value !== 'function' || typeof Reflect.get(value.prototype, 'alarm') !== 'function') throw new Error(`the engine module has no class ${name}`)
  return value as RunsClass
}

const engines = new Map<number, Promise<Engine>>()
/** The engine classes of a deploy generation. The specifiers are not literal, because tsconfig.json cannot follow the Worker files. */
function engine(generation: number): Promise<Engine> {
  let loaded = engines.get(generation)
  if (!loaded) {
    const query = generation === 0 ? '' : `?deploy=${generation}`
    const specifier = (file: string) => new URL(`../../src/cloudflare/${file}${query}`, import.meta.url).href
    loaded = Promise.all([import(specifier('run.ts')), import(specifier('develop.ts'))]).then(([run, develop]: unknown[]) => ({
      develop: runsClass(develop, 'DevelopmentRuns'),
      review: runsClass(run, 'PullRequestRuns'),
    }))
    engines.set(generation, loaded)
  }
  return loaded
}

/** A seeded PRNG (mulberry32): one seed gives the same sequence each time. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type RunKind = 'develop' | 'review'
/** The points where a fault can occur. The simulation counts each point from 1. */
type Point = 'storage' | 'github' | 'model' | 'box' | 'job'
type FaultKind = 'die-storage' | 'die-github' | 'die-model' | 'die-box' | 'budget' | 'github-500' | 'github-429' | 'lost-job' | 'deploy'
/** A fault at the `at`-th occurrence of its point. */
type Fault = { kind: FaultKind; at: number }

const pointOf: Record<FaultKind, Point> = {
  'die-storage': 'storage',
  'die-github': 'github',
  'die-model': 'model',
  'die-box': 'box',
  budget: 'model',
  'github-500': 'github',
  'github-429': 'github',
  'lost-job': 'job',
  deploy: 'model',
}
const faultKinds = Object.keys(pointOf) as FaultKind[]
/** The most faults of one seed. A correct engine recovers from each, so the run always ends. */
const maxFaults = 3
/** The alarm calls that a seed can use: this multiple of the sum of the reference count and the fault count. */
const callFactor = 4

/**
 * The faults of a seed, at points that the reference run reaches. When a found bug needs a change to a recorded D or
 * RD row, its fault point goes out of this schedule, with a comment that names the bug and its seed.
 */
export function schedule(seed: number, counts: Record<Point, number>): Fault[] {
  const random = prng(seed)
  const faults: Fault[] = []
  const count = Math.floor(random() * (maxFaults + 1))
  const possible = faultKinds.filter((kind) => counts[pointOf[kind]] > 0)
  for (let index = 0; index < count && possible.length > 0; index++) {
    const kind = possible[Math.floor(random() * possible.length)]!
    faults.push({ at: 1 + Math.floor(random() * counts[pointOf[kind]]), kind })
  }
  return faults
}

/** Each seed picks a development run or a review run. */
export function kindOf(seed: number): RunKind {
  return prng(seed ^ 0x5eed)() < 0.5 ? 'develop' : 'review'
}

/** What a simulation leaves for the invariant checks. */
export type Trace = {
  seed: number
  kind: RunKind
  faults: Fault[]
  /** The alarm calls of all objects, and the most that the seed can use. */
  calls: number
  limit: number
  /** The state and the note of the run that the seed started, at the end. */
  state: string | null
  note: string
  /** Each write of a ledger step: key, as `<object> <run> <key>`. */
  steps: string[]
  /** Each comment that the runs posted, in order. Edits are not posts. */
  posts: { issue: number; body: string }[]
  /** The report of the run. */
  report: string
  /** The commits of each branch, newest first, as `<tree> <message>`. */
  commits: Record<string, string[]>
  /** Each comment on GitHub at the end, with its last body. */
  comments: { issue: number; body: string }[]
  counts: Record<Point, number>
  /** Errors outside the engine, for example an alarm that threw. */
  errors: string[]
}

const terminal = ['passed', 'failed', 'error']
const stamp = /\bpr-(\d+)-\d{8}-\d{6}\b/g

/**
 * The values that a fault changes by design. Every other difference to the reference run is a finding. All masks are
 * here:
 * - The counters of planned stops and crash restarts, and the time of the last D13 restart. The alarm calls differ.
 * - The usage figures of the report (tokens and USD). A repeated model request is a real cost.
 * - The order of the usage rows. It is the order in which parallel steps end.
 * - The stamp in the name of a review run that a development run starts. A fault moves the time of that call.
 * - The commit IDs. The stamp and the real time of the in-process git change them. The commits check keeps the trees.
 */
function mask(text: string): string {
  const masked = text
    .replace(/- Alarm calls: \d+ planned stops?, \d+ crash restarts?/g, '- Alarm calls: (masked)')
    .replace(/^- Restart: .*$/gm, '- Restart: (masked)')
    .replace(/^(\| [^|\n]* \| [^|\n]* \|)( \d+ \|){4} [^|\n]* \|$/gm, '$1 (masked) |')
  return sortRuns(masked.split('\n'), (line) => /^\| (?!\*\*)[^|\n]* \| [^|\n]* \| \(masked\) \|$/.test(line))
    .join('\n')
    .replace(/Spent: \$[\d.]+\./g, 'Spent: (masked).')
    .replace(stamp, 'pr-$1-(stamp)')
    .replace(/\b[0-9a-f]{40}\b/g, '(sha)')
    .replace(/\b[0-9a-f]{12}\b/g, '(sha)')
}

/** Sorts each run of adjacent lines that `row` accepts, and keeps the other lines in place. */
function sortRuns(lines: string[], row: (line: string) => boolean): string[] {
  const sorted: string[] = []
  let run: string[] = []
  for (const line of [...lines, '']) {
    if (row(line)) {
      run.push(line)
      continue
    }
    sorted.push(...run.sort(), line)
    run = []
  }
  return sorted.slice(0, -1)
}

/** The invariant checks of a seed against the reference run. Returns each violation. */
export function violations(trace: Trace, reference: Trace): string[] {
  const found: string[] = []
  // A reference that does not pass makes each check of a seed vacuous.
  if (reference.state !== 'passed') found.push(`the reference run ended ${reference.state ?? 'missing'}, not passed: ${reference.note}`)
  if (!terminal.includes(trace.state ?? '')) found.push(`no end: the run is ${trace.state ?? 'missing'} after ${trace.calls} alarm calls (limit ${trace.limit})`)
  else if (trace.state === 'error' && reference.state !== 'error') found.push(`the run waits with error: ${trace.note}`)
  else if (trace.state !== reference.state) found.push(`the run ended ${trace.state}, the reference ${reference.state}`)
  const seenSteps = new Set<string>()
  for (const step of trace.steps) {
    if (seenSteps.has(step)) found.push(`the step ${step} finished two times`)
    seenSteps.add(step)
  }
  const seenPosts = new Set<string>()
  // The posts without repeats: the check above reports a repeat, and the check below reports a post that differs or is missing.
  const posts: { issue: number; body: string }[] = []
  for (const { issue, body } of trace.posts) {
    const post = `${issue} ${mask(body)}`
    if (seenPosts.has(post)) found.push(`a new comment on #${issue} repeats an earlier comment: ${JSON.stringify(body.slice(0, 120))}`)
    else posts.push({ body, issue })
    seenPosts.add(post)
  }
  const same = (name: string, actual: unknown, expected: unknown, masks = mask) => {
    // The masks apply to each string before JSON escapes its line breaks.
    const text = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => (typeof item === 'string' ? masks(item) : item), 1)
    const [a, b] = [text(actual), text(expected)]
    if (a !== b) found.push(`${name} differ from the reference: ${difference(a, b)}`)
  }
  same('the report lines', trace.report, reference.report)
  same('the commits', trace.commits, reference.commits, maskMessage)
  same('the comments', trace.comments, reference.comments)
  same('the posts', posts, reference.posts)
  found.push(...trace.errors)
  return found
}

/** Masks the message of a commit line `<tree> <message>`, but not its tree: a tree that differs is a finding. */
function maskMessage(line: string): string {
  const space = line.indexOf(' ')
  return space === -1 ? line : `${line.slice(0, space)} ${mask(line.slice(space + 1))}`
}

/** The first line that differs, with the line of the reference. */
function difference(actual: string, expected: string): string {
  const [a, b] = [actual.split('\n'), expected.split('\n')]
  const index = a.findIndex((line, position) => line !== b[position])
  const at = index === -1 ? a.length : index
  const [x = '', y = ''] = [a[at], b[at]]
  // Show the text around the first character that differs, because a line can be long.
  let from = 0
  while (from < x.length && x[from] === y[from]) from++
  const part = (line: string | undefined) => JSON.stringify(line === undefined ? '(none)' : line.slice(Math.max(0, from - 120), from + 180))
  return `line ${at + 1}: ${part(a[at])}, reference: ${part(b[at])}`
}

/** The text of a failed seed: the seed, its fault schedule, the violations and the command that runs only this seed. */
export function failureMessage(trace: Pick<Trace, 'seed' | 'kind' | 'faults'>, found: string[]): string {
  return [
    `seed ${trace.seed} (${trace.kind} run) failed`,
    `faults: ${JSON.stringify(trace.faults)}`,
    ...found.map((line) => `- ${line}`),
    `rerun: SIM_SEED=${trace.seed} node --test test/simulation.test.ts`,
  ].join('\n')
}

/** The end of an isolate. A dead instance throws it from storage, and its other calls never return. */
class IsolateDeath extends Error {}
const never = <T>() => new Promise<T>(() => {})

type SimObject = { name: string; kind: RunKind; db: DatabaseSync; alarm: number | null; markers: Map<string, string>; jobs: Map<string, boolean>; instance: Instance | null }
type Instance = { object: SimObject; dead: boolean; died: Promise<'died'>; kill(): void; runs: RunsObject | null; intervals: Set<() => void> }
type Current = { sim: Simulation; instance: Instance }
/** The instance whose code runs, also across awaits: the fetch of the engine needs it. */
const current = new AsyncLocalStorage<Current>()

/**
 * The fetch of the engine. The mock GitHub cannot see which object instance sends a request, so the fault points of
 * GitHub and the models, and the end of a dead instance, are here.
 */
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const here = current.getStore()
  if (!here) return realFetch(input, init)
  return here.sim.fetch(here.instance, input instanceof Request ? input.url : String(input), init)
}

type ObjectStorage = ReturnType<typeof objectStorage>
const writes = /^\s*(insert|update|delete|replace)\b/i

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>()
/** The statement of a query, prepared one time for each database: the engine sends the same queries many times. */
function prepared(db: DatabaseSync, query: string): StatementSync {
  let cache = statements.get(db)
  if (!cache) statements.set(db, (cache = new Map()))
  let statement = cache.get(query)
  if (!statement) cache.set(query, (statement = db.prepare(query)))
  return statement
}

/** The SQL cursor of Durable Object storage over node:sqlite. Blobs are ArrayBuffers, as in workerd. */
function cursor(db: DatabaseSync, query: string, bindings: unknown[]) {
  const values = bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value) as SQLInputValue)
  let names: string[] = []
  let rows: unknown[][] = []
  let written = 0
  if (values.length === 0 && query.trim().replace(/;$/, '').includes(';')) db.exec(query)
  else {
    const statement = prepared(db, query)
    names = statement.columns().map((column) => column.name)
    if (names.length === 0) written = Number(statement.run(...values).changes)
    else {
      statement.setReturnArrays(true)
      rows = (statement.all(...values) as unknown as unknown[][]).map((row) => row.map((value) => (value instanceof Uint8Array ? new Uint8Array(value).buffer : value)))
      if (writes.test(query)) written = Number((prepared(db, 'select changes() as n').get() as { n: number }).n)
    }
  }
  const object = (row: unknown[]) => Object.fromEntries(names.map((name, index) => [name, row[index]]))
  const objects = () => rows.map(object)
  return {
    columnNames: names,
    rowsRead: rows.length,
    rowsWritten: written,
    toArray: objects,
    one() {
      if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`)
      return object(rows[0]!)
    },
    raw: () => rows.values(),
    [Symbol.iterator]: () => objects().values(),
  }
}

/** The storage of one instance. The data stays with the object, so that a new instance after a death reads it. */
function objectStorage(sim: Simulation, instance: Instance) {
  const { object } = instance
  let savepoints = 0
  const alive = () => {
    if (instance.dead) throw new IsolateDeath('the isolate of this object died')
  }
  return {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        alive()
        // A death at this write throws here, before the write.
        if (writes.test(query)) void sim.point('storage', instance)
        const result = cursor(object.db, query, bindings)
        const key = bindings[1]
        if (/^insert or replace into factory_ledger\b/i.test(query) && typeof key === 'string' && key.startsWith('step:')) sim.steps.push(`${object.name} ${String(bindings[0])} ${key}`)
        return result
      },
      get databaseSize() {
        return 0
      },
    },
    transactionSync<T>(operation: () => T): T {
      alive()
      const name = `sim_${++savepoints}`
      object.db.exec(`savepoint ${name}`)
      try {
        const result = operation()
        object.db.exec(`release ${name}`)
        return result
      } catch (error) {
        object.db.exec(`rollback to ${name}`)
        object.db.exec(`release ${name}`)
        throw error
      }
    },
    async getAlarm(): Promise<number | null> {
      if (instance.dead) return never()
      return object.alarm
    },
    async setAlarm(at: number | Date): Promise<void> {
      if (instance.dead) return never()
      object.alarm = Number(at)
    },
    async deleteAlarm(): Promise<void> {
      if (instance.dead) return never()
      object.alarm = null
    },
  }
}

const passed = (output = ''): BoxResult => ({ exit_code: 0, output })

/**
 * The machine of an object, in memory. Every command passes, and the sync markers act as files. The machine stays
 * when an isolate dies, as a container does.
 */
function fakeBox(sim: Simulation, instance: Instance): Box {
  const { object } = instance
  const gate = async () => {
    await sim.point('box', instance)
    await new Promise((resolve) => setImmediate(resolve))
    if (instance.dead) return never<void>()
  }
  const run = (argv: string[]): BoxResult => {
    const [shell, flag, script = '', , first = '', second = ''] = argv
    if (shell !== 'bash' || flag !== '-c') return passed()
    if (script.startsWith('test "$(cat -- "$1" 2>/dev/null)" = "$2"')) {
      const agrees = object.markers.get(first) === second
      if (agrees && script.includes('rm -f -- "$1"')) object.markers.delete(first)
      return { exit_code: agrees ? 0 : 1, output: '' }
    }
    if (script === 'printf %s "$2" > "$1"') object.markers.set(first, second)
    if (script.startsWith('rm -rf -- "$1" "$1.sync"')) object.markers.delete(`${first}.sync`)
    return passed('ok\n')
  }
  return {
    async start() {
      await gate()
    },
    async exec(argv) {
      await gate()
      return run(argv)
    },
    async startJob(id) {
      await gate()
      object.jobs.set(id, !sim.lost())
    },
    async pollJob(id): Promise<JobState> {
      await gate()
      return object.jobs.get(id) ? { result: passed('ok\n'), state: 'done' } : { state: 'missing' }
    },
    async killJob(id) {
      await gate()
      object.jobs.delete(id)
    },
  }
}

/** The fake clock of a simulation: one time for all objects. The scheduler of the simulation ends each sleep and moves the time. */
class SimClock {
  now: number
  private ids = 0
  private readonly intervals = new Set<{ next: number; ms: number; tick: () => void }>()
  private readonly wake: (target: number, instance: Instance) => Promise<void>

  constructor(start: number, wake: (target: number, instance: Instance) => Promise<void>) {
    this.now = start
    this.wake = wake
  }

  advance(to: number): void {
    if (to <= this.now) return
    this.now = to
    for (const interval of [...this.intervals]) {
      if (interval.next > to) continue
      interval.next = to + interval.ms
      interval.tick()
    }
  }

  /** The clock of one instance: after its death, its sleeps never end and its intervals stop. */
  view(instance: Instance): Clock {
    return {
      every: (ms, tick) => {
        const interval = { ms, next: this.now + ms, tick }
        this.intervals.add(interval)
        const stop = () => void this.intervals.delete(interval)
        instance.intervals.add(stop)
        return stop
      },
      now: () => this.now,
      sleep: (ms) => {
        if (instance.dead) return never()
        // Sleeps that start at the same time do not add up: two waits of 1 s at once end after 1 s.
        return this.wake(this.now + Math.max(0, ms), instance)
      },
      uuid: () => `00000000-0000-4000-8000-${(++this.ids).toString(16).padStart(12, '0')}`,
    }
  }
}

/** The start of each simulation: a fixed time, so that the run names and the commit dates are the same each time. */
const startTime = Date.parse('2026-11-16T09:00:00Z')
const gitDate = '2026-11-16T09:00:00Z'
/** The default alarm budget of a run (ALARM_BUDGET_SECONDS): the budget fault moves the clock this far. */
const budgetMs = 780_000
const owner = 'acme'
const name = 'app'

/** A sleep that waits for the scheduler. */
type Sleeper = { target: number; order: number; instance: Instance; resolve: () => void }
/** The event loop turns without new activity after which the engine is idle. */
const quietTurns = 3

/**
 * The simulation and its scheduler. Real socket timing must not change the order of the engine calls, so the
 * scheduler releases one event at a time, and only when the engine is idle: first each request in the order of its
 * send, then the sleep with the earliest end. A seed thus gives the same fault points and clock readings each time.
 */
class Simulation {
  readonly clock = new SimClock(startTime, (target, instance) => this.sleep(target, instance))
  readonly steps: string[] = []
  readonly posts: { issue: number; body: string }[] = []
  readonly errors: string[] = []
  readonly counts: Record<Point, number> = { box: 0, github: 0, job: 0, model: 0, storage: 0 }
  readonly objects = new Map<string, SimObject>()
  readonly env: Record<string, unknown>
  calls = 0
  generation = 0
  /** Increments at each fault point, request, sleep and RPC call, so that the scheduler sees when the engine is idle. */
  private activity = 0
  private readonly requests: (() => Promise<void>)[] = []
  private readonly sleepers: Sleeper[] = []
  private sleeps = 0
  private pumping = false

  readonly faults: Fault[]

  constructor(faults: Fault[]) {
    this.faults = faults
    const rpc =
      (pr: string, method: string) =>
      (...args: unknown[]) =>
        this.rpc(pr, method, args)
    this.env = {
      ALLOWED_USERS: 'Maintainer',
      ANTHROPIC_API_KEY: 'sim-anthropic',
      GITHUB_TOKEN: 'sim-token',
      // The fake box replaces the machine, but the preflight needs a machine or a container.
      MACHINE_URL: 'http://machine.invalid',
      OPENAI_API_KEY: 'sim-openai',
      PAUSE_POLL_SECONDS: '60',
      PULL_REQUESTS: {
        get: (pr: string) => ({ outcome: rpc(pr, 'outcome'), resumeAfterError: rpc(pr, 'resumeAfterError'), start: rpc(pr, 'start') }),
        idFromName: (pr: string) => pr,
      },
    }
  }

  setUrl(url: string): void {
    Object.assign(this.env, { ANTHROPIC_URL: `${url}/v1/messages`, GITHUB_API_URL: url, OPENAI_URL: `${url}/v1` })
  }

  object(kind: RunKind, objectName: string): SimObject {
    const key = `${kind} ${objectName}`
    let object = this.objects.get(key)
    if (!object) {
      object = { alarm: null, db: new DatabaseSync(':memory:'), instance: null, jobs: new Map(), kind, markers: new Map(), name: key }
      this.objects.set(key, object)
    }
    return object
  }

  /** The live instance of an object, or a new one over the same storage when there is none. */
  async instance(object: SimObject): Promise<Instance> {
    if (object.instance && !object.instance.dead) return object.instance
    const Base = (await engine(this.generation))[object.kind]
    let resolveDied = () => {}
    const died = new Promise<'died'>((resolve) => (resolveDied = () => resolve('died')))
    const instance: Instance = {
      dead: false,
      died,
      intervals: new Set(),
      kill: () => {
        instance.dead = true
        for (const stop of instance.intervals) stop()
        resolveDied()
      },
      object,
      runs: null,
    }
    const box = fakeBox(this, instance)
    const ctx: ObjectContext = { container: undefined, id: { name: object.name }, storage: objectStorage(this, instance) }
    // The test subclass: the fake box replaces the container.
    const Simulated = class extends Base {
      box(): Box {
        return box
      }
    }
    const runs = current.run({ instance, sim: this }, () => new Simulated(ctx, this.env))
    runs.clock = this.clock.view(instance)
    instance.runs = runs
    object.instance = instance
    return instance
  }

  /**
   * Counts a fault point, and applies the faults of the seed at it. Returns the count of this occurrence. A death at a
   * storage write throws, as the write fails.
   */
  point(point: Point, instance: Instance): Promise<number> {
    this.activity++
    const at = ++this.counts[point]
    for (const fault of this.faults) {
      if (pointOf[fault.kind] !== point || fault.at !== at) continue
      if (fault.kind === 'budget') this.clock.advance(this.clock.now + budgetMs)
      if (fault.kind === 'deploy') {
        // A deploy ends the isolates of all objects, and the next instances run the new modules.
        this.generation = 1 - this.generation
        for (const object of this.objects.values()) object.instance?.kill()
      }
      if (fault.kind.startsWith('die-')) instance.kill()
    }
    if (instance.dead) {
      if (point === 'storage') throw new IsolateDeath('the isolate of this object died')
      return never()
    }
    return Promise.resolve(at)
  }

  /** True when the box loses the job that starts now. */
  lost(): boolean {
    const at = ++this.counts.job
    return this.faults.some((fault) => fault.kind === 'lost-job' && fault.at === at)
  }

  async fetch(instance: Instance, url: string, init: RequestInit | undefined): Promise<Response> {
    if (instance.dead) return never()
    const path = new URL(url).pathname
    const point = path === '/v1/messages' || path === '/v1/responses' ? 'model' : 'github'
    const at = await this.point(point, instance)
    const headers = new Headers(init?.headers)
    // The mock GitHub gives the status fault, because the request header names it.
    const status = this.faults.find((fault) => pointOf[fault.kind] === point && fault.at === at && fault.kind.startsWith('github-'))
    if (status) headers.set('x-sim-fault', status.kind)
    const response = await this.request(async () => {
      const real = await realFetch(url, { ...init, headers })
      // The full body, so that no socket read occurs after the scheduler releases the response.
      const body = [101, 204, 205, 304].includes(real.status) ? null : await real.arrayBuffer()
      return new Response(body, { headers: real.headers, status: real.status, statusText: real.statusText })
    })
    // A post counts also when the isolate died during the request, because GitHub has the comment.
    const posted = /\/issues\/(\d+)\/comments$/.exec(path)
    if (init?.method === 'POST' && posted && response.ok && typeof init.body === 'string') {
      this.posts.push({ body: String((JSON.parse(init.body) as { body?: unknown }).body), issue: Number(posted[1]) })
    }
    if (instance.dead) return never()
    return response
  }

  /** Sends a request when the scheduler releases it. Only one request is on a socket at a time. */
  private request<T>(send: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.requests.push(() => send().then(resolve, reject))
      this.wakeUp()
    })
  }

  /** A sleep until `target`. The scheduler ends it after all requests, and in the order of the end times. */
  private sleep(target: number, instance: Instance): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sleepers.push({ instance, order: ++this.sleeps, resolve, target })
      this.wakeUp()
    })
  }

  private wakeUp(): void {
    this.activity++
    if (this.pumping) return
    this.pumping = true
    void this.pump()
  }

  /** Releases the waiting events, one at a time, each when the engine is idle. */
  private async pump(): Promise<void> {
    try {
      for (;;) {
        await this.settle()
        const send = this.requests.shift()
        if (send) {
          await send()
          this.activity++
          continue
        }
        const live = this.sleepers.filter((sleeper) => !sleeper.instance.dead)
        this.sleepers.length = 0
        live.sort((a, b) => a.target - b.target || a.order - b.order)
        const next = live.shift()
        this.sleepers.push(...live)
        if (!next) return
        this.clock.advance(next.target)
        next.resolve()
        this.activity++
      }
    } finally {
      this.pumping = false
    }
  }

  /** Resolves when the engine is idle: some turns of the event loop pass with no new activity. */
  async settle(): Promise<void> {
    for (let quiet = 0; quiet < quietTurns; ) {
      const seen = this.activity
      await new Promise((resolve) => setImmediate(resolve))
      quiet = this.activity === seen ? quiet + 1 : 0
    }
  }

  /** A call of a Durable Object stub: async, with structured clones of the arguments and of the result, as RPC has. */
  async rpc(pr: string, method: string, args: unknown[]): Promise<unknown> {
    const caller = current.getStore()?.instance
    this.activity++
    await new Promise((resolve) => setImmediate(resolve))
    if (caller?.dead) return never()
    const instance = await this.instance(this.object('review', pr))
    const runs = instance.runs
    const target: unknown = runs ? Reflect.get(runs, method) : undefined
    if (typeof target !== 'function') throw new Error(`PullRequestRuns has no method ${method}`)
    const call = current.run({ instance, sim: this }, () => Promise.resolve(Reflect.apply(target, runs, structuredClone(args))))
    const result: unknown = await Promise.race([call, instance.died])
    if (instance.dead) throw new Error('Durable Object reset: the isolate of the called object died')
    if (caller?.dead) return never()
    return structuredClone(result)
  }

  /** Runs the alarms of all objects in time order until the run of `main` ends, or `limit` calls ran. */
  async drive(main: SimObject, limit: number): Promise<void> {
    while (!terminal.includes(latest(main.db)?.state ?? '') && this.calls < limit) {
      await this.settle()
      let next: SimObject | undefined
      for (const object of this.objects.values()) if (object.alarm !== null && (next?.alarm ?? Infinity) > object.alarm) next = object
      if (!next) break
      this.clock.advance(next.alarm!)
      next.alarm = null
      const instance = await this.instance(next)
      this.calls++
      const runs = instance.runs!
      const call = current.run({ instance, sim: this }, () => runs.alarm())
      const outcome = await Promise.race([call.then(() => 'done' as const, (error: unknown) => error), instance.died])
      if (instance.dead || outcome !== 'done') {
        if (!instance.dead) this.errors.push(`the alarm of ${next.name} threw: ${String(outcome)}`)
        // Cloudflare calls an alarm again about 2 s after a failed call. The heartbeat alarm of the run is later.
        next.alarm = Math.min(next.alarm ?? Infinity, this.clock.now + 2_000)
      }
    }
  }
}

function latest(db: DatabaseSync): { run: string; state: string; note: string } | undefined {
  return db.prepare('select run, state, note from factory_runs order by created desc limit 1').get() as { run: string; state: string; note: string } | undefined
}

const identity = { GIT_AUTHOR_DATE: gitDate, GIT_AUTHOR_EMAIL: 'test@example.com', GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_DATE: gitDate, GIT_COMMITTER_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, stdio: 'pipe' }).toString().trim()

const config = { stack: 'TypeScript', checks: { smoke: 'true' }, tests: { pattern: '\\.test\\.ts$', command: 'node --test {tests}' } }
const sub = 'export function sub(a: number, b: number): number {\n  return a - b\n}\n'

const templates = new Map<RunKind, string>()
/** The repository of a run kind: add() on main, and for a review run a feature branch with sub(). It is made one time, and each seed gets a copy. */
function template(kind: RunKind): string {
  const made = templates.get(kind)
  if (made) return made
  const repo = mkdtempSync(join(tmpdir(), 'factory-sim-template-'))
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  const commit = (message: string) => {
    git(repo, 'add', '-A')
    git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message)
  }
  git(repo, 'init', '-q', '-b', 'main')
  write('src/math.ts', 'export function add(a: number, b: number): number {\n  return a + b\n}\n')
  write('test/add.test.ts', "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { add } from '../src/math.ts'\n\ntest('add', () => assert.equal(add(2, 3), 5))\n")
  write('.agent-factory.json', JSON.stringify(config))
  commit('base')
  if (kind === 'review') {
    git(repo, 'checkout', '-q', '-b', 'feature')
    write('src/sub.ts', sub)
    commit('add sub')
    git(repo, 'checkout', '-q', 'main')
  }
  templates.set(kind, repo)
  return repo
}

const intake = { title: 'Add sub', summary: 'Adds sub() next to add().', slug: 'add-sub', larger: false, passes: 1, reason: 'One small function.', questions: [] }
const plan = {
  smallest_change: 'One new module.',
  goals: ['sub returns a - b'],
  non_goals: ['No mul'],
  done: [{ check: 'The tests pass', command: 'node --test test/add.test.ts' }],
  sections: [],
  tasks: [{ id: 'sub', title: 'Add sub', work: 'Build sub.', files: ['src/sub.ts'], depends_on: [] }],
}
const buildLog = { summary: 'sub works', changes: [{ path: 'src/sub.ts', why: 'sub works' }], tests: [], blocked: '' }

/** The scripted agents, short so that a seed is fast. The reviewers find nothing, so that the review passes without a patch. */
const script: Script = ({ role, output }) => {
  if (output !== null) return { text: 'done' }
  switch (role) {
    case 'intake':
      return { cell: `await tools.submit_intake(${JSON.stringify(intake)})` }
    case 'planner':
      return { cell: `await tools.submit_plan(${JSON.stringify(plan)})` }
    case 'builder':
      return {
        cell: [
          `await tools.Write({ file_path: '/repo/src/sub.ts', content: ${JSON.stringify(sub)} })`,
          // After a crash the turn runs again, and the checkpoint has nothing new to commit. A model reads the error and goes on.
          `try { await tools.checkpoint({ message: 'add sub' }) } catch (error) { text(String(error)) }`,
          `await tools.submit_build_log(${JSON.stringify(buildLog)})`,
        ].join('\n'),
      }
    case 'questions':
      return { cell: `await tools.submit_questions({ questions: [] })` }
    case 'intent':
      return { cell: `await tools.submit_verdict({ satisfied: true, gaps: [], summary: 'sub subtracts b from a' })` }
    default:
      return { cell: `await tools.submit_findings({ findings: [] }); text('submitted')` }
  }
}

/** The PR of a review run, and the issue of a development run. */
const reviewPr = 7
const issue = 5

/** The git reads of fixed commits, for all seeds of a thread: the repositories are copies of the templates, with the same config. */
const gitCache = new Map<string, Buffer>()
/** The log of each commit, by its ID. A commit ID fixes its log. */
const commitLogs = new Map<string, string>()

/**
 * The lines `<ref> <commit>` of each ref, sorted. A seed reads the loose ref files without a git process. Git reads the
 * refs when the repository also has packed refs or the reftable format.
 */
function refLines(repo: string): string[] {
  const gitDir = join(repo, '.git')
  if (['packed-refs', 'reftable'].some((name) => existsSync(join(gitDir, name)))) return git(repo, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(Boolean).sort()
  return readdirSync(join(gitDir, 'refs'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)
      return `${path.slice(gitDir.length + 1).split(sep).join('/')} ${readFileSync(path, 'utf8').trim()}`
    })
    .sort()
}

/** Runs one simulation: a run of `kind` with the faults, until it ends or uses `limit` alarm calls. */
export async function simulate(seed: number, kind: RunKind, faults: Fault[], limit: number): Promise<Trace> {
  const repo = mkdtempSync(join(tmpdir(), 'factory-sim-'))
  cpSync(template(kind), repo, { recursive: true })
  const sim = new Simulation(faults)
  const mock = await mockServices(repo, {
    botLogin: 'factory-bot',
    gitCache,
    fault: (headers) => {
      const fault = headers['x-sim-fault']
      if (fault === 'github-500') return { status: 500 }
      if (fault === 'github-429') return { headers: { 'retry-after': '1' }, status: 429 }
      return undefined
    },
    gitDate,
    issues: { [issue]: { body: 'Add sub(a, b) next to add(a, b).', title: 'Add sub' } },
    name,
    now: () => sim.clock.now,
    owner,
    ...(kind === 'review' ? { pr: reviewPr } : {}),
    script,
  })
  sim.setUrl(mock.url)
  const logs = { error: console.error, log: console.log, warn: console.warn }
  const quiet = () => {}
  const unhandled = (error: unknown) => {
    if (!(error instanceof IsolateDeath)) sim.errors.push(`an unhandled rejection: ${String(error)}`)
  }
  // The engine logs each step. A seed shows only its failure.
  Object.assign(console, { error: quiet, log: quiet, warn: quiet })
  process.on('unhandledRejection', unhandled)
  try {
    const main = kind === 'review' ? sim.object('review', `${owner}/${name}#${reviewPr}`) : sim.object('develop', `${owner}/${name}#${issue}`)
    const instance = await sim.instance(main)
    const request = kind === 'review' ? { by: 'Maintainer', owner, pr: reviewPr, repo: name, ship: false } : { by: 'Maintainer', issue, owner, repo: name }
    await current.run({ instance, sim }, () => instance.runs!.start(request))
    await sim.drive(main, limit)
    const end = latest(main.db)
    const report = end ? (main.db.prepare('select text from factory_files where run = ? and name = ?').get(end.run, 'report.md') as { text: string } | undefined) : undefined
    const commits: Record<string, string[]> = {}
    for (const line of refLines(repo)) {
      const [ref = '', sha = ''] = line.split(' ')
      let log = commitLogs.get(sha)
      if (log === undefined) commitLogs.set(sha, (log = git(repo, 'log', '--format=%T %B%x00', sha)))
      commits[ref.replace(stamp, 'pr-$1-(stamp)')] = log.split('\0').map((entry) => entry.trim()).filter(Boolean)
    }
    return {
      calls: sim.calls,
      comments: mock.state.comments.map((comment) => ({ body: comment.body, issue: comment.issue })),
      commits,
      counts: { ...sim.counts },
      errors: sim.errors,
      faults,
      kind,
      limit,
      note: end?.note ?? '',
      posts: sim.posts,
      report: report?.text ?? '',
      seed,
      state: end?.state ?? null,
      steps: sim.steps,
    }
  } finally {
    Object.assign(console, logs)
    process.off('unhandledRejection', unhandled)
    for (const object of sim.objects.values()) object.instance?.kill()
    await mock.close()
    rmSync(repo, { force: true, recursive: true })
    rmSync(mock.machineRoot, { force: true, recursive: true })
  }
}

/** The most alarm calls of a reference run. It has no faults, so it ends long before. */
const referenceLimit = 1_000
const references = new Map<RunKind, Promise<Trace>>()
/** The reference run of a kind, with no faults. It runs one time for each kind and thread. */
function reference(kind: RunKind): Promise<Trace> {
  let trace = references.get(kind)
  if (!trace) {
    trace = simulate(0, kind, [], referenceLimit)
    references.set(kind, trace)
  }
  return trace
}

/** Runs one seed and checks its invariants. Returns the failure message, or null when the seed passes. */
export async function runSeed(seed: number): Promise<string | null> {
  const kind = kindOf(seed)
  const expected = await reference(kind)
  const own = violations(expected, expected)
  if (own.length > 0) return failureMessage({ faults: [], kind, seed }, ['the reference run fails its own checks', ...own])
  const faults = schedule(seed, expected.counts)
  const trace = await simulate(seed, kind, faults, callFactor * (expected.calls + faults.length))
  const found = violations(trace, expected)
  return found.length > 0 ? failureMessage(trace, found) : null
}
