import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'

import {
  aggregate,
  classify,
  contractHash,
  evaluatePolicy,
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
  matchValue,
  parseTrace,
  noisePaths,
  orderedSpec,
  parseCurl,
  sliceSpec,
  slugify,
  validateJsonSchema,
  validateSpec,
  wilson,
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

// --------------------------------------------------------------------- agent

const TRACE_LINES = [
  'starting up',                                   // agents log; not JSON, ignored
  '{"type":"model","name":"planner","input":"refund order 123"}',
  '{"type":"tool_call","tool":"refund_order","arguments":{"order_id":"123","amount":4200}}',
  '{"type":"tool_result","name":"refund_order","result":{"ok":true}}',
  '{"type":"output","output":{"status":"refunded","order_id":123},"usage":{"total_tokens":960}}',
].join('\n')

test('parseTrace reads JSONL, a whole trace, and framework spellings', () => {
  const trace = parseTrace(TRACE_LINES)
  assert.equal(trace.events.length, 3)
  const call = trace.events[1]
  assert.equal(call.name, 'refund_order', '`tool` is the same field as `name`')
  assert.deepEqual(call.input, { order_id: '123', amount: 4200 }, '`arguments` is the same field as `input`')
  assert.deepEqual(trace.events[2].output, { ok: true }, '`result` is the same field as `output`')
  assert.deepEqual(trace.output, { status: 'refunded', order_id: 123 })
  assert.equal(trace.usage.total_tokens, 960)

  const whole = parseTrace(JSON.stringify({ events: [{ type: 'message' }], output: 'hi' }))
  assert.equal(whole.events.length, 1)
  assert.equal(whole.output, 'hi')
  assert.deepEqual(parseTrace('not json at all').events, [])
})

const agentObserved = (trace, duration_ms = 1200) => ({
  kind: 'agent',
  label: 'request',
  trace,
  json: trace,
  duration_ms,
})

test('a trace matches on the tool called and the arguments it was called with', () => {
  const o = agentObserved(parseTrace(TRACE_LINES))
  assert.equal(matchOutcome({ trace: { tool_call: { name: 'refund_order' } } }, o).ok, true)
  assert.equal(
    matchOutcome({ trace: { tool_call: { name: 'refund_order', arguments: { amount: { greater_than: 100 } } } } }, o).ok,
    true,
  )
  const tooSmall = matchOutcome(
    { trace: { tool_call: { name: 'refund_order', arguments: { amount: { greater_than: 9000 } } } } },
    o,
  )
  assert.equal(tooSmall.ok, false)
  assert.match(tooSmall.reasons[0], /amount 4200 is not > 9000/)
  assert.match(matchOutcome({ trace: { tool_call: { name: 'send_email' } } }, o).reasons[0], /no tool_call "send_email"/)
})

test('a trace matches on how many times a tool was called', () => {
  const looping = parseTrace(
    Array.from({ length: 12 }, () => '{"type":"tool_call","name":"web_search","input":{}}').join('\n'),
  )
  const o = agentObserved(looping)
  assert.equal(matchOutcome({ trace: { tool_call: { name: 'web_search', count: { greater_than: 10 } } } }, o).ok, true)
  assert.equal(matchOutcome({ trace: { tool_call: { name: 'web_search', count: 12 } } }, o).ok, true)
  // Zero matches is a count, not an absence: an explicit count must still hold.
  assert.equal(matchOutcome({ trace: { tool_call: { name: 'nope', count: 0 } } }, o).ok, true)
})

test('a trace matches on what the agent did NOT do first', () => {
  const unguarded = { trace: { sequence: { contains: [{ tool: 'refund_order' }], not_preceded_by: { tool: 'get_order' } } } }
  assert.equal(matchOutcome(unguarded, agentObserved(parseTrace(TRACE_LINES))).ok, true)

  const checked = parseTrace(
    [
      '{"type":"tool_call","name":"get_order","input":{"order_id":"123"}}',
      '{"type":"tool_call","name":"refund_order","input":{"order_id":"123"}}',
    ].join('\n'),
  )
  const guarded = matchOutcome(unguarded, agentObserved(checked))
  assert.equal(guarded.ok, false)
  assert.match(guarded.reasons[0], /preceded by get_order/)

  const missing = matchOutcome({ trace: { sequence: { contains: [{ tool: 'transfer_money' }] } } }, agentObserved(checked))
  assert.match(missing.reasons[0], /does not contain transfer_money/)
})

test('a trace matches on duration, usage and structured output', () => {
  const trace = parseTrace(TRACE_LINES)
  const o = agentObserved(trace, 12_000)
  assert.equal(matchOutcome({ duration_ms: { greater_than: 10_000 } }, o).ok, true)
  assert.equal(matchOutcome({ usage: { total_tokens: { greater_than: 50_000 } } }, o).ok, false)
  // Schema validity is unknown unless the step declared a schema to check.
  assert.match(matchOutcome({ output: { schema: { valid: false } } }, o).reasons[0], /no `output_schema`/)
  const validated = agentObserved({ ...trace, schema_valid: false, schema_errors: ['$.order_id is number'] })
  assert.equal(matchOutcome({ output: { schema: { valid: false } } }, validated).ok, true)
  assert.equal(matchOutcome({ output: { contains: 'refunded' } }, o).ok, true)
})

test('an object of comparators is a comparison; any other object is a value', () => {
  assert.equal(matchValue({ greater_than: 1 }, 2, 'x'), undefined)
  assert.match(matchValue({ greater_than: 1 }, 'two', 'x'), /is not a number/)
  // `{ state: 'WA' }` is an expected value, not a comparator soup.
  assert.equal(matchValue({ state: 'WA' }, { state: 'WA' }, 'x'), undefined)
  assert.match(matchValue({ state: 'WA' }, { state: 'CA' }, 'x'), /!=/)
  assert.equal(matchValue('SAVE20', 'SAVE20', 'x'), undefined)
})

test('validateJsonSchema catches the shapes agents actually get wrong', () => {
  const schema = {
    type: 'object',
    required: ['status', 'order_id'],
    properties: { status: { type: 'string' }, order_id: { type: 'string' } },
    additionalProperties: false,
  }
  assert.deepEqual(validateJsonSchema(schema, { status: 'ok', order_id: '123' }), [])
  assert.match(validateJsonSchema(schema, { status: 'ok', order_id: 123 })[0], /order_id is number/)
  assert.match(validateJsonSchema(schema, { status: 'ok' })[0], /order_id is required/)
  assert.match(validateJsonSchema(schema, { status: 'ok', order_id: '1', extra: 1 })[0], /not allowed/)
  assert.match(validateJsonSchema({ type: 'object' }, 'a string')[0], /expected object/)
})

// ------------------------------------------------------- outcomes / baseline

test('an unreached target is INVALID, never a passing run', () => {
  const spec = { name: 'x', scenario: [], failure: { reproduce: { status: 500 } } }
  const run = (status) => ({ status, run_id: '1', run_dir: '', duration_ms: 1, steps: [], artifacts: [], network: [], log_excerpt: '' })

  const noneValid = aggregate(spec, [run('invalid'), run('invalid')])
  assert.equal(noneValid.status, 'invalid', 'a precondition failure is not "not reproduced"')
  assert.equal(noneValid.reproduction_rate, 0)
  assert.equal(noneValid.invalid, 2)

  // INVALID runs are excluded from the denominator, not counted as passes.
  const mixed = aggregate(spec, [run('reproduced'), run('not_reproduced'), run('invalid'), run('error')])
  assert.equal(mixed.reproduction_rate, 0.5)
  assert.equal(mixed.invalid, 1)
  assert.equal(mixed.errors, 1)
  assert.equal(aggregate(spec, [run('error')]).status, 'error')
})

test('wilson widens the interval when the sample is small', () => {
  const [lo10, hi10] = wilson(1, 10)
  const [lo1000, hi1000] = wilson(100, 1000)
  assert.ok(hi10 - lo10 > hi1000 - lo1000, 'ten runs must be less certain than a thousand')
  assert.deepEqual(wilson(0, 0), [0, 0])
  assert.ok(wilson(0, 100)[1] < 0.05)
})

test('the contract hash ignores prose and key order, not the bug definition', () => {
  const spec = {
    name: 'x',
    description: 'checkout explodes',
    scenario: [{ http: { url: '/a' } }],
    failure: { reproduce: { status: 500 } },
  }
  const reordered = { failure: spec.failure, scenario: spec.scenario, name: spec.name }
  assert.equal(contractHash(spec), contractHash(reordered))
  assert.equal(contractHash(spec), contractHash({ ...spec, description: 'reworded' }))
  assert.notEqual(contractHash(spec), contractHash({ ...spec, failure: { reproduce: { status: 502 } } }))
})

test('an elimination policy is only checked when it is declared', () => {
  const result = { failures: 0, successes: 500, reproduction_rate: 0 }
  assert.equal(evaluatePolicy(undefined, result), undefined)
  assert.equal(evaluatePolicy({ trials: 500 }, result), undefined, 'trials alone declares no threshold')
  assert.equal(evaluatePolicy({ reproduced: { max: 0 } }, result).result, 'PASS')
  assert.equal(evaluatePolicy({ reproduced: { max: 0 } }, { ...result, failures: 1 }).result, 'FAIL')
  assert.equal(evaluatePolicy({ reproduction_rate: { less_than: 0.01 } }, { ...result, reproduction_rate: 0.02 }).result, 'FAIL')
  // No valid run means no measurement, so no policy can pass on it.
  assert.equal(evaluatePolicy({ reproduced: { max: 0 } }, { failures: 0, successes: 0, reproduction_rate: 0 }).result, 'FAIL')
})

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

test('establish, seal and verify hold the contract still', { timeout: 300_000 }, () => {
  // Isolated .repro so the baseline and seal do not land in the example.
  const dir = path.join(os.tmpdir(), `repro-seal-${process.pid}`, '.repro')
  mkdirSync(dir, { recursive: true })
  const spec = path.join(dir, 'repro.yaml')
  writeFileSync(spec, readFileSync(path.join(exampleRoot, '.repro', 'repro.yaml')))
  // verify exits non-zero while the bug still reproduces; that is the point.
  const at = (...args) => {
    try {
      return cliOutput([...args, '--spec', spec, '--root', exampleRoot, '--quiet'])
    } catch (err) {
      if (err.stdout) return err.stdout
      throw err
    }
  }

  try {
    const baseline = JSON.parse(at('establish', '--repeat', '2', '--json'))
    assert.equal(baseline.reproduced, 2)
    assert.equal(baseline.reproduction_rate, 1)

    const sealed = JSON.parse(at('seal', '--json'))
    assert.equal(sealed.contract, baseline.contract)

    const verified = JSON.parse(at('verify', '--repeat', '1', '--json'))
    assert.equal(verified.contract, 'UNCHANGED')
    assert.equal(verified.current.reproduced, 1)
    assert.equal(verified.policy.result, 'FAIL', 'the bug still reproduces, so the policy must fail')

    // Editing the definition of the bug cannot be hidden from a later verify.
    writeFileSync(spec, readFileSync(spec, 'utf8').replace('status: 500', 'status: 502'))
    const drifted = JSON.parse(at('verify', '--repeat', '1', '--json'))
    assert.equal(drifted.contract, 'MODIFIED')
    assert.notEqual(drifted.current_contract, drifted.sealed_contract)
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true })
  }
})

