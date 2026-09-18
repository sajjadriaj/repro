#!/usr/bin/env node
/** repro — turn any bug report into a reproduction your coding agent can run. */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dumpSpec, loadSpec, SpecError, type LoadedSpec } from './spec.js'
import { runReproduction, type RepeatResult } from './run.js'
import { minimize } from './minimize.js'
import { explain } from './explain.js'
import { bisect } from './bisect.js'
import { establish, seal, SealError, verify } from './seal.js'
import { detectProject, importEvidence, scaffold, type Imported } from './compile.js'
import {
  bold,
  cyan,
  dim,
  green,
  phaseLine,
  red,
  renderEstablish,
  renderExplain,
  renderMinimize,
  renderRun,
  renderSeal,
  renderVerify,
  yellow,
} from './report.js'

const VERSION = '0.1.0'

const OPTIONS = {
  json: { type: 'boolean' as const, default: false },
  repeat: { type: 'string' as const },
  confirm: { type: 'string' as const },
  verify: { type: 'string' as const },
  timeout: { type: 'string' as const },
  spec: { type: 'string' as const },
  root: { type: 'string' as const },
  out: { type: 'string' as const },
  from: { type: 'string' as const },
  good: { type: 'string' as const },
  bad: { type: 'string' as const },
  test: { type: 'boolean' as const, default: false },
  write: { type: 'boolean' as const, default: false },
  force: { type: 'boolean' as const, default: false },
  trace: { type: 'boolean' as const, default: false },
  headed: { type: 'boolean' as const, default: false },
  quiet: { type: 'boolean' as const, default: false },
  'exit-code': { type: 'boolean' as const, default: false },
  help: { type: 'boolean' as const, short: 'h', default: false },
  version: { type: 'boolean' as const, short: 'v', default: false },
}

type Flags = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K] extends { type: 'boolean' } ? boolean : string
}

async function main(argv: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (err) {
    process.stderr.write(`${red('error:')} ${(err as Error).message}\n\nrun \`repro help\` for usage.\n`)
    return 2
  }
  const flags = parsed.values as Flags
  const [command = '', ...rest] = parsed.positionals

  if (flags.version) {
    process.stdout.write(`repro ${VERSION}\n`)
    return 0
  }
  if (flags.help || command === '' || command === 'help') {
    process.stdout.write(usage())
    return command === '' && !flags.help ? 2 : 0
  }

  switch (command) {
    case 'init':
      return cmdInit(rest, flags)
    case 'from':
      return cmdFrom(rest, flags)
    case 'run':
      return cmdRun(flags)
    case 'establish':
      return cmdEstablish(flags)
    case 'seal':
      return cmdSeal(flags)
    case 'verify':
      return cmdVerify(flags)
    case 'minimize':
      return cmdMinimize(flags)
    case 'explain':
      return cmdExplain(flags)
    case 'bisect':
      return cmdBisect(flags)
    case 'export':
      return cmdExport(flags)
    default:
      process.stderr.write(`${red('error:')} unknown command "${command}"\n\n${usage()}`)
      return 2
  }
}

// -------------------------------------------------------------- init / from

