import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import {
  classify,
  confidenceOf,
  detectProject,
  diffNetworks,
  extractErrorMessage,
  failureStepIndex,
  fromHar,
  fromText,
  interpolate,
  jsonPath,
  matchOutcome,
  noisePaths,
  orderedSpec,
  parseCurl,
  sliceSpec,
  slugify,
  validateSpec,
} from '../dist/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const exampleRoot = path.join(repoRoot, 'example')
const cli = path.join(repoRoot, 'dist', 'cli.js')

// ------------------------------------------------------------------ matching

test('matchOutcome requires every declared clause', () => {
  const observed = { kind: 'http', label: 'x', status: 500, body: '{"error":"boom"}', duration_ms: 1 }
  assert.equal(matchOutcome({ status: 500 }, observed).ok, true)
  assert.equal(matchOutcome({ status: 500, body_contains: 'boom' }, observed).ok, true)
  assert.equal(matchOutcome({ status: 500, body_contains: 'nope' }, observed).ok, false)
  assert.equal(matchOutcome({ status: 200 }, observed).ok, false)
})

test('matchOutcome explains what differed', () => {
  const observed = { kind: 'http', label: 'x', status: 404, duration_ms: 1 }
  const result = matchOutcome({ status: 500 }, observed)
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], /status 404 != 500/)
})

test('matchOutcome finds exceptions in the body when there is no envelope', () => {
  const observed = { kind: 'http', label: 'x', status: 500, body: 'TypeError: nope', duration_ms: 1 }
  assert.equal(matchOutcome({ exception: 'TypeError' }, observed).ok, true)
})

test('matchOutcome checks service logs', () => {
  const observed = { kind: 'http', label: 'x', status: 500, duration_ms: 1 }
  assert.equal(matchOutcome({ logs_contain: 'ECONNRESET' }, observed, 'boom ECONNRESET').ok, true)
  assert.equal(matchOutcome({ logs_contain: 'ECONNRESET' }, observed, 'all good').ok, false)
})

test('jsonPath reads nested values and arrays', () => {
  const doc = { cart: { items: [{ sku: 'widget' }], total: 10 } }
  assert.equal(jsonPath(doc, '$.cart.total'), 10)
  assert.equal(jsonPath(doc, '$.cart.items[0].sku'), 'widget')
  assert.equal(jsonPath(doc, '$.cart.missing'), undefined)
  assert.equal(jsonPath(doc, '$.cart.items[3].sku'), undefined)
})

test('interpolate substitutes variables everywhere in a step', () => {
  const step = { http: { url: '/api/cart/${id}', headers: { 'x-session': '${sid}' } } }
  const out = interpolate(step, { id: '42', sid: 's1' })
  assert.equal(out.http.url, '/api/cart/42')
  assert.equal(out.http.headers['x-session'], 's1')
  // Unknown names are left alone rather than silently blanked.
  assert.equal(interpolate('${nope}', {}), '${nope}')
})

// ---------------------------------------------------------------------- spec

test('validateSpec rejects specs that cannot define a failure', () => {
  assert.throws(() => validateSpec({ scenario: [], failure: { reproduce: { status: 500 } } }), /name/)
  assert.throws(() => validateSpec({ name: 'x', scenario: [] }), /failure/)
  assert.throws(
    () => validateSpec({ name: 'x', scenario: [], failure: { reproduce: {} } }),
    /matches everything/,
  )
  assert.throws(
    () => validateSpec({ name: 'x', scenario: [{ nonsense: 1 }], failure: { reproduce: { status: 1 } } }),
    /no executable key/,
  )
})

test('failureStepIndex resolves by name, index, and default', () => {
  const spec = {
    name: 'x',
    scenario: [{ shell: 'a' }, { name: 'checkout', shell: 'b' }, { shell: 'c' }],
    failure: { reproduce: { status: 500 } },
  }
  assert.equal(failureStepIndex(spec), 2)
  assert.equal(failureStepIndex({ ...spec, failure: { ...spec.failure, step: 'checkout' } }), 1)
  assert.equal(failureStepIndex({ ...spec, failure: { ...spec.failure, step: 1 } }), 0)
  assert.throws(() => failureStepIndex({ ...spec, failure: { ...spec.failure, step: 9 } }), /range/)
})

// ----------------------------------------------------------------- minimizer

test('sliceSpec re-anchors the failure step after removals', () => {
  const spec = {
    name: 'x',
    scenario: [{ shell: 'a' }, { shell: 'b' }, { shell: 'c' }, { shell: 'd' }],
    failure: { step: 4, reproduce: { status: 500 } },
  }
  const sliced = sliceSpec(spec, [0, 3], 3)
  assert.equal(sliced.scenario.length, 2)
  assert.equal(sliced.failure.step, 2)
  assert.equal(sliced.scenario[1].shell, 'd')
})

