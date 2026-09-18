/**
 * Execution primitives: shell steps, HTTP steps, browser steps, and the
 * service supervisor that brings the application under test up and down.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  interpolate,
  jsonPath,
  matchOutcome,
  stepKindOf,
  stepLabel,
  type BrowserAction,
  type Observed,
  type Service,
  type Step,
} from './spec.js'
import YAML from 'yaml'
import { parseTrace, validateJsonSchema, type AgentTrace } from './agent.js'
import { clip, type NetworkEntry, type RunDir } from './evidence.js'

export type ExecContext = {
  root: string
  baseUrl?: string
  env: Record<string, string>
  vars: Record<string, string>
  run: RunDir
  network: NetworkEntry[]
  /** Accumulated stdout/stderr from all services, for `logs_contain`. */
  serviceLogs: () => string
  stepTimeoutMs: number
  trace: boolean
  headed: boolean
  browser?: BrowserSession
  onLog?: (line: string) => void
}

// ------------------------------------------------------------------- steps

export async function runStep(rawStep: Step, index: number, ctx: ExecContext): Promise<Observed> {
  const step = interpolate(rawStep, ctx.vars)
  const label = stepLabel(step, index)
  const kind = stepKindOf(step)
  const started = Date.now()

  let observed: Observed
  try {
    switch (kind) {
      case 'shell':
        observed = await execShell(step, ctx)
        break
      case 'http':
        observed = await execHttp(step, index, ctx)
        break
      case 'browser':
        observed = await execBrowser(step, index, ctx)
        break
      case 'agent':
        observed = await execAgent(step, index, ctx)
        break
      case 'sleep':
        await delay(step.sleep ?? 0)
        observed = { kind: 'sleep', label, duration_ms: 0 }
        break
      default:
        observed = {
          kind: 'shell',
          label,
          error: `step ${index + 1} has no executable key (shell/http/browser/sleep/agent)`,
          duration_ms: 0,
        }
    }
  } catch (err) {
    observed = {
      kind: kind ?? 'shell',
      label,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      duration_ms: Date.now() - started,
    }
  }

  observed.label = label
  observed.duration_ms = Date.now() - started

  // Capture variables for later steps.
  for (const [name, expr] of Object.entries(step.save ?? {})) {
    const value = expr.startsWith('$') ? jsonPath(observed.json, expr) : pickField(observed, expr)
    ctx.vars[name] = value === undefined || value === null ? '' : String(value)
  }

  if (step.expect) {
    const result = matchOutcome(step.expect, observed, ctx.serviceLogs())
    if (!result.ok) observed.expect_failed = result.reasons
  }
  return observed
}

function pickField(o: Observed, field: string): unknown {
  return (o as unknown as Record<string, unknown>)[field]
}

// ------------------------------------------------------------------- shell

async function execShell(step: Step, ctx: ExecContext): Promise<Observed> {
  const cwd = step.cwd ? path.resolve(ctx.root, step.cwd) : ctx.root
  const result = await spawnCapture(step.shell as string, {
    cwd,
    env: { ...process.env, ...ctx.env } as NodeJS.ProcessEnv,
    timeoutMs: ctx.stepTimeoutMs,
  })
  return {
    kind: 'shell',
    label: '',
    exit_code: result.code ?? undefined,
    stdout: clip(result.stdout),
    stderr: clip(result.stderr),
    body: clip(`${result.stdout}${result.stderr}`),
    error: result.timedOut ? `timed out after ${ctx.stepTimeoutMs}ms` : undefined,
    duration_ms: 0,
  }
}