async function cmdInit(positionals: string[], flags: Flags): Promise<number> {
  const root = path.resolve(flags.root ?? process.cwd())
  let description = positionals.join(' ').trim()
  let imported: Imported | undefined

  if (flags.from) {
    imported = await importEvidence(path.resolve(flags.from))
    description = description || imported.description
  }
  if (!description) {
    process.stderr.write(
      `${red('error:')} describe the bug, or pass --from <file>\n` +
        `  repro init "checkout returns 500 after applying SAVE20"\n`,
    )
    return 2
  }

  const facts = await detectProject(root)
  const result = await scaffold(
    root,
    {
      description,
      facts,
      scenario: imported?.scenario,
      reproduce: imported?.reproduce,
      expect: imported?.expect,
      baseUrl: imported?.baseUrl,
      raw: imported?.raw,
      source: imported?.source,
    },
    { force: flags.force, complete: Boolean(imported?.scenario?.length) },
  )

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          spec: result.specPath,
          brief: result.briefPath,
          detected: facts,
          notes: [...facts.notes, ...(imported?.notes ?? [])],
        },
        null,
        2,
      )}\n`,
    )
    return 0
  }

  const rel = (p: string) => path.relative(process.cwd(), p) || '.'
  process.stdout.write(
    [
      '',
      `${bold('detected')}  ${[facts.framework, facts.language, facts.packageManager, facts.database]
        .filter(Boolean)
        .join(', ')}`,
      facts.devCommand ? `${bold('start')}     ${facts.devCommand}` : dim('start     unknown'),
      facts.baseUrl ? `${bold('base url')}  ${facts.baseUrl}` : dim('base url  unknown'),
      '',
      `wrote ${cyan(rel(result.specPath))}${result.complete ? '' : dim('   (draft — scenario is a stub)')}`,
      `wrote ${cyan(rel(result.briefPath))}`,
      ...(result.reportPath ? [`wrote ${cyan(rel(result.reportPath))}`] : []),
      '',
      ...[...facts.notes, ...(imported?.notes ?? [])].map((n) => `${yellow('note')}  ${n}`),
      '',
      result.complete
        ? `Next: ${bold('repro run')}`
        : `Next: point your coding agent at ${cyan(rel(result.briefPath))}, then ${bold('repro run')}`,
      '',
    ].join('\n'),
  )
  return 0
}

async function cmdFrom(positionals: string[], flags: Flags): Promise<number> {
  const file = positionals[0]
  if (!file) {
    process.stderr.write(`${red('error:')} repro from <file.md|.log|.har|.curl|.txt>\n`)
    return 2
  }
  if (!existsSync(path.resolve(file))) {
    process.stderr.write(`${red('error:')} no such file: ${file}\n`)
    return 2
  }
  return cmdInit([], { ...flags, from: file })
}

// --------------------------------------------------------------------- run

async function cmdRun(flags: Flags): Promise<number> {
  const loaded = await load(flags)
  // --quiet drops the running commentary; the verdict is the point of the
  // command and survives everything except --json.
  const quiet = flags.quiet === true || flags.json === true
  if (!quiet) process.stdout.write(`${bold('REPRO')} ${loaded.spec.name}\n`)

  const result = await runReproduction(loaded, {
    repeat: num(flags.repeat) ?? 1,
    trace: flags.trace,
    headed: flags.headed,
    timeoutMs: num(flags.timeout),
    onPhase: (phase, status, detail) => {
      if (quiet || status === 'start') return
      process.stdout.write(`${phaseLine(phase, status)}${detail ? `  ${dim(detail)}` : ''}\n`)
    },
  })

  if (flags.json) process.stdout.write(`${JSON.stringify(toJson(result), null, 2)}\n`)
  else process.stdout.write(`${renderRun(result)}\n\n`)

  if (flags['exit-code']) {
    // git-bisect contract: 0 = good, 1 = bad, 125 = untestable. A run that
    // never reached the failure step is untestable, not good.
    if (result.status === 'error' || result.status === 'invalid') return 125
    return result.status === 'reproduced' ? 1 : 0
  }
  return 0
}

/** The agent-facing shape documented in the README. */
function toJson(result: RepeatResult) {
  return {
    status: result.status,
    name: result.name,
    reproduction_rate: result.reproduction_rate,
    classification: result.classification,
    confidence: result.confidence,
    runs: result.runs,
    failures: result.failures,
    successes: result.successes,
    invalid: result.invalid,
    errors: result.errors,
    interval: result.interval,
    failure: result.failure
      ? {
          step: result.failure.step,
          step_index: result.failure.step_index,
          expected_status: (result.failure.expected as { status?: number } | undefined)?.status,
          actual_status: result.failure.observed.status,
          exception: result.failure.observed.exception ?? result.failure.observed.error,
          trajectory: result.failure.observed.trajectory,
          mismatch: result.failure.mismatch,
        }
      : undefined,
    error: result.error,
    artifacts: result.artifacts,
  }
}

// ------------------------------------------------- establish / seal / verify

async function cmdEstablish(flags: Flags): Promise<number> {
  const loaded = await load(flags)
  const quiet = flags.quiet === true || flags.json === true
  if (!quiet) process.stdout.write(`${bold('ESTABLISH')} ${loaded.spec.name}\n`)

  const { baseline, path: file } = await establish(loaded, {
    // A single run is a story, not a baseline.
    repeat: num(flags.repeat) ?? 10,
    timeoutMs: num(flags.timeout),
    version: VERSION,
    onPhase: (phase, status, detail) => {
      if (quiet || status === 'start') return
      process.stdout.write(`${phaseLine(phase, status)}${detail ? `  ${dim(detail)}` : ''}\n`)
    },
  })

  if (flags.json) process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`)
  else {
    process.stdout.write(`${renderEstablish(baseline)}\n`)
    const rel = path.relative(process.cwd(), file) || file
    process.stdout.write(
      `\nwrote ${cyan(rel)}${dim(baseline.reproduced > 0 ? '  (now: repro seal)' : '')}\n\n`,
    )
  }
  return baseline.reproduced > 0 ? 0 : 1
}

