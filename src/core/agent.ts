import { AgentRuntime, Contracts } from 'nanocode-ts'
import { checkEgress, egressFetch, type Egress, type EgressHost } from './egress.ts'
import type { Ledger } from './ledger.ts'
import type { AgentStore } from './platform.ts'
import { dispatcher, type Credentials, type Provider } from './providers.ts'
import type { Role } from './roles.ts'
import { subagentLimits } from './subagents.ts'
import { recordUsage } from './usage.ts'
import { repoMount } from './workspace.ts'

export type HostToolHandler = (input: unknown, context: Contracts.ToolCallContext) => Promise<unknown>
export type HostTools = Record<string, { definition: Contracts.HostTool; call: HostToolHandler }>

/** One isolated agent: its own session, guidelines, workspace and tools. Nothing is shared with other agents. */
export type AgentSpec = {
  id: string
  provider: Provider
  model: string
  thinking?: Contracts.Thinking
  instructions: string
  workspace: Contracts.WorkspaceHost
  tools: HostTools
  /** Without it, the agent gets no subagents. A limit makes openAgent refuse a spawn over the limit. */
  subagents?: Role['subagents']
  /** The network access of the agent. Without it, the agent is offline. */
  egress?: Egress
}

export type AgentHost = {
  module: WebAssembly.Module
  store: AgentStore
  ledger: Ledger
  credentials: Credentials
  /** Replaces the credentialed dispatch, for scripted models in tests. */
  dispatch?: Contracts.RuntimeOptions['dispatch']
  /** Runs before the host opens an agent turn, for example to compare the spend with the budget. A rejection stops the turn. */
  beforeTurn?: () => Promise<void>
  /** The artifacts, the lock and the secrets of the egress. Only an agent with an egress uses it. */
  egress?: EgressHost
  log(line: string): void
}

export type Agent = {
  ask(requestId: string, prompt: string): Promise<Contracts.TurnReport>
  close(): Promise<void>
}

/**
 * The one host fetch of an agent, for its Code Mode cells and its shell. Without an egress, it refuses each request.
 * With an egress, the host must have an EgressHost and the spec must pass checkEgress.
 */
