# Agent reproduction — gap analysis

Maps the "agent-aware reproduction" proposal onto the repro that exists
(`current-state.md`). The question asked of every proposed concept is the one
the proposal itself asks: *does repro already have an abstraction that can
represent this?* Where the answer is yes, the plan extends it. Where the
proposal and the repository disagree on philosophy, the disagreement is
stated and resolved rather than papered over.

## One conceptual mismatch, stated first

The proposal describes repro as a **capture** tool: something observes a
production execution (processes, files, network, environment), stores it,
and later replays it. repro is not that. repro is a **scenario
re-executor**: production evidence enters through `repro from` as text, curl,
HAR or logs; a scenario is authored from it; repro then *drives* the
application and observes the outcome it produced. Its "capture" is the
evidence bundle of a run repro itself performed.

This matters because half the proposal's vocabulary ("captured execution",
"recorded nondeterministic inputs", "replay") assumes an observer that does
not exist and that the README rules out on purpose (no proxy, no SDK, no
model inside). The plan below keeps repro's model and adds the smallest
observers that fit inside it: what repro can see from the outside of a
process it spawned, at the points where it spawned it.

## Capability matrix

| Capability | Existing | Partial | Missing | Proposed change |
| --- | --- | --- | --- | --- |
| Process capture | Services supervised as process groups; shell/agent steps: exit code, stdout, stderr, timeout | ✓ | Subprocess *tree* of a service, shell step or agent | Keep as-is. Tree capture needs ptrace/strace or a PATH shim; not portable, invasive, and the `tool_call: shell` semantic event already names the command. Coverage report labels subprocesses **PARTIAL (semantic only)** |
| Filesystem state | `fixtureHash()` over `.repro/fixtures` and `.repro/scripts` at seal time | | Per-step working-tree mutations | Snapshot the root's git working tree before/after each `shell` and `agent` step (`git status --porcelain` + `git diff`); record `Observed.files_changed` and `runs/NNNN/fs/<step>.patch`; add a `files_changed` matcher clause. Roots without git: labelled **not captured** |
| Network | `network.json`: every HTTP exchange repro made; browser responses (method/url/status); `diffNetworks`/`noisePaths` in explain | ✓ | Application-outbound and agent-outbound calls (incl. model API) | No proxy (non-goal, both sides). Model calls stay **semantic** (`model` events with `input`/`output`/`usage`). Coverage report distinguishes "HTTP responses repro drove: recorded" from "outbound: uncontrolled" |
| Environment | `Fingerprint` (os, arch, node, repro, git commit + dirty, lockfile hashes) at establish/seal/verify/status | ✓ | Per-run recording | Write the existing `fingerprint()` into each `result.json`. No new type |
| Git | Commit + dirty flag in the fingerprint; `bisect` | ✓ | Per-run uncommitted diff; run-against-sealed-commit | Per run: `git rev-parse HEAD` + `git diff` patch into the run dir (same primitive as filesystem row). Later, optional: `--worktree <ref>` on `run`/`verify` using `git worktree add` (phase 5, gated on demand) |
| Model calls | `model` event type in `AgentTrace`; `trace.model` matcher; `usage` matcher | ✓ | Request/response split; model identity | Accept `model_request`/`model_response` as aliases that normalise to `model` with `input`/`output`; add optional `model?: string` on `AgentEvent`. No new event type |
| MCP | — | | MCP call/result semantics | An MCP call **is** a tool call with a transport. Accept `mcp_call`/`mcp_result` as aliases for `tool_call`/`tool_result` and add optional `server?: string` on `AgentEvent`; `EventMatcher.server`. No new event type |
| Tool calls | `tool_call`/`tool_result` events; `name`, `arguments`, `output`, `count`, `sequence.contains`, `not_preceded_by` | ✓ | Link to physical effect | Correlation is by ordering plus the per-step filesystem diff (above): "tool_call `edit` → files_changed contains `src/auth.ts`". Optional `step?: number` on `AgentEvent` for emitters that group by agent turn |
| Replay | — (README: "Reproduction, not replay"; tool virtualization listed as not implemented) | | Record / replay of model and tool responses | **Reject as a repro-owned mechanism.** repro cannot replay what it does not proxy. Instead an *agent cooperation contract*: `agent.replay: <trace file>` exports `REPRO_REPLAY=<path>`, `agent.record: true` exports `REPRO_RECORD=<dir>`; the agent harness honours them. repro's job is to hand the file over and to say in the coverage report whether replay was in effect. Experiment mode = today's live run |
| Regression | `establish` → `seal` → `verify` (policy, exit 0/1/2) → `hook` → `export --test` | ✓ | Importer for agent evidence | The proposal's `repro test <capture>` is `repro verify`; `--current-worktree` is what `verify` already does. Add `repro from <trace.jsonl>` so a production agent trace becomes an `agent:` step with `trace_file` and a derived `reproduce.trace` matcher, completing the incident → fixture arc for agents |
| Divergence detection | `explain`: step necessity, causal state probe with/without the boundary step, noise subtraction over `network.json`, code paths from stack traces | ✓ | Trajectory divergence; correlation across layers | `firstDivergence(a, b)` over two `AgentEvent[]` (first index where type/name/server differ, plus the two events). Used by `explain` when the failure step is an agent step (reproduced vs non-reproduced run), and by `verify` against a compact trajectory stored in the seal. Each divergence is annotated with the filesystem diff and network entries recorded for that step |

