import { AgentRuntime, Contracts } from 'nanocode-ts'
import type { Ledger } from './ledger.ts'
import type { AgentStore } from './platform.ts'
import { dispatcher, type Credentials, type Provider } from './providers.ts'
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
  subagents?: boolean
}

export type AgentHost = {
  module: WebAssembly.Module
  store: AgentStore
  ledger: Ledger
  credentials: Credentials
  /** Replaces the credentialed dispatch, for scripted models in tests. */
  dispatch?: Contracts.RuntimeOptions['dispatch']
  log(line: string): void
}

export type Agent = {
  ask(requestId: string, prompt: string): Promise<Contracts.TurnReport>
  close(): Promise<void>
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
  const scope = host.store.scope(spec.id)
  const sessionKey = `session:${spec.id}`
  const sessionId = host.ledger.get<string>(sessionKey) ?? Contracts.sessionUuid()
  host.ledger.put(sessionKey, sessionId)

  const connect = async () => {
    const runtime = await AgentRuntime.instantiate(host.module, host.store.sql, {
      published(events) {
        host.store.record(spec.id, events)
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
        web_search: false,
        subagents: spec.subagents ?? false,
        ...(spec.subagents ? { subagent_models: [{ harness: spec.provider, model: spec.model }] } : {}),
        tools: Object.values(spec.tools).map((tool) => tool.definition),
      },
      {
        dispatch: host.dispatch ?? dispatcher(host.credentials, spec.provider),
        fetch: async () => {
          throw new Error('network access is off for agents')
        },
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
      const submitted = await runtime.submit(scope, { metadata: { agent: spec.id }, prompt, request_id: requestId })
      if (submitted.submitted === 'too_large') throw new Error(`${spec.id}: prompt of ${submitted.bytes} bytes is too large`)
      if (submitted.submitted === 'conflict') throw new Error(`${spec.id}: turn ${requestId} exists with another prompt`)
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
 * same session uses another request ID and key.
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
  const agent = await openAgent(spec, host)
  try {
    const report = await agent.ask(turn.request, prompt)
    if (host.ledger.get(turn.key) === undefined) {
      if (report.status !== 'completed') throw new Error(`${spec.id}: turn ${report.status}: ${JSON.stringify(report.error ?? null)}`)
      // The first turn keeps the nudge request ID of earlier runs, so that their journals resume.
      const nudge = turn.request === 'task' ? 'nudge' : `${turn.request}-nudge`
      await agent.ask(nudge, `You ended the turn without calling ${tool}. Call tools.${tool} now.`)
    }
  } finally {
    await agent.close()
  }
  const output = host.ledger.get<T>(turn.key)
  if (output === undefined) throw new Error(`${spec.id} did not call ${tool}`)
  return output
}

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
