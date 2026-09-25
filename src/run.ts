/**
 * Reproduction orchestration.
 *
 * One run = setup steps -> services up -> scenario steps -> verdict -> evidence.
 * A verdict is deliberately narrow: REPRODUCED means the designated failure
 * step matched `failure.reproduce` AND every earlier step that declared an
 * `expect` still held. Without that second condition a scenario that fell over
 * for an unrelated reason would masquerade as a reproduction, and the minimizer
 * would happily delete the steps that actually matter.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  failureStepIndex,
  matchOutcome,
  stepKindOf,
  stepLabel,
  type LoadedSpec,
  type Observed,
  type Spec,
} from './spec.js'
import { changedFiles, fingerprint, git, newRunDir, type Fingerprint, type NetworkEntry, type RunDir } from './evidence.js'
import {
  assertReachable,
  closeBrowser,
  runStep,
  startServices,
  type ExecContext,
  type ServiceHandle,
} from './exec.js'
import { compactEvents, describeEvent, type EventKey } from './agent.js'
import { VERSION } from './version.js'

/**
 * Four outcomes, never three. INVALID (a precondition never held, so the
 * target condition was never reached) is not evidence that the bug is gone,
 * and ERROR (repro itself could not execute the contract) is not evidence of
 * anything at all. Collapsing either into the other lets a broken login read
 * as a fixed checkout.
 */
export type RunStatus = 'reproduced' | 'not_reproduced' | 'invalid' | 'error'

/**
 * Thrown when the system under test could not be brought to the point where
 * the failure signature is even observable: setup failed, a service never came
 * up, a precondition step did not hold. The run is INVALID, not ERROR.
 */
export class PreconditionError extends Error {}

export type FailureReport = {
  step: string
  step_index: number
  expected?: Record<string, unknown>
  observed: {
    status?: number
    exit_code?: number
    exception?: string
    error?: string
    body_excerpt?: string
    /** Agent steps: what the agent actually did, in order. */
    trajectory?: string
  }
  /** Agent steps: the whole trajectory, compact enough to seal and to diff. */
  events?: EventKey[]
  /** Why the reproduce matcher did not match (empty when it did). */
  mismatch: string[]
}

/**
 * One line of the coverage report: which layer of the execution this run
 * recorded, and how well. Evidence about the evidence — never a score,
 * because "87% reproducible" would have to invent the weights.
 */
export type CoverageItem = {
  layer: string
  status: 'captured' | 'partial' | 'uncontrolled' | 'none'
  detail: string
}

export type RunResult = {
  status: RunStatus
  run_id: string
  run_dir: string
  duration_ms: number
  steps: Observed[]
  failure?: FailureReport
  error?: string
  artifacts: string[]
  /** Every HTTP exchange this run made. Also written to network.json. */
  network: NetworkEntry[]
  /** Tail of the service/browser logs produced during this run. */
  log_excerpt: string
  /** Where this run happened. Recorded per run so two runs can be compared. */
  environment?: Fingerprint
  coverage?: CoverageItem[]
}

export type RunOptions = {
  repeat?: number
  /** Recorded in each run's fingerprint. */
  version?: string
  /**
   * The application is already running here; do not start `services:`.
   *
   * Two things it buys. A reproduction stops fighting whatever else holds the
   * port — a second gate, a dev server the developer is already using — and
   * `--repeat 100` stops being dominated by application startup, which for a
   * rate measurement is the whole cost. The spec is not edited, so the seal
   * does not move: where the app runs was never part of the bug.
   */
  baseUrl?: string
  trace?: boolean
  headed?: boolean
  timeoutMs?: number
  /** Write a numbered evidence bundle per run. Off for minimizer probes. */
  evidence?: boolean
  onPhase?: (phase: string, status: 'start' | 'pass' | 'fail', detail?: string) => void
}

export type RepeatResult = {
  name: string
  status: RunStatus
  runs: number
  /** Runs in which the bug reproduced. */
  failures: number
  /** Runs in which the application behaved. */
  successes: number
  /** Runs that never reached the failure step. Excluded from the rate. */
  invalid: number
  errors: number
  /** reproduced / (reproduced + not_reproduced). INVALID and ERROR never count. */
  reproduction_rate: number
  /** 95% Wilson interval for the observed rate, over valid runs. */
  interval: [number, number]
  classification: 'DETERMINISTIC' | 'FLAKY' | 'RARE' | 'NOT REPRODUCED'
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  failure?: FailureReport
  error?: string
  artifacts: string[]
  environment?: Fingerprint
  coverage?: CoverageItem[]
  runs_detail: { id: string; status: RunStatus; duration_ms: number }[]
}

