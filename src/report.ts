/** Human-readable rendering. Agent-readable output goes through --json. */
import path from 'node:path'
import type { RepeatResult } from './run.js'
import type { MinimizeResult } from './minimize.js'
import type { ExplainReport } from './explain.js'

const useColor =
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb'

const paint = (code: string) => (text: string) => (useColor ? `[${code}m${text}[0m` : text)
export const bold = paint('1')
export const dim = paint('2')
export const red = paint('31')
export const green = paint('32')
export const yellow = paint('33')
export const cyan = paint('36')

export function field(label: string, value: string): string {
  return `${label}\n  ${value.split('\n').join('\n  ')}`
}

export function phaseLine(name: string, status: 'pass' | 'fail' | 'start'): string {
  const badge = status === 'pass' ? green('PASS') : status === 'fail' ? red('FAIL') : dim('....')
  return `${name.padEnd(20)}${badge}`
}

export function renderRun(result: RepeatResult, cwd = process.cwd()): string {
  const lines: string[] = []
  const verdict =
    result.status === 'reproduced'
      ? red(bold('FAILURE REPRODUCED'))
      : result.status === 'error'
        ? yellow(bold('RUN ERROR'))
        : green(bold('NOT REPRODUCED'))
  lines.push('', verdict)

  if (result.error && result.status === 'error') lines.push(field('Error:', result.error))

  const f = result.failure
  if (f) {
    lines.push(field('Step:', f.step))
    if (f.expected) lines.push(field('Expected:', describeMatcher(f.expected)))
    lines.push(field('Observed:', describeObserved(f)))
    if (f.observed.exception) lines.push(field('Exception:', f.observed.exception))
    if (result.status === 'not_reproduced' && f.mismatch.length) {
      lines.push(field('Why not:', f.mismatch.join('\n')))
    }
  }

  if (result.runs > 1) {
    lines.push(
      field(
        'Runs:',
        [
          `${result.runs} total`,
          `${result.failures} reproduced`,
          `${result.successes} passed`,
          ...(result.errors ? [`${result.errors} errored`] : []),
        ].join('\n'),
      ),
    )
    lines.push(field('Reproduction rate:', `${Math.round(result.reproduction_rate * 100)}%`))
    lines.push(field('Classification:', classificationColor(result)))
  } else {
    lines.push(field('Reproduction:', `${result.failures} / ${result.failures + result.successes} runs`))
  }
  lines.push(field('Confidence:', result.confidence))

  if (result.artifacts.length) {
    const dir = path.relative(cwd, path.dirname(result.artifacts[0]!)) || '.'
    lines.push(field('Evidence:', `${dir}${path.sep}`))
  }
  return lines.join('\n')
}

function classificationColor(result: RepeatResult): string {
  switch (result.classification) {
    case 'DETERMINISTIC':
      return red('DETERMINISTIC')
    case 'FLAKY':
      return yellow('FLAKY')
    case 'RARE':
      return yellow('RARE')
    default:
      return green('NOT REPRODUCED')
  }
}

export function describeMatcher(m: Record<string, unknown>): string {
  return Object.entries(m)
    .map(([k, v]) => (k === 'status' ? String(v) : `${k}: ${JSON.stringify(v)}`))
    .join('\n')
}

function describeObserved(f: NonNullable<RepeatResult['failure']>): string {
  const parts: string[] = []
  if (f.observed.status !== undefined) parts.push(String(f.observed.status))
  if (f.observed.exit_code !== undefined) parts.push(`exit ${f.observed.exit_code}`)
  if (f.observed.error) parts.push(f.observed.error)
  if (!parts.length && f.observed.body_excerpt) parts.push(f.observed.body_excerpt.slice(0, 200))
  return parts.join('\n') || '(nothing observed)'
}

export function renderMinimize(result: MinimizeResult): string {
  const lines: string[] = []
  lines.push('', field('Original:', `${result.original_steps} steps`))
  lines.push(field('Reducing:', result.progress.join(' → ')))
  lines.push(
    field(
      'Minimal reproduction:',
      result.labels.map((l, i) => `${String(i + 1).padStart(2)}. ${l}`).join('\n'),
    ),
  )
  lines.push(
    field(
      'Failure reproduced:',
      `${result.confirmed.reproduced} / ${result.confirmed.runs}${
        result.confirmed.reproduced < result.confirmed.runs ? yellow('  (unstable — raise --confirm)') : ''
      }`,
    ),
  )
  lines.push(field('Probes:', `${result.probes} runs`))
  return lines.join('\n')
}

export function renderExplain(report: ExplainReport): string {
  const lines: string[] = []
  if (report.status !== 'reproduced') {
    lines.push('', yellow(bold('NO FAILURE TO EXPLAIN')))
    for (const note of report.notes) lines.push(field('Note:', note))
  } else {
    lines.push('', bold('Failure boundary identified.'))
    if (report.failure_step) lines.push(field('Failure observed at:', report.failure_step))
    if (report.boundary) {
      lines.push(field('Failure becomes observable after:', report.boundary.label))
    }
  }

  if (report.required.length) lines.push(field('Required steps:', report.required.join('\n')))
  if (report.irrelevant.length) {
    lines.push(field('Not required:', dim(report.irrelevant.join('\n'))))
  }
  const probe = report.state_diff.filter((d) => d.source === 'probe')
  const response = report.state_diff.filter((d) => d.source === 'response')
  const renderDiff = (d: (typeof report.state_diff)[number]) =>
    `${d.where} ${cyan(d.path)}\n  before: ${JSON.stringify(d.without_step)}\n  after:  ${JSON.stringify(d.with_step)}`

  if (probe.length) {
    lines.push(field('State difference (caused by the boundary step):', probe.slice(0, 12).map(renderDiff).join('\n')))
  }
  if (response.length) {
    lines.push(field('Response difference (with vs without the boundary step):', response.slice(0, 12).map(renderDiff).join('\n')))
  }
  if (report.nondeterministic_fields.length) {
    lines.push(
      field('Ignored as run-to-run noise:', dim(report.nondeterministic_fields.join(', '))),
    )
  }
  if (report.relevant_requests.length) {
    lines.push(
      field(
        'Relevant requests:',
        report.relevant_requests
          .map((r) => `${r.method.padEnd(6)}${r.url}${r.status ? `  → ${r.status}` : ''}`)
          .join('\n'),
      ),
    )
  }
  if (report.relevant_code_paths.length) {
    lines.push(field('Relevant code paths:', report.relevant_code_paths.join('\n')))
  }
  if (report.exception) lines.push(field('Exception:', report.exception))
  if (report.log_tail.length) {
    lines.push(field('Log tail:', dim(report.log_tail.slice(-10).join('\n'))))
  }
  lines.push(
    '',
    dim('repro reports where behaviour diverges. Diagnosing why is the agent’s job.'),
  )
  return lines.join('\n')
}
