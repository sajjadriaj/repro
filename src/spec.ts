/**
 * repro.yaml: the reproduction specification.
 *
 * Human-inspectable and hand-editable by design. Everything repro executes
 * comes from this file — there is no hidden state.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import {
  matchAgent,
  type AgentMatcher,
  type AgentStep,
  type AgentTrace,
  type NumberMatcher,
  type OutputMatcher,
  type TraceMatcher,
} from './agent.js'

// ---------------------------------------------------------------- matchers

/**
 * A Matcher describes an observed outcome. Every declared field must hold for
 * the matcher to match (AND, not OR).
 */
export type Matcher = {
  status?: number
  status_in?: number[]
  status_not?: number
  body_contains?: string
  body_matches?: string
  json?: Record<string, unknown>
  exception?: string
  exit_code?: number
  stdout_contains?: string
  stderr_contains?: string
  logs_contain?: string
  /** Agent steps: the normalized trace. See agent.ts. */
  trace?: TraceMatcher
  output?: OutputMatcher
  duration_ms?: NumberMatcher
  usage?: AgentMatcher['usage']
}

/** Uniform outcome shape across every step kind, so one Matcher covers all. */
export type Observed = {
  kind: StepKind
  label: string
  status?: number
  headers?: Record<string, string>
  body?: string
  json?: unknown
  exit_code?: number
  stdout?: string
  stderr?: string
  exception?: string
  error?: string
  duration_ms: number
  /** Set when the step declared `expect` and the observation did not match. */
  expect_failed?: string[]
  screenshots?: string[]
  /** Other files this step left behind (agent traces, dumps). */
  artifacts?: string[]
  trace?: AgentTrace
}

// ------------------------------------------------------------------- steps

export type StepKind = 'shell' | 'http' | 'browser' | 'sleep' | 'agent'

export type HttpReq = {
  method?: string
  url: string
  headers?: Record<string, string>
  body?: string
  json?: unknown
  form?: Record<string, string>
  timeout_ms?: number
}

/** Browser actions are single-key objects; see exec.ts for the dispatch table. */
export type BrowserAction = Record<string, unknown>

type StepCommon = {
  id?: string
  name?: string
  expect?: Matcher
  /** Minimizer will never remove this step. */
  keep?: boolean
  /** Capture values out of the response for later `${interpolation}`. */
  save?: Record<string, string>
}

export type Step = StepCommon & {
  shell?: string
  cwd?: string
  http?: HttpReq
  browser?: BrowserAction[]
  sleep?: number
  agent?: AgentStep
}

// ---------------------------------------------------------------- services

export type WaitFor = {
  http?: string
  port?: number
  log?: string
  timeout_ms?: number
}

export type Service = {
  name?: string
  command: string
  cwd?: string
  env?: Record<string, string>
  wait_for?: WaitFor
}

// -------------------------------------------------------------------- spec

export type FailureSpec = {
  /** Step id, step name, or 1-based index. Defaults to the last step. */
  step?: string | number
  /** What the step should do when the bug is fixed. Informational + export. */
  expect?: Matcher
  /** What the step does while the bug is present. This defines "reproduced". */
  reproduce: Matcher
}

/**
 * What counts as "this failure no longer happens". Without one, repro reports
 * a rate change and refuses to call a bug fixed — that call belongs to a
 * declared policy, not to a verdict printer.
 */
export type VerifyPolicy = {
  /** Runs `repro verify` performs when --repeat is not given. */
  trials?: number
  reproduced?: { max?: number }
  reproduction_rate?: { less_than?: number; less_than_or_equal?: number }
}

export type Spec = {
  name: string
  description?: string
  /** Prefixed onto relative `http.url` and browser `goto` targets. */
  base_url?: string
  env?: Record<string, string>
  vars?: Record<string, string>
  setup?: Step[]
  services?: Service[]
  scenario: Step[]
  failure: FailureSpec
  teardown?: Step[]
  /** Restart services between repeated runs. Slower; use for stateful daemons. */
  restart_services?: boolean
  /** Abort the scenario as soon as a step's `expect` fails. */
  stop_on_expect_fail?: boolean
  /** Elimination policy checked by `repro verify`. */
  verify?: VerifyPolicy
}

