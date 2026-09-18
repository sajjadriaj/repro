/**
 * The completion gate, native to Claude Code.
 *
 * A Stop hook runs when the agent believes it is finished, which is the one
 * moment worth interrupting. repro answers "not yet" with the measurement
 * attached, and the agent reads the reason as its next instruction.
 *
 * Nothing here reads the agent's transcript or judges its work. The
 * reproduction runs; the outcome decides.
 *
 * ## The polarity, and why the seal picks it
 *
 * repro is used for two opposite jobs and the gate has to know which one is in
 * progress. While the reproduction is being compiled the agent is trying to
 * MAKE the bug happen, so a run that does not reproduce is the unfinished
 * state. Once the bug is fixed the agent is trying to make it STOP, so a run
 * that reproduces is the unfinished state. Blocking on the wrong one would
 * fight the agent for the whole budget.
 *
 * The seal already records which job this is. `repro establish && repro seal`
 * is by definition performed while the bug still reproduces, so:
 *
 *   no seal  ->  gate wants REPRODUCED      (finish compiling it)
 *   sealed   ->  gate wants NOT REPRODUCED  (keep it fixed)
 *
 * ## What never gates
 *
 * An `invalid` or `error` run is untestable, not a verdict: a precondition
 * failed or a service never came up, so the bug was neither reproduced nor
 * disproven. Blocking a stop over a dead port spends the whole budget on the
 * environment.
 *
 * An edited contract does not gate either. An agent that cannot keep the bug
 * fixed can edit the bug instead — declining to gate makes that visible in the
 * transcript rather than making it a wall to climb.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { findReproDir, loadSpec, REPRO_DIR, SPEC_FILE, type LoadedSpec } from './spec.js'
import { runReproduction, type RepeatResult } from './run.js'
import { status } from './seal.js'

const SETTINGS = path.join('.claude', 'settings.json')
const STATE_FILE = 'hook-state.json'
const FEEDBACK_FILE = 'feedback.md'

/** How many times the gate refuses a stop before letting the agent go. */
export const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Bounded, and far above Claude Code's 60-second default: a reproduction that
 * boots an application and repeats it three times is routinely longer than
 * that, and a hook killed mid-run lets the agent stop with no verdict at all —
 * the one outcome the gate exists to prevent.
 */
export const HOOK_TIMEOUT_SEC = 900

export type HookOptions = {
  maxAttempts?: number
  specPath?: string
  root?: string
  baseUrl?: string
  repeat?: number
  timeoutMs?: number
}

export const hookEntry = (maxAttempts = DEFAULT_MAX_ATTEMPTS, specPath?: string) => ({
  hooks: [
    {
      type: 'command',
      command: `repro hook --max-attempts ${maxAttempts}${specPath ? ` --spec ${specPath}` : ''}`,
      timeout: HOOK_TIMEOUT_SEC,
    },
  ],
})

export const snippet = (maxAttempts?: number, specPath?: string): string =>
  JSON.stringify({ hooks: { Stop: [hookEntry(maxAttempts, specPath)] } }, null, 2)

export class HookError extends Error {}

const isOurs = (entry: unknown): boolean =>
  ((entry as { hooks?: { command?: unknown }[] })?.hooks ?? []).some(
    (h) => typeof h?.command === 'string' && /^repro hook\b/.test(h.command),
  )

/**
 * Add the Stop hook to the project's Claude Code settings.
 *
 * Merged, never overwritten: the file is the user's and holds every other hook
 * and permission they configured. A file that will not parse is refused rather
 * than replaced — settings repro rewrote are settings repro now owns.
 */
export function install(opts: HookOptions = {}): { path: string; added: boolean } {
  let settings: Record<string, unknown> = {}
  if (existsSync(SETTINGS)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(SETTINGS, 'utf8'))
    } catch (e) {
      throw new HookError(
        `${SETTINGS} is not valid JSON (${(e as Error).message}) — fix it, or add the hook by hand:\n${snippet(
          opts.maxAttempts,
          opts.specPath,
        )}`,
      )
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HookError(`${SETTINGS} is not a JSON object`)
    }
    settings = parsed as Record<string, unknown>
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>
  const stop = Array.isArray(hooks.Stop) ? [...(hooks.Stop as unknown[])] : []
  const already = stop.some(isOurs)
  if (!already) stop.push(hookEntry(opts.maxAttempts, opts.specPath))
  settings.hooks = { ...hooks, Stop: stop }
  mkdirSync(path.dirname(SETTINGS), { recursive: true })
  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`)
  return { path: SETTINGS, added: !already }
}

// ------------------------------------------------------------------ the gate

type State = { attempts?: number }

const stateFile = (reproDir: string) => path.join(reproDir, STATE_FILE)

function readState(reproDir: string): State {
  try {
    return JSON.parse(readFileSync(stateFile(reproDir), 'utf8')) as State
  } catch {
    return {}
  }
}

function clearState(reproDir: string): void {
  try {
    rmSync(stateFile(reproDir))
  } catch {
    /* never existed */
  }
}

/** Exit 0 and print nothing: the agent may stop. */
function allow(reason?: string): number {
  if (reason) process.stderr.write(`repro: ${reason}\n`)
  return 0
}

/** Exit 0 and print a block decision: Claude Code hands `reason` to the agent. */
function block(reason: string): number {
  process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`)
  return 0
}