export function spawnCapture(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: true,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    if (opts.input !== undefined) child.stdin?.end(opts.input)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

// ------------------------------------------------------------------- agent

/**
 * Run an agent and normalize whatever it emitted into a trace.
 *
 * repro stays out of the agent's business: it hands the input in on stdin and
 * reads a trace back, as one JSON object or as JSONL, from stdout or from a
 * file. Anything that can print JSON can be reproduced, with no SDK, no
 * framework integration and no model inside repro.
 */
async function execAgent(step: Step, index: number, ctx: ExecContext): Promise<Observed> {
  const spec = step.agent!
  const cwd = spec.cwd ? path.resolve(ctx.root, spec.cwd) : ctx.root
  const started = Date.now()

  let stdout = ''
  let stderr = ''
  let exitCode: number | undefined
  let error: string | undefined

  if (spec.run) {
    const result = await spawnCapture(spec.run, {
      cwd,
      env: { ...process.env, ...ctx.env, ...spec.env } as NodeJS.ProcessEnv,
      timeoutMs: spec.timeout_ms ?? ctx.stepTimeoutMs,
      input: spec.input === undefined ? undefined : `${JSON.stringify(spec.input)}\n`,
    })
    stdout = result.stdout
    stderr = result.stderr
    exitCode = result.code ?? undefined
    if (result.timedOut) error = `agent timed out after ${spec.timeout_ms ?? ctx.stepTimeoutMs}ms`
  } else if (!spec.trace_file) {
    return {
      kind: 'agent',
      label: '',
      error: 'agent step needs `run`, `trace_file`, or both',
      duration_ms: 0,
    }
  }

  let raw = stdout
  if (spec.trace_file) {
    const file = path.resolve(ctx.root, spec.trace_file)
    raw = await readFile(file, 'utf8').catch((err: Error) => {
      error ??= `could not read trace_file: ${err.message}`
      return ''
    })
  }

  const trace: AgentTrace = parseTrace(raw)
  trace.input ??= spec.input
  trace.duration_ms ??= Date.now() - started
  if (spec.output_schema !== undefined) {
    const schema = await loadSchema(spec.output_schema, ctx.root)
    const errors = validateJsonSchema(schema, trace.output)
    trace.schema_valid = errors.length === 0
    trace.schema_errors = errors
  }
  if (!trace.events.length && trace.output === undefined && !error) {
    error = 'the agent produced no trace — expected JSON or JSONL on stdout'
  }

  const file = await ctx.run
    .write(path.join('traces', `${String(index + 1).padStart(2, '0')}.json`), JSON.stringify(trace, null, 2))
    .catch(() => undefined)

  return {
    kind: 'agent',
    label: '',
    // Exposed as `json` too, so `save:` and `json:` path matchers work on a
    // trace exactly as they do on an HTTP response body.
    json: trace,
    trace,
    stdout: clip(stdout),
    stderr: clip(stderr),
    body: clip(stdout),
    exit_code: exitCode,
    error,
    artifacts: file ? [file] : undefined,
    duration_ms: 0,
  }
}

async function loadSchema(
  schema: string | Record<string, unknown>,
  root: string,
): Promise<unknown> {
  if (typeof schema !== 'string') return schema
  const text = await readFile(path.resolve(root, schema), 'utf8')
  return /\.ya?ml$/i.test(schema) ? YAML.parse(text) : JSON.parse(text)
}

// -------------------------------------------------------------------- http

export function resolveUrl(url: string, baseUrl?: string): string {
  if (/^https?:\/\//i.test(url)) return url
  if (!baseUrl) return url
  return new URL(url, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
}

async function execHttp(step: Step, index: number, ctx: ExecContext): Promise<Observed> {
  const req = step.http!
  const url = resolveUrl(req.url, ctx.baseUrl)
  const method = (req.method ?? (req.json || req.body || req.form ? 'POST' : 'GET')).toUpperCase()
  const headers: Record<string, string> = { ...req.headers }

  let body: string | undefined
  if (req.json !== undefined) {
    body = JSON.stringify(req.json)
    headers['content-type'] ??= 'application/json'
  } else if (req.form !== undefined) {
    body = new URLSearchParams(req.form).toString()
    headers['content-type'] ??= 'application/x-www-form-urlencoded'
  } else if (req.body !== undefined) {
    body = req.body
  }

  const entry: NetworkEntry = {
    step: index + 1,
    label: stepLabel(step, index),
    method,
    url,
    request_headers: headers,
    request_body: clip(body, 8192),
    duration_ms: 0,
  }
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(req.timeout_ms ?? ctx.stepTimeoutMs),
    })
    const text = await response.text()
    entry.status = response.status
    entry.response_headers = Object.fromEntries(response.headers.entries())
    entry.response_body = clip(text, 32768)
    entry.duration_ms = Date.now() - started
    ctx.network.push(entry)

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return {
      kind: 'http',
      label: '',
      status: response.status,
      headers: entry.response_headers,
      body: clip(text),
      json,
      exception: extractException(text, json),
      duration_ms: 0,
    }
  } catch (err) {
    entry.error = err instanceof Error ? err.message : String(err)
    entry.duration_ms = Date.now() - started
    ctx.network.push(entry)
    return {
      kind: 'http',
      label: '',
      error: `request failed: ${entry.error}`,
      duration_ms: 0,
    }
  }
}

