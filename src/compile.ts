/**
 * The compiler: bug evidence -> repro.yaml draft.
 *
 * Everything here is deterministic. Repo facts come from reading the repo;
 * HTTP steps come from parsing HAR/curl/logs. What repro cannot know — the
 * exact user journey implied by prose — is left as explicit TODOs plus a
 * COMPILE.md briefing for whichever coding agent is driving. That keeps repro
 * model-independent: no API key, no vendor, no hidden inference.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dumpSpec, REPRO_DIR, SPEC_FILE, type Matcher, type Spec, type Step } from './spec.js'

// ------------------------------------------------------------- repo facts

export type ProjectFacts = {
  root: string
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun'
  framework?: string
  language: 'typescript' | 'javascript' | 'unknown'
  scripts: Record<string, string>
  devCommand?: string
  setupCommands: string[]
  /**
   * Scripts that look like they destroy data. Detected, named, and deliberately
   * NOT written into `setup:` — see the note where they are classified.
   */
  destructiveSetupCommands: string[]
  baseUrl?: string
  healthUrl?: string
  database?: string
  testRunner?: string
  hasPlaywright: boolean
  envExample?: string
  notes: string[]
}

/** Words that mean "this throws data away". Matched against the script NAME. */
const DESTRUCTIVE_SCRIPT = /(reset|seed|drop|wipe|truncate|flush|purge|clean|nuke)/i

const FRAMEWORKS: [string, string][] = [
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['@remix-run/react', 'Remix'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['astro', 'Astro'],
  ['@nestjs/core', 'NestJS'],
  ['fastify', 'Fastify'],
  ['express', 'Express'],
  ['koa', 'Koa'],
  ['hono', 'Hono'],
  ['vite', 'Vite'],
]

const DEFAULT_PORTS: Record<string, number> = {
  'Next.js': 3000,
  Nuxt: 3000,
  Remix: 3000,
  SvelteKit: 5173,
  Astro: 4321,
  Vite: 5173,
  NestJS: 3000,
}

export async function detectProject(root: string): Promise<ProjectFacts> {
  const facts: ProjectFacts = {
    root,
    packageManager: 'npm',
    language: 'unknown',
    scripts: {},
    setupCommands: [],
    destructiveSetupCommands: [],
    hasPlaywright: false,
    notes: [],
  }

  const pkgPath = path.join(root, 'package.json')
  let pkg: Record<string, any> = {}
  if (existsSync(pkgPath)) {
    pkg = JSON.parse(await readFile(pkgPath, 'utf8').catch(() => '{}'))
  } else {
    facts.notes.push('no package.json found — repro cannot infer how to start this app')
  }

  facts.scripts = (pkg.scripts ?? {}) as Record<string, string>
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies }

  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) facts.packageManager = 'pnpm'
  else if (existsSync(path.join(root, 'yarn.lock'))) facts.packageManager = 'yarn'
  else if (existsSync(path.join(root, 'bun.lockb'))) facts.packageManager = 'bun'

  facts.language =
    existsSync(path.join(root, 'tsconfig.json')) || 'typescript' in deps ? 'typescript' : 'javascript'

  for (const [dep, name] of FRAMEWORKS) {
    if (dep in deps) {
      facts.framework = name
      break
    }
  }

  const run = (script: string) => runScript(facts.packageManager, script)
  const devScript = ['dev', 'start:dev', 'serve', 'start'].find((s) => s in facts.scripts)
  if (devScript) facts.devCommand = run(devScript)

  // `setup:` runs before EVERY iteration, so an inferred `db:seed` that nobody
  // read becomes a hundred reseeds under `--repeat 100`, against whatever
  // DATABASE_URL happens to be live. A tool whose whole argument is "do not
  // trust the inference" must not quietly infer a command that destroys data:
  // these are detected and named, and the author decides.
  for (const candidate of ['db:reset', 'db:migrate', 'migrate', 'prisma:migrate', 'seed', 'db:seed']) {
    if (!(candidate in facts.scripts)) continue
    if (DESTRUCTIVE_SCRIPT.test(candidate)) facts.destructiveSetupCommands.push(run(candidate))
    else facts.setupCommands.push(run(candidate))
  }
  if (facts.destructiveSetupCommands.length) {
    facts.notes.push(
      `${facts.destructiveSetupCommands.join(', ')} look like they reset data — left OUT of ` +
        '`setup:` and listed as comments in the spec. `setup:` runs before every iteration.',
    )
  }

  if (existsSync(path.join(root, 'prisma', 'schema.prisma'))) facts.database = 'Prisma'
  else if (existsSync(path.join(root, 'drizzle.config.ts'))) facts.database = 'Drizzle'
  else if ('mongoose' in deps) facts.database = 'Mongoose'
  else if ('pg' in deps || 'postgres' in deps) facts.database = 'Postgres'
  for (const compose of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml']) {
    if (existsSync(path.join(root, compose))) {
      facts.notes.push(`${compose} present — services may need \`docker compose up -d\` in setup`)
      break
    }
  }

  facts.testRunner = ['vitest', 'jest', 'mocha', 'ava'].find((t) => t in deps)
  facts.hasPlaywright = '@playwright/test' in deps || 'playwright' in deps

  const port = detectPort(facts)
  if (port) {
    facts.baseUrl = `http://localhost:${port}`
    facts.healthUrl = facts.baseUrl
  }

  for (const envFile of ['.env.example', '.env.sample', '.env.template']) {
    if (existsSync(path.join(root, envFile))) {
      facts.envExample = envFile
      break
    }
  }
  return facts
}

