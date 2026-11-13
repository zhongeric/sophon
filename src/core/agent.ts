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

/** A one-line progress note for the events worth showing: tool calls and turn ends. */
function describe(logged: Contracts.LoggedEvent): string | null {
  const event = logged.event as { type?: string; status?: string; event?: { type?: string; payload?: Record<string, unknown> } }
  if (event.type === 'result') return `turn ${logged.request_id} ${event.status ?? 'ended'}`
  const inner = event.event
  if (inner?.type === 'tool.call') return `tool ${String(inner.payload?.tool ?? inner.payload?.name ?? '?')}`
  return null
}