/** Pull an error message out of a JSON error envelope or an HTML error page. */
export function extractException(text: string, json: unknown): string | undefined {
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>
    for (const key of ['error', 'message', 'exception', 'detail', 'stack']) {
      const v = o[key]
      if (typeof v === 'string' && v) return v
      if (v && typeof v === 'object') {
        const nested = (v as Record<string, unknown>).message
        if (typeof nested === 'string') return nested
      }
    }
  }
  const match =
    /((?:[A-Z]\w*Error|Error|Exception)[^\n<]{0,200})/.exec(text) ??
    /(Cannot read propert[^\n<]{0,200})/.exec(text)
  return match?.[1]?.trim()
}

// ----------------------------------------------------------------- browser

export type BrowserSession = {
  browser: { close(): Promise<void> }
  context: { close(): Promise<void>; tracing: { stop(o: { path: string }): Promise<void> } }
  page: Record<string, any>
}

async function getBrowser(ctx: ExecContext): Promise<BrowserSession> {
  if (ctx.browser) return ctx.browser
  let playwright: any
  try {
    // Indirect specifier: playwright is an optional peer, so it must not be a
    // hard module resolution at build time.
    const specifier = 'playwright'
    playwright = await import(specifier)
  } catch {
    throw new Error(
      'this reproduction uses browser steps but playwright is not installed.\n' +
        '  npm i -D playwright && npx playwright install chromium',
    )
  }
  const browser = await playwright.chromium.launch({ headless: !ctx.headed })
  const context = await browser.newContext()
  if (ctx.trace) {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  }
  const page = await context.newPage()
  page.on('console', (msg: any) => ctx.onLog?.(`[browser:${msg.type()}] ${msg.text()}`))
  page.on('pageerror', (err: Error) => ctx.onLog?.(`[browser:pageerror] ${err.message}`))
  page.on('response', (res: any) => {
    ctx.network.push({
      step: -1,
      label: 'browser',
      method: res.request().method(),
      url: res.url(),
      status: res.status(),
      duration_ms: 0,
    })
  })
  ctx.browser = { browser, context, page }
  return ctx.browser
}

export async function closeBrowser(ctx: ExecContext): Promise<void> {
  if (!ctx.browser) return
  try {
    if (ctx.trace) await ctx.browser.context.tracing.stop({ path: ctx.run.file('trace.zip') })
    await ctx.browser.context.close()
    await ctx.browser.browser.close()
  } catch {
    // Closing is best-effort; a dead browser is not a reproduction result.
  }
  ctx.browser = undefined
}

async function execBrowser(step: Step, index: number, ctx: ExecContext): Promise<Observed> {
  const { page } = await getBrowser(ctx)
  const screenshots: string[] = []
  const consoleBefore = ctx.network.length
  let exception: string | undefined

  for (const action of step.browser as BrowserAction[]) {
    const [key, value] = Object.entries(action)[0] ?? []
    if (!key) continue
    try {
      await applyBrowserAction(page, key, value, ctx, index, screenshots)
    } catch (err) {
      exception = err instanceof Error ? err.message : String(err)
      const shot = ctx.run.file(`screenshots/step-${index + 1}-failure.png`)
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {})
      screenshots.push(shot)
      break
    }
  }

  const html: string = await page.content().catch(() => '')
  const lastResponse = ctx.network.slice(consoleBefore).filter((n) => n.status !== undefined).pop()
  return {
    kind: 'browser',
    label: '',
    status: lastResponse?.status,
    body: clip(html),
    exception,
    screenshots,
    duration_ms: 0,
  }
}