function runScript(pm: ProjectFacts['packageManager'], script: string): string {
  return pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`
}

export function detectPort(facts: ProjectFacts): number | undefined {
  const haystack = Object.values(facts.scripts).join(' ')
  const explicit =
    /(?:--port[= ]|-p[= ])(\d{2,5})/.exec(haystack) ?? /PORT[= ](\d{2,5})/.exec(haystack)
  if (explicit?.[1]) return Number(explicit[1])
  if (facts.framework && facts.framework in DEFAULT_PORTS) return DEFAULT_PORTS[facts.framework]
  return undefined
}

// -------------------------------------------------------------- scaffolding

export function slugify(text: string, max = 6): string {
  const stop = new Set([
    'the', 'a', 'an', 'when', 'after', 'and', 'is', 'are', 'to', 'of', 'in', 'on', 'i', 'my',
    'it', 'that', 'with', 'for', 'then', 'but', 'sometimes', 'always',
  ])
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !stop.has(w))
    .slice(0, max)
  return words.join('-') || 'bug'
}

export type DraftInput = {
  description: string
  facts: ProjectFacts
  scenario?: Step[]
  reproduce?: Matcher
  expect?: Matcher
  baseUrl?: string
  raw?: string
  source?: string
}

export function draftSpec(input: DraftInput): Spec {
  const { facts } = input
  const setup: Step[] = facts.setupCommands.map((command) => ({ shell: command }))
  const spec: Spec = {
    name: slugify(input.description),
    description: input.description.trim(),
    base_url: input.baseUrl ?? facts.baseUrl,
    ...(setup.length ? { setup } : {}),
    ...(facts.devCommand
      ? {
          services: [
            {
              name: 'app',
              command: facts.devCommand,
              wait_for: facts.healthUrl ? { http: facts.healthUrl, timeout_ms: 120000 } : undefined,
            },
          ],
        }
      : {}),
    scenario:
      input.scenario && input.scenario.length
        ? input.scenario
        : [
            {
              name: 'TODO: replace with the first real step of the reproduction',
              http: { method: 'GET', url: '/' },
              expect: { status: 200 },
            },
          ],
    failure: {
      expect: input.expect ?? { status: 200 },
      reproduce: input.reproduce ?? { status: 500 },
    },
  }
  return spec
}

export type ScaffoldResult = {
  reproDir: string
  specPath: string
  briefPath: string
  reportPath?: string
  facts: ProjectFacts
  spec: Spec
  complete: boolean
}

export async function scaffold(
  root: string,
  input: DraftInput,
  opts: { force?: boolean; complete?: boolean } = {},
): Promise<ScaffoldResult> {
  const reproDir = path.join(root, REPRO_DIR)
  const specPath = path.join(reproDir, SPEC_FILE)
  if (existsSync(specPath) && !opts.force) {
    throw new Error(`${path.relative(root, specPath)} already exists — pass --force to overwrite`)
  }
  const spec = draftSpec(input)
  await mkdir(path.join(reproDir, 'fixtures'), { recursive: true })
  await mkdir(path.join(reproDir, 'scripts'), { recursive: true })
  await writeFile(specPath, header(input) + dumpSpec(spec))

  let reportPath: string | undefined
  if (input.raw) {
    reportPath = path.join(reproDir, 'report.md')
    await writeFile(reportPath, input.raw)
  }

  const briefPath = path.join(reproDir, 'COMPILE.md')
  await writeFile(briefPath, briefing(input, spec, opts.complete === true))
  return {
    reproDir,
    specPath,
    briefPath,
    reportPath,
    facts: input.facts,
    spec,
    complete: opts.complete === true,
  }
}

function header(input: DraftInput): string {
  return [
    '# Reproduction spec — edit freely, this file is the source of truth.',
    `# Bug report${input.source ? ` (from ${input.source})` : ''}:`,
    ...input.description
      .trim()
      .split('\n')
      .map((l) => `#   ${l}`),
    ...(input.raw ? ['# Full report: .repro/report.md'] : []),
    // Offered rather than inferred. `setup:` runs before every iteration, so a
    // reseed nobody read runs once per repetition against the live database.
    // Uncommenting is a decision; having it appear in the file is not.
    ...(input.facts.destructiveSetupCommands.length
      ? [
          '#',
          '# These scripts were detected and deliberately NOT added to `setup:` —',
          '# setup runs before EVERY iteration, so `--repeat 100` would run them a',
          '# hundred times against whatever database is configured. Move them in',
          '# yourself if this reproduction needs a clean slate:',
          '#',
          '# setup:',
          ...input.facts.destructiveSetupCommands.map((c) => `#   - shell: ${c}`),
        ]
      : []),
    '',
  ].join('\n')
}

