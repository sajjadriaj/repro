/**
 * Evidence collection. Every run writes a self-contained bundle under
 * .repro/runs/NNNN/ so a failure can be inspected long after it happened.
 */
import { mkdir, writeFile, readdir, symlink, rm } from 'node:fs/promises'
import path from 'node:path'

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
