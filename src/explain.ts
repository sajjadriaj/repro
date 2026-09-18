/**
 * Evidence correlation around the failure boundary.
 *
 * explain does NOT claim a root cause. It answers three questions with actual
 * executions: which steps are load-bearing, where the observable state first
 * diverges, and which files the failure points at. The coding agent does the
 * diagnosing — this just hands it a much smaller haystack.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { jsonPath, stepKindOf, stepLabel, type LoadedSpec, type Observed } from './spec.js'
import type { RunResult } from './run.js'
import { makeProber, type Prober } from './minimize.js'
import type { NetworkEntry } from './evidence.js'

export type NecessaryStep = {
  index: number
  label: string
  necessary: boolean
}

export type StateDiff = {
  /** `probe` = a read replayed with and without the boundary step (causal).
   *  `response` = the same request compared across a good and a bad run. */
  source: 'probe' | 'response'
  where: string
  path: string
  without_step: unknown
  with_step: unknown
}

export type ExplainReport = {
  name: string
  status: RunResult['status']
  failure_step?: string
  /** The last required step before the failure surfaces. */
  boundary?: { index: number; label: string }
  steps: NecessaryStep[]
  required: string[]
  irrelevant: string[]
  state_diff: StateDiff[]
  /** Response fields that vary between two identical runs — excluded above. */
  nondeterministic_fields: string[]
  relevant_requests: { method: string; url: string; status?: number }[]
  relevant_code_paths: string[]
  log_tail: string[]
  exception?: string
  notes: string[]
  run_dir: string
}

export type ExplainOptions = {
  timeoutMs?: number
  confirm?: number
  /** The application is already running here; do not start `services:`. */
  baseUrl?: string
  onProgress?: (message: string) => void
}

export async function explain(
  loaded: LoadedSpec,
  opts: ExplainOptions = {},
): Promise<ExplainReport> {
  const { spec } = loaded
  opts.onProgress?.('running the reproduction')
  const prober = await makeProber(loaded, {
    confirm: opts.confirm ?? 1,
    timeoutMs: opts.timeoutMs,
    baseUrl: opts.baseUrl,
  })

  try {
    // Share the prober's application instance; a second copy would fight it
    // for the port.
    const bad = await prober.testOnce(prober.all, { evidence: true })
    const notes: string[] = []

    if (bad.status !== 'reproduced') {
      notes.push(
        bad.status === 'error'
          ? `the run errored (${bad.error ?? 'unknown'}), so boundary analysis was skipped`
          : bad.status === 'invalid'
            ? `the run never reached the failure step (${bad.error ?? 'a precondition failed'}), so boundary analysis was skipped`
            : 'the bug did not reproduce on this run, so boundary analysis was skipped',
      )
      return blank(loaded, bad, notes)
    }

    // Which steps are load-bearing? Drop exactly one and see if the bug survives.
    const steps: NecessaryStep[] = []
    for (const index of prober.all) {
      const label = stepLabel(spec.scenario[index]!, index)
      if (!prober.removable.includes(index)) {
        steps.push({ index, label, necessary: true })
        continue
      }
      opts.onProgress?.(`testing without step ${index + 1}: ${label}`)
      const outcome = await prober.test(prober.all.filter((i) => i !== index))
      steps.push({ index, label, necessary: !outcome.reproduced })
    }

    const beforeFailure = steps.filter((s) => s.necessary && s.index < prober.failureIndex)
    const boundaryStep = beforeFailure.at(-1)

    // Ids, timestamps and order numbers differ every run. Establish that noise
    // floor from two identical runs so it can be subtracted from every diff —
    // otherwise a fresh session id looks exactly like a causal state change.
    opts.onProgress?.('measuring run-to-run noise')
    const bad2 = await prober.testOnce(prober.all)
    const noise = noisePaths(bad.network, bad2.network)

    const stateDiff: StateDiff[] = []
    if (boundaryStep) {
      // Causal probe: replay the scenario's read-only requests with and without
      // the boundary step. The difference is what that step actually does.
      const probes = readOnlySteps(loaded, prober)
      const priorRequired = beforeFailure.filter((s) => s.index < boundaryStep.index).map((s) => s.index)
      if (probes.length) {
        opts.onProgress?.(`probing state with and without step ${boundaryStep.index + 1}`)
        const without = await prober.runOrdered([...priorRequired, ...probes])
        const with_ = await prober.runOrdered([...priorRequired, boundaryStep.index, ...probes])
        stateDiff.push(
          ...diffTail(without.network, with_.network, probes.length)
            .filter((d) => !noise.has(d.path))
            .map((d) => ({ ...d, source: 'probe' as const })),
        )
      } else {
        notes.push('no read-only steps in the scenario, so state could not be probed directly')
      }

      // Response-level diff: the same reproduction minus the boundary step.
      opts.onProgress?.(`diffing responses with and without step ${boundaryStep.index + 1}`)
      const good = await prober.testOnce(prober.all.filter((i) => i !== boundaryStep.index))
      stateDiff.push(
        ...diffNetworks(good.network, bad.network)
          .filter((d) => !noise.has(d.path))
          .map((d) => ({ ...d, source: 'response' as const })),
      )
    }

    return {
      name: spec.name,
      status: bad.status,
      failure_step: bad.failure?.step,
      boundary: boundaryStep
        ? { index: boundaryStep.index + 1, label: boundaryStep.label }
        : undefined,
      steps,
      required: steps.filter((s) => s.necessary).map((s) => s.label),
      irrelevant: steps.filter((s) => !s.necessary).map((s) => s.label),
      state_diff: dedupe(stateDiff).slice(0, 40),
      nondeterministic_fields: [...noise].sort(),
      relevant_requests: summarizeRequests(bad.network),
      relevant_code_paths: codePaths(loaded.root, bad),
      log_tail: tail(bad.log_excerpt),
      exception: bad.failure?.observed.exception,
      notes,
      run_dir: bad.run_dir,
    }
  } finally {
    await prober.close()
  }
}