function briefing(input: DraftInput, spec: Spec, complete: boolean): string {
  const f = input.facts
  const todo = complete
    ? []
    : [
        '## What repro could not infer',
        '',
        'The scenario below is a stub. Replace it with the real sequence of',
        'actions that triggers the bug. Everything else was detected from the repo.',
        '',
      ]

  return `# Compile this reproduction

repro turned the bug report into a draft spec at \`.repro/repro.yaml\`.
${complete ? 'Steps were extracted from the supplied evidence.' : 'The scenario still needs to be written.'}

## The bug report

> ${(input.raw ?? input.description).trim().split('\n').join('\n> ')}

## What repro detected

| fact | value |
| --- | --- |
| framework | ${f.framework ?? 'unknown'} |
| language | ${f.language} |
| package manager | ${f.packageManager} |
| start command | ${f.devCommand ?? 'unknown'} |
| base url | ${spec.base_url ?? 'unknown'} |
| database | ${f.database ?? 'none detected'} |
| setup scripts | ${f.setupCommands.join(', ') || 'none detected'} |
${f.destructiveSetupCommands.length ? `| destructive scripts | ${f.destructiveSetupCommands.join(', ')} — NOT in setup:, see the comments in repro.yaml |\n` : ''}
| test runner | ${f.testRunner ?? 'none'} |
| playwright | ${f.hasPlaywright ? 'installed' : 'not installed'} |
${f.envExample ? `| env template | ${f.envExample} |\n` : ''}
${f.notes.map((n) => `- note: ${n}`).join('\n')}

${todo.join('\n')}
## Your job

1. Read the code paths the report implicates.
2. Fill in \`scenario:\` with concrete, executable steps.
3. Set \`failure.reproduce\` to the observable symptom (status, exception, log line).
4. Run \`repro run\` until it prints \`FAILURE REPRODUCED\`.
5. Run \`repro run --repeat 10\` to measure whether the bug is deterministic or flaky.
6. Run \`repro minimize\` to cut the scenario down to what actually matters.

Do not fix the bug yet. A reproduction that fails reliably is the deliverable.

## Step reference

\`\`\`yaml
scenario:
  # shell
  - shell: npm run seed
    expect: { exit_code: 0 }

  # http — url is relative to base_url
  - name: create user
    http:
      method: POST
      url: /api/users
      json: { email: test@example.com }
    expect: { status: 201 }
    save: { userId: $.id }          # reuse later as \${userId}

  - http: { method: POST, url: /api/users/\${userId}/cart }

  # browser (needs playwright installed)
  - browser:
      - goto: /checkout
      - fill: { selector: "#coupon", value: SAVE20 }
      - click: "#submit"
      - wait_for: "#error"
      - screenshot: after-submit

  # agent — anything that prints a JSON or JSONL trace on stdout
  - id: request
    agent:
      run: node agents/support.mjs
      input: { message: "Please refund order 123" }
      output_schema: .repro/schemas/reply.json   # optional
      env: { TEMPERATURE: "0.7" }
      # trace_file: .repro/traces/captured.jsonl  # instead of, or as well as run

  # pause
  - sleep: 250
\`\`\`

### Matcher fields

\`status\`, \`status_in\`, \`status_not\`, \`body_contains\`, \`body_matches\` (regex),
\`json\` (map of \`$.path\` to expected value), \`exception\`, \`exit_code\`,
\`stdout_contains\`, \`stderr_contains\`, \`logs_contain\`.

For agent steps, also \`trace\`, \`output\`, \`duration_ms\` and \`usage\`:

\`\`\`yaml
reproduce:
  trace:
    tool_call:
      name: refund_order
      arguments: { amount: { greater_than: 100 } }
      count: { greater_than: 10 }        # omit for "at least once"
    sequence:
      contains: [{ tool: transfer_money }]
      not_preceded_by: { tool: verify_identity }
  output: { schema: { valid: false } }   # needs output_schema on the step
  usage: { total_tokens: { greater_than: 50000 } }
  duration_ms: { greater_than: 10000 }
\`\`\`

Comparators: \`equals\`, \`not_equals\`, \`greater_than\`, \`greater_than_or_equal\`,
\`less_than\`, \`less_than_or_equal\`, \`contains\`, \`matches\`, \`exists\`, \`missing\`.
An agent step's whole trace also reads as JSON: \`json: { $.output.status: ok }\`
in a matcher, \`save: { id: $.output.order_id }\` to capture from it.

### Rules that matter

- \`failure.reproduce\` defines "reproduced". Make it specific — \`{ status: 500 }\`
  alone will also match an unrelated crash.
- An \`expect\` on a step *before* the failure step is a precondition. If it
  fails, the run is reported as invalid, not as a reproduction. Use this to
  stop the minimizer from deleting steps that silently matter.
- Mark a step \`keep: true\` to protect it from the minimizer.
- \`failure.step\` selects the failing step by id, name, or 1-based index.
  It defaults to the last step.
`
}