async function cmdSeal(flags: Flags): Promise<number> {
  const loaded = await load(flags)
  const { seal: sealed, path: file } = await seal(loaded, VERSION)
  if (flags.json) process.stdout.write(`${JSON.stringify(sealed, null, 2)}\n`)
  else {
    process.stdout.write(`${renderSeal(sealed)}\n`)
    const rel = path.relative(process.cwd(), file) || file
    process.stdout.write(
      `\nwrote ${cyan(rel)}\n${dim('commit it. the implementation may now change; this definition may not.')}\n\n`,
    )
  }
  return 0
}

async function cmdVerify(flags: Flags): Promise<number> {
  const loaded = await load(flags)
  const quiet = flags.quiet === true || flags.json === true
  if (!quiet) process.stdout.write(`${bold('VERIFY')} ${loaded.spec.name}\n`)

  const report = await verify(loaded, {
    repeat: num(flags.repeat),
    timeoutMs: num(flags.timeout),
    version: VERSION,
    onPhase: (phase, status, detail) => {
      if (quiet || status === 'start') return
      process.stdout.write(`${phaseLine(phase, status)}${detail ? `  ${dim(detail)}` : ''}\n`)
    },
  })

  if (flags.json) {
    const { result: _full, ...summary } = report
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else process.stdout.write(`${renderVerify(report)}\n\n`)

  // A modified contract invalidates the comparison whatever the runs said.
  if (report.contract === 'MODIFIED' || report.fixtures === 'MODIFIED') return 2
  if (report.policy) return report.policy.result === 'PASS' ? 0 : 1
  return report.current.reproduced > 0 ? 1 : 0
}

// ---------------------------------------------------------------- minimize

async function cmdMinimize(flags: Flags): Promise<number> {
  const loaded = await load(flags)
  const quiet = flags.quiet === true || flags.json === true
  if (!quiet) process.stdout.write(`${bold('MINIMIZE')} ${loaded.spec.name}\n`)

  const result = await minimize(loaded, {
    confirm: num(flags.confirm) ?? 1,
    verify: num(flags.verify) ?? 3,
    timeoutMs: num(flags.timeout),
    onProgress: (message) => {
      if (!quiet) process.stdout.write(`${dim(`  ${message}`)}\n`)
    },
  })

  const yaml = dumpSpec(result.spec)
  // Derived from the spec's own name so `--spec browser.yaml` cannot clobber
  // the minimized output of a different reproduction.
  const stem = path.basename(loaded.specPath, path.extname(loaded.specPath))
  const target = flags.write ? loaded.specPath : path.join(loaded.reproDir, `${stem}.min.yaml`)
  if (flags.write) {
    await writeFile(path.join(loaded.reproDir, `${stem}.original.yaml`), await readFile(loaded.specPath))
  }
  await writeFile(target, yaml)

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          original_steps: result.original_steps,
          minimal_steps: result.minimal_steps,
          removed_steps: result.removed.map((i) => i + 1),
          steps: result.labels,
          progress: result.progress,
          probes: result.probes,
          confirmed: result.confirmed,
          spec: target,
        },
        null,
        2,
      )}\n`,
    )
  } else {
    process.stdout.write(`${renderMinimize(result)}\n`)
    const rel = path.relative(process.cwd(), target) || target
    process.stdout.write(
      `\nwrote ${cyan(rel)}${flags.write ? dim('  (original saved as .repro/repro.original.yaml)') : dim('  (pass --write to replace repro.yaml)')}\n\n`,
    )
  }
  return 0
}

// ----------------------------------------------------------------- explain

async function cmdExplain(flags: Flags): Promise<number> {
  const loaded = await load(flags)
  const quiet = flags.quiet === true || flags.json === true
  if (!quiet) process.stdout.write(`${bold('EXPLAIN')} ${loaded.spec.name}\n`)

  const report = await explain(loaded, {
    confirm: num(flags.confirm) ?? 1,
    timeoutMs: num(flags.timeout),
    onProgress: (message) => {
      if (!quiet) process.stdout.write(`${dim(`  ${message}`)}\n`)
    },
  })

  if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else process.stdout.write(`${renderExplain(report)}\n\n`)
  return report.status === 'reproduced' ? 0 : 1
}

// ------------------------------------------------------------------ bisect

async function cmdBisect(flags: Flags): Promise<number> {
  if (!flags.good || !flags.bad) {
    process.stderr.write(`${red('error:')} repro bisect --good <ref> --bad <ref>\n`)
    return 2
  }
  const loaded = await load(flags)
  const quiet = flags.quiet === true || flags.json === true
  if (!quiet) process.stdout.write(`${bold('BISECT')} ${loaded.spec.name}\n`)

  // git echoes the whole predicate before every probe; the interesting lines
  // are "Bisecting: N revisions left" and the verdict.
  let pending = ''
  const relay = (chunk: string) => {
    if (quiet) return
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('running ')) continue
      process.stdout.write(`${dim(line)}\n`)
    }
  }

  const result = await bisect(loaded, {
    good: flags.good,
    bad: flags.bad,
    repeat: num(flags.repeat),
    timeoutMs: num(flags.timeout),
    onOutput: relay,
  })
  if (pending && !quiet) process.stdout.write(`${dim(pending)}\n`)

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        { commit: result.commit, subject: result.subject, commits_tested: result.commits_tested },
        null,
        2,
      )}\n`,
    )
  } else if (result.commit) {
    process.stdout.write(
      `\n${red(bold('Regression introduced by:'))}\n  ${result.commit}\n  ${result.subject ?? ''}\n\n`,
    )
  } else {
    process.stdout.write(`\n${yellow('bisect finished without identifying a commit')}\n\n`)
  }
  return result.commit ? 0 : 1
}

