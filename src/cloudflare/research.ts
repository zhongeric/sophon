import { DurableObject } from 'cloudflare:workers'
import type { Env } from './runs.ts'

/**
 * The research runs of one program issue (docs/specs/research-workflow.md, section 7). #51 builds it on `Runs`. It is
 * empty until then, because the binding, the migration and the container in wrangler.jsonc need an exported class.
 */
export class ResearchRuns extends DurableObject<Env> {}