## What repro already implements from the proposal

- **Agent execution as a specialisation of the generic contract.** The
  `agent:` step is one of five kinds sharing `Observed` and `Matcher`. The
  README says it in one sentence: "An agent bug is not a different product.
  It is the same contract with a different observation."
- **Semantic events.** `model`, `tool_call`, `tool_result`, `retrieval`,
  `handoff`, `message`, `custom`, with framework field aliases.
- **Agent-specific assertions.** Wrong tool, wrong arguments, missing
  guard (`not_preceded_by`), looping (`count`), cost (`usage`), latency
  (`duration_ms`), malformed output (`output.schema`).
- **Stochastic bugs as rates.** `--repeat`, Wilson interval,
  DETERMINISTIC / FLAKY / RARE, `establish`/`seal`/`verify` against an
  interval. This *is* the proposal's "regression" and "does my change fix
  it" capability.
- **Environment fingerprint** with the right privacy stance (no env vars).
- **Divergence with noise subtraction** for HTTP-observable state.
- **Completion gate** for Claude Code (`hook.ts`), i.e. one integration
  already exists and it is thin.
- **Production evidence → fixture** for HTTP applications: `from` (HAR,
  curl, logs) → scenario → seal → `export --test`.

## What is genuinely missing

1. Any physical observation of what a `shell` or `agent` step did to the
   working tree.
2. Per-run environment and git state (fingerprint exists but is not
   recorded per run).
3. MCP and model-identity metadata on events, and their matchers.
4. A coverage report: which layers a run recorded, which it could not.
5. Trajectory divergence (first differing event) between two runs, and the
   cross-layer annotation of that divergence.
6. An importer for agent traces (`repro from trace.jsonl`).
7. A stated record/replay contract between repro and an agent harness.
8. A normaliser for at least one real agent's native event stream
   (Claude Code `--output-format stream-json`).

## Architectural conflicts and their resolution

| Proposal | repro | Resolution |
| --- | --- | --- |
| "Reproduction mode: use recorded model responses to recreate the original execution" | "Replaying a recorded model output … proves only that the recording still plays" | Both are right about different questions. Live re-execution answers *would the agent decide this again* (the rate). Replay answers *given that decision, does the application fail* (the physical layer). Keep live as the default and the seal's measurement; offer replay only as the cooperation contract above, labelled in the coverage report, never as a proxy |
| Capture a production execution, then reproduce it | Evidence is imported; the scenario is authored; repro drives | Keep. Add the trace importer so agent evidence enters the same door HAR files do |
| `repro test <capture> [--current-worktree]` | `repro verify` runs the sealed contract against the current tree and exits 0/1/2 | Do not add a synonym command. Document the mapping. Consider `--worktree <ref>` later for the inverse (run against the sealed commit) |
| Numerical "reproducibility score" | Classification + Wilson interval + confidence | Coverage is a checklist of evidence, not a number; the proposal agrees |
| `agent.step` as a first-class event with children | Flat event list | Optional `step` index on events; the tree in the proposal is a *rendering* of ordering plus per-step physical diffs, not a stored structure |
| `integrations/` with five adapters | One (`hook.ts`), plus a JSONL contract any agent can meet | One normaliser (Claude Code) after the generic work; others when a real trace shows up |
| Process tree capture | stdout/stderr/exit only | Semantic-only, labelled PARTIAL. Not worth strace |

## Minimal extension points (in the order the code lets them in)

1. `agent.ts` `normalizeEvent()` + `AgentEvent` — aliases and three optional
   fields (`server`, `model`, `step`). `EventMatcher.server`.
2. `exec.ts` `execShell()` / `execAgent()` — bracket with a git working-tree
   snapshot; write the patch through `ctx.run.write()`.
