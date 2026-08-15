/**
 * git bisect, using the reproduction as the predicate.
 *
 * The spec is copied outside the working tree first: bisect checks out old
 * commits, and a spec that time-travels with them is not the same predicate.
 */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import type { LoadedSpec } from './spec.js'

export type BisectOptions = {
  good: string
  bad: string
  repeat?: number
  timeoutMs?: number
  onOutput?: (chunk: string) => void
}

export type BisectResult = {
  commit?: string
  subject?: string
  output: string
  commits_tested: number
}

export async function bisect(loaded: LoadedSpec, opts: BisectOptions): Promise<BisectResult> {
  const cwd = loaded.root
  await git(['rev-parse', '--is-inside-work-tree'], cwd)

  const status = await git(['status', '--porcelain'], cwd)
  if (status.stdout.trim()) {
    throw new Error('working tree is dirty — commit or stash before bisecting')
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'repro-bisect-'))
  const specCopy = path.join(tmp, 'repro.yaml')
  await copyFile(loaded.specPath, specCopy)

  const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
  const predicate = [
    quote(process.execPath),
    quote(cli),
    'run',
    '--exit-code',
    '--quiet',
    '--spec',
    quote(specCopy),
    '--root',
    quote(loaded.root),
    ...(opts.repeat ? ['--repeat', String(opts.repeat)] : []),
    ...(opts.timeoutMs ? ['--timeout', String(opts.timeoutMs)] : []),
  ].join(' ')

  let output = ''
  try {
    await git(['bisect', 'start'], cwd)
    await git(['bisect', 'bad', opts.bad], cwd)
    await git(['bisect', 'good', opts.good], cwd)
    const run = await git(['bisect', 'run', 'sh', '-c', predicate], cwd, opts.onOutput)
    output = `${run.stdout}${run.stderr}`
  } finally {
    await git(['bisect', 'reset'], cwd).catch(() => undefined)
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }

  const commit = /([0-9a-f]{7,40}) is the first bad commit/.exec(output)?.[1]
  let subject: string | undefined
  if (commit) {
    subject = (await git(['log', '-1', '--format=%s', commit], cwd)).stdout.trim()
  }
  const tested = output.match(/Bisecting:/g)?.length ?? 0
  return { commit, subject, output, commits_tested: tested }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function git(
  args: string[],
  cwd: string,
  onOutput?: (chunk: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      onOutput?.(d.toString())
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      onOutput?.(d.toString())
    })
    child.on('error', reject)
    child.on('close', (code) => {
      // `git bisect run` exits non-zero on some paths but still reports a
      // result, so only hard-fail when there is nothing usable.
      if (code === 0 || args[1] === 'run') resolve({ stdout, stderr })
      else reject(new Error(`git ${args.join(' ')} failed (${code}):\n${stderr || stdout}`))
    })
  })
}