// -------------------------------------------------------------- importers

export type Imported = {
  scenario: Step[]
  reproduce?: Matcher
  expect?: Matcher
  baseUrl?: string
  description: string
  /** The original report, preserved verbatim for the agent to read. */
  raw?: string
  source: string
  notes: string[]
}

export async function importEvidence(file: string): Promise<Imported> {
  const text = await readFile(file, 'utf8')
  const ext = path.extname(file).toLowerCase()
  const base = path.basename(file)

  if (ext === '.har' || text.trimStart().startsWith('{"log"')) return fromHar(text, base)
  if (ext === '.curl' || /^\s*curl\s/.test(text)) return fromCurl(text, base)
  return fromText(text, base)
}

const ASSET = /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm)(\?|$)/i

export function fromHar(text: string, source: string): Imported {
  const har = JSON.parse(text)
  const entries: any[] = har?.log?.entries ?? []
  const notes: string[] = []
  const scenario: Step[] = []
  let baseUrl: string | undefined
  let reproduce: Matcher | undefined

  const interesting = entries.filter((e) => {
    const url: string = e?.request?.url ?? ''
    if (!url || ASSET.test(url)) return false
    const mime: string = e?.response?.content?.mimeType ?? ''
    const method: string = e?.request?.method ?? 'GET'
    return method !== 'GET' || /json|text\/plain/.test(mime) || /\/api\//.test(url)
  })

  if (interesting.length === 0) notes.push('no non-asset requests found in the HAR')

  for (const entry of interesting) {
    const url = new URL(entry.request.url)
    baseUrl ??= url.origin
    const headers = pickHeaders(entry.request.headers ?? [])
    const bodyText: string | undefined = entry.request.postData?.text
    const step: Step = {
      http: {
        method: entry.request.method,
        url: `${url.pathname}${url.search}`,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(bodyText ? bodyOrJson(bodyText) : {}),
      },
    }
    const status: number | undefined = entry.response?.status
    if (status !== undefined && status < 400) step.expect = { status }
    scenario.push(step)
    if (status !== undefined && status >= 400) {
      reproduce = { status }
      const body: string | undefined = entry.response?.content?.text
      const exception = body ? extractErrorMessage(body) : undefined
      if (exception) reproduce.exception = exception
    }
  }

  // The failing request is the interesting one; drop anything recorded after it.
  const lastFailure = scenario.findIndex((s, i) => interesting[i]?.response?.status >= 400)
  const trimmed = lastFailure >= 0 ? scenario.slice(0, lastFailure + 1) : scenario
  if (lastFailure >= 0 && lastFailure < scenario.length - 1) {
    notes.push(`dropped ${scenario.length - lastFailure - 1} requests recorded after the failure`)
  }
  if (trimmed.at(-1)) delete trimmed[trimmed.length - 1]!.expect

  return {
    scenario: trimmed,
    reproduce,
    expect: { status: 200 },
    baseUrl,
    description: `Imported from ${source} (${trimmed.length} requests).`,
    source,
    notes,
  }
}

