/**
 * Claude Code's event stream, normalized into repro's trace.
 *
 * Both `claude -p --output-format stream-json --verbose` and the session
 * transcripts under ~/.claude/projects/ print the same records: `assistant`
 * and `user` messages whose `content` is a list of blocks, and a final
 * `result`. This maps them onto the generic events — nothing else in repro
 * knows the shape, and an agent that prints the generic JSONL never gets
 * here.
 */
import type { AgentEvent, AgentTrace, AgentUsage } from '../agent.js'

type Block = Record<string, unknown> & { type?: string }
type Message = { id?: string; role?: string; content?: unknown; model?: string; usage?: AgentUsage }

const message = (r: Record<string, unknown>): Message | undefined =>
  r.message && typeof r.message === 'object' ? (r.message as Message) : undefined

export function isClaudeCodeStream(records: Record<string, unknown>[]): boolean {
  return records.some(
    (r) => (r.type === 'assistant' || r.type === 'user') && Array.isArray(message(r)?.content),
  )
}

/** Claude Code names MCP tools `mcp__<server>__<tool>`. */
function splitTool(full: string | undefined): { name?: string; server?: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(full ?? '')
  return m ? { name: m[2], server: m[1] } : { name: full }
}

export function fromClaudeCode(records: Record<string, unknown>[]): AgentTrace {
  const trace: AgentTrace = { events: [] }
  const usage: AgentUsage = { input_tokens: 0, output_tokens: 0 }
  const toolNames = new Map<string, string>()
  let step = 0
  let turn: { id?: string; model: AgentEvent } | undefined

  for (const r of records) {
    const msg = message(r)
    if (r.type === 'assistant' && Array.isArray(msg?.content)) {
      const blocks = msg.content as Block[]
      const text = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
      // The stream may print one record per content block, all under the
      // same message id. That is one turn — one model event, counted once.
      if (!turn || !msg.id || msg.id !== turn.id) {
        step++
        turn = { id: msg.id, model: { type: 'model', name: msg.model, model: msg.model, step } }
        trace.events.push(turn.model)
        usage.input_tokens! += msg.usage?.input_tokens ?? 0
        usage.output_tokens! += msg.usage?.output_tokens ?? 0
      }
      if (text) turn.model.output = turn.model.output ? `${turn.model.output}\n${text}` : text
      for (const block of blocks) {
        if (block.type === 'tool_use') {
          if (typeof block.id === 'string' && typeof block.name === 'string') toolNames.set(block.id, block.name)
          trace.events.push({ type: 'tool_call', ...splitTool(block.name as string), input: block.input, step })
        } else if (block.type === 'text' && block.text) {
          trace.events.push({ type: 'message', name: 'assistant', output: block.text, step })
        }
      }
    } else if (r.type === 'user' && msg) {
      if (typeof msg.content === 'string') {
        trace.input ??= msg.content
        continue
      }
      for (const block of (msg.content as Block[] | undefined) ?? []) {
        if (block.type === 'tool_result') {
          const full = toolNames.get(String(block.tool_use_id))
          const event: AgentEvent = { type: 'tool_result', ...splitTool(full), output: block.content, step }
          trace.events.push(event)
        } else if (block.type === 'text' && trace.input === undefined) {
          trace.input = block.text
        }
      }
    } else if (r.type === 'result') {
      if (r.result !== undefined) trace.output = r.result
      if (typeof r.duration_ms === 'number') trace.duration_ms = r.duration_ms
      const total = r.usage as AgentUsage | undefined
      if (total?.input_tokens !== undefined) usage.input_tokens = total.input_tokens
      if (total?.output_tokens !== undefined) usage.output_tokens = total.output_tokens
    }
  }
  usage.total_tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
  if (usage.total_tokens > 0) trace.usage = usage
  return trace
}
