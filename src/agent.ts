/**
 * Agent reproductions.
 *
 * An LLM agent is not a different kind of product for repro — it is a
 * stochastic system with more observable behaviour. The step runs the agent,
 * the agent emits a trace, and the trace is matched exactly the way an HTTP
 * status is. What changes is that "reproduced" is usually a rate rather than a
 * yes, and repeated execution already handles that.
 *
 * This module is deliberately free of framework knowledge and of repro's own
 * execution code: it defines the normalized trace, parses one out of whatever
 * the agent printed, and matches it. Nothing here imports an SDK.
 */

// ------------------------------------------------------------- trace model

export type AgentEventType =
  | 'model'
  | 'tool_call'
  | 'tool_result'
  | 'retrieval'
  | 'handoff'
  | 'message'
  | 'custom'

export type AgentEvent = {
  type: AgentEventType
  name?: string
  /** Tool call arguments, model prompt, retrieval query. */
  input?: unknown
  output?: unknown
  timestamp?: number
}

export type AgentUsage = {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

export type AgentTrace = {
  input?: unknown
  events: AgentEvent[]
  output?: unknown
  duration_ms?: number
  usage?: AgentUsage
  /** Set when the step declared an `output_schema`. */
  schema_valid?: boolean
  schema_errors?: string[]
}

/** An `agent:` step. Either runs something, reads a trace file, or both. */
export type AgentStep = {
  /** Command to run. Receives the input as JSON on stdin. */
  run?: string
  cwd?: string
  env?: Record<string, string>
  /** Passed to the agent on stdin and recorded as `trace.input`. */
  input?: unknown
  /**
   * Read the trace from this file instead of stdout. Also usable without
   * `run`, to match against a trace captured somewhere else.
   */
  trace_file?: string
  /** JSON Schema the final output is expected to satisfy. */
  output_schema?: string | Record<string, unknown>
  timeout_ms?: number
}

const EVENT_TYPES = new Set<string>([
  'model',
  'tool_call',
  'tool_result',
  'retrieval',
  'handoff',
  'message',
  'custom',
])

/**
 * Parse whatever the agent produced. Accepts a whole trace as one JSON
 * object, or JSONL with one event per line — and ignores lines that are not
 * JSON, because agents log.
 */
export function parseTrace(text: string): AgentTrace {
  const trimmed = text.trim()
  if (!trimmed) return { events: [] }

  const whole = tryJson(trimmed)
  if (whole && typeof whole === 'object' && !Array.isArray(whole) && 'events' in whole) {
    return normalizeTrace(whole as Record<string, unknown>)
  }
  if (Array.isArray(whole)) return { events: whole.map(normalizeEvent).filter(isEvent) }

  const trace: AgentTrace = { events: [] }
  for (const line of trimmed.split('\n')) {
    const parsed = tryJson(line.trim())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    // A line that carries the final answer rather than an event.
    if (record.type === 'output' || (record.output !== undefined && record.type === undefined)) {
      trace.output = record.output
      if (record.usage) trace.usage = record.usage as AgentUsage
      continue
    }
    if (record.type === 'usage') {
      trace.usage = (record.usage ?? record) as AgentUsage
      continue
    }
    const event = normalizeEvent(record)
    if (isEvent(event)) trace.events.push(event)
  }
  return trace
}

function normalizeTrace(raw: Record<string, unknown>): AgentTrace {
  const events = Array.isArray(raw.events) ? raw.events.map(normalizeEvent).filter(isEvent) : []
  return {
    input: raw.input,
    events,
    output: raw.output,
    duration_ms: typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined,
    usage: raw.usage as AgentUsage | undefined,
  }
}

function normalizeEvent(raw: unknown): AgentEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const type = typeof r.type === 'string' ? r.type : undefined
  if (!type || !EVENT_TYPES.has(type)) return undefined
  return {
    type: type as AgentEventType,
    name: typeof r.name === 'string' ? r.name : typeof r.tool === 'string' ? r.tool : undefined,
    // Frameworks disagree on the word; both mean "what the tool was called with".
    input: r.input ?? r.arguments ?? r.args,
    output: r.output ?? r.result,
    timestamp: typeof r.timestamp === 'number' ? r.timestamp : undefined,
  }
}

function isEvent(e: AgentEvent | undefined): e is AgentEvent {
  return e !== undefined
}