export function hostFetch(agentId: string, egress: Egress | undefined, host: AgentHost): typeof fetch {
  if (!egress) {
    return async () => {
      throw new Error('network access is off for agents')
    }
  }
  if (!host.egress) throw new Error(`${agentId}: the spec has an egress, but the host has no egress`)
  try {
    checkEgress(egress, host.egress)
  } catch (error) {
    throw new Error(`${agentId}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return egressFetch(agentId, egress, host.egress, (line) => host.log(line))
}

const finished = new Set(['completed', 'failed', 'cancelled'])
const driveWaitMs = 500
const maxReconnects = 3

/**
 * Opens the agent's durable session. The session ID is in the ledger before the first turn,
 * so a crashed host reopens the same session and the SDK resumes the turn from its journal.
 */
export async function openAgent(spec: AgentSpec, host: AgentHost): Promise<Agent> {
  const credential = host.credentials[spec.provider]
  if (!credential) throw new Error(`${spec.id}: no credential for ${spec.provider}`)
  // The egress check comes before the session opens, so a refused spec starts no session.
  const agentFetch = hostFetch(spec.id, spec.egress, host)
  const scope = host.store.scope(spec.id)
  const sessionKey = `session:${spec.id}`
  const sessionId = host.ledger.get<string>(sessionKey) ?? Contracts.sessionUuid()
  host.ledger.put(sessionKey, sessionId)
  const limits = typeof spec.subagents === 'object' ? subagentLimits(host.ledger, spec.id, spec.subagents) : undefined
  const dispatch = host.dispatch ?? dispatcher(host.credentials, spec.provider)

  const connect = async () => {
    const runtime = await AgentRuntime.instantiate(host.module, host.store.sql, {
      published(events) {
        host.store.record(spec.id, events)
        recordUsage(host.ledger, spec.id, spec.model, events)
        limits?.observe(events)
        for (const event of events) {
          const line = describe(event)
          if (line) host.log(`${spec.id}: ${line}`)
        }
      },
    })
    await runtime.open(
      {
        scope,
        session_id: sessionId,
        provider: spec.provider,
        model: spec.model,
        ...(spec.thinking ? { thinking: spec.thinking } : {}),
        instructions: spec.instructions,
        subscription: credential.subscription,
        endpoint: credential.endpoint,
        code_mode: true,
        workspace: repoMount,
        workspace_tools: 'all',
        // Web search runs at the provider, outside the egress and its lock (RD9 of the research spec).
        web_search: spec.egress?.web_search ?? false,
        subagents: spec.subagents !== undefined,
        ...(spec.subagents !== undefined ? { subagent_models: [{ harness: spec.provider, model: spec.model }] } : {}),
        tools: Object.values(spec.tools).map((tool) => tool.definition),
      },
      {
        dispatch: limits ? limits.dispatch(dispatch) : dispatch,
        fetch: agentFetch,
        tools: {
          call(name, input, _signal, context) {
            const tool = spec.tools[name]
            if (!tool) throw new Error(`no host tool named ${name}`)
            return tool.call(input, context)
          },
        },
        workspace: spec.workspace,
      },
    )
    return runtime
  }

  let runtime = await connect()
  return {
    async ask(requestId, prompt) {
      limits?.begin(requestId)
      const submitted = await runtime.submit(scope, { metadata: { agent: spec.id }, prompt, request_id: requestId })
      if (submitted.submitted === 'too_large') throw new Error(`${spec.id}: prompt of ${submitted.bytes} bytes is too large`)
      if (submitted.submitted === 'conflict') {
        // The turn keeps the prompt of its journal, because the agent already worked from it. A deploy can change the prompt text.
        if (!(await runtime.turn(scope, requestId))) throw new Error(`${spec.id}: turn ${requestId} exists with another prompt`)
        host.log(`${spec.id}: the prompt of turn ${requestId} changed, so the turn continues with the prompt of its journal`)
      }
      for (let reconnects = 0; ; ) {
        const view = await runtime.turn(scope, requestId)
        if (view && finished.has(view.report.status)) {
          host.ledger.put(`report:${spec.id}:${requestId}`, view.report)
          return view.report
        }
        const driven = await runtime.drive(requestId)
        if (driven.retry) {
          if (++reconnects > maxReconnects) throw new Error(`${spec.id}: the runtime failed ${reconnects} times`)
          runtime = await connect()
        } else if (driven.idle) {
          throw new Error(`${spec.id}: turn ${requestId} is neither pending nor finished`)
        } else if (driven.waiting) {
          await new Promise((resolve) => setTimeout(resolve, driveWaitMs))
        }
      }
    },
    async close() {
      await runtime.dispose()
    },
  }
}

/**
 * Runs one agent turn to its submit tool. The submit handler writes the output to the ledger under `turn.key`,
 * so a resumed run returns it even when the SDK replays the tool call from its receipt. A follow-up turn in the
 * same session uses another request ID and key. A failed turn stays failed in the journal under its request ID, so
 * the next call asks again under a new request ID. Thus a model error, such as an empty credit balance, does not
 * come back on every resume.
 */
export async function runTurn<T>(
  host: AgentHost,
  spec: AgentSpec,
  prompt: string,
  tool: string,
  turn: { request: string; key: string } = { request: 'task', key: `output:${spec.id}` },
): Promise<T> {
  const recorded = host.ledger.get<T>(turn.key)
  if (recorded !== undefined) return recorded
  await host.beforeTurn?.()
  const retriesKey = `retries:${spec.id}:${turn.request}`
  const retries = host.ledger.get<number>(retriesKey) ?? 0
  const request = retries === 0 ? turn.request : `${turn.request}-retry-${retries}`
  const agent = await openAgent(spec, host)
  let failed = false
  try {
    const report = await agent.ask(request, retries === 0 ? prompt : `${retryNote}\n\n${prompt}`)
    failed = report.status === 'failed'
    if (host.ledger.get(turn.key) === undefined) {
      if (report.status !== 'completed') throw new Error(`${spec.id}: turn ${report.status}: ${JSON.stringify(report.error ?? null)}`)
      // The first turn keeps the nudge request ID of earlier runs, so that their journals resume.
      const nudge = request === 'task' ? 'nudge' : `${request}-nudge`
      // The nudge is a new agent turn, so the budget check applies to it too.
      await host.beforeTurn?.()
      failed = (await agent.ask(nudge, `You ended the turn without calling ${tool}. Call tools.${tool} now.`)).status === 'failed'
    }
  } finally {
    if (failed && host.ledger.get(turn.key) === undefined) host.ledger.put(retriesKey, retries + 1)
    await agent.close()
  }
  const output = host.ledger.get<T>(turn.key)
  if (output === undefined) throw new Error(`${spec.id} did not call ${tool}`)
  return output
}

/** The start of the prompt that asks again after a failed turn. The failed turn can have stopped before any work. */
const retryNote = 'Your last turn stopped with an error before it finished. Here is the task again. Keep the work that you already did in this session.'

/** A submit tool that only the root agent may call, one time, after `check` accepts the input. */
export function submitOnce(host: AgentHost, key: string, definition: Contracts.HostTool, check: (input: unknown) => Promise<unknown>): HostTools {
  return {
    [definition.name]: {
      definition,
      async call(input, call) {
        if (call.subagent) throw new Error('only the root agent submits')
        if (host.ledger.get(key) !== undefined) throw new Error(`${definition.name} was already accepted`)
        const output = await check(input)
        host.ledger.put(key, output)
        return { accepted: true }
      },
    },
  }
}

/** A one-line progress note for the events worth showing: tool calls and turn ends. */
function describe(logged: Contracts.LoggedEvent): string | null {
  const event = logged.event as { type?: string; status?: string; event?: { type?: string; payload?: Record<string, unknown> } }
  if (event.type === 'result') return `turn ${logged.request_id} ${event.status ?? 'ended'}`
  const inner = event.event
  if (inner?.type === 'tool.call') return `tool ${String(inner.payload?.tool ?? inner.payload?.name ?? '?')}`
  return null
}