/** Run the reproduction `repeat` times and aggregate. */
export async function runReproduction(
  loaded: LoadedSpec,
  opts: RunOptions = {},
): Promise<RepeatResult> {
  const { spec } = loaded
  const repeat = Math.max(1, opts.repeat ?? 1)
  const results: RunResult[] = []

  // Services start once per invocation unless the spec asks otherwise: a dev
  // server restart per iteration turns `--repeat 20` into a coffee break. The
  // holder is filled in by the first run, after its setup steps — starting the
  // app before `db:reset` has run is a different experiment.
  const holder: ServiceHolder | undefined =
    spec.services?.length && spec.restart_services !== true && !opts.baseUrl ? {} : undefined
  try {
    for (let i = 0; i < repeat; i++) {
      results.push(await executeOnce(loaded, opts, holder))
    }
  } catch (err) {
    return aggregate(spec, results, message(err))
  } finally {
    await holder?.handle?.stop()
  }
  return aggregate(spec, results)
}

/** Shared service slot, filled lazily so setup always runs first. */
export type ServiceHolder = { handle?: ServiceHandle }

/** Execute the scenario exactly once. */
export async function executeOnce(
  loaded: LoadedSpec,
  opts: RunOptions = {},
  holder?: ServiceHolder,
): Promise<RunResult> {
  const { spec, root, reproDir } = loaded
  const started = Date.now()
  const evidence = opts.evidence !== false
  const run = evidence ? await newRunDir(reproDir) : await scratchRunDir(reproDir)

  // The code under test, before any step touches it: commit, lockfiles, and
  // the uncommitted diff. "Reproduced against SHA X with these changes" is
  // only answerable if this was written down at the start.
  let environment: Fingerprint | undefined
  let gitTop: string | undefined
  const repoFiles: string[] = []
  if (evidence) {
    environment = await fingerprint(root, opts.version ?? VERSION)
    gitTop = (await git(root, ['rev-parse', '--show-toplevel']))?.trim() || undefined
    if (environment.git_dirty) {
      const patch = await git(root, ['diff', 'HEAD', '--', '.'])
      if (patch) repoFiles.push(await run.write('repo.patch', patch))
      const status = await git(root, ['status', '--porcelain', '--untracked-files=all', '--', '.'])
      if (status) repoFiles.push(await run.write('repo.status', status))
    }
  }

  const network: NetworkEntry[] = []
  const extraLogs: string[] = []
  let ownServices: ServiceHandle | undefined
  // Only this run's slice of a shared service's output counts as its evidence.
  let logMark = 0

  const ctx: ExecContext = {
    root,
    baseUrl: opts.baseUrl ?? spec.base_url,
    env: spec.env ?? {},
    vars: { ...spec.vars },
    run,
    network,
    serviceLogs: () => {
      const handle = holder?.handle ?? ownServices
      return `${handle ? handle.logs().slice(holder ? logMark : 0) : ''}\n${extraLogs.join('')}`
    },
    stepTimeoutMs: opts.timeoutMs ?? 30_000,
    trace: opts.trace === true,
    headed: opts.headed === true,
    onLog: (line) => extraLogs.push(`${line}\n`),
    gitTop,
  }

  const steps: Observed[] = []
  let error: string | undefined
  let unreachable = false

  try {
    // 1. Environment
    if (spec.setup?.length) {
      opts.onPhase?.('Environment', 'start')
      for (const [i, step] of spec.setup.entries()) {
        const observed = await runStep(step, i, ctx)
        if (observed.error || (observed.exit_code !== undefined && observed.exit_code !== 0)) {
          const detail = observed.error ?? `${stepLabel(step, i)} exited ${observed.exit_code}`
          opts.onPhase?.('Environment', 'fail', detail)
          throw new PreconditionError(
            `setup step failed: ${detail}\n${(observed.stderr ?? '').slice(-1000)}`,
          )
        }
      }
      opts.onPhase?.('Environment', 'pass')
    }

    // 2. Services
    if (opts.baseUrl) {
      // Told the app is already up. Confirm that before running a scenario
      // against nothing: a connection refused on every step is a precondition
      // failure, not a bug that stopped reproducing.
      opts.onPhase?.('Services', 'start')
      try {
        await assertReachable(opts.baseUrl)
      } catch (err) {
        opts.onPhase?.('Services', 'fail', message(err))
        throw new PreconditionError(message(err))
      }
      opts.onPhase?.('Services', 'pass')
    } else if (spec.services?.length) {
      if (!holder) {
        opts.onPhase?.('Services', 'start')
        try {
          ownServices = await startServices(spec.services, {
            root,
            env: spec.env ?? {},
            baseUrl: spec.base_url,
            vars: ctx.vars,
          })
        } catch (err) {
          opts.onPhase?.('Services', 'fail', message(err))
          throw new PreconditionError(`service failed to start: ${message(err)}`)
        }
        opts.onPhase?.('Services', 'pass')
      } else {
        if (!holder.handle) {
          opts.onPhase?.('Services', 'start')
          try {
            holder.handle = await startServices(spec.services, {
              root,
              env: spec.env ?? {},
              baseUrl: spec.base_url,
              vars: ctx.vars,
            })
          } catch (err) {
            opts.onPhase?.('Services', 'fail', message(err))
            throw new PreconditionError(`service failed to start: ${message(err)}`)
          }
          opts.onPhase?.('Services', 'pass')
        }
        logMark = holder.handle.logs().length
      }
    }

    // 3. Scenario
    opts.onPhase?.('Scenario', 'start')
    for (const [i, step] of spec.scenario.entries()) {
      const observed = await runStep(step, i, ctx)
      steps.push(observed)
      if (spec.stop_on_expect_fail && observed.expect_failed) break
    }
    opts.onPhase?.('Scenario', 'pass')
  } catch (err) {
    error = message(err)
    unreachable = err instanceof PreconditionError
  } finally {
    await closeBrowser(ctx)
    for (const step of spec.teardown ?? []) {
      await runStep(step, 0, ctx).catch(() => undefined)
    }
    await ownServices?.writeLogs(run).catch(() => undefined)
    await ownServices?.stop()
  }

  const logs = ctx.serviceLogs()
  const verdict = evaluate(spec, steps, logs, error, unreachable)
  const result: RunResult = {
    status: verdict.status,
    run_id: run.id,
    run_dir: run.dir,
    duration_ms: Date.now() - started,
    steps,
    failure: verdict.failure,
    error: error ?? verdict.error,
    artifacts: [],
    network,
    log_excerpt: logs.slice(-8000),
    environment,
  }
  if (evidence) result.coverage = coverage(spec, result, opts, Boolean(gitTop))

  if (holder?.handle) {
    await writeFile(run.file('service.log'), holder.handle.logs().slice(logMark)).catch(() => {})
  }
  if (extraLogs.length) await run.write('browser.log', extraLogs.join(''))
  if (network.length) await run.write('network.json', JSON.stringify(network, null, 2))
  result.artifacts = [
    run.file('result.json'),
    ...(network.length ? [run.file('network.json')] : []),
    ...repoFiles,
    ...steps.flatMap((s) => s.screenshots ?? []),
    ...steps.flatMap((s) => s.artifacts ?? []),
  ]
  // network lives in network.json; duplicating it into result.json doubles the
  // bundle for no gain.
  const { network: _omit, ...onDisk } = result
  await run.write('result.json', JSON.stringify(onDisk, null, 2))
  return result
}