/**
 * Three questions, three key sets, because conflating them made a seal break
 * for reasons that had nothing to do with the bug.
 *
 * `description` is in none of them: it is prose about the bug rather than part
 * of it, so rewording it has never broken a seal.
 */

/**
 * Where the application lives and how it is started.
 *
 * NOT part of the bug. "The notes route accepts a write it should refuse" is
 * the bug; "port 3000 answered 201" is where it was observed. Moving the app
 * to another port, renaming the service, or pointing `base_url` at a container
 * changes none of the predicate — and a fingerprint that said otherwise forced
 * a re-measurement to record the same number again.
 *
 * Changes here are reported as drift, in the same breath as a changed git
 * commit, and for the same reason: worth seeing, not worth refusing. That is
 * deliberately a judgement call. A `services.env` flag CAN be what causes the
 * bug, and an agent could switch one off and call it fixed — so the drift is
 * printed on every verify rather than buried, which is the same bargain repro
 * already makes with the commit hash.
 */
export const ENVIRONMENT_KEYS = ['base_url', 'services'] as const

/**
 * What actually executes: the bug, minus the goalposts.
 *
 * This is what a baseline measures, so this — and only this — invalidates one.
 * `verify` is excluded because an elimination policy is applied to the numbers
 * after the runs finish; declaring one does not change what ran, and being
 * unable to add a policy after `establish` left no way forward that did not
 * destroy the record that the bug was ever real.
 */
export const EXECUTION_KEYS = [
  'name',
  'env',
  'vars',
  'setup',
  'scenario',
  'failure',
  'teardown',
  'restart_services',
  'stop_on_expect_fail',
] as const

/**
 * What the bug is, plus what counts as fixing it.
 *
 * `verify` belongs here and not in EXECUTION_KEYS: an agent that cannot reach
 * `reproduced: {max: 0}` can relax it to `{max: 5}`, which is exactly the
 * goalpost-moving a seal exists to expose.
 */
export const CONTRACT_KEYS = [...EXECUTION_KEYS, 'verify'] as const

export class SpecError extends Error {}

// ------------------------------------------------------------------ loading

export const REPRO_DIR = '.repro'
export const SPEC_FILE = 'repro.yaml'