async function applyBrowserAction(
  page: any,
  key: string,
  value: any,
  ctx: ExecContext,
  index: number,
  screenshots: string[],
): Promise<void> {
  switch (key) {
    case 'goto':
      await page.goto(resolveUrl(String(value), ctx.baseUrl), { waitUntil: 'domcontentloaded' })
      return
    case 'click':
      await page.click(String(value))
      return
    case 'fill': {
      const { selector, value: text } = normalizePair(value)
      await page.fill(selector, text)
      return
    }
    case 'type': {
      const { selector, value: text } = normalizePair(value)
      await page.type(selector, text)
      return
    }
    case 'select': {
      const { selector, value: text } = normalizePair(value)
      await page.selectOption(selector, text)
      return
    }
    case 'press': {
      const { selector, value: text } = normalizePair(value)
      await page.press(selector || 'body', text)
      return
    }
    case 'wait_for':
      await page.waitForSelector(String(value))
      return
    case 'wait':
      await delay(Number(value))
      return
    case 'expect_text':
    case 'wait_for_text': {
      // Polls rather than reading once: a click that triggers a fetch has not
      // updated the DOM by the time the click promise resolves.
      const { selector, value: text } = normalizePair(value)
      try {
        await page.waitForFunction(
          ([sel, want]: [string, string]) => {
            // Runs in the page, so the DOM lib is not available at build time.
            const el = (globalThis as any).document?.querySelector(sel)
            return String(el?.textContent ?? '').includes(want)
          },
          [selector, text],
          { timeout: 10_000 },
        )
      } catch {
        const actual = await page.textContent(selector).catch(() => null)
        throw new Error(
          `expected ${selector} to contain ${JSON.stringify(text)}, got ${JSON.stringify(actual)}`,
        )
      }
      return
    }
    case 'expect_visible':
      await page.waitForSelector(String(value), { state: 'visible' })
      return
    case 'screenshot': {
      const name = String(value || `step-${index + 1}`)
      const file = ctx.run.file(`screenshots/${name}.png`)
      await page.screenshot({ path: file, fullPage: true })
      screenshots.push(file)
      return
    }
    case 'eval': {
      await page.evaluate(String(value))
      return
    }
    default:
      throw new Error(`unknown browser action: ${key}`)
  }
}

/** Accept both `fill: {selector, value}` and `fill: ["#id", "text"]`. */
function normalizePair(value: unknown): { selector: string; value: string } {
  if (Array.isArray(value)) return { selector: String(value[0]), value: String(value[1] ?? '') }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return { selector: String(o.selector ?? o.target ?? ''), value: String(o.value ?? o.text ?? '') }
  }
  return { selector: String(value), value: '' }
}

// ---------------------------------------------------------------- services

export type RunningService = {
  name: string
  child: ChildProcess
  log: string[]
}

export type ServiceHandle = {
  services: RunningService[]
  logs(): string
  stop(): Promise<void>
  writeLogs(run: RunDir): Promise<void>
}