function pickHeaders(headers: { name: string; value: string }[]): Record<string, string> {
  const keep = new Set(['content-type', 'accept', 'authorization', 'cookie', 'x-csrf-token'])
  const out: Record<string, string> = {}
  for (const h of headers) {
    const name = h.name.toLowerCase()
    if (name.startsWith(':')) continue
    if (keep.has(name)) out[name] = h.value
  }
  return out
}

function bodyOrJson(text: string): { json: unknown } | { body: string } {
  try {
    return { json: JSON.parse(text) }
  } catch {
    return { body: text }
  }
}

export function fromCurl(text: string, source: string): Imported {
  const commands = text
    .replace(/\\\r?\n/g, ' ')
    .split(/\n(?=\s*curl\s)/)
    .map((c) => c.trim())
    .filter((c) => c.startsWith('curl'))

  const scenario: Step[] = []
  let baseUrl: string | undefined
  for (const command of commands) {
    const parsed = parseCurl(command)
    if (!parsed) continue
    baseUrl ??= parsed.origin
    scenario.push({ http: parsed.http })
  }
  return {
    scenario,
    baseUrl,
    description: `Imported from ${source} (${scenario.length} curl requests).`,
    source,
    notes: scenario.length ? [] : ['no curl commands recognized'],
  }
}

/** Tokenize a curl command well enough for the flags people actually paste. */
export function parseCurl(command: string): { http: NonNullable<Step['http']>; origin?: string } | undefined {
  const tokens = tokenize(command)
  if (!tokens.length) return undefined
  let method: string | undefined
  let url: string | undefined
  const headers: Record<string, string> = {}
  let body: string | undefined

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    switch (token) {
      case '-X':
      case '--request':
        method = tokens[++i]
        break
      case '-H':
      case '--header': {
        const raw = tokens[++i] ?? ''
        const sep = raw.indexOf(':')
        if (sep > 0) headers[raw.slice(0, sep).trim().toLowerCase()] = raw.slice(sep + 1).trim()
        break
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
										body = tokens[++i]
        break
      case '-b':
      case '--cookie':
        headers.cookie = tokens[++i] ?? ''
        break
      case '-u':
      case '--user': {
        const creds = tokens[++i] ?? ''
        headers.authorization = `Basic ${Buffer.from(creds).toString('base64')}`
        break
      }
      case '-A':
      case '--user-agent':
        headers['user-agent'] = tokens[++i] ?? ''
        break
      default:
        if (!token.startsWith('-') && /^https?:\/\//i.test(token)) url = token
        else if (token === '--url') url = tokens[++i]
    }
  }
  if (!url) return undefined
  const parsed = new URL(url)
  const http: NonNullable<Step['http']> = {
    method: (method ?? (body ? 'POST' : 'GET')).toUpperCase(),
    url: `${parsed.pathname}${parsed.search}`,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(body ? bodyOrJson(body) : {}),
  }
  return { http, origin: parsed.origin }
}

function tokenize(command: string): string[] {
  const tokens: string[] = []
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g
  for (const m of command.matchAll(re)) {
    tokens.push(m[1] ?? (m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]!))
  }
  return tokens
}

