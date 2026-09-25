/**
 * Run a contract against another commit without touching the working tree.
 *
 * `verify` answers "does my current change fix this" against the tree as it
 * is. `--worktree <ref>` is the inverse: the same contract, the same
 * evidence directory, against the code the failure was sealed on (or any
 * other ref). The spec is not checked out with the code — as with bisect, a
 * predicate that time-travels is a different predicate.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { git } from './evidence.js'
import type { LoadedSpec } from './spec.js'

const exec = promisify(execFile)

export async function inWorktree<T>(
  loaded: LoadedSpec,
  ref: string,
  fn: (loaded: LoadedSpec) => Promise<T>,
): Promise<T> {
  const top = (await git(loaded.root, ['rev-parse', '--show-toplevel']))?.trim()
  if (!top) throw new Error(`--worktree needs a git repository at ${loaded.root}`)
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'repro-worktree-'))
  try {
    // A run killed mid-way leaves its worktree's metadata in .git/worktrees; sweep it first.
    await exec('git', ['worktree', 'prune'], { cwd: top }).catch(() => undefined)
    await exec('git', ['worktree', 'add', '--detach', tmp, ref], { cwd: top }).catch((err: Error) => {
      throw new Error(`git worktree add ${ref} failed: ${err.message.split('\n').at(-1)}`)
    })
    // Borrowed from today's tree when the ref has none of its own:
    // ponytail: dependencies are borrowed, not installed — the ref runs with
    // today's node_modules. Run `npm ci` in the worktree yourself when the
    // lockfile moved between the two commits.
    // The spec came from today's .repro/, so the fixtures and recordings it
    // names must too; a ref that predates the reproduction has no .repro/ to
    // offer. (A ref with an older .repro/ keeps it — commit the fixture.)
    // Each link is excluded in the worktree's own exclude file, which dies
    // with it: a `node_modules/` ignore rule matches directories, not a
    // symlink, and a link repro planted must not make the worktree read dirty.
    const excludes: string[] = []
    const borrow = async (src: string) => {
      const rel = path.relative(top, src)
      const dst = path.join(tmp, rel)
      if (rel.startsWith('..') || !existsSync(src) || existsSync(dst)) return
      await mkdir(path.dirname(dst), { recursive: true })
      await symlink(src, dst, 'junction').catch(() => undefined)
      excludes.push(`/${rel.split(path.sep).join('/')}`)
    }
    await borrow(path.join(top, 'node_modules'))
    await borrow(loaded.reproDir)
    const exclude = excludes.length ? (await git(tmp, ['rev-parse', '--git-path', 'info/exclude']))?.trim() : undefined
    if (exclude) {
      const file = path.resolve(tmp, exclude)
      await mkdir(path.dirname(file), { recursive: true })
      await appendFile(file, `${excludes.join('\n')}\n`)
    }
    const root = path.join(tmp, path.relative(top, loaded.root))
    return await fn({ ...loaded, root })
  } finally {
    await exec('git', ['worktree', 'remove', '--force', tmp], { cwd: top }).catch(() => undefined)
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}
