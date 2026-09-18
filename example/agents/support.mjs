#!/usr/bin/env node
/**
 * A support agent with a real bug, and no model inside it.
 *
 * Asked to refund an order that was already refunded, it is supposed to look
 * the order up first and decline. Sometimes it skips the lookup and refunds
 * again. `AGENT_BUG_RATE` stands in for the sampling that makes a real agent
 * do this on some runs and not others.
 *
 * It talks to repro the way any agent can: JSONL events on stdout.
 */
import { readFileSync } from 'node:fs'

const ORDERS = {
  123: { id: '123', total: 4200, status: 'refunded', refunded_at: '2026-04-02T10:00:00Z' },
}

const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
const message = String(input.message ?? '')
const orderId = (message.match(/\b(\d{3,})\b/) ?? [])[1] ?? '123'
const bugRate = Number(process.env.AGENT_BUG_RATE ?? '0.35')

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)

emit({ type: 'model', name: 'planner', input: message })

// The bug: the order lookup is skipped, so nothing tells the agent that this
// refund already happened.
const skipsLookup = Math.random() < bugRate
let order

if (!skipsLookup) {
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
  // ...and the structured output goes out malformed on the same path.
  output = { status: 'refunded', order_id: Number(orderId), amount }
}

emit({
  type: 'output',
  output,
  usage: { input_tokens: 820, output_tokens: 140, total_tokens: 960 },
})
