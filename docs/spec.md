# The spec

`.repro/repro.yaml` is the source of truth. It is YAML you can read, edit and
review; there is no hidden state behind it.

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
the run is reported as *invalid*, not as a reproduction and not as a pass. That
is what stops a broken login from masquerading as the bug — and what stops the
minimizer from deleting the login step.


## Top level

| key | meaning |
| --- | --- |
| `name` | identifier for the reproduction (required) |
| `description` | human summary of the bug. Prose, not contract: rewording it does not break a seal |
| `base_url` | prefix for relative `http.url` and browser `goto` targets. Environment, not bug |
| `env` | environment variables for services and shell steps |
| `vars` | initial values for `${interpolation}` |
| `setup` | steps run before services start, on every iteration |
| `services` | long-running processes to supervise. Environment, not bug |
| `scenario` | the reproduction steps (required) |
| `failure` | what counts as reproduced (required): `step`, optional `expect`, `reproduce` |
| `teardown` | steps run after the scenario, always |
| `restart_services` | restart services between repeated runs |
| `stop_on_expect_fail` | abort the scenario at the first failed `expect` |
| `verify` | elimination policy checked by `repro verify` — see [Commands → repro verify](commands.md#repro-verify) |


## Steps

| kind | example |
| --- | --- |
| `shell` | `- shell: npm run seed` with optional `cwd` |
| `http` | `- http: { method, url, headers, json / body / form, timeout_ms }` |
| `browser` | `- browser: [ { goto: / }, { click: "#buy" } ]` |
| `agent` | `- agent: { run: node agent.mjs, input: { message: "..." } }` |
| `sleep` | `- sleep: 250` |

Every step also accepts `id`, `name`, `expect`, `keep`, and `save`.
`save: { sid: $.session }` captures a value from the response for use as
`${sid}` later; `${env.NAME}` reads the environment. `keep: true` protects a
step from `repro minimize`.

In a git repository, `shell` and `agent` steps are bracketed by a snapshot of
the dirty part of the working tree, so what a step added, modified or deleted
is recorded on the step and assertable with `files_changed`. Evidence under
`.repro/` is excluded.


## Agent step keys

| key | meaning |
| --- | --- |
| `run` | command to run; `input` arrives as one JSON line on stdin |
| `input` | recorded as `trace.input` and handed to the command |
| `trace_file` | read the trace from here instead of, or as well as, stdout |
| `output_schema` | JSON Schema the final output must satisfy |
| `format` | `jsonl` (default, detected) or `claude-code` |
| `replay` | reproduction mode: exported as `REPRO_REPLAY=<path>` — see [Agents → Reproduction and replay](agents.md#reproduction-and-replay) |
| `record` | exported as `REPRO_RECORD=<dir>` inside the run's evidence |
| `env`, `cwd`, `timeout_ms` | as for shell steps |

What the trace looks like and what can be matched on it is in
[Agent reproduction](agents.md).


## Browser actions

`goto`, `click`, `fill`, `type`, `select`, `press`, `wait_for`, `wait`,
`wait_for_text`, `expect_text`, `expect_visible`, `screenshot`, `eval`.

Selector/value actions accept either form:

```yaml
- fill: { selector: "#coupon", value: SAVE20 }
- fill: ["#coupon", SAVE20]
```


## Matchers

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
| `trace` | agent trajectory — see [Agent reproduction](agents.md#what-you-can-match) |
| `output` | agent final output: `equals`, `contains`, `matches`, `schema` |
| `duration_ms` | how long the step took |
| `usage` | `input_tokens`, `output_tokens`, `total_tokens` |
| `files_changed` | substring(s) of paths a shell or agent step added, modified or deleted |

### Comparators

`equals`, `not_equals`, `greater_than`, `greater_than_or_equal`, `less_than`,
`less_than_or_equal`, `contains`, `matches`, `exists`, `missing`. An object
whose keys are all comparators is a comparison; any other object is an expected
value.

```yaml
reproduce:
  json: { $.cart.total: { greater_than: 100 } }
  duration_ms: { less_than: 2000 }
```


## Services

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

Services start once per invocation and setup steps run before each iteration,
so `--repeat 20` does not mean twenty dev-server boots. Set
`restart_services: true` when a run must not inherit any process state. When
the application is already running, `--base-url` skips `services:` entirely.
