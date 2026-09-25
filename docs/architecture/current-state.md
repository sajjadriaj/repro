# repro — current state

Repository archaeology as of commit `67071a9` (repro 0.2.0). Everything below
is read off the code, not the README; where the two disagree the code wins and
the disagreement is noted.

## Purpose

repro turns a bug report into an executable reproduction and hands a coding
agent an objective definition of "the bug". It is not a capture daemon and it
is not a replay engine. It is a **scenario re-executor**: a human or agent
writes `.repro/repro.yaml`, repro runs that scenario against the application,
observes the designated failure step, and says whether the failure signature
matched. The README states the identity in three lines that constrain every
design decision below:

- "There is no model inside repro." No API key, no vendor, no inference.
- "Reproduction, not replay." The agent runs fresh every time.
- "It has one responsibility: turn bugs into executable reproductions."

## Execution model

```
loadSpec()                       spec.ts      .repro/repro.yaml -> Spec
runReproduction(loaded, opts)    run.ts       N x executeOnce, then aggregate
  executeOnce()                  run.ts       one run:
    1. setup steps               exec.ts        runStep() per step; non-zero exit => INVALID
    2. services                  exec.ts        startServices(); readiness probe; or --base-url
    3. scenario steps            exec.ts        runStep() per step -> Observed
    4. teardown                  exec.ts        always
    5. evaluate()                run.ts         preconditions, then failure.reproduce matcher
    6. evidence                  evidence.ts    .repro/runs/NNNN/
aggregate()                      run.ts       rate over valid runs, Wilson interval,
                                              DETERMINISTIC / FLAKY / RARE, confidence
```