test('a failed precondition is reported as INVALID and is untestable to bisect', { timeout: 120_000 }, () => {
  const dir = path.join(os.tmpdir(), `repro-invalid-${process.pid}`, '.repro')
  mkdirSync(dir, { recursive: true })
  const spec = path.join(dir, 'repro.yaml')
  writeFileSync(
    spec,
    [
      'name: precondition-guard',
      'base_url: http://localhost:3100',
      'services:',
      '  - command: npm run dev',
      '    wait_for: { http: http://localhost:3100/health, timeout_ms: 30000 }',
      'scenario:',
      '  - name: impossible precondition',
      '    http: { method: GET, url: /health }',
      '    expect: { status: 999 }',
      '  - name: checkout',
      '    http: { method: POST, url: /api/checkout }',
      'failure:',
      '  step: checkout',
      '  reproduce: { status: 500 }',
      '',
    ].join('\n'),
  )
  try {
    const run = JSON.parse(cliOutput(['run', '--json', '--spec', spec, '--root', exampleRoot]))
    assert.equal(run.status, 'invalid')
    assert.match(run.error, /precondition failed/)

    let code = 0
    try {
      execFileSync(process.execPath, [cli, 'run', '--exit-code', '--quiet', '--spec', spec, '--root', exampleRoot], { cwd: exampleRoot })
    } catch (err) {
      code = err.status
    }
    assert.equal(code, 125, 'an unreached target is untestable, not good')
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true })
  }
})

