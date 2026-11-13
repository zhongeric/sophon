import type { Contracts } from 'nanocode-ts'

/** One model reply: a Code Mode cell to run, or a final text. */
export type Reply = { cell: string } | { text: string }

export type Turn = {
  provider: Contracts.ModelProvider
  role: string
  /** The output of the last cell, when the model already ran one in this turn. */
  output: string | null
}

export type Script = (turn: Turn) => Reply

const sse = (events: [string | null, unknown][]) =>
  new Response(events.map(([event, data]) => (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })

/** A dispatch that answers Claude and Codex requests from a script, with no network. */
export function scriptedDispatch(script: Script, turns: Turn[]): Contracts.RuntimeOptions['dispatch'] {
  let calls = 0
  return async (request) => {
    const body = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, any>
    const provider = request.provider ?? (body.messages ? 'claude' : 'codex')
    const role = /Agent role: ([a-z-]+)/.exec(JSON.stringify(body))?.[1] ?? 'unknown'
    const turn: Turn = { provider, role, output: provider === 'claude' ? claudeOutput(body) : codexOutput(body) }
    turns.push(turn)
    const reply = script(turn)
    const call = calls++
    return provider === 'claude' ? claudeReply(body.model, reply, call) : codexReply(body.model, reply, call)
  }
}

function claudeOutput(body: Record<string, any>): string | null {
  const content = body.messages.at(-1)?.content
  const result = Array.isArray(content) ? content.find((block: { type: string }) => block.type === 'tool_result') : undefined
  return result ? JSON.stringify(result.content) : null
}

function codexOutput(body: Record<string, any>): string | null {
  const items = body.input as { type: string; role?: string; output?: unknown }[]
  const user = items.findLastIndex((item) => item.type === 'message' && item.role === 'user')
  const result = items.find((item, index) => index > user && item.type === 'custom_tool_call_output')
  return result ? JSON.stringify(result.output) : null
}

function claudeReply(model: string, reply: Reply, call: number): Response {
  const block =
    'cell' in reply
      ? [{ type: 'tool_use', id: `toolu_${call}`, name: 'exec', input: {} }, { type: 'input_json_delta', partial_json: JSON.stringify({ code: reply.cell }) }]
      : [{ type: 'text', text: '' }, { type: 'text_delta', text: reply.text }]
  return sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: { id: `message_${call}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: block[0] }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: block[1] }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'cell' in reply ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }],
  ])
}

function codexReply(model: string, reply: Reply, call: number): Response {
  const id = `resp_${call}`
  const item =
    'cell' in reply
      ? { type: 'custom_tool_call', id: `ctc_${call}`, call_id: `call_${call}`, name: 'exec', input: reply.cell, status: 'completed' }
      : { type: 'message', id: `msg_${call}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply.text }] }
  const delta =
    'cell' in reply
      ? { type: 'response.custom_tool_call_input.delta', output_index: 0, item_id: item.id, delta: reply.cell }
      : { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: reply.text }
  const started = 'cell' in reply ? { ...item, status: 'in_progress', input: '' } : { ...item, status: 'in_progress', content: [] }
  return sse([
    [null, { type: 'response.created', response: { id, status: 'in_progress' } }],
    [null, { type: 'response.output_item.added', output_index: 0, item: started }],
    [null, delta],
    [null, { type: 'response.output_item.done', output_index: 0, item }],
    [null, { type: 'response.completed', response: { id, status: 'completed', model, output: [item], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } }],
  ])
}
