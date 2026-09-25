# Agent reproduction

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

- [The trace](#the-trace)
- [What you can match](#what-you-can-match)
- [Two layers, one run](#two-layers-one-run)
- [Stochastic bugs are still bugs](#stochastic-bugs-are-still-bugs)
- [Reproduction and replay](#reproduction-and-replay)
- [Claude Code](#claude-code)
- [From an incident to a fixture](#from-an-incident-to-a-fixture)
- [Semantic failures](#semantic-failures)


## The trace

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

Other spellings normalize onto those seven rather than adding to them:

| emitted | becomes |
| --- | --- |
| `model.request` / `model_request`, then `model.response` / `model_response` | one `model` event with `input` and `output` |
| `tool.call`, `tool_use` / `tool.result` | `tool_call` / `tool_result` |
| `mcp.call`, `mcp_call` / `mcp.result`, `mcp_result` | `tool_call` / `tool_result` with `server` set (`mcp` when unnamed) |
| `agent.step`, `agent_step` | not an event; numbers every event after it with `step` |

An MCP call is a tool call with a transport, so `server` is a field, not a
type. `model` events may carry `model` (the identifier) and every event may
carry `step`.

The step keys — `run`, `input`, `trace_file`, `output_schema`, `format`,
`replay`, `record` — are listed in [The spec → Agent step keys](spec.md#agent-step-keys).


## What you can match

| bug | matcher |
| --- | --- |
| wrong tool | `trace: { tool_call: { name: refund_order } }` |
| wrong arguments | `arguments: { amount: { greater_than: 100 } }` |
| wrong MCP server | `tool_call: { name: read_file, server: filesystem }` |
| missing required action | `sequence: { contains: [...], not_preceded_by: {...} }` |
| looping | `tool_call: { name: web_search, count: { greater_than: 10 } }` |
| cost or latency | `usage: { total_tokens: { greater_than: 50000 } }`, `duration_ms` |
| malformed structured output | `output: { schema: { valid: false } }` |
| edited the wrong file | `files_changed: [src/auth.ts]` |

Comparators are `equals`, `not_equals`, `greater_than`,
`greater_than_or_equal`, `less_than`, `less_than_or_equal`, `contains`,
`matches`, `exists`, `missing`. An object whose keys are all comparators is a
comparison; any other object is an expected value.


## Two layers, one run

An agent trace says *the agent called `npm test`*. repro also sees the run the
agent happened in:

```
                    AGENT SEMANTICS      model → tool_call: shell → tool_call: edit
                                             │                  │
────────────────────────────────────────────┼──────────────────┼────────────
                    REAL EXECUTION           │                  │
                                        exit code, output   files_changed
                    git 67071a9 + repo.patch · lockfile hashes · network.json
```

The semantic events come from the agent; the physical layer comes from repro
observing the process it spawned — exit codes, output, the working tree before
and after, the commit and uncommitted diff the run started from. The
[coverage checklist](evidence.md#coverage) says which of those a run actually
has. The link between the two layers is by step: `tool_call: edit` on the
trace, `~ src/auth.ts` on the same step's files.


## Stochastic bugs are still bugs

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
— against the interval, not against a single lucky run. For an agent bug the
seal also keeps the trajectory that reproduced, so `verify` reports where the
fixed agent left the bug path, and `explain` compares a reproducing run with
one that avoided it. Both are shown under
[Commands](commands.md#repro-verify).


## Reproduction and replay

repro runs the agent fresh every time. That answers *would the agent make the
same bad decision again* — the rate, which is what `establish`, `seal` and
`verify` measure. Replaying a recorded model output cannot answer that; it
proves only that the recording still plays.

Replay answers a different question: *given that decision, does the rest still
fail*. That isolates the physical layer — the tools, the files, the
application — from the model's sampling, and it is what `replay:` is for:

```yaml
- agent:
    run: node agents/support.mjs
    replay: .repro/fixtures/incident.jsonl   # reproduction mode
    record: true                              # save what this run would replay
```

repro does not proxy the model. It exports `REPRO_REPLAY=<absolute path>`
and `REPRO_RECORD=<dir under the run's evidence>` to the agent and the
harness honours them — the shipped support agent takes its planner decision
from the recording, runs its tools live, and saves the decision it made under
`REPRO_RECORD` so the next run can replay it. Coverage reports `model
responses: replayed from …` when the contract was in effect, so a replayed run
is never mistaken for a measurement. Everything else in the spec — a different
model in `env`, a different prompt in `input`, different code in the working
tree — is experiment mode: change one thing, run live, watch the rate.

The consequence to be aware of either way: the agent's tools run for real.
Point the step at a harness whose tools are stubbed, or at a staging
environment, before reproducing a bug whose failing step is `refund_customer`.


## Claude Code

`claude -p "<prompt>" --output-format stream-json --verbose` prints a stream
repro recognizes by shape, and the session transcripts under
`~/.claude/projects/` have the same shape:

```yaml
- id: fix
  agent:
    run: claude -p "fix the failing auth test" --output-format stream-json --verbose
    # format: claude-code   # only if detection guesses wrong
```

Assistant turns become `model` events (with the model id and usage), tool
uses become `tool_call`, tool results `tool_result`, text `message`; MCP tools
named `mcp__<server>__<tool>` split into `name` and `server`; the final
`result` is the output. A turn printed as several records under one message id
is one turn. `repro from session.jsonl` imports a transcript directly. This is
the only integration repro ships, and it is a normalizer, not a dependency — an
agent that prints the generic JSONL never touches it.


## From an incident to a fixture

```bash
repro from incident.jsonl
repro run
```

The trace becomes an `agent` step with `trace_file` pointing at a copy under
`.repro/fixtures/`, and `failure.reproduce` is derived from the last tool call.
The first `repro run` reproduces from the recording: that proves the matcher
describes the failure in the evidence. Add `run:` and drop `trace_file` to make
the live agent do it again, then `establish`, `seal`, fix, `verify`, and
`export --test` as with any other bug. `COMPILE.md` walks the agent through it.


## Semantic failures

Some failures cannot be expressed structurally: "the assistant claimed a
cancelled reservation was still active". Today, write that check as a `shell`
step that reads the trace from the run directory and exits non-zero, and match
on its `exit_code`. The order of preference is worth keeping: deterministic
state, then structured output, then tool trajectory, then an executable check,
and only then a model judging another model.