// ------------------------------------------------------------------ export

async function cmdExport(flags: Flags): Promise<number> {
  const loaded = await load(flags)
  if (!flags.test) {
    process.stderr.write(`${red('error:')} repro export --test [--out <file>]\n`)
    return 2
  }
  const facts = await detectProject(loaded.root)
  const runner = facts.testRunner === 'jest' || facts.testRunner === 'vitest' ? facts.testRunner : 'node'
  const out = path.resolve(
    flags.out ?? path.join(loaded.root, 'tests', `repro-${loaded.spec.name}.test.${runner === 'node' ? 'mjs' : 'ts'}`),
  )
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, regressionTest(loaded, runner, path.dirname(out)), {
    flag: flags.force ? 'w' : 'wx',
  }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') throw new Error(`${out} already exists — pass --force to overwrite`)
      throw err
    },
  )
  const rel = path.relative(process.cwd(), out) || out
  if (flags.json) process.stdout.write(`${JSON.stringify({ test: out, runner }, null, 2)}\n`)
  else
    process.stdout.write(
      `\nwrote ${cyan(rel)}\n${dim(`this test fails while the bug reproduces and passes once it is fixed (${runner})`)}\n\n`,
    )
  return 0
}

function regressionTest(
  loaded: LoadedSpec,
  runner: 'node' | 'vitest' | 'jest',
  outDir: string,
): string {
  // Paths are resolved from the test file itself, so the test does not care
  // which directory the runner was invoked from.
  const toSpec = relativeSpecifier(outDir, loaded.specPath)
  const toRoot = relativeSpecifier(outDir, loaded.root)
  const imports =
    runner === 'node'
      ? "import { test } from 'node:test'\nimport assert from 'node:assert/strict'"
      : runner === 'vitest'
        ? "import { test, expect } from 'vitest'"
        : ''
  const assertion =
    runner === 'node'
      ? "assert.notEqual(result.status, 'reproduced', `bug still reproduces: ${JSON.stringify(result.failure)}`)"
      : "expect(result.status, JSON.stringify(result.failure)).not.toBe('reproduced')"

  return `// Generated by \`repro export --test\` from ${path.relative(loaded.root, loaded.specPath)}
// Regression guard for: ${(loaded.spec.description ?? loaded.spec.name).split('\n')[0]}
// Requires repro on the path: npm i -D repro
${imports}
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const spec = fileURLToPath(new URL(${JSON.stringify(toSpec)}, import.meta.url))
const root = fileURLToPath(new URL(${JSON.stringify(toRoot)}, import.meta.url))

test(${JSON.stringify(`${loaded.spec.name} does not reproduce`)}, { timeout: 300_000 }, () => {
  const stdout = execFileSync('npx', ['repro', 'run', '--json', '--quiet', '--spec', spec, '--root', root], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const result = JSON.parse(stdout)
  ${assertion}
})
`
}

