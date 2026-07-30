# rpc-subagents

A [Pi](https://github.com/earendil-works/pi-mono) extension for running persistent child agents through Pi's JSONL RPC mode.

## Features

- Spawn independent read-only or writable child agents
- Send RPC commands while agents keep running in the background
- Read structured events using byte-budgeted sequence cursors
- Fetch compact final results without replaying lifecycle traces
- Detect expired cursors and dropped events after buffer rollover
- Wait for activity or agent settlement
- Inspect and terminate child processes
- Inherit the parent model, thinking level, and project trust
- Automatically clean up child processes when the session shuts down

## Install

```bash
pi install git:github.com/prodmodfour/rpc-subagents
```

To try it without installing:

```bash
pi -e git:github.com/prodmodfour/rpc-subagents
```

Pi packages execute with your system permissions. Review the source before installing.

## Tools

| Tool | Purpose |
| --- | --- |
| `subagent_spawn` | Start a persistent child agent, optionally with an initial task |
| `subagent_rpc` | Send any supported Pi RPC command to a child |
| `subagent_events` | Read or wait for structured child events (trace view) |
| `subagent_result` | Wait for and return a compact answer, usage, status, errors, and changed files |
| `subagent_list` | List child agents with lifecycle state and answer previews |
| `subagent_kill` | Terminate a child process |

## Example workflow

1. Spawn a read-only child with a research task.
2. Call `subagent_result` for the normal compact answer path; it waits for settlement by default.
3. Use `subagent_events` when you need the raw trace, continuing from its `nextSequence` cursor and checking `cursorExpired`/`eventsDropped`.
4. Send follow-up prompts or terminate the child.

Writable children receive Pi's normal tool set. Read-only children are restricted to `read`, `grep`, `find`, and `ls`.

## Requirements

- Pi with RPC mode support
- Node.js or Bun supported by your Pi installation

## License

MIT