test('orderedSpec keeps caller order and allows repeats', () => {
  const spec = {
    name: 'x',
    scenario: [{ shell: 'a' }, { shell: 'b' }],
    failure: { reproduce: { status: 500 } },
  }
  const ordered = orderedSpec(spec, [1, 0, 1])
  assert.deepEqual(
    ordered.scenario.map((s) => s.shell),
    ['b', 'a', 'b'],
  )
  assert.equal(ordered.failure.step, 3)
})

// ------------------------------------------------------------- classification

test('classify separates deterministic, flaky, rare and clean', () => {
  assert.equal(classify(1, 5), 'DETERMINISTIC')
  assert.equal(classify(0.85, 20), 'FLAKY')
  assert.equal(classify(0.1, 20), 'RARE')
  assert.equal(classify(0, 20), 'NOT REPRODUCED')
  assert.equal(classify(0, 0), 'NOT REPRODUCED')
})

test('confidence reflects how much was measured, not how bad the bug is', () => {
  assert.equal(confidenceOf(1, 1), 'LOW')
  assert.equal(confidenceOf(1, 3), 'HIGH')
  assert.equal(confidenceOf(0.5, 4), 'MEDIUM')
  assert.equal(confidenceOf(0, 10), 'HIGH')
})

// -------------------------------------------------------------------- compile

test('parseCurl handles the flags people actually paste', () => {
  const parsed = parseCurl(
    `curl -X PUT 'http://localhost:3000/api/shipping-address?x=1' -H 'Content-Type: application/json' -H 'X-Session: s1' -d '{"state":"WA"}'`,
  )
  assert.equal(parsed.http.method, 'PUT')
  assert.equal(parsed.http.url, '/api/shipping-address?x=1')
  assert.equal(parsed.origin, 'http://localhost:3000')
  assert.equal(parsed.http.headers['x-session'], 's1')
  assert.deepEqual(parsed.http.json, { state: 'WA' })
})

test('parseCurl infers POST from a body', () => {
  const parsed = parseCurl(`curl https://api.example.com/v1/orders -d 'a=1'`)
  assert.equal(parsed.http.method, 'POST')
  assert.equal(parsed.http.body, 'a=1')
})

test('fromText keeps repeated requests and finds the failing status', () => {
  const imported = fromText(
    [
      'POST /api/session 201',
      'PUT /api/shipping-address 200',
      'PUT /api/shipping-address 200',
      'POST /api/checkout 500',
      "TypeError: Cannot read properties of null (reading 'toUpperCase')",
    ].join('\n'),
    'issue.md',
  )
  assert.equal(imported.scenario.length, 4)
  assert.equal(imported.scenario[1].http.url, '/api/shipping-address')
  assert.equal(imported.scenario[2].http.url, '/api/shipping-address')
  assert.equal(imported.scenario[0].expect.status, 201)
  // The failing step carries no expect — its failure is the point.
  assert.equal(imported.scenario[3].expect, undefined)
  assert.equal(imported.reproduce.status, 500)
  assert.match(imported.reproduce.exception, /Cannot read properties of null/)
})

test('fromText prefers embedded curl commands over log lines', () => {
  const imported = fromText(`curl -X POST 'http://x.test/api/pay' -d '{}'\nGET /noise 200`, 'bug.txt')
  assert.equal(imported.scenario.length, 1)
  assert.equal(imported.scenario[0].http.url, '/api/pay')
  assert.equal(imported.baseUrl, 'http://x.test')
})

test('fromText says so when it found nothing to execute', () => {
  const imported = fromText('the checkout page feels slow sometimes', 'vague.md')
  assert.equal(imported.scenario.length, 0)
  assert.ok(imported.notes.some((n) => /no HTTP requests/.test(n)))
  assert.ok(imported.notes.some((n) => /guessed/.test(n)))
})

test('fromHar drops assets, keeps API calls, and stops at the failure', () => {
  const har = JSON.stringify({
    log: {
      entries: [
        entry('GET', 'http://localhost:3000/app.css', 200, 'text/css'),
        entry('POST', 'http://localhost:3000/api/session', 201, 'application/json'),
        entry('POST', 'http://localhost:3000/api/checkout', 500, 'application/json', '{"error":"TypeError: boom"}'),
        entry('GET', 'http://localhost:3000/api/telemetry', 200, 'application/json'),
      ],
    },
  })
  const imported = fromHar(har, 'checkout.har')
  assert.equal(imported.baseUrl, 'http://localhost:3000')
  assert.deepEqual(
    imported.scenario.map((s) => s.http.url),
    ['/api/session', '/api/checkout'],
  )
  assert.equal(imported.scenario[0].expect.status, 201)
  assert.equal(imported.reproduce.status, 500)
  assert.ok(imported.notes.some((n) => /after the failure/.test(n)))
})