function tryJson(text: string): unknown {
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ----------------------------------------------------------------- matchers

/** `5`, or a comparison. Used by counts, durations and token usage. */
export type NumberMatcher =
  | number
  | {
      equals?: number
      not_equals?: number
      greater_than?: number
      greater_than_or_equal?: number
      less_than?: number
      less_than_or_equal?: number
    }

/**
 * A literal value, or a comparison. An object counts as a comparison only if
 * every one of its keys is a comparator name — otherwise it is an expected
 * value and is compared structurally.
 */
export type ValueMatcher = unknown

const COMPARATORS = new Set([
  'equals',
  'not_equals',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
  'contains',
  'matches',
  'exists',
  'missing',
])

export type EventMatcher = {
  /** Only for `trace.event`; the other keys imply their own type. */
  type?: AgentEventType
  name?: string
  name_matches?: string
  /** Matched against the event's `input` (tool arguments). */
  arguments?: Record<string, ValueMatcher>
  output?: Record<string, ValueMatcher>
  /** How many events must match. Omitted means "at least one". */
  count?: NumberMatcher
}

export type SequenceStep = { tool?: string; type?: AgentEventType; name?: string }

export type SequenceMatcher = {
  /** Events that must appear in this order, not necessarily adjacent. */
  contains?: SequenceStep[]
  /** ...with none of these occurring before the first of them. */
  not_preceded_by?: SequenceStep
}

export type TraceMatcher = {
  tool_call?: EventMatcher
  tool_result?: EventMatcher
  retrieval?: EventMatcher
  message?: EventMatcher
  model?: EventMatcher
  handoff?: EventMatcher
  /** Any event type, named explicitly. */
  event?: EventMatcher
  sequence?: SequenceMatcher
}

export type OutputMatcher = {
  equals?: unknown
  contains?: string
  matches?: string
  /** Requires `output_schema` on the step. */
  schema?: { valid: boolean }
}

export type AgentMatcher = {
  trace?: TraceMatcher
  output?: OutputMatcher
  duration_ms?: NumberMatcher
  usage?: { input_tokens?: NumberMatcher; output_tokens?: NumberMatcher; total_tokens?: NumberMatcher }
}

const IMPLIED_TYPE: Record<string, AgentEventType> = {
  tool_call: 'tool_call',
  tool_result: 'tool_result',
  retrieval: 'retrieval',
  message: 'message',
  model: 'model',
  handoff: 'handoff',
}

/**
 * Every failed clause, in the same style as the HTTP matchers: a trajectory
 * that did not reproduce should say which part of it did not hold.
 */
export function matchAgent(m: AgentMatcher, trace: AgentTrace | undefined, durationMs: number): string[] {
  const reasons: string[] = []
  if (m.trace && !trace) {
    reasons.push('no agent trace on this step')
    return reasons
  }
  if (trace && m.trace) reasons.push(...matchTrace(m.trace, trace))

  if (m.output) reasons.push(...matchOutput(m.output, trace))

  if (m.duration_ms !== undefined) {
    const observed = trace?.duration_ms ?? durationMs
    const reason = matchNumber(m.duration_ms, observed, 'duration_ms')
    if (reason) reasons.push(reason)
  }
  for (const [key, matcher] of Object.entries(m.usage ?? {})) {
    if (matcher === undefined) continue
    const observed = trace?.usage?.[key as keyof AgentUsage]
    if (observed === undefined) {
      reasons.push(`usage.${key} was not reported by the agent`)
      continue
    }
    const reason = matchNumber(matcher, observed, `usage.${key}`)
    if (reason) reasons.push(reason)
  }
  return reasons
}

export function matchTrace(m: TraceMatcher, trace: AgentTrace): string[] {
  const reasons: string[] = []
  for (const [key, matcher] of Object.entries(m)) {
    if (key === 'sequence' || matcher === undefined) continue
    const type = IMPLIED_TYPE[key] ?? (matcher as EventMatcher).type
    if (key === 'event' && !type) {
      reasons.push('trace.event needs a `type`')
      continue
    }
    reasons.push(...matchEvents(matcher as EventMatcher, type, trace.events, key))
  }
  if (m.sequence) reasons.push(...matchSequence(m.sequence, trace.events))
  return reasons
}

function matchEvents(
  m: EventMatcher,
  type: AgentEventType | undefined,
  events: AgentEvent[],
  label: string,
): string[] {
  const ofType = type ? events.filter((e) => e.type === type) : events
  const named = m.name
    ? ofType.filter((e) => e.name === m.name)
    : m.name_matches
      ? ofType.filter((e) => e.name !== undefined && new RegExp(m.name_matches!).test(e.name))
      : ofType

  const matching: AgentEvent[] = []
  const argReasons: string[] = []
  for (const event of named) {
    const failed = [
      ...matchFields(m.arguments, event.input, 'arguments'),
      ...matchFields(m.output, event.output, 'output'),
    ]
    if (failed.length === 0) matching.push(event)
    else if (argReasons.length === 0) argReasons.push(...failed)
  }

  const describe = `${label}${m.name ? ` "${m.name}"` : m.name_matches ? ` /${m.name_matches}/` : ''}`
  if (m.count !== undefined) {
    const reason = matchNumber(m.count, matching.length, `${describe} count`)
    return reason ? [reason] : []
  }
  if (matching.length > 0) return []
  if (named.length > 0 && argReasons.length) return [`${describe}: ${argReasons.join('; ')}`]
  return [`no ${describe} in the trace`]
}

function matchFields(
  fields: Record<string, ValueMatcher> | undefined,
  value: unknown,
  label: string,
): string[] {
  if (!fields) return []
  const reasons: string[] = []
  const record = (value ?? {}) as Record<string, unknown>
  for (const [key, matcher] of Object.entries(fields)) {
    const reason = matchValue(matcher, record[key], `${label}.${key}`)
    if (reason) reasons.push(reason)
  }
  return reasons
}

/**
 * "Did the agent do X without doing Y first?" — the shape of most agent
 * safety bugs, and the reason a trajectory needs more than a count.
 */
function matchSequence(m: SequenceMatcher, events: AgentEvent[]): string[] {
  const wanted = m.contains ?? []
  if (!wanted.length) return []

  // Leftmost greedy subsequence match: it finds an occurrence if one exists,
  // and the earliest possible first event, which is the occurrence with the
  // fewest chances of having been guarded.
  const describe = wanted.map(describeStep).join(' → ')
  let first = -1
  let cursor = 0
  for (const step of wanted) {
    while (cursor < events.length && !sequenceStepMatches(step, events[cursor]!)) cursor++
    if (cursor >= events.length) return [`the trace does not contain ${describe}`]
    if (first < 0) first = cursor
    cursor++
  }
  if (!m.not_preceded_by) return []

  const guard = m.not_preceded_by
  const guarded = events.slice(0, first).some((e) => sequenceStepMatches(guard, e))
  return guarded ? [`${describe} was preceded by ${describeStep(guard)}`] : []
}

function sequenceStepMatches(step: SequenceStep, event: AgentEvent): boolean {
  const name = step.tool ?? step.name
  const type = step.type ?? (step.tool ? 'tool_call' : undefined)
  if (type && event.type !== type) return false
  return name === undefined || event.name === name
}

function describeStep(step: SequenceStep): string {
  return step.tool ?? step.name ?? step.type ?? '(any event)'
}

function matchOutput(m: OutputMatcher, trace: AgentTrace | undefined): string[] {
  const reasons: string[] = []
  const output = trace?.output
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? null)

  if (m.equals !== undefined && !deepEqual(output, m.equals)) {
    reasons.push(`output ${text} != ${JSON.stringify(m.equals)}`)
  }
  if (m.contains !== undefined && !text.includes(m.contains)) {
    reasons.push(`output does not contain ${JSON.stringify(m.contains)}`)
  }
  if (m.matches !== undefined && !new RegExp(m.matches).test(text)) {
    reasons.push(`output does not match /${m.matches}/`)
  }
  if (m.schema !== undefined) {
    if (trace?.schema_valid === undefined) {
      reasons.push('no `output_schema` declared on the agent step, so schema validity is unknown')
    } else if (trace.schema_valid !== m.schema.valid) {
      reasons.push(
        m.schema.valid
          ? `output does not satisfy the schema: ${(trace.schema_errors ?? []).join('; ')}`
          : 'output satisfies the schema',
      )
    }
  }
  return reasons
}