export async function stopHook(opts: HookOptions = {}): Promise<number> {
  // Consumed so the pipe closes. Nothing in it changes the decision.
  try {
    readFileSync(0, 'utf8')
  } catch {
    /* no stdin */
  }

  // No reproduction, no opinion. Installed globally this runs in every project,
  // and most of them have nothing for it to enforce.
  const specPath = opts.specPath ?? (findReproDir(opts.root) ? undefined : null)
  if (specPath === null) return allow()

  let loaded: LoadedSpec
  try {
    loaded = await loadSpec(opts.specPath, opts.root)
  } catch (e) {
    return allow(`the reproduction cannot be run — ${(e as Error).message.split('\n')[0]}`)
  }

  const state = await status(loaded, 'hook')
  if (state.contract === 'MODIFIED' || state.fixtures === 'MODIFIED') {
    return allow(
      'the reproduction has changed since it was sealed, so no run can be compared against the ' +
        'baseline — not gating this stop. `repro status` shows what moved.',
    )
  }

  const wantReproduced = !state.sealed
  const repeat = opts.repeat ?? loaded.spec.verify?.trials ?? 3
  const result = await runReproduction(loaded, {
    repeat,
    baseUrl: opts.baseUrl,
    timeoutMs: opts.timeoutMs,
    evidence: true,
  })

  if (result.status === 'invalid' || result.status === 'error') {
    return allow(
      `the reproduction could not be executed (${result.status}${
        result.error ? `: ${result.error.split('\n')[0]}` : ''
      }) — not gating this stop`,
    )
  }

  const satisfied = wantReproduced ? result.failures > 0 : result.failures === 0
  if (satisfied) {
    clearState(loaded.reproDir)
    return allow(
      wantReproduced
        ? `the bug reproduces — ${result.failures}/${result.runs}. Next: repro establish && repro seal`
        : `the bug stays fixed — 0/${result.runs} reproduced`,
    )
  }

  const attempt = (readState(loaded.reproDir).attempts ?? 0) + 1
  const feedback = renderFeedback(loaded, result, wantReproduced, attempt, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  mkdirSync(loaded.reproDir, { recursive: true })
  writeFileSync(path.join(loaded.reproDir, FEEDBACK_FILE), feedback)

  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  if (attempt > maxAttempts) {
    // The override, and the only one besides editing the settings. Let it stop,
    // say why, and leave the evidence where the next reader will look. The
    // counter resets so the next session starts its own budget.
    clearState(loaded.reproDir)
    return allow(
      `${
        wantReproduced ? 'the bug still does not reproduce' : 'the bug still reproduces'
      } after ${maxAttempts} attempt(s) — letting the agent stop. Evidence: ${path.join(
        REPRO_DIR,
        FEEDBACK_FILE,
      )}`,
    )
  }
  writeFileSync(stateFile(loaded.reproDir), `${JSON.stringify({ attempts: attempt })}\n`)
  return block(feedback)
}

function renderFeedback(
  loaded: LoadedSpec,
  result: RepeatResult,
  wantReproduced: boolean,
  attempt: number,
  maxAttempts: number,
): string {
  const spec = path.join(REPRO_DIR, SPEC_FILE)
  const lines = [
    `# ${wantReproduced ? 'Not reproduced yet' : 'The bug is back'} (attempt ${attempt} of ${maxAttempts})`,
    '',
    `Reproduction: ${loaded.spec.name}`,
    loaded.spec.description ? `\n> ${loaded.spec.description.trim()}\n` : '',
  ]

  if (wantReproduced) {
    lines.push(
      'The scenario ran and the failure signature did not match, so there is still no',
      'executable reproduction of this bug. This is not a passing test — it is an',
      'unfinished one. Do not fix anything yet.',
      '',
      `- Ran ${result.runs} time(s); ${result.successes} behaved, ${result.failures} reproduced.`,
      ...(result.failure?.mismatch.length
        ? ['', 'What did not match:', ...result.failure.mismatch.map((m) => `- ${m}`)]
        : []),
      '',
      `Read the code path the report implicates, then edit \`scenario:\` in ${spec} until`,
      '`repro run` prints FAILURE REPRODUCED. If the signature in `failure.reproduce` is',
      'wrong, fix that instead — a matcher nothing can satisfy is the more common mistake.',
    )
  } else {
    lines.push(
      'This bug is sealed: it was measured while it was real, and it is happening again.',
      'That makes this a regression, not a flake.',
      '',
      `- Reproduced ${result.failures} of ${result.runs} run(s) — ${result.classification}.`,
      ...(result.failure
        ? [
            '',
            `Step: ${result.failure.step}`,
            ...(result.failure.expected ? [`Expected: ${JSON.stringify(result.failure.expected)}`] : []),
            `Observed: ${JSON.stringify(result.failure.observed)}`,
          ]
        : []),
      '',
      `The definition of the bug is in ${spec} and is sealed — fix the code, not the contract.`,
    )
  }
  lines.push('', `Evidence: ${result.artifacts.join(', ') || path.join(REPRO_DIR, 'runs')}`)
  return lines.join('\n')
}