function relativeSpecifier(from: string, to: string): string {
  const rel = path.relative(from, to).split(path.sep).join('/')
  return rel.startsWith('.') ? rel : `./${rel}`
}

// ------------------------------------------------------------------ shared

async function load(flags: Flags): Promise<LoadedSpec> {
  const loaded = await loadSpec(flags.spec, flags.root)
  return flags.root ? { ...loaded, root: path.resolve(flags.root) } : loaded
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new SpecError(`expected a number, got "${value}"`)
  return parsed
}

function usage(): string {
  return `${bold('repro')} — turn any bug report into a reproduction your coding agent can run

${bold('USAGE')}
  repro <command> [options]

${bold('COMMANDS')}
  init <description>     Inspect the repo and scaffold .repro/repro.yaml
  from <file>            Same, seeded from evidence (.md .log .har .curl .txt)
  run                    Execute the reproduction and report a verdict
  establish              Measure the failure repeatedly and record a baseline
  seal                   Freeze the contract, baseline and environment
  verify                 Re-run the sealed contract and compare
  minimize               Cut the scenario to the steps that actually matter
  explain                Locate the failure boundary and collect evidence
  bisect                 Find the commit that introduced the failure
  export --test          Emit a regression test from the reproduction

${bold('OPTIONS')}
  --repeat <n>           Run n times; measures flakiness  (run, establish, verify, bisect)
  --json                 Machine-readable output                  (all)
  --exit-code            Exit 1 when reproduced, 125 on error     (run)
  --confirm <n>          Runs required per probe                  (minimize, explain)
  --verify <n>           Runs to verify the minimal scenario      (minimize)
  --write                Replace repro.yaml with the minimal one  (minimize)
  --good/--bad <ref>     Bisect endpoints                         (bisect)
  --trace                Record a Playwright trace                (run)
  --headed               Show the browser                         (run)
  --timeout <ms>         Per-step timeout, default 30000          (all)
  --spec <file>          Use a specific spec file                 (all)
  --root <dir>           Project root, default the spec's parent  (all)
  --force                Overwrite existing files                 (init, export)
  --quiet                Drop progress output, keep the verdict   (all)

${bold('EXAMPLES')}
  repro init "checkout returns 500 after changing address and applying SAVE20"
  repro from bug-report.md
  repro run --repeat 20
  repro establish --repeat 100 && repro seal
  repro verify --repeat 500  ${dim('# same contract, after the fix')}
  repro minimize --write
  repro explain
  repro bisect --good v2.4.1 --bad HEAD
  repro run --json          ${dim('# what your coding agent should loop on')}
`
}

// ------------------------------------------------------------------- entry

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err)
      process.stderr.write(`${red('error:')} ${detail}\n`)
      process.exitCode = err instanceof SpecError || err instanceof SealError ? 2 : 1
    })
}

export { main }
export const version = VERSION