test('an agent bug reproduces on its trace, with the trajectory as evidence', { timeout: 120_000 }, () => {
  const run = JSON.parse(cliOutput(['run', '--json', '--spec', '.repro/agent.yaml']))
  assert.equal(run.status, 'reproduced')
  assert.match(run.failure.trajectory, /tool_call refund_order/)
  assert.ok(
    run.artifacts.some((a) => a.endsWith(path.join('traces', '01.json'))),
    'the trace itself is the evidence and must be kept',
  )

  // Same contract, agent no longer taking the bug path.
  const dir = path.join(os.tmpdir(), `repro-agent-${process.pid}`, '.repro')
  mkdirSync(dir, { recursive: true })
  const spec = path.join(dir, 'repro.yaml')
  writeFileSync(
    spec,
    readFileSync(path.join(exampleRoot, '.repro', 'agent.yaml'), 'utf8').replace(
      'AGENT_BUG_RATE: "1"',
      'AGENT_BUG_RATE: "0"',
    ),
  )
  try {
    const fixed = JSON.parse(cliOutput(['run', '--json', '--spec', spec, '--root', exampleRoot]))
    assert.equal(fixed.status, 'not_reproduced')
    assert.match(fixed.failure.mismatch.join(' '), /no tool_call "refund_order"/)
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true })
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
