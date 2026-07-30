# rpc-subagents

A [Pi](https://github.com/earendil-works/pi-mono) extension for running persistent child agents through Pi's JSONL RPC mode.

## Features

- Spawn independent read-only or writable child agents
- Send RPC commands while agents keep running in the background
- Read structured events using sequence cursors
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
| `subagent_events` | Read or wait for structured child events |
| `subagent_list` | List child agents and their current state |
| `subagent_kill` | Terminate a child process |

## Example workflow

1. Spawn a read-only child with a research task.
2. Poll `subagent_events` with `wait: "settled"`.
3. Read `lastAssistantText` or request additional state with `subagent_rpc`.
4. Send follow-up prompts or terminate the child.

Writable children receive Pi's normal tool set. Read-only children are restricted to `read`, `grep`, `find`, and `ls`.

## Requirements

- Pi with RPC mode support
- Node.js or Bun supported by your Pi installation

## License

MIT
