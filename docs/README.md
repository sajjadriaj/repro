# repro documentation

| | |
| --- | --- |
| [Getting started](getting-started.md) | install, the first reproduction, the agent loop, the example |
| [The spec](spec.md) | `repro.yaml` key by key: steps, matchers, comparators, services |
| [Commands](commands.md) | every command with its output and options |
| [Agent reproduction](agents.md) | traces, MCP, the two layers, record and replay, Claude Code |
| [Evidence](evidence.md) | the run bundle, the coverage checklist, the fingerprint |
| [Design](design.md) | why repro exists, principles, non-goals, development |
| [Architecture notes](architecture/) | repository archaeology and the agent-reproduction gap analysis |

`docs/demo.sh` regenerates the recording under `assets/`; everything in it is
really executed against `example/`.