export function matchNumber(m: NumberMatcher, value: number, label: string): string | undefined {
  if (typeof m === 'number') return value === m ? undefined : `${label} ${value} != ${m}`
  const fail = (text: string) => `${label} ${value} ${text}`
  if (m.equals !== undefined && value !== m.equals) return fail(`!= ${m.equals}`)
  if (m.not_equals !== undefined && value === m.not_equals) return fail(`== ${m.not_equals}`)
  if (m.greater_than !== undefined && !(value > m.greater_than)) return fail(`is not > ${m.greater_than}`)
  if (m.greater_than_or_equal !== undefined && !(value >= m.greater_than_or_equal)) {
    return fail(`is not >= ${m.greater_than_or_equal}`)
  }
  if (m.less_than !== undefined && !(value < m.less_than)) return fail(`is not < ${m.less_than}`)
  if (m.less_than_or_equal !== undefined && !(value <= m.less_than_or_equal)) {
    return fail(`is not <= ${m.less_than_or_equal}`)
  }
  return undefined
}

export function matchValue(m: ValueMatcher, value: unknown, label: string): string | undefined {
  if (isComparison(m)) {
    const c = m as Record<string, unknown>
    if (c.exists !== undefined) {
      const present = value !== undefined
      if (present !== c.exists) return `${label} ${present ? 'exists' : 'is missing'}`
    }
    if (c.missing !== undefined) {
      const absent = value === undefined
      if (absent !== c.missing) return `${label} ${absent ? 'is missing' : 'exists'}`
    }
    if (c.contains !== undefined) {
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
      if (!text.includes(String(c.contains))) return `${label} does not contain ${JSON.stringify(c.contains)}`
    }
    if (c.matches !== undefined) {
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
      if (!new RegExp(String(c.matches)).test(text)) return `${label} does not match /${c.matches}/`
    }
    const numeric = Object.keys(c).filter((k) => k !== 'contains' && k !== 'matches' && k !== 'exists' && k !== 'missing')
    if (numeric.length) {
      if (typeof value !== 'number') return `${label} = ${JSON.stringify(value)} is not a number`
      return matchNumber(c as NumberMatcher, value, label)
    }
    return undefined
  }
  return deepEqual(value, m) ? undefined : `${label} = ${JSON.stringify(value)} != ${JSON.stringify(m)}`
}

