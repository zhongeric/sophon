// A worker thread of test/simulation.test.ts: it runs its share of the seeds and posts the result of each.
import { parentPort, workerData } from 'node:worker_threads'
import { runSeed } from './simulation.ts'

const seeds: unknown = workerData
if (!parentPort || !Array.isArray(seeds) || !seeds.every((seed) => Number.isSafeInteger(seed))) throw new Error('the simulation worker needs a list of seeds')
for (const seed of seeds as number[]) parentPort.postMessage({ failure: await runSeed(seed), seed })
// A killed isolate leaves its requests open, as on Cloudflare. The thread ends without a wait for them.
process.exit(0)
