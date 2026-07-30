# Local pi-panda bridge

This is the version-one, process-local integration contract between `children-of-pi` and a `pi-panda` extension loaded in the same parent Pi process. It uses `pi.events`; it is not a socket protocol and is not available across processes by itself.

The bridge is optional. children-of-pi has no pi-panda package dependency and does not depend on extension load order. A consumer should retry discovery if its first request is emitted before children-of-pi loads.

## Channels

| Channel | Direction | Purpose |
| --- | --- | --- |
| `children-of-pi:request` | pi-panda → children-of-pi | Discovery or bio operation |
| `children-of-pi:response:<requestId>` | children-of-pi → pi-panda | Exactly correlated response |
| `children-of-pi:changed` | children-of-pi → listeners | Additive invalidation/lifecycle event |

`requestId` is a non-empty consumer-generated string of at most 256 characters. Requests may include `version: 1`; an omitted version is accepted for event-bus compatibility. Any other version is rejected.

## Capabilities

Version one advertises only:

```json
[
  "children.read",
  "children.bio.read",
  "children.bio.write"
]
```

These names deliberately do not claim generic child messaging or generic child RPC.

## Requests

All requests have this base:

```json
{
  "version": 1,
  "requestId": "d56f...",
  "type": "children.list"
}
```

`requestType` is accepted as a compatibility alias for `type`, but new consumers should send `type`.

Supported request-specific fields:

| Type | Fields |
| --- | --- |
| `children.list` | none |
| `child.get` | `instanceId` |
| `bio.get` | `instanceId` |
| `bio.set` | `instanceId`, `bio`, `expectedRevision?`, `force?`, `actor` |
| `bio.clear` | `instanceId`, `expectedRevision?`, `force?`, `actor` |

`instanceId` is the UUID-backed child instance ID, not the display ID (`agent-3`). The stable address returned in summaries is `child:<owner-session-id>:<instance-id>`.

A mutation actor is authenticated and derived by pi-panda before it reaches this trusted local bridge:

```ts
type ExternalBioActor =
  | { kind: "parent"; sessionId: string; name: string | null }
  | { kind: "human"; via: "pi-tui" | "whatspi"; parentSessionId?: string };
```

The bridge rejects a caller-supplied `system` actor. Fields named `updatedBy` are ignored; only `actor` becomes the audit attribution. pi-panda is responsible for authenticating a remote endpoint before forwarding its actor. A local model-facing tool must not expose an arbitrary actor parameter.

## Responses

Responses are emitted on the request-specific response channel:

```json
{
  "version": 1,
  "requestId": "d56f...",
  "type": "response",
  "requestType": "bio.get",
  "success": true,
  "result": {}
}
```

Errors use:

```json
{
  "version": 1,
  "requestId": "d56f...",
  "type": "response",
  "requestType": "child.get",
  "success": false,
  "error": {
    "code": "child_unavailable",
    "message": "No live child exists for instanceId ..."
  }
}
```

Known error codes are `invalid_request`, `incompatible_version`, `unsupported_request`, `child_unavailable`, `bio_revision_conflict`, and `duplicate_request`.

The responder keeps a bounded in-memory request cache. Retrying the same `requestId` with the same payload returns the original response without applying a mutation twice. Reusing an ID with a different payload returns `duplicate_request`.

A CAS conflict has `success: false`, error code `bio_revision_conflict`, and a structured result containing `conflict: true`, `expectedRevision`, `current`, and `bio` (the same current record). A successful mutation result contains identity fields plus the new `bio`.

`children.list` returns:

```json
{
  "ownerSessionId": "parent-session-id",
  "capabilities": ["children.read", "children.bio.read", "children.bio.write"],
  "children": []
}
```

Only live children appear. Each child is a deliberately narrow projection with exactly `address`, `displayId`, `instanceId`, `ownerSessionId`, string `state`, and `bio`; process handles, RPC state, stderr, event buffers, and generic RPC are never exposed by the bridge. `child.get`, `bio.get`, `bio.set`, and `bio.clear` reject dead, unknown, or replaced instance IDs.

## Changed events

The changed channel emits invalidation events shaped like:

```json
{
  "version": 1,
  "type": "changed",
  "change": "spawn | exit | lifecycle | bio | context-reset",
  "ownerSessionId": "parent-session-id",
  "capabilities": ["children.read", "children.bio.read", "children.bio.write"],
  "instanceId": "child-instance-id",
  "address": "child:parent-session-id:child-instance-id",
  "child": {}
}
```

Identity fields are present for child-specific events. A live child's embedded `child` summary is a detached narrow snapshot; exit events retain identity but omit `child` because the live child and its bio no longer exist. Consumers should issue `children.list` or `child.get` when they need authoritative current state.

Events are emitted after spawn, process exit (including kill), important run lifecycle changes, successful local or bridged bio edits, and successful full-context reset clearing. Conflicts and failed/cancelled context replacements do not emit a bio change.

## Trust boundary

This bridge is intentionally process-local. It does not authenticate network peers, decide pi-panda parent visibility, or bypass hidden-parent policy. pi-panda must enforce project scope, endpoint authentication, and hidden-agent rules before forwarding an operation. children-of-pi remains authoritative for whether a child instance is alive and whether its bio CAS succeeds.