function isComparison(m: unknown): boolean {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false
  const keys = Object.keys(m as object)
  return keys.length > 0 && keys.every((k) => COMPARATORS.has(k))
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

// ---------------------------------------------------------------- schema

/**
 * Structured-output validation.
 *
 * ponytail: a JSON Schema subset — type, required, properties, items, enum,
 * additionalProperties, and the obvious bounds. No $ref, allOf/anyOf/oneOf,
 * format or patternProperties. That covers "did the agent return the shape it
 * promised", which is the failure §26 is about. Swap in ajv the day a
 * reproduction genuinely needs draft-07 in full.
 */
export function validateJsonSchema(schema: unknown, value: unknown, at = '$'): string[] {
  if (!schema || typeof schema !== 'object') return []
  const s = schema as Record<string, unknown>
  const errors: string[] = []

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string]
    if (!types.some((t) => isType(value, t))) {
      errors.push(`${at} is ${typeName(value)}, expected ${types.join(' or ')}`)
      return errors
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((option) => deepEqual(option, value))) {
    errors.push(`${at} = ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`)
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) errors.push(`${at} < minimum ${s.minimum}`)
    if (typeof s.maximum === 'number' && value > s.maximum) errors.push(`${at} > maximum ${s.maximum}`)
  }
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) errors.push(`${at} shorter than ${s.minLength}`)
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) errors.push(`${at} longer than ${s.maxLength}`)
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(value)) {
      errors.push(`${at} does not match /${s.pattern}/`)
    }
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) errors.push(`${at} has fewer than ${s.minItems} items`)
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) errors.push(`${at} has more than ${s.maxItems} items`)
    if (s.items) value.forEach((item, i) => errors.push(...validateJsonSchema(s.items, item, `${at}[${i}]`)))
  }
  if (isPlainObject(value)) {
    const record = value as Record<string, unknown>
    for (const key of (s.required as string[] | undefined) ?? []) {
      if (!(key in record)) errors.push(`${at}.${key} is required`)
    }
    const properties = (s.properties as Record<string, unknown> | undefined) ?? {}
    for (const [key, sub] of Object.entries(properties)) {
      if (key in record) errors.push(...validateJsonSchema(sub, record[key], `${at}.${key}`))
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) errors.push(`${at}.${key} is not allowed`)
      }
    }
  }
  return errors
}

function isType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'null':
      return value === null
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
      return typeof value === 'number'
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    default:
      return true
  }
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