// ----------------------------------------------------------------- verdict

function evaluate(
  spec: Spec,
  steps: Observed[],
  logs: string,
  hardError: string | undefined,
  unreachable = false,
): { status: RunStatus; failure?: FailureReport; error?: string } {
  if (hardError) return { status: unreachable ? 'invalid' : 'error', error: hardError }

  let failIdx: number
  try {
    failIdx = failureStepIndex(spec)
  } catch (err) {
    return { status: 'error', error: message(err) }
  }

  const observed = steps[failIdx]
  if (!observed) {
    return {
      status: 'invalid',
      error: `scenario stopped before reaching the failure step (${failIdx + 1}/${spec.scenario.length})`,
    }
  }

  // Preconditions: an earlier step that declared `expect` must still hold,
  // otherwise this run never reached the state the bug needs.
  for (let i = 0; i < failIdx; i++) {
    const prior = steps[i]
    if (prior?.expect_failed) {
      return {
        status: 'invalid',
        error: `precondition failed at step ${i + 1} (${prior.label}): ${prior.expect_failed.join('; ')}`,
      }
    }
  }

  const match = matchOutcome(spec.failure.reproduce, observed, logs)
  const report: FailureReport = {
    step: observed.label,
    step_index: failIdx + 1,
    expected: spec.failure.expect as Record<string, unknown> | undefined,
    observed: {
      status: observed.status,
      exit_code: observed.exit_code,
      exception: observed.exception,
      error: observed.error,
      body_excerpt: excerpt(observed.body),
      trajectory: trajectory(observed),
    },
    events: observed.trace?.events.length ? compactEvents(observed.trace.events) : undefined,
    mismatch: match.reasons,
  }
  return { status: match.ok ? 'reproduced' : 'not_reproduced', failure: report }
}