function entry(method, url, status, mimeType, text) {
  return {
    request: { method, url, headers: [{ name: 'Content-Type', value: 'application/json' }] },
    response: { status, content: { mimeType, text } },
  }
}

test('extractErrorMessage picks the specific line', () => {
  assert.match(extractErrorMessage('info\nTypeError: bad thing happened\nmore'), /TypeError: bad thing/)
  assert.match(extractErrorMessage('Cannot read properties of undefined (reading "x")'), /Cannot read/)
  assert.equal(extractErrorMessage('everything is fine'), undefined)
})

test('slugify makes a usable spec name', () => {
  assert.equal(
    slugify('Checkout returns 500 after changing the shipping address'),
    'checkout-returns-500-changing-shipping-address',
  )
  assert.equal(slugify('!!!'), 'bug')
})

test('detectProject reads the example app', async () => {
  const facts = await detectProject(exampleRoot)
  assert.equal(facts.packageManager, 'npm')
  assert.equal(facts.devCommand, 'npm run dev')
  assert.equal(facts.baseUrl, 'http://localhost:3100')
  assert.deepEqual(facts.setupCommands, ['npm run db:reset', 'npm run seed'])
})

// -------------------------------------------------------------------- explain

test('diffNetworks pairs repeated requests by occurrence', () => {
  const good = [
    net('GET', 'http://x/api/cart', 200, '{"tax_region":"WA"}'),
    net('GET', 'http://x/api/cart', 200, '{"tax_region":"WA"}'),
  ]
  const bad = [
    net('GET', 'http://x/api/cart', 200, '{"tax_region":"WA"}'),
    net('GET', 'http://x/api/cart', 200, '{"tax_region":null}'),
  ]
  const diffs = diffNetworks(good, bad)
  assert.equal(diffs.length, 1)
  assert.equal(diffs[0].path, '$.tax_region')
  assert.equal(diffs[0].without_step, 'WA')
  assert.equal(diffs[0].with_step, null)
})

test('noisePaths captures fields that change between identical runs', () => {
  const a = [net('POST', 'http://x/api/session', 201, '{"session":"s1","stable":1}')]
  const b = [net('POST', 'http://x/api/session', 201, '{"session":"s2","stable":1}')]
  const noise = noisePaths(a, b)
  assert.ok(noise.has('$.session'))
  assert.ok(!noise.has('$.stable'))
})

function net(method, url, status, body) {
  return { step: 1, label: '', method, url, status, response_body: body, duration_ms: 1 }
}

// ------------------------------------------------------------------------ e2e

test('the example bug reproduces, minimizes to 5 steps, and reports a boundary', { timeout: 180_000 }, () => {
  const run = JSON.parse(cliOutput(['run', '--json']))
  assert.equal(run.status, 'reproduced')
  assert.equal(run.failure.actual_status, 500)
  assert.equal(run.classification, 'DETERMINISTIC')

  const min = JSON.parse(cliOutput(['minimize', '--json']))
  assert.equal(min.original_steps, 12)
  assert.equal(min.minimal_steps, 5)
  assert.deepEqual(min.steps, [
    'create session',
    'set shipping address to CA',
    'change shipping address to WA',
    'apply coupon SAVE20',
    'checkout',
  ])
  assert.equal(min.confirmed.reproduced, min.confirmed.runs)

  const why = JSON.parse(cliOutput(['explain', '--json']))
  assert.equal(why.boundary.label, 'apply coupon SAVE20')
  const taxRegion = why.state_diff.find((d) => d.path === '$.cart.tax_region')
  assert.ok(taxRegion, 'expected the tax_region divergence in the state diff')
  assert.equal(taxRegion.without_step, 'WA')
  assert.equal(taxRegion.with_step, null)
  assert.ok(why.relevant_code_paths.some((p) => p.startsWith('src/tax.mjs')))
  // Session ids change every run and must not be reported as a state change.
  assert.ok(why.nondeterministic_fields.includes('$.session'))
})

test('the same bug reproduces through the browser, with a trace and screenshot', { timeout: 180_000 }, () => {
  const run = JSON.parse(cliOutput(['run', '--json', '--trace', '--spec', '.repro/browser.yaml']))
  assert.equal(run.status, 'reproduced')
  assert.equal(run.failure.step, 'place order')
  const dir = path.dirname(run.artifacts[0])
  for (const artifact of ['trace.zip', 'browser.log', 'network.json', 'screenshots/checkout-result.png']) {
    assert.ok(existsSync(path.join(dir, artifact)), `expected evidence: ${artifact}`)
  }
})

test('--exit-code follows the git bisect contract', () => {
  let code = 0
  try {
    execFileSync(process.execPath, [cli, 'run', '--exit-code', '--quiet'], { cwd: exampleRoot })
  } catch (err) {
    code = err.status
  }
  assert.equal(code, 1, 'a reproducing bug must exit 1 so git bisect calls the commit bad')
})

function cliOutput(args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: exampleRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}
