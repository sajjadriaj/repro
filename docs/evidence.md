# Evidence

A reproduction should produce more than PASS or FAIL. Every run leaves a bundle
behind that can be inspected long after it happened.

## The run bundle

```
.repro/runs/0011/
├── result.json       verdict, per-step observations (incl. files changed), timings,
│                     environment fingerprint, coverage
├── network.json      every request and response
├── repo.patch        the uncommitted diff the run started from (when dirty)
├── repo.status       the dirty and untracked paths at that moment
├── traces/NN.json    the normalized trace of each agent step
├── recordings/       whatever a harness saved under REPRO_RECORD (absent when it saved nothing)
├── service.log       this run's slice of the application's output
├── browser.log       console messages and page errors
├── screenshots/      including an automatic one at the failing action
└── trace.zip         Playwright trace (--trace)
```

`.repro/runs/latest` always points at the most recent run. Runs are
per-machine noise and belong in `.gitignore`; the spec, its fixtures and the
seal are what gets committed.

## The fingerprint

Every run records the same fingerprint the seal does — platform, runtime,
commit, dirty flag, lockfile hashes — so two runs can be compared on where they
happened. It never holds environment variables, credentials or tokens: a
fingerprint gets committed and shared, so it only ever contains things that are
safe to read.

```json
{
  "os": "linux 6.8.0",
  "arch": "x64",
  "node": "v20.11.0",
  "repro": "0.3.0",
  "git_commit": "67071a9",
  "git_dirty": true,
  "locks": { "package-lock.json": "4f2a91c" }
}
```

When the tree is dirty the run also writes `repo.patch` and `repo.status`, so
"reproduced against `67071a9` with these uncommitted changes" is answerable
later.

## Coverage

Coverage is evidence about the evidence: which layers of the execution a run
recorded, which it could only see in part, and which it does not control.

```
Coverage:
  ✓ repository state      git 67071a9, uncommitted changes in repo.patch
  ✓ filesystem mutations  2 files changed across 1 step
  ~ subprocesses          exit codes and output captured; process trees are not observed
  ✓ model responses       1 model response recorded in traces/
  ~ MCP                   2 MCP calls recorded; servers are not managed by repro
  ! outbound network      calls the application or agent makes are not recorded
  ✓ environment           os, runtime and lockfiles fingerprinted; environment variables never recorded
  ~ randomness            time and randomness are not controlled; --repeat measures the rate
  ✓ application           started by repro: app
```

| mark | status | meaning |
| --- | --- | --- |
| `✓` | captured | the layer is in the bundle |
| `~` | partial | recorded, with a stated limit |
| `!` | uncontrolled | outside repro's reach; the detail says why |
| `-` | none | not observed in this setup, and why |

It is derived from what the run actually wrote, so a layer is captured because
the file is there, not because the feature exists: `filesystem mutations` reads
`captured` only in a git repository, `model responses` only when the agent
emitted model events with outputs, `application` only when repro started the
services itself. A replayed agent step reports `model responses: replayed
from …`, so a replayed run is never mistaken for a measurement.

It is deliberately not a percentage. "87% reproducible" would have to invent
the weights, and a checklist that names each uncontrolled layer tells the reader
what to pin down next.

The same list is in `repro run --json` under `coverage`, and in each run's
`result.json`.