/** A trace is evidence; a verdict without it says nothing about what happened. */
function trajectory(observed: Observed): string | undefined {
  const events = observed.trace?.events
  if (!events?.length) return undefined
  const shown = events.slice(0, 12).map(describeEvent)
  if (events.length > shown.length) shown.push(`… ${events.length - shown.length} more`)
  return shown.join(' → ')
}

// ---------------------------------------------------------------- coverage

/**
 * Which layers of this execution the run recorded, which it could only see
 * in part, and which it does not control. Derived from what the run
 * actually produced, so a layer is "captured" because the file is there,
 * not because the feature exists.
 */
export function coverage(spec: Spec, result: RunResult, opts: RunOptions, inRepo: boolean): CoverageItem[] {
  const items: CoverageItem[] = []
  const add = (layer: string, status: CoverageItem['status'], detail: string) => items.push({ layer, status, detail })
  const kinds = new Set([...(spec.setup ?? []), ...spec.scenario, ...(spec.teardown ?? [])].map(stepKindOf))
  const runsProcesses = kinds.has('shell') || kinds.has('agent')
  const env = result.environment
  const n = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

  if (env?.git_commit) {
    add('repository state', 'captured', `git ${env.git_commit}${env.git_dirty ? ', uncommitted changes in repo.patch' : ''}`)
  } else add('repository state', 'uncontrolled', 'not a git repository')

  if (runsProcesses) {
    const observed = result.steps.filter((s) => s.files)
    if (!inRepo) add('filesystem mutations', 'none', 'not observed — the project root is not a git repository')
    else {
      const files = new Set(observed.flatMap((s) => changedFiles(s.files!)))
      add(
        'filesystem mutations',
        'captured',
        files.size ? `${n(files.size, 'file')} changed across ${n(observed.filter((s) => changedFiles(s.files!).length).length, 'step')}` : 'no files changed',
      )
    }
    add('subprocesses', 'partial', 'exit codes and output captured; process trees are not observed')
  }

  const agentSteps = spec.scenario.map((s, i) => [s, i] as const).filter(([s]) => s.agent)
  if (agentSteps.length) {
    const replayed = agentSteps.map(([s]) => s.agent!.replay).filter(Boolean)
    const events = result.steps.flatMap((s) => s.trace?.events ?? [])
    const models = events.filter((e) => e.type === 'model')
    const answered = models.filter((e) => e.output !== undefined)
    if (replayed.length) {
      add('model responses', 'captured', `replayed from ${replayed.join(', ')} — the agent honours REPRO_REPLAY, repro only sets it`)
    }
    else if (answered.length) add('model responses', 'captured', `${n(answered.length, 'model response')} recorded in traces/`)
    else if (models.length) add('model responses', 'partial', `${n(models.length, 'model event')} recorded without responses`)
    else add('model responses', 'none', 'the agent emitted no model events')
    const mcp = events.filter((e) => e.server)
    if (mcp.length) add('MCP', 'partial', `${n(mcp.length, 'MCP call')} recorded; servers are not managed by repro`)
  }

  if (kinds.has('http') || kinds.has('browser') || result.network.length) {
    add('HTTP responses', 'captured', `${n(result.network.length, 'exchange')} repro drove, in network.json`)
  }
  if (runsProcesses || spec.services?.length) {
    add('outbound network', 'uncontrolled', 'calls the application or agent makes are not recorded')
  }

  add('environment', 'captured', 'os, runtime and lockfiles fingerprinted; environment variables never recorded')
  add('randomness', 'partial', 'time and randomness are not controlled; --repeat measures the rate')

  if (kinds.has('http') || kinds.has('browser')) {
    const url = opts.baseUrl ?? spec.base_url
    if (opts.baseUrl || !spec.services?.length) {
      add('application', 'uncontrolled', url ? `${url} is not managed by repro` : 'no services declared')
    } else {
      add('application', 'captured', `started by repro: ${spec.services.map((s) => s.name ?? s.command).join(', ')}`)
    }
  }
  return items
}

