# Design

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

repro is not another coding agent. It is the reproduction layer underneath
whichever one you use.


## Principles

**Reproduction before diagnosis.** Can we make it fail? Can we make it fail
consistently? Can we make it smaller? Only then, why.

**Deterministic where possible.** A model is useful for turning prose into a
candidate scenario. Deciding whether the bug reproduced is not a judgement call,
so nothing in the execution path is one.

**Agent independent.** No dependency on a particular model, assistant or IDE.
There is no model inside repro: no API key, no vendor, no hidden inference.

**Human inspectable.** The spec is a YAML file you can read, edit and review.
There is no hidden state.

**The contract outlives the implementation.** The code changes; the definition of
the bug does not. A seal makes any change to that definition visible instead of
preventing it.

**Evidence over claims.** Not "I think I reproduced it" — `20/20 runs`, a trace,
and a diff.

**Re-execution, not replay.** repro runs the scenario again rather than playing
a recording back. Where a recording is useful — a model decision an agent
should hold fixed — it is handed to the process through a documented contract
and reported in the coverage, never proxied.


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

For agents specifically, repro is not an LLM proxy, a model gateway, an MCP
gateway, an agent framework or a tracing dashboard. It observes a process it
spawned from the outside and matches what it observes.


## Architecture notes

- [Current state](architecture/current-state.md) — the repository as it stood
  before agent reproduction was added: execution model, data model, extension
  points, limitations.
- [Agent reproduction gap](architecture/agent-reproduction-gap.md) — the
  capability matrix, what was missing, the phased plan, and where each phase
  landed.


## Development

```bash
npm install
npm run build
npm test          # unit and end-to-end: reproduce, minimize, explain, verify
bash docs/demo.sh # regenerate the demo recording under docs/assets/
```

```
src/
├── cli.ts            commands and flags, including export --test
├── spec.ts           the YAML model, matchers, hashing key sets
├── exec.ts           steps and the service supervisor
├── run.ts            one run, repeated runs, the verdict, coverage
├── evidence.ts       run directories, fingerprint, working-tree snapshots
├── agent.ts          the trace model, its parser and matchers, divergence
├── integrations/     normalizers for native streams (Claude Code)
├── seal.ts           establish, seal, verify, status
├── minimize.ts       delta debugging over scenario steps
├── explain.ts        failure boundary, state probing, trajectory divergence
├── compile.ts        init and from: repository facts, importers, briefing
├── worktree.ts       --worktree
├── bisect.ts, hook.ts, report.ts
example/              a shop with a real checkout bug, a browser spec, an agent spec
test/                 one file, node:test, run against dist/
```

The MVP targets JavaScript and TypeScript web applications and any agent that
can print a JSON trace; the execution layer is deliberately separated from the
ecosystem so others can be added.
