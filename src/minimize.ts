/**
 * Delta minimization.
 *
 * Repeatedly drop steps and re-run. A step survives only if removing it stops
 * the bug from reproducing. What's left is the shortest sequence repro could
 * prove still triggers the failure — which is the search space the coding
 * agent actually has to reason about.
 */
import {
  dumpSpec,
  failureStepIndex,
  stepLabel,
  type LoadedSpec,
  type Spec,
  type Step,
} from './spec.js'
import { executeOnce, type RepeatResult, type RunResult, type ServiceHolder } from './run.js'

export type Prober = {
  /** Does the scenario made of these scenario indices still reproduce? Cached. */
  test(indices: number[]): Promise<ProbeOutcome>
  /** One uncached execution — used for verification, where the cache would lie. */
  testOnce(indices: number[], opts?: { evidence?: boolean }): Promise<RunResult>
  /**
   * Run an arbitrary step sequence: order is preserved and repeats are allowed,
   * so callers can append state probes. Used by explain, not by minimization.
   */
  runOrdered(indices: number[]): Promise<RunResult>
  /** Scenario indices the minimizer is allowed to remove. */
  removable: number[]
  failureIndex: number
  all: number[]
  close(): Promise<void>
}

export type ProbeOutcome = {
  reproduced: boolean
  runs: RunResult[]
}

export type ProberOptions = {
  /** Runs per probe; every run must reproduce for the removal to be accepted. */
  confirm?: number
  timeoutMs?: number
  onProbe?: (indices: number[], outcome: ProbeOutcome) => void
}

export async function makeProber(loaded: LoadedSpec, opts: ProberOptions = {}): Promise<Prober> {
  const { spec } = loaded
  const failureIndex = failureStepIndex(spec)
  const all = spec.scenario.map((_, i) => i)
  const removable = all.filter((i) => i !== failureIndex && spec.scenario[i]?.keep !== true)
  const confirm = Math.max(1, opts.confirm ?? 1)
  const cache = new Map<string, ProbeOutcome>()

  // Probes share one application instance — booting a dev server per probe
  // would make minimization take longer than reading the code.
  const holder: ServiceHolder | undefined =
    spec.services?.length && spec.restart_services !== true ? {} : undefined

  const once = (indices: number[], runOpts: { evidence?: boolean } = {}): Promise<RunResult> =>
    executeOnce(
      { ...loaded, spec: sliceSpec(spec, indices, failureIndex) },
      { evidence: runOpts.evidence ?? false, timeoutMs: opts.timeoutMs },
      holder,
    )

  return {
    all,
    removable,
    failureIndex,
    testOnce: once,
    runOrdered: (indices) =>
      executeOnce(
        { ...loaded, spec: orderedSpec(spec, indices) },
        { evidence: false, timeoutMs: opts.timeoutMs },
        holder,
      ),
    async test(indices) {
      const key = indices.join(',')
      const hit = cache.get(key)
      if (hit) return hit
      const runs: RunResult[] = []
      let reproduced = true
      for (let i = 0; i < confirm; i++) {
        const result = await once(indices)
        runs.push(result)
        if (result.status !== 'reproduced') {
          reproduced = false
          break // No point confirming a candidate that already failed once.
        }
      }
      const outcome: ProbeOutcome = { reproduced, runs }
      cache.set(key, outcome)
      opts.onProbe?.(indices, outcome)
      return outcome
    },
    async close() {
      await holder?.handle?.stop()
    },
  }
}

/** Build a spec containing only `indices`, with `failure.step` re-anchored. */
export function sliceSpec(spec: Spec, indices: number[], failureIndex: number): Spec {
  const ordered = [...indices].sort((a, b) => a - b)
  const scenario = ordered.map((i) => spec.scenario[i]).filter(Boolean) as Step[]
  const position = ordered.indexOf(failureIndex)
  return {
    ...spec,
    scenario,
    failure: { ...spec.failure, step: position >= 0 ? position + 1 : scenario.length },
  }
}