function excerpt(body: string | undefined, max = 400): string | undefined {
  if (!body) return undefined
  const trimmed = body.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

// --------------------------------------------------------------- aggregate

export function aggregate(spec: Spec, results: RunResult[], fatal?: string): RepeatResult {
  const failures = results.filter((r) => r.status === 'reproduced').length
  const successes = results.filter((r) => r.status === 'not_reproduced').length
  const invalid = results.filter((r) => r.status === 'invalid').length
  const errors = results.filter((r) => r.status === 'error').length
  const valid = failures + successes
  const rate = valid === 0 ? 0 : failures / valid

  // With no valid run there is no measurement, so the aggregate reports why
  // rather than pretending the bug is gone.
  const status: RunStatus =
    failures > 0
      ? 'reproduced'
      : valid > 0
        ? 'not_reproduced'
        : invalid > 0
          ? 'invalid'
          : 'error'

  const reproduced = results.find((r) => r.status === 'reproduced')
  const anyFailure = reproduced ?? results.find((r) => r.failure)

  return {
    name: spec.name,
    status,
    runs: results.length,
    failures,
    successes,
    invalid,
    errors,
    reproduction_rate: Number(rate.toFixed(4)),
    interval: wilson(failures, valid),
    classification: classify(rate, valid),
    confidence: confidenceOf(rate, valid),
    failure: anyFailure?.failure,
    error: fatal ?? results.find((r) => r.error)?.error,
    artifacts: (reproduced ?? results.at(-1))?.artifacts ?? [],
    environment: (reproduced ?? results.at(-1))?.environment,
    coverage: (reproduced ?? results.at(-1))?.coverage,
    runs_detail: results.map((r) => ({ id: r.run_id, status: r.status, duration_ms: r.duration_ms })),
  }
}

/**
 * 95% Wilson score interval. Reported instead of a bare percentage because
 * "3/10 reproduced" and "300/1000 reproduced" are not the same measurement,
 * and a fix that moves 30% to 20% on ten runs has moved nothing.
 */
export function wilson(successes: number, trials: number): [number, number] {
  if (trials === 0) return [0, 0]
  const z = 1.959964
  const p = successes / trials
  const d = 1 + (z * z) / trials
  const centre = p + (z * z) / (2 * trials)
  const spread = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))
  const lo = Math.max(0, (centre - spread) / d)
  const hi = Math.min(1, (centre + spread) / d)
  return [Number(lo.toFixed(4)), Number(hi.toFixed(4))]
}

export function classify(rate: number, validRuns: number): RepeatResult['classification'] {
  if (validRuns === 0 || rate === 0) return 'NOT REPRODUCED'
  if (rate === 1) return 'DETERMINISTIC'
  if (rate >= 0.5) return 'FLAKY'
  return 'RARE'
}

/**
 * Confidence is about the *measurement*, not the bug: one green run says very
 * little, twenty consistent runs say a lot.
 */
export function confidenceOf(rate: number, validRuns: number): RepeatResult['confidence'] {
  const consistency = Math.max(rate, 1 - rate)
  if (validRuns >= 5 && consistency >= 0.9) return 'HIGH'
  if (validRuns >= 3 && consistency === 1) return 'HIGH'
  if (validRuns >= 3 && consistency >= 0.7) return 'MEDIUM'
  if (validRuns >= 2) return 'MEDIUM'
  return 'LOW'
}

async function scratchRunDir(reproDir: string): Promise<RunDir> {
  const dir = path.join(reproDir, 'runs', 'scratch')
  await mkdir(dir, { recursive: true })
  return {
    dir,
    id: 'scratch',
    file: (...parts: string[]) => path.join(dir, ...parts),
    async write(rel, data) {
      const target = path.join(dir, rel)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, data)
      return target
    },
  }
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
