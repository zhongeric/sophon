import { DurableObject } from 'cloudflare:workers'
import type { Env } from './runs.ts'

/**
 * One slot of the pool of scan boxes: a small container with no network for one search unit. #84 builds it. It is
 * empty until then, because the binding, the migration and the container in wrangler.jsonc need an exported class.
 */
export class ScanBoxes extends DurableObject<Env> {}