/** `POST /api/x 500`, `"POST /api/x HTTP/1.1" 500`, and common access-log shapes. */
const HTTP_LINE =
  /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+"?((?:https?:\/\/[^\s"]+)|\/[^\s"]*)"?(?:\s+HTTP\/[\d.]+"?)?(?:\s+-)?(?:\s+([1-5]\d{2}))?/g

/** A production log can hold thousands of lines; a scenario should not. */
const MAX_IMPORTED_STEPS = 40

/**
 * Best-effort extraction from a log file, issue body, or pasted stack trace.
 * Whatever is recognized becomes real steps; the raw text is preserved in the
 * description so the agent can read what repro could not parse.
 */
export function fromText(text: string, source: string): Imported {
  const notes: string[] = []
  const scenario: Step[] = []
  let baseUrl: string | undefined
  let failingStatus: number | undefined

  // Embedded curl commands win — they are complete requests.
  const curlBlocks = text.match(/curl\s[^\n]*(?:\\\n[^\n]*)*/g) ?? []
  for (const block of curlBlocks) {
    const parsed = parseCurl(block.replace(/\\\n/g, ' '))
    if (!parsed) continue
    baseUrl ??= parsed.origin
    scenario.push({ http: parsed.http })
  }

  if (!scenario.length) {
    for (const m of text.matchAll(HTTP_LINE)) {
      const [, method, target, status] = m
      if (!method || !target) continue
      // Repeats are kept deliberately: "changed the address twice" is exactly
      // the kind of duplicate that carries the bug.
      let url = target
      if (/^https?:\/\//i.test(target)) {
        const parsed = new URL(target)
        baseUrl ??= parsed.origin
        url = `${parsed.pathname}${parsed.search}`
      }
      const step: Step = { http: { method, url } }
      const code = status ? Number(status) : undefined
      if (code !== undefined && code < 400) step.expect = { status: code }
      if (code !== undefined && code >= 400) failingStatus = code
      scenario.push(step)
    }
    if (scenario.length > MAX_IMPORTED_STEPS) {
      notes.push(
        `found ${scenario.length} requests, kept the last ${MAX_IMPORTED_STEPS} — trim or extend by hand`,
      )
      scenario.splice(0, scenario.length - MAX_IMPORTED_STEPS)
    }
  }

  const exception = extractErrorMessage(text)
  if (!scenario.length) notes.push('no HTTP requests or curl commands found — scenario left as a stub')

  const reproduce: Matcher = {}
  if (failingStatus) reproduce.status = failingStatus
  if (exception) reproduce.exception = exception
  if (!Object.keys(reproduce).length) {
    reproduce.status = 500
    notes.push('no failing status or exception found — guessed `status: 500`, fix it')
  }
  if (scenario.at(-1)) delete scenario[scenario.length - 1]!.expect

  return {
    scenario,
    reproduce,
    expect: { status: 200 },
    baseUrl,
    description: title(text),
    raw: text.trim(),
    source,
    notes,
  }
}

/** First meaningful line of a report, used as the spec name and description. */
export function title(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 3)
  return (line ?? 'imported bug report').slice(0, 200)
}

/** Pull the most specific-looking error line out of free text. */
export function extractErrorMessage(text: string): string | undefined {
  const patterns = [
    /^\s*((?:[A-Z]\w*)?(?:Error|Exception|Panic)(?::| -)\s*[^\n]{3,160})/m,
    /\b(Cannot read propert(?:y|ies)[^\n]{0,120})/,
    /\b(undefined is not (?:a function|an object)[^\n]{0,120})/,
    /\b(null pointer[^\n]{0,120})/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    const found = match?.[1]?.trim()
    if (found) return found.replace(/\s+/g, ' ').slice(0, 160)
  }
  return undefined
}
