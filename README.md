# children-of-pi

A [Pi](https://github.com/earendil-works/pi-mono) extension for running persistent child agents through Pi's JSONL RPC mode.

## Features

- Spawn independent read-only or writable child agents
- Send RPC commands while agents keep running in the background
- Read structured events using byte-budgeted sequence cursors
- Fetch compact final results without replaying lifecycle traces
- Detect expired cursors and dropped events after buffer rollover
- Wait for activity or agent settlement
- Inspect and terminate child processes
- Describe knowledge in a live child's current context with revisioned child bios
- Address each child unambiguously with a UUID-backed instance address
- Integrate local parent networks through the optional pi-panda event-bus bridge
- Use each child Pi's configured model, thinking level, and settings without overriding them
- Inherit parent project trust only for the same canonical working directory
- Automatically clean up child processes when the session shuts down

## Install

```bash
pi install git:github.com/prodmodfour/children-of-pi
```

To try it without installing:

```bash
pi -e git:github.com/prodmodfour/children-of-pi
```

Pi packages execute with your system permissions. Review the source before installing.

## Tools

| Tool | Purpose |
| --- | --- |
| `subagent_spawn` | Start a persistent child agent, optionally with an initial task |
| `subagent_rpc` | Send any supported Pi RPC command to a child |
| `subagent_events` | Read or wait for structured child events (trace view) |
| `subagent_bio` | Read, CAS-update, or clear a live child's descriptive bio |
| `subagent_result` | Wait for and return the latest run's answer/status/error plus session-wide usage and changed files |
| `subagent_list` | List child agents with lifecycle state and answer previews |
| `subagent_kill` | Terminate a child process |

## Example workflow

1. Spawn a read-only child with a research task.
2. Call `subagent_result` for the normal compact answer path; it waits for settlement by default.
3. Use `subagent_events` when you need the raw trace, continuing from its `nextSequence` cursor and checking `cursorExpired`/`eventsDropped`.
4. Send follow-up prompts or terminate the child.

Writable children receive Pi's normal tool set. Read-only children are restricted to `read`, `grep`, `find`, and `ls`, and direct RPC `bash` commands are rejected. Children of Pi does not override child model or thinking settings and rejects RPC commands that mutate Pi settings.

Every child receives an explicit project-trust flag. Parent trust is inherited only when the requested child cwd and the parent's cwd resolve to the same canonical directory; a different or unresolvable cwd is started with project resources unapproved.

`subagent_result.answer`, `stopReason`, `status`, and `error` describe the latest agent run. `sessionUsage` and `sessionChangedFiles` are lifetime aggregates for the child session. Changed-file tracking is best-effort: it includes successful built-in `edit` and `write` calls, but cannot infer arbitrary filesystem changes made through Bash or custom tools.

## Child identity

The familiar display ID (`agent-1`, `agent-2`, …) is convenient but is process-local and may be reused after the extension restarts. Every spawn also receives a random `instanceId`. Its canonical address is:

```text
child:<owner-session-id>:<instance-id>
```

Machine summaries from `subagent_spawn`, `subagent_list`, and `subagent_result` add `instanceId`, `ownerSessionId`, `ownerParentSessionId`, `address`, and `bio` without changing existing fields. Use `address` or `instanceId`, never a display ID alone, as a durable remote reference.

## Child bios

A bio is **a short description of useful knowledge currently present in an agent's conversation context**. Bios are blank by default.

A bio is not a role. It is untrusted routing metadata—not an instruction, permission, policy, assignment, proof, or source of authority. Children of Pi never inserts a bio into the child's system prompt or incoming messages, and a bio never changes tools or access.

`subagent_bio` accepts:

```json
{
  "id": "agent-1",
  "action": "get | set | clear",
  "bio": "Has inspected session persistence through commit abc1234.",
  "expectedRevision": 0,
  "force": false
}
```

`set` requires `bio`. `set` and `clear` use optimistic compare-and-set: pass the revision returned by the prior read. A stale or missing revision returns a structured conflict and the current record instead of overwriting it. `force: true` is an explicit bypass. The model cannot supply `updatedBy`; local tool updates are attributed to the owning parent session.

Bio text is limited to 2,000 Unicode code points. CRLF is normalized to LF, while intentional Markdown, line breaks, and other whitespace are preserved. Each successful set or clear increments the revision and records update time and actor. Child audit history is bounded in memory.

In Pi's interactive TUI, `/child-bio <child-id>` opens the multiline editor at the current revision. Saving uses CAS, an empty editor clears the bio, and a concurrent edit is reported without silent overwrite. The command is disabled outside TUI mode and does not trigger a model turn.

A child bio persists through prompts, steering, follow-ups, and compaction while that exact child process and context remain alive. A successful `new_session`, `switch_session`, `fork`, or `clone` RPC response clears it, increments its revision, and attributes the reset to `system/context-reset`. Failed or cancelled replacements do not clear it. The bio is discarded when the child process exits or the owning children-of-pi session shuts down.

## Local pi-panda bridge

When pi-panda is loaded in the same parent Pi process, it can discover live children and mediate remote child bio reads or edits through Pi's process-local extension event bus. children-of-pi remains authoritative for instance identity, lifecycle, and bio CAS.

The bridge exposes only:

- `children.list`
- `child.get`
- `bio.get`
- `bio.set`
- `bio.clear`

It advertises `children.read`, `children.bio.read`, and `children.bio.write`. It does **not** expose generic child RPC or child messaging. Mutations accept an authenticated parent/human actor supplied by pi-panda; system attribution cannot be forged. Dead or superseded instance IDs fail as unavailable.

Channels and exact payloads are documented in [`docs/pi-panda-bridge.md`](docs/pi-panda-bridge.md). Change notifications are emitted after spawn, exit, important lifecycle transitions, bio edits, and context-reset clearing. children-of-pi does not depend on pi-panda and behaves normally when it is absent.

## Requirements

- Pi with RPC mode support
- Node.js or Bun supported by your Pi installation

## License

MIT
