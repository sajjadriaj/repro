# repro

**Turn any bug report into a reproduction your coding agent can run.**

![repro reproducing, measuring, minimizing and verifying a checkout bug](docs/demo.gif)

Coding agents are good at fixing bugs and bad at reproducing them. Given
*"checkout sometimes fails after I change my address and apply a coupon"*, an
agent will read some code, guess, patch something plausible, and declare victory
without ever having seen the bug happen.

`repro` supplies the missing step. It turns a bug report into an executable
scenario, proves the failure happens, measures how often, cuts it down to the
steps that matter, and hands the agent an objective signal to work against:

```
$ repro run --json
{ "status": "reproduced", "reproduction_rate": 1.0, ... }
```

Fix the bug. Run it again. `"status": "not_reproduced"` means done — not "the
model thinks it's done".

repro is not another coding agent. It is the reproduction layer underneath
whichever one you use.


## Contents

- [Why](#why)
- [Install](#install)
- [Quick start](#quick-start)
- [The spec](#the-spec)
- [Commands](#commands)
- [The gate](#repro-hook)
- [Spec reference](#spec-reference)
- [LLM agents](#llm-agents)
- [Agent integration](#agent-integration)
- [Evidence](#evidence)
- [Try it](#try-it)
- [Design principles](#design-principles)
- [Non-goals](#non-goals)
- [Development](#development)


## Why

Bug fixing starts with reproduction. Humans know this:

```
report -> reproduce -> understand -> fix -> verify
```

Agents skip the second step, because it is the hardest one to do from a text
prompt. Without a reproduction there is no strong definition of "fixed", and no
answer to any of the questions that matter:

- Did anything ever actually fail?
- Under exactly which conditions?
- Was it intermittent, and is it still?
- Did the change eliminate those conditions, or something nearby?
- Can a second person confirm it?
- Can it become a regression test?

repro answers all of those by making the bug executable.

```
Bug report
    |
    v
  repro          understands the repo, builds the environment,
    |            constructs the scenario, reproduces the failure,
    |            captures evidence, minimizes the reproduction
    v
Executable reproduction
    |
    v
Coding agent -> inspect -> fix -> repro run -> bug no longer reproduces
```


## Install

```bash
npm i -D repro
```

Browser steps additionally need Playwright:

```bash
npm i -D playwright && npx playwright install chromium
```

Requires Node 20 or newer.


## Quick start

```bash
repro init "Checkout returns 500 after changing the shipping address and applying SAVE20"
```

repro reads the repository — framework, package manager, start command, port,
database, setup scripts — and writes:

```
.repro/
├── repro.yaml     the reproduction spec (commit this)
├── COMPILE.md     briefing for your coding agent
├── report.md      the original bug report, when one was imported
├── baseline.json  the measured reproduction rate (repro establish)
├── seal.json      the frozen contract, baseline and environment (repro seal)
├── fixtures/
├── scripts/
└── runs/          evidence bundles, one per run
```

One thing it will not infer for you: a setup script that destroys data.
`db:reset`, `seed`, `drop` and their relatives are detected and written into
`repro.yaml` **as comments**, never into `setup:` — which runs before *every*
iteration, so an unread `db:seed` becomes a hundred reseeds under
`--repeat 100`, against whatever database is configured. Move them in yourself
if the reproduction needs a clean slate. A tool whose argument is "do not trust
the inference" should not quietly infer one of those.

`repro.yaml` arrives complete except for the scenario, because the scenario is
the one thing that cannot be read off disk. Point your agent at `COMPILE.md`; it
writes the steps and iterates on `repro run` until the bug fails on demand.

There is no model inside repro. No API key, no vendor, no hidden inference —
whichever agent you already use does the writing, and repro does the executing.
That is what keeps the same `repro.yaml` runnable by Claude Code, Codex, Aider,
CI, and a human at a terminal.


## The spec

```yaml
name: checkout-address-coupon
base_url: http://localhost:3000

setup:
  - shell: npm run db:reset
  - shell: npm run seed

services:
  - command: npm run dev
    wait_for: { http: http://localhost:3000/health }

scenario:
  - name: create session
    http: { method: POST, url: /api/session }
    expect: { status: 201 }
    save: { sid: $.session }

  - name: set shipping address
    http:
      method: PUT
      url: /api/shipping-address
      headers: { x-session: "${sid}" }
      json: { country: US, state: CA }
    expect: { status: 200 }

  - name: change shipping address
    http:
      method: PUT
      url: /api/shipping-address
      headers: { x-session: "${sid}" }
      json: { state: WA }
    expect: { status: 200 }

  - name: apply coupon
    http:
      method: POST
      url: /api/coupon
      headers: { x-session: "${sid}" }
      json: { code: SAVE20 }
    expect: { status: 200 }

  - name: checkout
    http: { method: POST, url: /api/checkout, headers: { x-session: "${sid}" } }

failure:
  step: checkout
  expect: { status: 200 }
  reproduce:
    status: 500
    exception: Cannot read properties of null
```

Two rules carry more weight than they look like they do.

**`failure.reproduce` defines "reproduced".** Make it specific. `{status: 500}`
on its own will happily match an unrelated crash and send your agent chasing it.

**An `expect` on a step before the failure step is a precondition.** If it fails,
the run is reported as an *error*, not as a reproduction. That is what stops a
broken login from masquerading as the bug — and what stops the minimizer from
deleting the login step.


## Commands

### repro run

```
$ repro run
REPRO checkout-address-coupon
Environment         PASS
Services            PASS
Scenario            PASS

FAILURE REPRODUCED
Step:
  checkout
Expected:
  200
Observed:
  500
Exception:
  Cannot read properties of null (reading 'toUpperCase')
Reproduction:
  1 / 1 runs
Confidence:
  HIGH
Evidence:
  .repro/runs/0007/
```

When the bug does not reproduce, repro says which clause failed to match rather
than just printing a verdict:

```
NOT REPRODUCED
Why not:
  status 200 != 500
  no exception containing "Cannot read properties of null"
```

### repro run --repeat N

Reproducibility is a measurement, not a yes/no.

```
Runs:
  20 total
  17 reproduced
  3 passed
Reproduction rate:
  85%   95% 64.0% – 94.8%
Classification:
  FLAKY
Confidence:
  HIGH
```

The interval is a 95% Wilson score interval over the valid runs. `17/20` and
`170/200` are both "85%" and are not the same measurement — a fix that moves 85%
to 70% across twenty runs has moved nothing you can distinguish from noise.

| rate | classification |
| --- | --- |
| 100% | DETERMINISTIC |
| 50-99% | FLAKY |
| 1-49% | RARE |
| 0% | NOT REPRODUCED |

Confidence describes the measurement, not the bug: one green run says very
little, twenty consistent runs say a lot. After a fix, run it a few hundred
times and see whether the rate actually moved.

Services start once per invocation and setup steps run before each iteration, so
`--repeat 20` does not mean twenty dev-server boots. When the application is
already running — a dev server you are using, a staging deployment, a container
— `--base-url` reuses it and skips `services:` entirely:

```bash
repro run --repeat 200 --base-url http://localhost:3000
```

The spec is not edited, so the seal does not move: where the app runs was never
part of the bug. An unreachable URL makes the run `invalid`, never a pass —
nothing was disproven because nothing was reached. Set `restart_services: true`
when a run must not inherit any process state.

### Four outcomes, not two

Every run ends in exactly one of:

| outcome | meaning |
| --- | --- |
| `reproduced` | every precondition held and the failure signature matched |
| `not_reproduced` | every precondition held and the failure signature did not match |
| `invalid` | the run never reached the failure step — a precondition failed, setup failed, or a service never came up |
| `error` | repro itself could not execute the contract |

The distinction that matters is `invalid`. If login breaks, the checkout bug was
not reproduced — but it was not disproven either, and reporting that run as a
pass is how a fix gets declared on a reproduction that never ran. `invalid` and
`error` runs are excluded from the reproduction rate rather than counted as
successes, and `--exit-code` reports both as `125` (untestable) so `git bisect`
skips the commit instead of calling it good.

### repro establish

A single run is a story. A baseline is a measurement.

```
$ repro establish --repeat 100
ESTABLISHED
Runs:
  100 total
  98 valid
  23 reproduced
  2 invalid
Reproduction rate:
  23.5%   95% 16.2% – 32.7%
Classification:
  RARE
Confidence:
  HIGH
Contract:
  b831ac6f21b9
```

Writes `.repro/baseline.json`. For a deterministic bug this is a formality; for
an intermittent one the recorded rate is the only thing a later verification has
to compare against.

### repro seal

```
$ repro seal
REPRO SEALED
Contract:
  b831ac6f21b9
Fixtures:
  e3b0c44298fc
Baseline:
  23 / 98 valid runs  23.5%
Environment:
  linux 6.8.0  x64
  node v20.11.0  repro 0.1.0
  git 747cf5a
  package-lock.json 4f2a91c
```

The seal hashes the bug definition — steps, failure signature, fixtures, scripts
— together with the baseline and an environment fingerprint. `description` is
prose about the bug rather than part of it, so rewording it does not break a
seal; changing a matcher does.

Three questions, three hashes, because conflating them broke seals for reasons
that had nothing to do with the bug:

| hash | covers | what a change means |
| --- | --- | --- |
| **contract** | `scenario`, `failure`, `setup`, `teardown`, `env`, `vars`, `verify` | the bug or the goalposts moved — `verify` exits `2` |
| **execution** | the same, minus `verify` | what ran changed, so the baseline no longer measures it — `seal` asks you to re-establish |
| **environment** | `base_url`, `services` | where it runs changed. Reported as drift; the seal still holds |

`base_url` and `services` are deliberately outside the bug. "The notes route
accepts a write it should refuse" is the bug; "port 3000 answered 201" is where
it was observed, and a rate measured on one port is the same rate on another.
That is a judgement call and it is stated rather than hidden: a `services.env`
flag *can* be what causes a bug, so an edit there prints on every `verify` and
`status`, the same bargain repro already makes with the commit hash.

`verify` is in the contract but not in the execution hash for the same kind of
reason. An elimination policy judges numbers that already exist — declaring one
does not re-run anything, so it must not invalidate a baseline. Relaxing
`reproduced: {max: 0}` to `{max: 5}` still breaks the seal, because that is
exactly the move a seal exists to expose.

Sealing does not lock the file. It makes editing the file impossible to hide:

```
Contract:
  MODIFIED
  sealed:  b831ac6f21b9
  current: 91dc223a70e4
```

Nothing is captured that should not be shared: the fingerprint holds platform,
runtime and lockfile hashes, and never environment variables, credentials or
tokens.

### repro verify

Run the sealed contract again after the fix.

```
$ repro verify --repeat 500
Sealed baseline:
  23 / 98 reproduced  23.5%   95% 16.2% – 32.7%
Current:
  1 / 500 reproduced  0.2%   95% 0.0% – 1.1%
Contract:
  UNCHANGED
Elimination policy:
  PASS
```

repro does not say "BUG FIXED" on its own. It reports that the rate moved from
23.5% to 0.2% under an unchanged contract. Whether that is enough is a question
the spec answers, not the tool:

```yaml
verify:
  trials: 500
  reproduced: { max: 0 }          # deterministic bugs
  # reproduction_rate: { less_than: 0.01 }   # stochastic ones
```

With a policy declared, verify reports `PASS` or `FAIL` and exits `0` or `1`.
Without one it reports the change and stops there. A modified contract exits `2`
whatever the runs said, because the comparison is no longer between like and
like.

### repro status

Where the reproduction stands, without running it.

```
$ repro status
REPRO checkout-address-coupon

Contract:
  UNCHANGED

Environment:
  MODIFIED  base_url, services
  the seal still holds — base_url and services are not part of the bug

Baseline:
  23 / 98 valid runs  23.5%  RARE
  2026-09-18T10:42:06.001Z
```

`verify` boots the application to answer "did the rate move". That is the right
cost for that question and the wrong one for "has the contract been edited",
which a gate asks on every single invocation. `status` is a few file reads.

Exits `2` when the contract or the fixtures moved, `0` otherwise — an edited
`base_url` is reported, never a failure.

### repro hook

The completion gate, as a Claude Code Stop hook.

```bash
repro hook --install      # adds it to .claude/settings.json
repro hook --print        # shows the snippet
```

A Stop hook runs when the agent believes it is finished, which is the one moment
worth interrupting. The reproduction runs; the outcome decides; a refusal hands
the agent the measurement as its next instruction.

**The seal picks the polarity, because repro is used for two opposite jobs.**
While the reproduction is being compiled the agent is trying to *make* the bug
happen, so a run that does not reproduce is the unfinished state. After the fix
it is trying to make it *stop*, so a run that reproduces is. Blocking on the
wrong one would fight the agent for its whole budget.

`repro establish && repro seal` is by definition performed while the bug still
reproduces, so the seal already records which job this is:

| state | the gate wants | blocks while |
| --- | --- | --- |
| no seal | REPRODUCED | the scenario is still a stub |
| sealed | NOT REPRODUCED | the bug is back |

Three things never gate. An `invalid` or `error` run is untestable — a
precondition failed or a service never came up, so the bug was neither
reproduced nor disproven, and blocking a stop over a dead port spends the budget
on the environment. An edited contract does not gate either: an agent that
cannot keep a bug fixed can edit the bug instead, and declining to gate makes
that visible in the transcript rather than a wall to climb. And after
`--max-attempts` refusals (default 3) it lets go, leaving `.repro/feedback.md`
where the next reader will look.

The hook is a no-op in a directory with no `.repro/repro.yaml`, so it is safe to
leave installed.

### repro minimize

Drops steps and re-runs. A step survives only if removing it stops the bug.

```
$ repro minimize
Original:
  12 steps
Reducing:
  12 -> 11 -> 10 -> 9 -> 8 -> 7 -> 6 -> 5
Minimal reproduction:
   1. create session
   2. set shipping address to CA
   3. change shipping address to WA
   4. apply coupon SAVE20
   5. checkout
Failure reproduced:
  3 / 3
Probes:
  23 runs
```

An 18-step user journey becomes four API calls, and the agent's search space
shrinks with it. Instead of "understand this checkout system", the instruction
becomes "the failure needs an address mutation followed by a coupon".

Writes `.repro/<name>.min.yaml` by default; `--write` replaces the spec and keeps
the original alongside. `--confirm N` requires N reproductions before accepting a
removal, which matters for flaky bugs. Mark a step `keep: true` to protect it.

### repro explain

Not a root-cause claim — evidence about where behaviour diverges, gathered by
running things.

```
Failure boundary identified.
Failure observed at:
  checkout
Failure becomes observable after:
  apply coupon SAVE20
Required steps:
  create session, set shipping address to CA,
  change shipping address to WA, apply coupon SAVE20, checkout
Not required:
  health check, browse products, add widget to cart, open cart, ...
State difference (caused by the boundary step):
  GET /api/cart $.cart.tax_region
    before: "WA"
    after:  null
Ignored as run-to-run noise:
  $.cart.id, $.session
Relevant code paths:
  src/tax.mjs:4
  server.mjs:96
```

Three things are happening here, all deterministic:

1. **Necessity.** Each step is dropped in turn to see whether the bug survives.
2. **State probing.** The scenario's read-only requests are replayed with and
   without the boundary step, so the difference is caused by that step alone.
3. **Noise subtraction.** Fields that differ between two *identical* runs —
   session ids, timestamps, order numbers — are measured first and removed, so
   they cannot be mistaken for causal change.

repro deliberately stops short of naming a cause. Its job is to hand the agent a
much smaller haystack.

### repro from

```bash
repro from issue.md
repro from production.log
repro from request.curl
repro from checkout.har
```

- **HAR** becomes HTTP steps, with assets stripped and everything recorded after
  the failing request dropped.
- **curl** commands are parsed flag by flag, including `-X`, `-H`, `-d`, `-b`,
  `-u` and `--data-raw`.
- **Free text** gives up its stack traces, error messages, embedded curl
  commands, and `POST /api/checkout 500` log lines.

Repeated requests are kept: *"I changed the address twice"* is usually the whole
bug. Anything repro could not parse is preserved in `.repro/report.md` for the
agent to read, and every guess it had to make is printed as a note.

### repro bisect

Once a reproduction exists, it is a git primitive.

```
$ repro bisect --good v2.4.1 --bad HEAD
Regression introduced by:
  a913de7
  refactor checkout pricing state
```

The spec is copied outside the working tree first — a spec that time-travels with
the checkout is not the same predicate. `--repeat N` makes each commit's verdict
more robust for flaky failures.

### repro export --test

Turns a fixed bug into a permanent regression test, so the bug report becomes a
durable engineering asset instead of disappearing when the issue closes. Detects
vitest or jest, falling back to `node:test`.

```
Bug report -> reproduction -> minimized -> sealed -> agent fix -> verified -> regression test
```


## Spec reference

### Top level

| key | meaning |
| --- | --- |
| `name` | identifier for the reproduction (required) |
| `description` | human summary of the bug |
| `base_url` | prefix for relative `http.url` and browser `goto` targets. Environment, not bug |
| `env` | environment variables for services and shell steps |
| `vars` | initial values for `${interpolation}` |
| `setup` | steps run before services start, on every iteration |
| `services` | long-running processes to supervise. Environment, not bug |
| `scenario` | the reproduction steps (required) |
| `failure` | what counts as reproduced (required) |
| `teardown` | steps run after the scenario, always |
| `restart_services` | restart services between repeated runs |
| `stop_on_expect_fail` | abort the scenario at the first failed `expect` |
| `verify` | elimination policy checked by `repro verify` |

### Steps

| kind | example |
| --- | --- |
| `shell` | `- shell: npm run seed` with optional `cwd` |
| `http` | `- http: { method, url, headers, json / body / form, timeout_ms }` |
| `browser` | `- browser: [ { goto: / }, { click: "#buy" } ]` |
| `agent` | `- agent: { run: node agent.mjs, input: { message: "..." } }` |
| `sleep` | `- sleep: 250` |

Every step also accepts `id`, `name`, `expect`, `keep`, and `save`.
`save: { sid: $.session }` captures a value from the response for use as
`${sid}` later; `${env.NAME}` reads the environment.

### Browser actions

`goto`, `click`, `fill`, `type`, `select`, `press`, `wait_for`, `wait`,
`wait_for_text`, `expect_text`, `expect_visible`, `screenshot`, `eval`.

Selector/value actions accept either form:

```yaml
- fill: { selector: "#coupon", value: SAVE20 }
- fill: ["#coupon", SAVE20]
```

### Matchers

Used by `expect`, `failure.expect` and `failure.reproduce`. Every declared field
must hold.

| field | matches |
| --- | --- |
| `status` | exact HTTP status |
| `status_in` | status in a list |
| `status_not` | any status but this one |
| `body_contains` | substring of the response body |
| `body_matches` | regular expression against the body |
| `json` | map of `$.json.path` to expected value |
| `exception` | substring of the error message or stack |
| `exit_code` | shell exit code |
| `stdout_contains` / `stderr_contains` | shell output |
| `logs_contain` | substring of the service or browser logs |
| `trace` | agent trajectory — see [LLM agents](#llm-agents) |
| `output` | agent final output: `equals`, `contains`, `matches`, `schema` |
| `duration_ms` | how long the step took |
| `usage` | `input_tokens`, `output_tokens`, `total_tokens` |

### Services

```yaml
services:
  - name: app
    command: npm run dev
    cwd: .
    env: { NODE_ENV: test }
    wait_for:
      http: http://localhost:3000/health   # or: port: 3000, or: log: "listening on"
      timeout_ms: 60000
```

Services are started as process groups and killed as process groups. Dev servers
routinely fork children, and killing only the shell leaves the port bound so the
next run silently talks to a stale process.


## LLM agents

An agent bug is not a different product. It is the same contract with a
different observation: instead of a status code, the step produces a trace.

```yaml
scenario:
  - id: request
    agent:
      run: node agents/support.mjs
      input: { message: Please refund order 123 }
      output_schema: .repro/schemas/refund-reply.json

failure:
  step: request
  reproduce:
    trace:
      tool_call:
        name: refund_order
        arguments: { amount: { greater_than: 0 } }
      sequence:
        contains: [{ tool: refund_order }]
        not_preceded_by: { tool: get_order }
```

That reads: the agent refunded, and it did so without ever looking the order up.

### The trace

repro has no SDK inside it and no framework integration. The agent is a process
that prints JSON — one object, or JSONL, on stdout or into a file — and repro
normalizes whatever it prints:

```json
{"type": "model",       "name": "planner",      "input": "refund order 123"}
{"type": "tool_call",   "name": "refund_order", "input": {"order_id": "123", "amount": 4200}}
{"type": "tool_result", "name": "refund_order", "output": {"ok": true}}
{"type": "output", "output": {"status": "refunded"}, "usage": {"total_tokens": 960}}
```

Event types: `model`, `tool_call`, `tool_result`, `retrieval`, `handoff`,
`message`, `custom`. `tool`/`name`, `arguments`/`input` and `result`/`output` are
accepted as the same field, because frameworks disagree about the word. Lines
that are not JSON are ignored, because agents log. The whole trace is also
readable as JSON, so `json: { $.output.status: refunded }` and
`save: { id: $.output.order_id }` work exactly as they do on an HTTP response.

### What you can match

| bug | matcher |
| --- | --- |
| wrong tool | `trace: { tool_call: { name: refund_order } }` |
| wrong arguments | `arguments: { amount: { greater_than: 100 } }` |
| missing required action | `sequence: { contains: [...], not_preceded_by: {...} }` |
| looping | `tool_call: { name: web_search, count: { greater_than: 10 } }` |
| cost or latency | `usage: { total_tokens: { greater_than: 50000 } }`, `duration_ms` |
| malformed structured output | `output: { schema: { valid: false } }` |

Comparators are `equals`, `not_equals`, `greater_than`,
`greater_than_or_equal`, `less_than`, `less_than_or_equal`, `contains`,
`matches`, `exists`, `missing`. An object whose keys are all comparators is a
comparison; any other object is an expected value.

### Stochastic bugs are still bugs

Most agent failures are intermittent, which is exactly why `--repeat` and
`establish` exist:

```
$ repro run --repeat 20 --spec .repro/agent.yaml
Runs:
  20 total
  6 reproduced
  14 passed
Reproduction rate:
  30%   95% 14.5% – 51.9%
Classification:
  RARE
```

A 30% bug is reproduced. `repro establish` records that rate, `repro seal`
freezes it, and after the fix `repro verify --repeat 500` says whether it moved
— against the interval, not against a single lucky run.

### Reproduction, not replay

repro runs the agent fresh every time. Replaying a recorded model output and a
recorded tool response proves only that the recording still plays; it cannot
tell you whether the agent would make the same bad decision again.

The consequence to be aware of: the agent's tools run for real. Point the step
at a harness whose tools are stubbed, or at a staging environment, before
reproducing a bug whose failing step is `refund_customer`. Built-in tool
virtualization — stub, record and replay modes with side effects captured
rather than performed — is not implemented yet.

### Semantic failures

Some failures cannot be expressed structurally: "the assistant claimed a
cancelled reservation was still active". Today, write that check as a `shell`
step that reads the trace from the run directory and exits non-zero, and match
on its `exit_code`. The order of preference is worth keeping: deterministic
state, then structured output, then tool trajectory, then an executable check,
and only then a model judging another model.


## Agent integration

Any assistant that can run a shell command can use repro:

> Fix the bug. Use `repro run --json` to reproduce it.
> Keep working until the reproduction no longer fails.

```json
{
  "status": "reproduced",
  "name": "checkout-address-coupon",
  "reproduction_rate": 1.0,
  "classification": "DETERMINISTIC",
  "confidence": "HIGH",
  "runs": 1,
  "failures": 1,
  "successes": 0,
  "invalid": 0,
  "errors": 0,
  "interval": [0.2065, 1],
  "failure": {
    "step": "checkout",
    "step_index": 12,
    "expected_status": 200,
    "actual_status": 500,
    "exception": "Cannot read properties of null (reading 'toUpperCase')",
    "mismatch": []
  },
  "artifacts": [".repro/runs/0007/result.json", ".repro/runs/0007/network.json"]
}
```

Every command takes `--json`. `repro run --exit-code` follows the git bisect
contract: `0` good, `1` reproduced, `125` untestable — which includes an
`invalid` run, so a commit whose preconditions never held is skipped rather than
called good.

The stronger agent loop seals the contract first, so the agent cannot move the
goalposts while working:

```bash
repro establish --repeat 20 && repro seal   # before the fix
repro verify                                # after it
```

Better still, stop asking the agent to police itself. `repro hook --install`
makes the reproduction the loop's terminating condition — the agent stops when
the bug stops reproducing, not when it feels done, and before the seal exists it
cannot stop while the reproduction is still a stub.

And when it is fixed, retire the spec into the project's own test suite:

```bash
repro export --test
```

That is the end of the arc, not `not_reproduced`. A `.repro/` directory nobody
runs again is how the thing you built to stop an agent deleting a test becomes a
test nobody owns.

repro is also importable as a library:

```js
import { loadSpec, runReproduction, minimize, explain, establish, seal, verify } from 'repro'

const loaded = await loadSpec()
const result = await runReproduction(loaded, { repeat: 20 })
```


## Evidence

A reproduction should produce more than PASS or FAIL. Every run leaves a bundle
behind:

```
.repro/runs/0011/
├── result.json       verdict, per-step observations, timings
├── network.json      every request and response
├── service.log       this run's slice of the application's output
├── browser.log       console messages and page errors
├── screenshots/      including an automatic one at the failing action
└── trace.zip         Playwright trace (--trace)
```

`.repro/runs/latest` always points at the most recent run.


## Try it

The repository ships a small shop with a genuine checkout bug: writing the
shipping address twice makes the coupon endpoint restore a stale pricing
snapshot, which nulls the tax region, which crashes checkout.

```bash
git clone git@github.com:sajjadriaj/repro.git
cd repro && npm install && npm run build
cd example

node ../dist/cli.js run                             # reproduces
node ../dist/cli.js run --repeat 10                 # deterministic
node ../dist/cli.js minimize                        # 12 steps -> 5
node ../dist/cli.js explain                         # boundary and state diff
node ../dist/cli.js establish --repeat 10            # baseline
node ../dist/cli.js seal                            # freeze the contract
node ../dist/cli.js verify                          # FAIL: the bug is still there
node ../dist/cli.js run --spec .repro/browser.yaml  # same bug through the UI
node ../dist/cli.js run --spec .repro/agent.yaml    # an agent bug, matched on its trace
```

Set `FLAKY_RATE=0.7` on the example server to watch `--repeat` classify an
intermittent failure. The agent example ships a support agent that skips an
order lookup and refunds an already-refunded order; drop `AGENT_BUG_RATE` in
`.repro/agent.yaml` to 0.35 and run `--repeat 20` to see a stochastic bug
measured rather than argued about.


## Design principles

**Reproduction before diagnosis.** Can we make it fail? Can we make it fail
consistently? Can we make it smaller? Only then, why.

**Deterministic where possible.** A model is useful for turning prose into a
candidate scenario. Deciding whether the bug reproduced is not a judgement call,
so nothing in the execution path is one.

**Agent independent.** No dependency on a particular model, assistant or IDE.

**Human inspectable.** The spec is a YAML file you can read, edit and review.
There is no hidden state.

**The contract outlives the implementation.** The code changes; the definition of
the bug does not. A seal makes any change to that definition visible instead of
preventing it.

**Evidence over claims.** Not "I think I reproduced it" — `20/20 runs`, a trace,
and a diff.


## Non-goals

repro is not a coding agent, a general-purpose testing framework, a Playwright
replacement, a unit test replacement, a CI platform, an observability platform,
or an agent orchestrator. It has one responsibility: turn bugs into executable
reproductions.

It is also not an eval framework. An eval asks how well a system performs across
a distribution of tasks. repro asks under which conditions one reported failure
can be observed. There is no helpfulness score, no quality score, no model
ranking — a score only exists here when it is literally the failure signature of
a particular bug.


## Development

```bash
npm install
npm run build
npm test          # 26 tests, including end-to-end reproduce/minimize/explain
bash docs/demo.sh # regenerate the demo recording
```

The MVP targets JavaScript and TypeScript web applications and any agent that
can print a JSON trace; the execution layer is deliberately separated from the
ecosystem so others can be added.


## License

MIT