/** Like sliceSpec, but keeps the caller's order and allows repeated steps. */
export function orderedSpec(spec: Spec, indices: number[]): Spec {
  const scenario = indices.map((i) => spec.scenario[i]).filter(Boolean) as Step[]
  return { ...spec, scenario, failure: { ...spec.failure, step: scenario.length } }
}

export type MinimizeResult = {
  original_steps: number
  minimal_steps: number
  kept: number[]
  removed: number[]
  spec: Spec
  /** Step-count after each accepted reduction, e.g. [18, 14, 10, 7, 5, 4]. */
  progress: number[]
  probes: number
  confirmed: { runs: number; reproduced: number }
  labels: string[]
}

export type MinimizeOptions = ProberOptions & {
  /** Final verification runs on the minimal scenario. */
  verify?: number
  onProgress?: (message: string) => void
}

export async function minimize(
  loaded: LoadedSpec,
  opts: MinimizeOptions = {},
): Promise<MinimizeResult> {
  const { spec } = loaded
  let probes = 0
  const prober = await makeProber(loaded, {
    ...opts,
    onProbe: (indices, outcome) => {
      probes++
      opts.onProbe?.(indices, outcome)
    },
  })

  try {
    let current = [...prober.all]
    const progress = [current.length]

    const baseline = await prober.test(current)
    if (!baseline.reproduced) {
      throw new Error(
        'the full scenario does not reproduce, so there is nothing to minimize.\n' +
          'run `repro run` first and make the reproduction reliable.',
      )
    }

    // Coarse pass: drop contiguous blocks. On a long recorded journey most of
    // the prefix is navigation noise and goes in a handful of probes.
    for (let granularity = 2; granularity <= 8; granularity *= 2) {
      let progressed = true
      while (progressed) {
        progressed = false
        const size = Math.floor(current.length / granularity)
        if (size < 1) break
        for (let start = 0; start + size <= current.length; start += size) {
          const block = current.slice(start, start + size)
          if (block.some((i) => !prober.removable.includes(i))) continue
          const candidate = current.filter((i) => !block.includes(i))
          if (candidate.length === current.length) continue
          if ((await prober.test(candidate)).reproduced) {
            current = candidate
            progress.push(current.length)
            opts.onProgress?.(
              `removed ${block.length} step${block.length === 1 ? '' : 's'} → ${current.length}`,
            )
            progressed = true
            break
          }
        }
      }
    }

    // Fine pass: one step at a time, last to first, until nothing else goes.
    // ponytail: greedy, not full ddmin. Removing one step can unlock another,
    // so we loop until stable — that catches the common cases without the
    // quadratic probe count. Swap in ddmin if a real scenario resists.
    let changed = true
    while (changed) {
      changed = false
      for (const index of [...current].reverse()) {
        if (!prober.removable.includes(index)) continue
        const candidate = current.filter((i) => i !== index)
        if ((await prober.test(candidate)).reproduced) {
          current = candidate
          progress.push(current.length)
          opts.onProgress?.(`removed step ${index + 1} → ${current.length}`)
          changed = true
          break
        }
      }
    }

    // Final verification: prove the minimal scenario holds up repeatedly.
    // Uncached on purpose — a cached "yes" proves nothing about run 2..N.
    const verify = Math.max(1, opts.verify ?? 3)
    let reproduced = 0
    for (let i = 0; i < verify; i++) {
      const result = await prober.testOnce(current)
      if (result.status === 'reproduced') reproduced++
    }

    const minimalSpec = sliceSpec(spec, current, prober.failureIndex)
    return {
      original_steps: spec.scenario.length,
      minimal_steps: current.length,
      kept: current,
      removed: prober.all.filter((i) => !current.includes(i)),
      spec: minimalSpec,
      progress: dedupeConsecutive(progress),
      probes,
      confirmed: { runs: verify, reproduced },
      labels: minimalSpec.scenario.map((step, i) => stepLabel(step, i)),
    }
  } finally {
    await prober.close()
  }
}

function dedupeConsecutive(values: number[]): number[] {
  return values.filter((v, i) => i === 0 || v !== values[i - 1])
}

export function minimizedYaml(result: MinimizeResult): string {
  return dumpSpec(result.spec)
}

export type { RepeatResult }