/** Walk up from `from` looking for a `.repro/repro.yaml`. */
export function findReproDir(from: string = process.cwd()): string | undefined {
  let dir = path.resolve(from)
  for (;;) {
    const candidate = path.join(dir, REPRO_DIR, SPEC_FILE)
    if (existsSync(candidate)) return path.join(dir, REPRO_DIR)
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export type LoadedSpec = {
  spec: Spec
  /** Absolute path to the .repro directory. */
  reproDir: string
  /** Absolute path to the project root (parent of .repro). */
  root: string
  specPath: string
}

export async function loadSpec(specPath?: string, from?: string): Promise<LoadedSpec> {
  let resolved: string
  let reproDir: string
  if (specPath) {
    resolved = path.resolve(specPath)
    if (!existsSync(resolved)) throw new SpecError(`no such spec: ${resolved}`)
    reproDir = path.dirname(resolved)
  } else {
    const found = findReproDir(from)
    if (!found) {
      throw new SpecError(
        `no .repro/${SPEC_FILE} found in this directory or any parent.\n` +
          `run \`repro init "<bug description>"\` to create one.`,
      )
    }
    reproDir = found
    resolved = path.join(found, SPEC_FILE)
  }
  const text = await readFile(resolved, 'utf8')
  const raw = YAML.parse(text)
  const spec = validateSpec(raw, resolved)
  return { spec, reproDir, root: path.dirname(reproDir), specPath: resolved }
}

export function validateSpec(raw: unknown, where = 'repro.yaml'): Spec {
  if (!raw || typeof raw !== 'object') throw new SpecError(`${where}: expected a YAML mapping`)
  const s = raw as Record<string, unknown>
  const problems: string[] = []

  if (typeof s.name !== 'string' || !s.name.trim()) problems.push('`name` is required')
  if (!Array.isArray(s.scenario)) problems.push('`scenario` must be a list of steps')
  const failure = s.failure as FailureSpec | undefined
  if (!failure || typeof failure !== 'object') {
    problems.push('`failure` is required')
  } else if (!failure.reproduce || typeof failure.reproduce !== 'object') {
    problems.push('`failure.reproduce` is required — it defines what "reproduced" means')
  } else if (Object.keys(failure.reproduce).length === 0) {
    problems.push('`failure.reproduce` is empty — an empty matcher matches everything')
  }

  const steps = Array.isArray(s.scenario) ? (s.scenario as unknown[]) : []
  steps.forEach((step, i) => {
    const kind = stepKindOf(step)
    if (!kind) {
      problems.push(
        `scenario[${i}]: no executable key — expected one of shell, http, browser, sleep, agent`,
      )
    }
  })
  for (const svc of (s.services as Service[] | undefined) ?? []) {
    if (!svc || typeof svc.command !== 'string') problems.push('each service needs a `command`')
  }

  if (problems.length) throw new SpecError(`${where}:\n  - ${problems.join('\n  - ')}`)
  return s as unknown as Spec
}

export function stepKindOf(step: unknown): StepKind | undefined {
  if (!step || typeof step !== 'object') return undefined
  const s = step as Step
  if (typeof s.shell === 'string') return 'shell'
  if (s.http && typeof s.http === 'object') return 'http'
  if (Array.isArray(s.browser)) return 'browser'
  if (typeof s.sleep === 'number') return 'sleep'
  if (s.agent && typeof s.agent === 'object') return 'agent'
  return undefined
}

export function stepLabel(step: Step, index: number): string {
  if (step.name) return step.name
  if (step.id) return step.id
  if (step.http) {
    const method = (step.http.method ?? 'GET').toUpperCase()
    return `${method} ${step.http.url}`
  }
  if (step.shell) return `$ ${step.shell}`
  if (step.browser) {
    const first = step.browser[0]
    const key = first ? Object.keys(first)[0] : undefined
    return `browser (${step.browser.length} actions${key ? `, ${key}…` : ''})`
  }
  if (step.agent) {
    const input = step.agent.input
    const summary =
      typeof input === 'string'
        ? input
        : typeof (input as { message?: string })?.message === 'string'
          ? (input as { message: string }).message
          : (step.agent.run ?? step.agent.trace_file ?? 'trace')
    return `agent: ${summary.slice(0, 60)}`
  }
  if (typeof step.sleep === 'number') return `sleep ${step.sleep}ms`
  return `step ${index + 1}`
}

/**
 * Resolve `failure.step` to a scenario index. Accepts a step id, a step name,
 * or a 1-based index. Defaults to the last step.
 */
export function failureStepIndex(spec: Spec): number {
  const target = spec.failure.step
  const last = spec.scenario.length - 1
  if (target === undefined) return last
  if (typeof target === 'number') {
    const idx = target - 1
    if (idx < 0 || idx > last) throw new SpecError(`failure.step ${target} is out of range`)
    return idx
  }
  const byId = spec.scenario.findIndex((s) => s.id === target || s.name === target)
  if (byId >= 0) return byId
  throw new SpecError(`failure.step "${target}" matches no step id or name`)
}

// ----------------------------------------------------------- interpolation

/** Replace `${name}` from vars, and `${env.NAME}` from the environment. */
export function interpolateString(input: string, vars: Record<string, string>): string {
  return input.replace(/\$\{([^}]+)\}/g, (whole, expr: string) => {
    const key = expr.trim()
    if (key.startsWith('env.')) return process.env[key.slice(4)] ?? ''
    const value = vars[key]
    return value === undefined ? whole : value
  })
}

/** Deep-interpolate every string inside a value. */
export function interpolate<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === 'string') return interpolateString(value, vars) as unknown as T
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolate(v, vars)
    }
    return out as unknown as T
  }
  return value
}

