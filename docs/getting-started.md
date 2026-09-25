# Getting started

## Install

```bash
npm i -D repro
```

Browser steps additionally need Playwright:

```bash
npm i -D playwright && npx playwright install chromium
```

Requires Node 20 or newer.


## The first reproduction

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


## Starting from evidence

A bug report, a HAR file, a curl command, a production log or an agent trace
seeds the scenario instead of a stub:

```bash
repro from issue.md
repro from checkout.har
repro from request.curl
repro from production.log
repro from incident.jsonl
```

What each format yields is under [Commands → repro from](commands.md#repro-from).


## The loop

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
  "artifacts": [".repro/runs/0007/result.json", ".repro/runs/0007/network.json"],
  "environment": { "git_commit": "67071a9", "git_dirty": true, "node": "v24.13.1", "...": "..." },
  "coverage": [{ "layer": "repository state", "status": "captured", "detail": "git 67071a9, ..." }]
}
```

Every command takes `--json`. `repro run --exit-code` follows the git bisect
contract: `0` good, `1` reproduced, `125` untestable — which includes an
`invalid` run, so a commit whose preconditions never held is skipped rather than
called good.

The stronger loop seals the contract first, so the agent cannot move the
goalposts while working:

```bash
repro establish --repeat 20 && repro seal   # before the fix
repro verify                                # after it
```

Better still, stop asking the agent to police itself. `repro hook --install`
makes the reproduction the loop's terminating condition — the agent stops when
the bug stops reproducing, not when it feels done, and before the seal exists it
cannot stop while the reproduction is still a stub. How the gate decides is
under [Commands → repro hook](commands.md#repro-hook).

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


## Try the example

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
node ../dist/cli.js establish --repeat 10           # baseline
node ../dist/cli.js seal                            # freeze the contract
node ../dist/cli.js verify                          # FAIL: the bug is still there
node ../dist/cli.js run --spec .repro/browser.yaml  # same bug through the UI
node ../dist/cli.js run --spec .repro/agent.yaml    # an agent bug, matched on its trace
node ../dist/cli.js run --worktree HEAD             # the same contract against another commit
node ../dist/cli.js from .repro/runs/latest/traces/01.json --root /tmp/shop  # a trace becomes a fixture
```

Set `FLAKY_RATE=0.7` on the example server to watch `--repeat` classify an
intermittent failure. The agent example ships a support agent that skips an
order lookup and refunds an already-refunded order; drop `AGENT_BUG_RATE` in
`.repro/agent.yaml` to 0.35 and run `--repeat 20` to see a stochastic bug
measured rather than argued about.


## Next

- [The spec](spec.md) — every key, step kind and matcher
- [Commands](commands.md) — what each command prints and why
- [Agent reproduction](agents.md) — traces, replay, Claude Code
