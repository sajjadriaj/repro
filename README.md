# repro

**Turn any bug report into a reproduction your coding agent can run.**

Coding agents are good at fixing bugs and bad at reproducing them. Given
*"checkout sometimes fails after I change my address and apply a coupon"*, an
agent will read some code, guess, patch something plausible, and declare
victory — without ever having seen the bug happen.

`repro` supplies the missing step. It turns a bug report into an executable
scenario, proves the failure happens, measures how often, cuts it down to the
steps that matter, and gives the agent an objective signal to work against:

```
$ repro run --json
{ "status": "reproduced", "reproduction_rate": 1.0, ... }
```

Fix the bug. Run it again. `"status": "not_reproduced"` means done — not
"the model thinks it's done".

repro is **not another coding agent**. It is the reproduction layer underneath
whichever one you use.

---

## Install

```bash
npm i -D repro
# browser steps also need playwright:
npm i -D playwright && npx playwright install chromium
```

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
├── fixtures/
├── scripts/
└── runs/          evidence bundles, one per run
```

`repro.yaml` arrives complete except for the scenario, because the scenario is
the one thing that cannot be read off disk. Point your agent at `COMPILE.md`;
it fills in the steps and iterates on `repro run` until the bug fails on demand.

There is no model inside repro. No API key, no vendor, no hidden inference —
whichever agent you already use does the writing, and repro does the executing.

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

Step kinds: `shell`, `http`, `browser`, `sleep`.
Matcher fields: `status`, `status_in`, `status_not`, `body_contains`,
`body_matches`, `json`, `exception`, `exit_code`, `stdout_contains`,
`stderr_contains`, `logs_contain`.

Two rules carry more weight than they look like they do:

- **`failure.reproduce` defines "reproduced".** Make it specific. `{status: 500}`
  on its own will happily match an unrelated crash and send your agent chasing it.
- **An `expect` on a step before the failure step is a precondition.** If it
  fails, the run is reported as an *error*, not a reproduction. That is what stops
  a broken login from masquerading as the bug — and what stops the minimizer from
  deleting the login step.

## Commands

### `repro run`

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

### `repro run --repeat 20` — flaky bug detection

Reproducibility is treated as a measurement, not a yes/no.

```
Runs:
  20 total
  17 reproduced
  3 passed
Reproduction rate:
  85%
Classification:
  FLAKY
Confidence:
  HIGH
```

`DETERMINISTIC` / `FLAKY` / `RARE` / `NOT REPRODUCED`. After a fix, run it a few
hundred times and see whether the rate actually moved.

### `repro minimize`

Drops steps and re-runs. A step survives only if removing it stops the bug.

```
$ repro minimize
Original:
  12 steps
Reducing:
  12 → 11 → 10 → 9 → 8 → 7 → 6 → 5
Minimal reproduction:
   1. create session
   2. set shipping address to CA
   3. change shipping address to WA
   4. apply coupon SAVE20
   5. checkout
Failure reproduced:
  3 / 3
```

An 18-step user journey becomes four API calls, and the agent's search space
shrinks with it. `--write` replaces `repro.yaml` (keeping the original alongside);
`keep: true` protects a step from removal.

### `repro explain`

Not a root-cause claim — evidence about where behaviour diverges, gathered by
running things.

```
Failure boundary identified.
Failure becomes observable after:
  apply coupon SAVE20
Required steps:
  create session, set shipping address to CA,
  change shipping address to WA, apply coupon SAVE20, checkout
Not required:
  health check, browse products, add widget to cart, open cart, …
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

The state difference comes from replaying the scenario's read-only requests with
and without the boundary step. Fields that differ between two *identical* runs —
session ids, timestamps, order numbers — are measured first and subtracted, so
they cannot be mistaken for causal change.

### `repro from <file>`

```bash
repro from issue.md
repro from production.log
repro from request.curl
repro from checkout.har
```

HAR files become HTTP steps with assets stripped and everything after the failing
request dropped. curl commands are parsed flag by flag. Free text gives up its
stack traces, error messages, and `POST /api/checkout 500` lines. Repeated
requests are kept — *"I changed the address twice"* is usually the whole bug.
Whatever repro could not parse is left in `.repro/report.md` for the agent to read.

### `repro bisect`

The reproduction becomes the predicate for `git bisect`.

```
$ repro bisect --good v2.4.1 --bad HEAD
Regression introduced by:
  a913de7
  refactor checkout pricing state
```

The spec is copied outside the working tree first — a spec that time-travels with
the checkout is not the same predicate.

### `repro export --test`

Turns a fixed bug into a permanent regression test, so the bug report outlives
the ticket.

## Agent integration

Any assistant that can run a shell command can use repro:

> Fix the bug. Use `repro run --json` to reproduce it.
> Keep working until the reproduction no longer fails.

```json
{
  "status": "reproduced",
  "reproduction_rate": 1.0,
  "classification": "DETERMINISTIC",
  "confidence": "HIGH",
  "failure": {
    "step": "checkout",
    "expected_status": 200,
    "actual_status": 500,
    "exception": "Cannot read properties of null (reading 'toUpperCase')"
  },
  "artifacts": [".repro/runs/0007/result.json", ".repro/runs/0007/network.json"]
}
```

Every command takes `--json`. `repro run --exit-code` follows the git bisect
contract: `0` good, `1` reproduced, `125` untestable.

## Evidence

Every run leaves a bundle behind:

```
.repro/runs/0011/
├── result.json
├── network.json      every request and response
├── service.log       this run's slice of the app's output
├── browser.log       console + page errors
├── screenshots/
└── trace.zip         playwright trace (--trace)
```

## Try it

The repo ships a small shop with a genuine checkout bug.

```bash
cd example
node ../dist/cli.js run                             # reproduces
node ../dist/cli.js minimize                        # 12 steps → 5
node ../dist/cli.js explain                         # boundary + state diff
node ../dist/cli.js run --spec .repro/browser.yaml  # same bug through the UI
```

## Design principles

**Reproduction before diagnosis.** Can we make it fail? Can we make it fail
consistently? Can we make it smaller? Only then, why.

**Deterministic where possible.** An LLM is useful for turning prose into a
candidate scenario. Deciding whether the bug reproduced is not a judgement call,
so nothing in the execution path is one.

**Agent independent.** Claude Code, Codex, Aider, CI, or a human all run the same
`repro.yaml`.

**Human inspectable.** The spec is a YAML file you can read and edit. There is no
hidden state.

**Evidence over claims.** Not "I think I reproduced it" — `20/20 runs`, a trace,
and a diff.

## Non-goals

Not a coding agent, not a testing framework, not a Playwright replacement, not a
CI or observability platform. One job: turn bugs into executable reproductions.

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