3. `spec.ts` `Observed.files_changed` + `Matcher.files_changed` + one clause
   in `matchOutcome()`.
4. `run.ts` `executeOnce()` — record `fingerprint()` into the result; derive
   `coverage` from the result; `report.ts` renders it.
5. `agent.ts` `firstDivergence()`; `explain.ts` calls it for agent failure
   steps; `seal.ts` stores the baseline's compact trajectory and `verify()`
   compares.
6. `compile.ts` `importEvidence()` — `.jsonl` / `.json` with `events` →
   `fromTrace()`.
7. `agent.ts` `AgentStep.replay` / `record` → env vars in `execAgent()`.
8. `agent.ts` `AgentStep.format: 'claude-code'` → a second normaliser.

Nothing above adds a type whose name starts with `Agent` beyond the ones
that already exist.

## Phased plan

Each phase leaves `npm test` green (50 today) and adds tests in
`test/repro.test.mjs`. Phases 1–4 are the milestone; 5–6 are gated on a real
trace or a real request.

| phase | delivers | touches | rejects |
| --- | --- | --- | --- |
| 1 | Event aliases (`model_request`, `model_response`, `mcp_call`, `mcp_result`); `server`, `model`, `step` fields; `server` matcher. Per-step git working-tree diff for `shell` and `agent` steps; `files_changed` observation and matcher; per-run fingerprint in `result.json` | agent.ts, exec.ts, spec.ts, run.ts, evidence.ts, example agent gains an `edit` tool that writes a file | New event types; new step kinds |
| 2 | Coverage report: repository state, filesystem mutations, subprocesses (semantic), model responses, HTTP responses (driven vs outbound), environment, randomness, external dependencies (`base_url` without `services`, declared services, teardown). Rendered in `run` and present in `--json` | run.ts, report.ts, cli.ts | A score |
| 3 | `firstDivergence()`; `explain` on an agent failure step reports it with the per-step filesystem and network annotations; seal stores the baseline trajectory; `verify` reports divergence from it | agent.ts, explain.ts, seal.ts, report.ts | A `compare` command |
| 4 | `repro from trace.jsonl` → `agent:` step with `trace_file` and a derived `reproduce.trace` from the last tool call, COMPILE.md brief updated | compile.ts | A capture daemon |
| 5 | `agent.replay` / `agent.record` cooperation contract via env; coverage says "model responses: replayed"; optional `--worktree <ref>` | agent.ts, exec.ts, cli.ts | Proxying the model |
| 6 | `format: claude-code` normaliser for `claude -p --output-format stream-json`; `repro from` accepts a Claude Code transcript | agent.ts, compile.ts | Four more integrations nobody has asked for |

## Rejected outright

- `AgentArtifact`, `AgentEnvironment`, `AgentReplay` and any parallel
  evidence model: `RunDir`, `Observed`, `Fingerprint` already hold it.
- A model gateway or HTTP proxy for capturing model calls.
- ptrace/strace-based process observation.
- A numeric reproducibility score.
- `repro test` as a new command.
- An `integrations/` tree with speculative adapters.
- Any change to the three seal hashes' key sets. New observations are
  evidence, not contract, so they must not move a seal.

## Implementation status

All six phases landed in repro 0.3.0, on the extension points listed above
and nowhere else:

| phase | where it lives |
| --- | --- |
| 1 | `agent.ts` (`TYPE_ALIASES`, `server`/`model`/`step`, `EventMatcher.server`), `evidence.ts` (`treeSnapshot`, `diffSnapshots`, `fingerprint` moved here), `exec.ts` (`runStep` brackets shell/agent steps), `spec.ts` (`Observed.files`, `files_changed`), `run.ts` (per-run `environment`, `repo.patch`, `repo.status`) |
| 2 | `run.ts` `coverage()`, `report.ts` `renderCoverage()`, `--json` `coverage` |
| 3 | `agent.ts` `firstDivergence()`, `explain.ts` `trajectory`, `seal.ts` `Baseline.trajectory` + `VerifyReport.trajectory` |
| 4 | `compile.ts` `fromTrace()`; `scaffold` copies the trace into `.repro/fixtures/` |
| 5 | `agent.ts` `AgentStep.replay` / `record` → `REPRO_REPLAY` / `REPRO_RECORD` in `exec.ts`; `worktree.ts` + `--worktree` on `run` and `verify` |
| 6 | `integrations/claude-code.ts`, detected by shape in `parseTrace()` or forced with `format: claude-code` |

The seal's three hash key sets are unchanged. No type named `Agent*` was
added. `verify` remains the answer to "does my current change fix this".