function blank(loaded: LoadedSpec, bad: RunResult, notes: string[]): ExplainReport {
  return {
    name: loaded.spec.name,
    status: bad.status,
    failure_step: bad.failure?.step,
    steps: [],
    required: [],
    irrelevant: [],
    state_diff: [],
    nondeterministic_fields: [],
    relevant_requests: summarizeRequests(bad.network),
    relevant_code_paths: codePaths(loaded.root, bad),
    log_tail: tail(bad.log_excerpt),
    exception: bad.failure?.observed.exception,
    notes,
    run_dir: bad.run_dir,
  }
}

/** A scenario that reads the same endpoint repeatedly reports it once. */
function dedupe(diffs: StateDiff[]): StateDiff[] {
  const seen = new Set<string>()
  return diffs.filter((d) => {
    const key = `${d.source}|${d.where}|${d.path}|${JSON.stringify(d.without_step)}|${JSON.stringify(d.with_step)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Scenario steps safe to replay as state probes: plain GET requests. */
function readOnlySteps(loaded: LoadedSpec, prober: Prober): number[] {
  return prober.all.filter((i) => {
    const step = loaded.spec.scenario[i]
    if (!step || stepKindOf(step) !== 'http') return false
    if (i === prober.failureIndex) return false
    return (step.http?.method ?? 'GET').toUpperCase() === 'GET'
  })
}

// ------------------------------------------------------------- state diffs

function summarizeRequests(network: NetworkEntry[]) {
  return network
    .filter((n) => n.step >= 0)
    .map((n) => ({ method: n.method, url: shortUrl(n.url), status: n.status }))
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

type RawDiff = Omit<StateDiff, 'source'>

/** Fields whose value changes between two runs of the identical scenario. */
export function noisePaths(a: NetworkEntry[], b: NetworkEntry[]): Set<string> {
  const noise = new Set<string>()
  for (const diff of diffNetworks(a, b)) noise.add(diff.path)
  return noise
}

/** Compare the last `count` requests of each run, positionally. */
export function diffTail(a: NetworkEntry[], b: NetworkEntry[], count: number): RawDiff[] {
  const left = a.filter((e) => e.step >= 0).slice(-count)
  const right = b.filter((e) => e.step >= 0).slice(-count)
  const diffs: RawDiff[] = []
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    diffs.push(...diffEntry(left[i]!, right[i]!, `${right[i]!.method} ${shortUrl(right[i]!.url)}`))
  }
  return diffs
}

/**
 * Pair up the same request in both runs (same method+path, same occurrence
 * number) and report every JSON field that differs.
 */
export function diffNetworks(good: NetworkEntry[], bad: NetworkEntry[]): RawDiff[] {
  const index = (entries: NetworkEntry[]) => {
    const seen = new Map<string, number>()
    return entries
      .filter((e) => e.step >= 0)
      .map((e) => {
        const key = `${e.method} ${shortUrl(e.url)}`
        const nth = (seen.get(key) ?? 0) + 1
        seen.set(key, nth)
        return { key: `${key}#${nth}`, entry: e }
      })
  }
  const goodMap = new Map(index(good).map((x) => [x.key, x.entry]))
  const diffs: RawDiff[] = []

  for (const { key, entry } of index(bad)) {
    const counterpart = goodMap.get(key)
    if (!counterpart) continue
    diffs.push(...diffEntry(counterpart, entry, key.replace(/#1$/, '')))
  }
  return diffs
}

function diffEntry(without: NetworkEntry, with_: NetworkEntry, where: string): RawDiff[] {
  const diffs: RawDiff[] = []
  if (without.status !== with_.status) {
    diffs.push({ where, path: 'status', without_step: without.status, with_step: with_.status })
  }
  const a = safeJson(without.response_body)
  const b = safeJson(with_.response_body)
  if (a === undefined || b === undefined) return diffs
  const seen = new Set<string>()
  for (const p of jsonPaths(a).concat(jsonPaths(b))) {
    if (seen.has(p)) continue
    seen.add(p)
    const av = jsonPath(a, p)
    const bv = jsonPath(b, p)
    if (JSON.stringify(av) === JSON.stringify(bv)) continue
    diffs.push({ where, path: p, without_step: av, with_step: bv })
  }
  return diffs
}

function safeJson(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Enumerate leaf paths (`$.a.b[0]`) up to a sane depth. */
function jsonPaths(value: unknown, prefix = '$', depth = 0): string[] {
  if (depth > 4 || value === null || typeof value !== 'object') return prefix === '$' ? [] : [prefix]
  const entries = Array.isArray(value)
    ? value.slice(0, 10).map((v, i) => [`${prefix}[${i}]`, v] as const)
    : Object.entries(value).map(([k, v]) => [`${prefix}.${k}`, v] as const)
  if (!entries.length) return [prefix]
  return entries.flatMap(([p, v]) => jsonPaths(v, p, depth + 1))
}

// ------------------------------------------------------------- code paths

// Matches bare, relative and absolute paths, including the `file:///…` form
// Node uses in ESM stack traces.
const FRAME = /(?:file:\/\/)?(\/?(?:[\w.@~-]+\/)*[\w.@-]+\.(?:tsx?|jsx?|mjs|cjs))(?::(\d+))?(?::\d+)?/g

/** Extract file references from the exception and logs, keeping ones that exist. */
export function codePaths(root: string, run: RunResult): string[] {
  const haystack = [
    run.failure?.observed.exception ?? '',
    run.failure?.observed.body_excerpt ?? '',
    run.log_excerpt,
    ...run.steps.map((s: Observed) => `${s.exception ?? ''}\n${s.stderr ?? ''}`),
  ].join('\n')

  const found = new Map<string, string>()
  for (const match of haystack.matchAll(FRAME)) {
    const file = match[1]
    if (!file || file.includes('node_modules')) continue
    const line = match[2]
    for (const candidate of [file, path.join('src', file), path.join('app', file)]) {
      const abs = path.resolve(root, candidate)
      if (!abs.startsWith(root) || !existsSync(abs)) continue
      const rel = path.relative(root, abs)
      const display = line ? `${rel}:${line}` : rel
      if (!found.has(rel)) found.set(rel, display)
      break
    }
  }
  return [...found.values()].slice(0, 20)
}

function tail(text: string, lines = 25): string[] {
  return text.split('\n').filter(Boolean).slice(-lines)
}