Services start once per `runReproduction` invocation (lazily, after the first
run's setup) unless `restart_services: true`. `--base-url` skips services and
asserts the URL is reachable, otherwise the run is INVALID.

### Step kinds

`stepKindOf()` dispatches on the first executable key present:

| kind | executor | what it observes |
| --- | --- | --- |
| `shell` | `execShell` → `spawnCapture` | exit code, stdout, stderr, timeout |
| `http` | `execHttp` → `fetch` | status, headers, body, parsed JSON, extracted exception |
| `browser` | `execBrowser` → Playwright | last response status, page HTML, exception, screenshots |
| `agent` | `execAgent` → `spawnCapture` + `parseTrace` | normalized `AgentTrace`, stdout/stderr, exit code, schema validity |
| `sleep` | `delay` | nothing |

Every kind returns the same `Observed` shape, so one `Matcher` covers all of
them. Agent traces are additionally exposed as `Observed.json`, so `save:` and
`json:` path matchers work on a trace the way they do on an HTTP body.

### Outcomes

Four, never three: `reproduced`, `not_reproduced`, `invalid` (a precondition
never held, so the failure step was never observable), `error` (repro itself
could not execute the contract). `invalid` and `error` are excluded from the
reproduction rate and map to exit code 125 under `--exit-code`.

A run is `reproduced` only if every earlier step that declared `expect` still
held. That rule is what stops an unrelated breakage from masquerading as the
bug and what stops the minimizer from deleting load-bearing steps.

## Capture lifecycle

repro captures **what repro itself did** during a run it drove. It does not
observe the application or agent from the inside.

Per run, `evidence.ts` allocates `.repro/runs/NNNN/` and points `latest` at
it. Written there:

| file | source | contents |
| --- | --- | --- |
| `result.json` | run.ts | verdict, per-step `Observed[]`, failure report, timings, artifact list |
| `network.json` | exec.ts | every HTTP exchange repro made (`http` steps: full request/response; browser: method/url/status only) |
| `service.log` | run.ts | this run's slice of the supervised services' stdout/stderr |
| `browser.log` | exec.ts | console messages and page errors |
| `screenshots/` | exec.ts | explicit `screenshot:` actions and an automatic one at a failing browser action |
| `trace.zip` | exec.ts | Playwright trace (`--trace`) |
| `traces/NN.json` | exec.ts | normalized `AgentTrace` per agent step |

Payloads are clipped (`clip()`, 64 KiB default; 8 KiB request bodies, 32 KiB
response bodies in network.json). Minimizer and explain probes use a scratch
run dir and write no evidence.

**Not captured today:** subprocess trees spawned by services, shell steps or
agents; filesystem mutations made by any step; network calls the application
or the agent makes outbound (including model API calls); environment
variables (deliberately, see fingerprint); git working-tree contents per run.

## Reproduction lifecycle

```
repro init "<bug>"  |  repro from <evidence>     compile.ts   scaffold spec + COMPILE.md brief
        ↓  (coding agent writes scenario:)
repro run [--repeat N]                            run.ts       verdict, rate, classification
repro minimize                                    minimize.ts  drop steps, keep only load-bearing ones
repro explain                                     explain.ts   necessity, causal state probe, noise subtraction, code paths
repro establish --repeat N                        seal.ts      baseline.json: measured rate + hashes + fingerprint
repro seal                                        seal.ts      seal.json: contract frozen against that baseline
        ↓  (coding agent fixes the code)
repro verify [--repeat N]                         seal.ts      re-run, compare against baseline, apply verify: policy
repro status                                      seal.ts      has the contract moved? no execution
repro hook                                        hook.ts      Claude Code Stop hook: seal picks the polarity
repro bisect --good --bad                         bisect.ts    the reproduction as the git bisect predicate
repro export --test                               cli.ts       vitest / jest / node:test regression file
```

`verify` always runs against the **current working tree**. There is no mode
that re-runs against the state recorded at seal time; `bisect` is the only
command that checks anything out, and it does so through git bisect.

## Artifact and data model

All types live in `src/`; the library surface re-exports them from `index.ts`.

| type | file | role |
| --- | --- | --- |
| `Spec`, `Step`, `Service`, `FailureSpec`, `VerifyPolicy` | spec.ts | the contract |
| `Matcher` | spec.ts | one assertion vocabulary for every step kind |
| `Observed` | spec.ts | uniform observation per step |
| `RunResult`, `RepeatResult`, `FailureReport` | run.ts | one run; N runs aggregated |
| `NetworkEntry`, `RunDir` | evidence.ts | HTTP exchange record; evidence bundle handle |
| `AgentTrace`, `AgentEvent`, `AgentUsage`, `AgentStep` | agent.ts | normalized agent trajectory and the `agent:` step |
| `TraceMatcher`, `EventMatcher`, `SequenceMatcher`, `OutputMatcher`, `NumberMatcher` | agent.ts | trajectory assertions |
| `Fingerprint`, `Baseline`, `Seal` | seal.ts | environment identity; measurement; frozen contract |
| `VerifyReport`, `StatusReport` | seal.ts | comparison outputs |
| `ExplainReport`, `StateDiff` | explain.ts | boundary and divergence evidence |
| `MinimizeResult`, `Prober` | minimize.ts | delta reduction |
| `ProjectFacts`, `Imported`, `DraftInput` | compile.ts | repo detection; evidence importers |

### The trace model (agent.ts)

```
AgentEvent { type, name?, input?, output?, timestamp? }
  type ∈ model | tool_call | tool_result | retrieval | handoff | message | custom
AgentTrace { input?, events[], output?, duration_ms?, usage?, schema_valid?, schema_errors? }
```

`parseTrace()` accepts one JSON object with `events`, a JSON array, or JSONL
with one event per line; non-JSON lines are ignored. Field aliases:
`tool`≡`name`, `arguments`≡`args`≡`input`, `result`≡`output`. A line with
`type: output` (or an untyped line with `output`) is the final answer; `type:
usage` carries token counts. Unknown event types are **dropped** by the
`EVENT_TYPES` whitelist.

The trace is flat. There is no step grouping, no parent/child relation
between a model decision and the tool call it produced, and no link from a
`tool_call` to anything physical.

### The seal (seal.ts)

Three hashes over the spec, canonicalised (sorted keys, `undefined` removed):

| hash | keys | invalidates |
| --- | --- | --- |
| contract | `EXECUTION_KEYS` + `verify` | the verdict comparison (`verify` exits 2) |
| execution | `name env vars setup scenario failure teardown restart_services stop_on_expect_fail` | the baseline (`seal` refuses) |
| spec environment | `base_url`, `services`, hashed per key | nothing; reported as drift |

Plus `fixtureHash()` over `.repro/fixtures/**` and `.repro/scripts/**`, and a
`Fingerprint`. Legacy seals (no `execution` field) are compared with the
pre-split hash so they keep verifying.

### The fingerprint (seal.ts)

`os`, `arch`, `node`, `repro` version, `git_commit` (short), `git_dirty`,
and a short hash per lockfile found from an allowlist of eight. Never
environment variables, credentials, or working-tree contents. Recorded at
`establish` and `seal`; compared at `verify` and `status`; **not** recorded
per run.

## CLI

`cli.ts` uses `node:util.parseArgs` with one flat option table shared by all
commands. Commands: `init`, `from`, `run`, `establish`, `seal`, `verify`,
`status`, `hook`, `minimize`, `explain`, `bisect`, `export --test`. Every
command takes `--json`, `--spec`, `--root`, `--quiet`, `--timeout`. Exit
codes: `run --exit-code` follows git bisect (0 good, 1 reproduced, 125
untestable); `verify` and `status` exit 2 on a modified contract or fixtures.

## Supported applications and workloads

- `detectProject()` reads `package.json`, lockfiles, framework deps, scripts,
  Prisma/Drizzle/Mongoose/pg, docker-compose presence, `.env.example`. It
  targets JavaScript/TypeScript web applications; anything else gets
  `language: unknown` and no start command.
- The executor is ecosystem-agnostic: any process for `shell`/`services`, any
  HTTP server for `http`, Chromium via optional Playwright for `browser`, any
  process that prints JSON/JSONL for `agent`.
- The shipped example is a Node HTTP shop with a real checkout bug, plus a
  browser spec and a support agent with a stochastic double-refund bug driven
  by `AGENT_BUG_RATE`.

## Network handling

repro is an HTTP **client**, not an observer. `http` steps go through global
`fetch` with `redirect: 'manual'` and a per-step timeout; each exchange is
pushed to `ctx.network` and written to `network.json`. Browser steps record
`page.on('response')` as method/url/status with `step: -1`. `explain` uses
`network.json` for `diffNetworks()`, `diffTail()` and `noisePaths()`.

There is no proxy, no interception of the application's or the agent's own
outbound calls, and no response recording or replay of any kind.

## Filesystem handling

None during a run. The only filesystem hashing is `fixtureHash()` over the
two fixture directories at establish/seal/verify/status time. `codePaths()`
in explain checks that file references pulled out of stack traces exist under
the root, which is a read, not a capture.

## Process handling

- Services: `spawn(command, { shell: true, detached: true })` as a process
  group; readiness by `http`, `port`, `log`, or inferred from `base_url`;
  stdout/stderr accumulated per service; killed as a group with SIGTERM then
  SIGKILL after 5 s (`taskkill /T /F` on Windows).
- Shell and agent steps: `spawnCapture()` with `shell: true`, stdout/stderr
  buffered, SIGKILL on timeout, optional stdin. Agent steps get the step's
  `input` as one JSON line on stdin and `spec.env` + `agent.env` merged over
  `process.env`.
- Nothing observes what those processes spawn.

## Environment capture

Only the `Fingerprint` above. `spec.env` and `services[].env` are inputs, and
the spec environment hash covers `services` (values hashed, never printed).

## Verification and assertion mechanisms

- `Matcher` fields: `status`, `status_in`, `status_not`, `body_contains`,
  `body_matches`, `json` (`$.path` → value), `exception`, `exit_code`,
  `stdout_contains`, `stderr_contains`, `logs_contain`, and for agents
  `trace`, `output`, `duration_ms`, `usage`. AND semantics; every failed
  clause is reported as a reason.
- `trace` matchers: `tool_call`, `tool_result`, `retrieval`, `message`,
  `model`, `handoff`, `event` (with `type`), each taking `name`,
  `name_matches`, `arguments`, `output`, `count`; and `sequence` with
  `contains` (ordered subsequence) and `not_preceded_by`.
- Value matchers: an object whose keys are all comparators is a comparison
  (`equals`, `not_equals`, `greater_than`, `greater_than_or_equal`,
  `less_than`, `less_than_or_equal`, `contains`, `matches`, `exists`,
  `missing`); any other value is compared structurally.
- `output_schema` on an agent step validates the final output against a JSON
  Schema subset (type, required, properties, items, enum,
  additionalProperties, bounds).
- Preconditions: `expect` on any step before the failure step.
- `failure.reproduce` defines reproduced; `failure.expect` is informational
  and used by `export`.
- `verify:` policy: `trials`, `reproduced.max`, `reproduction_rate.less_than`
  / `less_than_or_equal`. Evaluated over valid runs only.

## Extension points

Ordered by how cheaply the codebase lets a new capability in:

1. **A new field on `Observed` plus a new `Matcher` clause.** `runStep()`
   already funnels every kind into one shape and `matchOutcome()` already
   delegates agent-specific clauses to `matchAgent()`. Adding an observation
   is one field, one clause, one reason string.
2. **A new field on `AgentEvent`.** `normalizeEvent()` is the single place
   framework spellings are reconciled; `EventMatcher` is the single place a
   new field becomes assertable.
3. **Evidence files.** `RunDir.write()` accepts any relative path; `result.artifacts`
   lists what a run left behind.
4. **A new importer in `compile.ts`.** `importEvidence()` dispatches on
   extension and content sniffing to `fromHar`, `fromCurl`, `fromText`; each
   returns `Imported { scenario, reproduce, expect, baseUrl, description, raw, notes }`.
5. **A new step kind.** The `switch` in `runStep()`, `stepKindOf()`, and
   `validateSpec()`'s error text. The last kind added (`agent`) touched only
   those plus its own module.
6. **`RunOptions.onPhase` / `onProgress` callbacks** for reporting.
7. **`Fingerprint` fields** in `fingerprint()` and `environmentDrift()`.
8. **The library surface** (`index.ts`): every module is exported, so a
   harness can compose `executeOnce`, `makeProber`, `parseTrace` directly.
9. **The Claude Code Stop hook** (`hook.ts`) is the one existing agent
   integration. It runs the reproduction and emits a block decision; it reads
   nothing from the agent's transcript.

## Tests

One file, `test/repro.test.mjs`, 50 tests under `node:test`, run against
`dist/` after `tsc`. Roughly: 35 unit tests (matchers, JSON path,
interpolation, spec validation, slicing, classification, curl/HAR/text
importers, project detection, network diffing, trace parsing and matching,
JSON Schema subset, aggregation, Wilson, the three hashes, policy) and 10
end-to-end tests that boot the example app (reproduce → minimize to 5 steps
→ explain boundary; browser with trace and screenshot; establish → seal →
verify → drift; INVALID precondition and exit 125; agent trace reproduced and
not reproduced; `--root` anchoring; `--exit-code`; symlinked CLI; unreachable
`--base-url`; `status` without execution; hook install merging).

## Known limitations

Stated in the README or visible in the code:

- Tool virtualization for agents (stub / record / replay with side effects
  captured rather than performed) is not implemented; an agent's tools run
  for real.
- Semantic failures ("the assistant claimed X") need a `shell` step that reads
  the trace and exits non-zero.
- The agent contract is stdout/stdin JSON only; there is no SDK, proxy or
  framework hook, so anything the agent does not print is invisible.
- The trace is flat; no grouping into agent steps, no correlation to
  processes, files or network.
- `explain` probes state only through the scenario's own GET `http` steps;
  agent and shell steps contribute stack-trace file paths and nothing else.
- Filesystem, subprocess and outbound-network effects of any step are not
  observed, so "did the agent edit `auth.ts`" cannot be asserted.
- The fingerprint is recorded at establish/seal, not per run, so two runs
  cannot be compared on environment.
- The minimizer is greedy, not full ddmin. JSON Schema is a subset.
- `detectProject` knows the Node ecosystem only.
- `verify` runs only against the current working tree; there is no way to
  re-run a sealed contract against the sealed commit.