// -------------------------------------------------------------- json paths

/** Minimal `$.a.b[0]` reader. Enough for pulling ids out of responses. */
export function jsonPath(root: unknown, expr: string): unknown {
  const cleaned = expr.replace(/^\$\.?/, '')
  if (!cleaned) return root
  let cursor: unknown = root
  for (const rawPart of cleaned.split('.')) {
    if (cursor == null) return undefined
    const match = /^([^[\]]*)((\[\d+\])*)$/.exec(rawPart)
    if (!match) return undefined
    const [, key = '', indexes = ''] = match
    if (key) {
      if (typeof cursor !== 'object') return undefined
      cursor = (cursor as Record<string, unknown>)[key]
    }
    for (const idx of indexes.match(/\d+/g) ?? []) {
      if (!Array.isArray(cursor)) return undefined
      cursor = cursor[Number(idx)]
    }
  }
  return cursor
}

// --------------------------------------------------------------- matching

export type MatchResult = { ok: boolean; reasons: string[] }

/**
 * Check an observation against a matcher. `reasons` explains every failed
 * clause, so a NOT REPRODUCED result says exactly what differed.
 */
export function matchOutcome(m: Matcher, o: Observed, logs = ''): MatchResult {
  const reasons: string[] = []
  const body = o.body ?? ''
  const streams = `${o.stdout ?? ''}\n${o.stderr ?? ''}`
  const exception = o.exception ?? o.error ?? ''

  if (m.status !== undefined && o.status !== m.status) {
    reasons.push(`status ${fmt(o.status)} != ${m.status}`)
  }
  if (m.status_not !== undefined && o.status === m.status_not) {
    reasons.push(`status is ${m.status_not}, expected anything else`)
  }
  if (m.status_in !== undefined && (o.status === undefined || !m.status_in.includes(o.status))) {
    reasons.push(`status ${fmt(o.status)} not in [${m.status_in.join(', ')}]`)
  }
  if (m.body_contains !== undefined && !body.includes(m.body_contains)) {
    reasons.push(`body does not contain ${JSON.stringify(m.body_contains)}`)
  }
  if (m.body_matches !== undefined && !new RegExp(m.body_matches).test(body)) {
    reasons.push(`body does not match /${m.body_matches}/`)
  }
  if (m.json !== undefined) {
    for (const [expr, want] of Object.entries(m.json)) {
      const got = jsonPath(o.json, expr)
      if (!deepEqual(got, want)) {
        reasons.push(`json ${expr} = ${JSON.stringify(got)} != ${JSON.stringify(want)}`)
      }
    }
  }
  if (m.exception !== undefined && !exception.includes(m.exception) && !body.includes(m.exception)) {
    reasons.push(`no exception containing ${JSON.stringify(m.exception)}`)
  }
  if (m.exit_code !== undefined && o.exit_code !== m.exit_code) {
    reasons.push(`exit code ${fmt(o.exit_code)} != ${m.exit_code}`)
  }
  if (m.stdout_contains !== undefined && !(o.stdout ?? '').includes(m.stdout_contains)) {
    reasons.push(`stdout does not contain ${JSON.stringify(m.stdout_contains)}`)
  }
  if (m.stderr_contains !== undefined && !(o.stderr ?? '').includes(m.stderr_contains)) {
    reasons.push(`stderr does not contain ${JSON.stringify(m.stderr_contains)}`)
  }
  if (m.logs_contain !== undefined && !logs.includes(m.logs_contain) && !streams.includes(m.logs_contain)) {
    reasons.push(`service logs do not contain ${JSON.stringify(m.logs_contain)}`)
  }
  if (m.trace || m.output || m.duration_ms !== undefined || m.usage) {
    reasons.push(...matchAgent(m, o.trace, o.duration_ms))
  }

  return { ok: reasons.length === 0, reasons }
}

function fmt(v: unknown): string {
  return v === undefined ? '(none)' : String(v)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  )
}

export function dumpSpec(spec: Spec): string {
  return YAML.stringify(spec, { lineWidth: 100 })
}