export async function startServices(
  services: Service[],
  ctx: {
    root: string
    env: Record<string, string>
    baseUrl?: string
    vars: Record<string, string>
    onLog?: (line: string) => void
  },
): Promise<ServiceHandle> {
  const running: RunningService[] = []
  const handle: ServiceHandle = {
    services: running,
    logs: () => running.map((s) => s.log.join('')).join('\n'),
    stop: () => stopAll(running),
    async writeLogs(run) {
      for (const svc of running) {
        await run.write(`${safeName(svc.name)}.log`, svc.log.join(''))
      }
    },
  }

  try {
    for (const raw of services) {
      const service = interpolate(raw, ctx.vars)
      const name = service.name ?? firstWord(service.command)
      const child = spawn(service.command, {
        cwd: service.cwd ? path.resolve(ctx.root, service.cwd) : ctx.root,
        env: { ...process.env, ...ctx.env, ...service.env } as NodeJS.ProcessEnv,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
      const entry: RunningService = { name, child, log: [] }
      const capture = (d: Buffer) => {
        const text = d.toString()
        entry.log.push(text)
        ctx.onLog?.(text)
      }
      child.stdout?.on('data', capture)
      child.stderr?.on('data', capture)
      child.on('error', (err) => entry.log.push(`[repro] failed to start: ${err.message}\n`))
      running.push(entry)

      await waitForReady(service, entry, ctx.baseUrl)
    }
  } catch (err) {
    await stopAll(running)
    throw err
  }
  return handle
}

async function waitForReady(
  service: Service,
  entry: RunningService,
  baseUrl?: string,
): Promise<void> {
  const wait = service.wait_for ?? inferWaitFor(baseUrl)
  const timeout = wait?.timeout_ms ?? 60_000
  if (!wait) {
    await delay(1000)
    return
  }
  const deadline = Date.now() + timeout
  for (;;) {
    if (entry.child.exitCode !== null) {
      throw new Error(
        `service "${entry.name}" exited with code ${entry.child.exitCode} before becoming ready\n` +
          indent(entry.log.join('').slice(-2000)),
      )
    }
    if (await isReady(wait, entry)) return
    if (Date.now() > deadline) {
      throw new Error(
        `service "${entry.name}" not ready after ${timeout}ms (${describeWait(wait)})\n` +
          indent(entry.log.join('').slice(-2000)),
      )
    }
    await delay(250)
  }
}

function inferWaitFor(baseUrl?: string): WaitForish | undefined {
  if (!baseUrl) return undefined
  try {
    const url = new URL(baseUrl)
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    return { port, timeout_ms: 60_000 }
  } catch {
    return undefined
  }
}

type WaitForish = NonNullable<Service['wait_for']>

async function isReady(wait: WaitForish, entry: RunningService): Promise<boolean> {
  if (wait.log) return entry.log.join('').includes(wait.log)
  if (wait.http) {
    try {
      const res = await fetch(wait.http, { signal: AbortSignal.timeout(2000) })
      return res.status < 500
    } catch {
      return false
    }
  }
  if (wait.port) return portOpen(wait.port)
  return true
}

function describeWait(wait: WaitForish): string {
  if (wait.log) return `waiting for log ${JSON.stringify(wait.log)}`
  if (wait.http) return `waiting for ${wait.http}`
  if (wait.port) return `waiting for port ${wait.port}`
  return 'no readiness check'
}

/**
 * Confirm an application repro did not start is actually answering.
 *
 * Used for `--base-url`, where the caller says the app is already up. Without
 * this every step fails with its own connection error and the run reads as a
 * scenario problem; with it the run is INVALID, which is what "I could not get
 * to the point where the bug is observable" has always meant here.
 *
 * Any HTTP answer counts, 404 and 500 included: something is listening and
 * speaking HTTP, which is all this can honestly claim.
 */
export async function assertReachable(baseUrl: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(2000) })
      return
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    if (Date.now() > deadline) {
      throw new Error(
        `nothing is answering at ${baseUrl} after ${timeoutMs}ms (${last}).\n` +
          'start the application, or drop --base-url and let the spec\'s `services:` start it.',
      )
    }
    await delay(250)
  }
}

export function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1500)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function stopAll(running: RunningService[]): Promise<void> {
  await Promise.all(running.map(killTree))
  running.length = 0
}

/**
 * Kill the service and everything it spawned. Dev servers routinely fork
 * children; killing only the shell leaves the port bound and the next run
 * silently talks to a stale process.
 */
async function killTree(svc: RunningService): Promise<void> {
  const child = svc.child
  if (child.exitCode !== null || child.pid === undefined) return
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-child.pid, 'SIGTERM')
    }
  } catch {
    child.kill('SIGTERM')
  }
  const timedOut = await Promise.race([exited.then(() => false), delay(5000).then(() => true)])
  if (timedOut) {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

function firstWord(command: string): string {
  return command.trim().split(/\s+/)[0] ?? 'service'
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_')
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
}
