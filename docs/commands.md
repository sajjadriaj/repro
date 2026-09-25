# Commands

Every command takes `--json`, `--spec <file>`, `--root <dir>`, `--timeout <ms>`
and `--quiet`. The full option table is at the [end](#options).

- [repro init / from](#repro-from)
- [repro run](#repro-run) — [--repeat](#repro-run---repeat-n), [four outcomes](#four-outcomes-not-two)
- [repro establish](#repro-establish)
- [repro seal](#repro-seal)
- [repro verify](#repro-verify)
- [repro status](#repro-status)
- [repro hook](#repro-hook)
- [repro minimize](#repro-minimize)
- [repro explain](#repro-explain)
- [repro bisect](#repro-bisect)
- [repro export --test](#repro-export---test)


## repro run

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
Coverage:
  ✓ repository state      git 67071a9, uncommitted changes in repo.patch
  ✓ filesystem mutations  no files changed
  ~ subprocesses          exit codes and output captured; process trees are not observed
  ✓ HTTP responses        12 exchanges repro drove, in network.json
  ! outbound network      calls the application or agent makes are not recorded
  ✓ environment           os, runtime and lockfiles fingerprinted; environment variables never recorded
  ~ randomness            time and randomness are not controlled; --repeat measures the rate
  ✓ application           started by repro: app
```

**Coverage** is evidence about the evidence: which layers of the execution this
run recorded, which it could only see in part, and which it does not control.
It is described in [Evidence → Coverage](evidence.md#coverage).

When the bug does not reproduce, repro says which clause failed to match rather
than just printing a verdict:

```
NOT REPRODUCED
Why not:
  status 200 != 500
  no exception containing "Cannot read properties of null"
```

`--exit-code` follows the git bisect contract: `0` good, `1` reproduced, `125`
untestable. `--worktree <ref>` runs the same contract against another commit —
see [repro verify](#repro-verify).

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


## repro establish

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
to compare against. For an agent bug the baseline also keeps the trajectory of
a run that reproduced, so `verify` can later say where the fixed agent left it.


## repro seal

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
  node v20.11.0  repro 0.3.0
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


## repro verify

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

For an agent bug the seal also keeps the trajectory of a run that reproduced,
so verify can say where the fixed agent left the bug path instead of only that
the rate moved:

```
Trajectory:
  diverges from the sealed bug path at event 2
  sealed:   tool_call refund_order
  current:  tool_call get_order
```

`verify` always runs against the working tree as it is — that is the question
"does my current change fix this real failure". The inverse is
`--worktree <ref>`: the same contract, the same evidence directory, against
another commit checked out in a temporary worktree. `node_modules` is
borrowed, not reinstalled, and so is today's `.repro/` when the ref has none:
the spec, its fixtures and its recordings are not checked out with the code.


## repro status

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


## repro hook

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


## repro minimize

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


## repro explain

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

An agent failure diverges *inside* one step rather than between steps, so for
an `agent` failure step explain looks for a run that did not take the bug path
and reports the first event where the two part ways — with what each run did to
the working tree beside it, so the decision and its physical consequence are
read together:

```
Trajectory divergence:
  at event 2
    reproduced:      tool_call refund_order
    not reproduced:  tool_call get_order
Files changed (reproduced):
  ~ src/auth.ts
Files changed (not reproduced):
  (no files changed)
```

A deterministic agent bug never yields a clean run; explain says so after
three attempts and stops, because every attempt may cost real model calls.


## repro from

`repro init "<description>"` scaffolds from a sentence. `repro from <file>`
scaffolds from evidence:

```bash
repro from issue.md
repro from production.log
repro from request.curl
repro from checkout.har
repro from incident.jsonl
```

- **HAR** becomes HTTP steps, with assets stripped and everything recorded after
  the failing request dropped.
- **curl** commands are parsed flag by flag, including `-X`, `-H`, `-d`, `-b`,
  `-u` and `--data-raw`.
- **Free text** gives up its stack traces, error messages, embedded curl
  commands, and `POST /api/checkout 500` log lines.
- **An agent trace** — JSONL events, a whole trace, or a Claude Code session —
  becomes an `agent` step that reads the recording back, with
  `failure.reproduce` derived from the last tool call. The file is copied
  under `.repro/fixtures/` so the seal covers it. `repro run` then reproduces
  from the recording, which proves the matcher describes the failure in the
  evidence; adding `run:` and dropping `trace_file` makes the live agent do it
  again. That is the incident → fixture arc for agents, and it ends at
  `export --test` like every other one.

Repeated requests are kept: *"I changed the address twice"* is usually the whole
bug. Anything repro could not parse is preserved in `.repro/report.md` for the
agent to read, and every guess it had to make is printed as a note.


## repro bisect

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


## repro export --test

Turns a fixed bug into a permanent regression test, so the bug report becomes a
durable engineering asset instead of disappearing when the issue closes. Detects
vitest or jest, falling back to `node:test`.

```
Bug report -> reproduction -> minimized -> sealed -> agent fix -> verified -> regression test
```


## Options

| option | meaning | commands |
| --- | --- | --- |
| `--repeat <n>` | run n times; measures flakiness | run, establish, verify, bisect |
| `--base-url <url>` | the app is already running there; skip `services:` | run, establish, verify, minimize, explain, hook |
| `--json` | machine-readable output | all |
| `--exit-code` | exit 1 when reproduced, 125 on error | run |
| `--confirm <n>` | runs required per probe | minimize, explain |
| `--verify <n>` | runs to verify the minimal scenario | minimize |
| `--write` | replace `repro.yaml` with the minimal one | minimize |
| `--good` / `--bad <ref>` | bisect endpoints | bisect |
| `--trace` | record a Playwright trace | run |
| `--headed` | show the browser | run |
| `--timeout <ms>` | per-step timeout, default 30000 | all |
| `--spec <file>` | use a specific spec file | all |
| `--root <dir>` | project root, default the spec's parent | all |
| `--worktree <ref>` | run against that commit in a temporary worktree | run, verify |
| `--force` | overwrite existing files | init, from, export |
| `--quiet` | drop progress output, keep the verdict | all |
| `--install` / `--print` | write the Stop hook, or show it | hook |
| `--max-attempts <n>` | refusals before the gate lets go, default 3 | hook |
