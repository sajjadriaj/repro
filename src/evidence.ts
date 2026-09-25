/**
 * Evidence collection. Every run writes a self-contained bundle under
 * .repro/runs/NNNN/ so a failure can be inspected long after it happened.
 *
 * Also the physical observers: what repro can see of a process it spawned
 * from the outside — the git working tree before and after a step, and the
 * environment the run happened in. Nothing here proxies, traces or hooks the
 * process itself.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, writeFile, readdir, readFile, symlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export type RunDir = {
  dir: string
  id: string
  file(...parts: string[]): string
  write(rel: string, data: string | Uint8Array): Promise<string>
}

/** Allocate the next numbered run directory and point `latest` at it. */
export async function newRunDir(reproDir: string): Promise<RunDir> {
  const runsRoot = path.join(reproDir, 'runs')
  await mkdir(runsRoot, { recursive: true })
  const existing = await readdir(runsRoot).catch(() => [] as string[])
  const highest = existing
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0)
  const id = String(highest + 1).padStart(4, '0')
  const dir = path.join(runsRoot, id)
  await mkdir(dir, { recursive: true })
  await pointLatestAt(runsRoot, id)
  return {
    dir,
    id,
    file: (...parts: string[]) => path.join(dir, ...parts),
    async write(rel, data) {
      const target = path.join(dir, rel)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, data)
      return target
    },
  }
}

async function pointLatestAt(runsRoot: string, id: string): Promise<void> {
  const link = path.join(runsRoot, 'latest')
  await rm(link, { recursive: true, force: true }).catch(() => {})
  try {
    await symlink(id, link, 'junction')
  } catch {
    // ponytail: no symlink permission (Windows without dev mode) — leave a
    // pointer file instead so `latest` is still discoverable.
    await writeFile(path.join(runsRoot, 'latest.json'), JSON.stringify({ run: id }, null, 2))
  }
}

/** A recorded HTTP exchange, written to network.json. */
export type NetworkEntry = {
  step: number
  label: string
  method: string
  url: string
  request_headers?: Record<string, string>
  request_body?: string
  status?: number
  response_headers?: Record<string, string>
  response_body?: string
  duration_ms: number
  error?: string
}

/** Truncate long payloads so an evidence bundle stays readable. */
export function clip(text: string | undefined, max = 64 * 1024): string | undefined {
  if (text === undefined) return undefined
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} bytes]`
}

// --------------------------------------------------------------------- git

/** Raw stdout, or undefined when git is absent, `cwd` is not a repo, or the command failed. */
export function git(cwd: string, args: string[]): Promise<string | undefined> {
  return exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
    .then((r) => r.stdout)
    .catch(() => undefined)
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

const short = (hash: string) => hash.slice(0, 7)

const LOCKFILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'requirements.txt',
  'poetry.lock',
  'Cargo.lock',
  'go.sum',
  'Gemfile.lock',
]

export type Fingerprint = {
  os: string
  arch: string
  node: string
  repro: string
  git_commit?: string
  git_dirty?: boolean
  /** Hash per dependency lockfile found at the project root. */
  locks: Record<string, string>
}

/**
 * Enough to identify drift, and nothing more. No environment variables, no
 * credentials, no working directory contents: a fingerprint gets committed and
 * shared, so it only ever holds things that are safe to read.
 */
export async function fingerprint(root: string, version: string): Promise<Fingerprint> {
  const locks: Record<string, string> = {}
  for (const name of LOCKFILES) {
    const file = path.join(root, name)
    if (existsSync(file)) locks[name] = short(sha256(await readFile(file, 'utf8')))
  }
  const commit = (await git(root, ['rev-parse', 'HEAD']))?.trim()
  const dirty = commit === undefined ? undefined : (await git(root, ['status', '--porcelain']))?.trim() !== ''
  return {
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    repro: version,
    git_commit: commit ? short(commit) : undefined,
    git_dirty: dirty,
    locks,
  }
}

// ------------------------------------------------------------ working tree

export type FileChanges = { added: string[]; modified: string[]; deleted: string[] }

/** Every changed path, for matchers and counts. */
export function changedFiles(c: FileChanges): string[] {
  return [...c.added, ...c.modified, ...c.deleted]
}

/**
 * The dirty part of the working tree under `root`: path → `XY:sha256`, or
 * `D` for a deletion. Two of these bracket a step; their difference is what
 * the step did to the repository. Clean files are not listed, which is what
 * keeps this cheap enough to run around every shell and agent step.
 *
 * Paths are relative to `root`, which need not be the repository top; files
 * outside it are ignored, and so is `.repro/`, because evidence a step wrote
 * is not a mutation the step made.
 *
 * ponytail: every dirty file is hashed twice per step. Fine for a working
 * tree with tens of dirty files; a tree with thousands wants mtime+size.
 */
export async function treeSnapshot(root: string, top: string): Promise<Record<string, string>> {
  const status = (await git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.'])) ?? ''
  const out: Record<string, string> = {}
  const fields = status.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    if (field.length < 4) continue
    const xy = field.slice(0, 2)
    // A rename or copy is followed by its origin path as a field of its own.
    if (/[RC]/.test(xy)) i++
    const rel = path.relative(root, path.join(top, field.slice(3)))
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    const file = rel.split(path.sep).join('/')
    if (file === '.repro' || file.startsWith('.repro/')) continue
    out[file] = xy.includes('D') ? 'D' : `${xy}:${await hashFile(path.join(root, file))}`
  }
  return out
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', () => resolve('unreadable'))
  })
}

export function diffSnapshots(before: Record<string, string>, after: Record<string, string>): FileChanges {
  const changes: FileChanges = { added: [], modified: [], deleted: [] }
  for (const [file, state] of Object.entries(after)) {
    if (before[file] === state) continue
    if (state === 'D') changes.deleted.push(file)
    else if (state.startsWith('??') && before[file] === undefined) changes.added.push(file)
    else changes.modified.push(file)
  }
  for (const [file, state] of Object.entries(before)) {
    if (file in after) continue
    // Dirty before, clean after: an untracked file was removed, or a tracked
    // change was reverted or committed. Either way the step touched it.
    if (state.startsWith('??')) changes.deleted.push(file)
    else changes.modified.push(file)
  }
  for (const list of Object.values(changes)) list.sort()
  return changes
}
