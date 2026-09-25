#!/usr/bin/env node
/**
 * A support agent with a real bug, and no model inside it.
 *
 * Asked to refund an order that was already refunded, it is supposed to look
 * the order up first and decline. Sometimes it skips the lookup and refunds
 * again. `AGENT_BUG_RATE` stands in for the sampling that makes a real agent
 * do this on some runs and not others.
 *
 * It talks to repro the way any agent can: JSONL events on stdout. It also
 * honours repro's record/replay contract: with `REPRO_REPLAY` set it takes
 * the planner's decision from that recording instead of sampling one, so the
 * tools run live against a decision that already happened.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ORDERS = {
  123: { id: '123', total: 4200, status: 'refunded', refunded_at: '2026-04-02T10:00:00Z' },
}

const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
const message = String(input.message ?? '')
const orderId = (message.match(/\b(\d{3,})\b/) ?? [])[1] ?? '123'
const bugRate = Number(process.env.AGENT_BUG_RATE ?? '0.35')

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)

// The model's decision: sampled live, or replayed from a recorded trace.
let decision
if (process.env.REPRO_REPLAY) {
  // Either repro's saved traces/NN.json (one object with `events`) or the
  // JSONL this agent prints.
  const text = readFileSync(process.env.REPRO_REPLAY, 'utf8')
  let recorded
  try {
    const whole = JSON.parse(text)
    recorded = Array.isArray(whole.events) ? whole.events : [whole]
  } catch {
    recorded = text.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
  }
  decision = recorded.find((e) => e.type === 'model' && e.output)?.output
}
decision ??= { skip_lookup: Math.random() < bugRate }
// The other half of the contract: with `REPRO_RECORD` set, save what a later
// run would replay — the same JSONL this agent reads back above.
if (process.env.REPRO_RECORD) {
  writeFileSync(
    path.join(process.env.REPRO_RECORD, 'decision.jsonl'),
    `${JSON.stringify({ type: 'model', name: 'planner', output: decision })}\n`,
  )
}

emit({ type: 'model', name: 'planner', input: message, output: decision })

let order
if (!decision.skip_lookup) {
  emit({ type: 'tool_call', name: 'get_order', input: { order_id: orderId } })
  order = ORDERS[orderId]
  emit({ type: 'tool_result', name: 'get_order', output: order ?? null })
}

let output
if (order?.status === 'refunded') {
  emit({ type: 'message', name: 'assistant', output: `Order ${orderId} was already refunded.` })
  output = { status: 'declined_already_refunded', order_id: orderId }
} else {
  const amount = ORDERS[orderId]?.total ?? 0
  emit({ type: 'tool_call', name: 'refund_order', input: { order_id: orderId, amount } })
  emit({ type: 'tool_result', name: 'refund_order', output: { ok: true, amount } })
  emit({ type: 'message', name: 'assistant', output: `Refunded ${amount} for order ${orderId}.` })
  output = { status: 'refunded', order_id: Number(orderId), amount }
}

emit({
  type: 'output',
  output,
  usage: { input_tokens: 820, output_tokens: 140, total_tokens: 960 },
})
