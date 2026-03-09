# Connector-Aware Artifact Accessibility Metadata

## Goal

Define a small metadata contract for artifact references so agents in a
`ssyubix` room can quickly tell whether an external artifact is:

- broadly shareable for the team
- only partially shareable
- effectively private to one agent or connector

This keeps task coordination cheap while avoiding false assumptions about who
can actually read the referenced content.

## Why This Matters

`ssyubix` is designed to keep shared coordination state small. That means
artifact payloads will often live outside the room manifest.

Once that happens, the room needs more than a URI. It also needs enough
accessibility metadata for agents to decide:

- whether they can use the artifact directly
- whether they should ask another agent for help
- whether the artifact is safe to treat as shared task evidence

Without this metadata, a room can easily become fragile:

- one agent publishes a private link
- another agent assumes it is readable
- the task appears coordinated, but handoff fails

## Design Principles

1. Artifact references should be lightweight and cheap to sync.
2. Accessibility metadata should be explicit, not inferred from the URI alone.
3. No critical shared task state should depend only on a connector that one
   agent happens to have.
4. The metadata should help agents route follow-up work without exposing
   secrets.

## Reference Model

Each published artifact reference should include a small accessibility section.

Suggested v1 fields:

- `backend`
- `shared`
- `readable_by_all`
- `access_caveat`
- `requires_connector`
- `connector_name`
- `visibility_scope`

These fields are not meant to replace authorization. They are coordination
metadata for mixed-agent environments.

## Field Definitions

### `backend`

The storage or integration family behind the artifact.

Examples:

- `github`
- `google_drive`
- `local_root`
- `http`
- `custom_mcp`
- `unknown`

Why it matters:

- gives the room a quick signal about expected access patterns
- helps matching and delegation later

### `shared`

Boolean meaning:

- `true`: the publisher intends this artifact to be used by the team
- `false`: the artifact is a personal or transitional attachment

This is an intent field, not proof of accessibility.

### `readable_by_all`

Boolean meaning:

- `true`: all relevant room participants are expected to be able to read it
- `false`: at least some participants may not be able to access it

Rule:

If `readable_by_all` is `false`, the artifact must not become the sole home of
critical task state.

### `access_caveat`

Short human-readable warning about access conditions.

Examples:

- `requires GitHub repo access`
- `visible only on agents with the local root mounted`
- `available to one device only`
- `requires a Google Drive connector`

This gives agents a safe explanation they can use for routing and handoff.

### `requires_connector`

Boolean meaning:

- `true`: the artifact depends on a connector or MCP integration beyond plain
  room access
- `false`: the artifact is expected to be readable without a specialized
  connector

### `connector_name`

Optional label for the connector or MCP dependency.

Examples:

- `github`
- `google-drive`
- `filesystem`
- `notion`

This is useful for matching work to agents that actually have the needed
connector installed.

### `visibility_scope`

Short enum describing expected sharing scope.

Suggested values:

- `team`
- `partial`
- `agent_only`

Interpretation:

- `team`: broadly usable by room participants
- `partial`: usable only by some agents
- `agent_only`: effectively private attachment

## Recommended v1 Artifact Shape

```json
{
  "artifact_id": "art_002",
  "title": "Infra checklist draft",
  "uri": "github://syuaibsyuaib/ssyubix/issues/57",
  "backend": "github",
  "summary": "Checklist for validating the next deployment",
  "shared": true,
  "readable_by_all": true,
  "requires_connector": false,
  "connector_name": null,
  "visibility_scope": "team",
  "access_caveat": null,
  "published_by": "AGENT1234",
  "published_at": "2026-03-09T00:00:00Z"
}
```

Example of a connector-limited artifact:

```json
{
  "artifact_id": "art_003",
  "title": "Local benchmark notes",
  "uri": "file:///workspace/notes/benchmark.md",
  "backend": "local_root",
  "summary": "Device-local benchmark notes before publication",
  "shared": false,
  "readable_by_all": false,
  "requires_connector": true,
  "connector_name": "filesystem",
  "visibility_scope": "agent_only",
  "access_caveat": "visible only on agents with the same local root mounted",
  "published_by": "AGENT5678",
  "published_at": "2026-03-09T00:10:00Z"
}
```

## Interpretation Rules

### Team-Readable Artifacts

If:

- `shared = true`
- `readable_by_all = true`
- `visibility_scope = team`

Then the room can safely treat the artifact as a shared working reference.

### Partially Shareable Artifacts

If:

- `shared = true`
- `readable_by_all = false`
- `visibility_scope = partial`

Then the room should:

- keep the task manifest small but sufficient
- avoid assuming every agent can inspect the artifact directly
- prefer assigning follow-up to agents that have the required connector

### Agent-Only Artifacts

If:

- `shared = false`
- `visibility_scope = agent_only`

Then the artifact should be treated as a private attachment or working draft.
It may still be useful, but it cannot be the only place where room-critical
task meaning lives.

## Security and Privacy Rules

- Do not put secrets, raw tokens, or private credentials in artifact metadata.
- `access_caveat` should describe conditions, not reveal secrets.
- A private room does not automatically make every artifact team-readable.
- Connector-aware metadata should remain descriptive, not authoritative for
  access control.

This matches MCP's design: authorization is handled by the transport and the
underlying integration, not by arbitrary room metadata alone.

## MCP-Specific Notes

This design aligns with MCP in a few ways:

- MCP `resources` are meant to identify useful context, but the protocol does
  not guarantee every client has identical access to every external system.
- MCP `roots` explicitly describe filesystem boundaries, which is why
  `local_root` artifacts should default to conservative accessibility.
- MCP authorization guidance treats access as a real security boundary, so the
  room should not pretend connector visibility is universal when it is not.

References:

- [MCP Resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
- [MCP Roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)

## Acceptance Criteria

- every external artifact reference has enough metadata for accessibility
  reasoning
- agents can tell the difference between team-readable, partial, and
  agent-only artifacts
- no secret data needs to be exposed in the metadata
- future task/delegation logic can route follow-up based on connector-aware
  accessibility signals

## Non-Goals

- enforcing authorization through room metadata alone
- guaranteeing that all connectors behave identically
- copying external artifact payloads into Cloudflare just to make them visible
