# Task Manifests with External Artifact References

## Goal

Define a minimal shared task manifest for `ssyubix` so the room can coordinate
work without storing every task document, note, or artifact payload in
Cloudflare.

This design keeps:

- Cloudflare as the coordination plane
- external connectors and shared systems as optional work planes
- local device state as draft, cache, and checkpoint storage

## Why This Matters

`ssyubix` is intentionally taking the `Cloudflare + local` path to keep
development fast and operating cost low.

Cloudflare pricing and Durable Object behavior make the tradeoff clear:

- Durable Objects are excellent for small shared coordination state
- Durable Object duration and frequent storage writes become the first real
  cost pressure for chatty or document-heavy designs
- SQLite-backed Durable Object writes are more expensive than reads
- WebSocket hibernation helps only if we avoid turning every room interaction
  into durable storage churn

At the same time, MCP already allows agents to expose files, services, and
application-specific resources through other MCP servers and connectors. That
means `ssyubix` does not need to become the main document store for every team.

References:

- [Cloudflare Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [MCP Resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
- [MCP Roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

## Core Principle

`ssyubix` should synchronize only the smallest shared task metadata required for
cross-device coordination.

Everything else should be one of:

1. an external reference to a shared system
2. a local draft not yet published
3. a derived summary that can be rebuilt

## Task Manifest Rule

Each task in `ssyubix` should be represented by a small shared manifest.

The manifest exists to answer:

- what work exists
- what state it is in
- who owns it now
- who delegated it
- who should be contacted
- what external artifacts or decisions are relevant

The manifest does **not** exist to store:

- long task documents
- full working notes
- large reports
- patches or binary artifacts
- private connector-specific content that other agents cannot access

## State Split

### Cloud-Synced Manifest Fields

These fields belong in Cloudflare because every agent in the room may need them
to coordinate correctly:

- `task_id`
- `title`
- `status`
- `delegated_by`
- `responsible_agent_id`
- `point_of_contact_agent_id`
- `created_at`
- `updated_at`
- `lease_until`
- `priority`
- `artifact_refs`
- `decision_refs`
- `visibility`

These fields must stay compact, stable, and cheap to update.

### External Reference Fields

These are references to systems outside `ssyubix`, exposed through a connector,
another MCP server, or a shared platform such as GitHub or a team drive:

- `artifact_refs[].uri`
- `artifact_refs[].backend`
- `artifact_refs[].title`
- `artifact_refs[].summary`
- `artifact_refs[].shared`
- `artifact_refs[].readable_by_all`
- `artifact_refs[].access_caveat`

The purpose of these fields is to tell agents where the real work product
exists, without copying the whole payload into the room manifest.

### Local-Draft Fields

These should remain local to a device until they are explicitly published:

- in-progress notes
- working scratchpad content
- partial summaries
- unpublished patches
- retry metadata
- inbox-derived interpretation

Local draft state may help one agent work efficiently, but it must not be
treated as the room's source of truth.

## Artifact Reference Contract

Each published artifact reference should be small and explicit.

Suggested v1 shape:

```json
{
  "artifact_id": "art_123",
  "title": "Draft deployment checklist",
  "uri": "github://syuaibsyuaib/ssyubix/issues/42",
  "backend": "github",
  "summary": "Current checklist for staging deploy",
  "shared": true,
  "readable_by_all": true,
  "access_caveat": null,
  "published_by": "AGENT1234",
  "published_at": "2026-03-09T00:00:00Z"
}
```

The important part is not the exact field names, but the policy:

- the room should know **what** the artifact is
- the room should know **where** it lives
- the room should know **whether everyone can read it**
- the room should not need the full payload to coordinate around it

## Accessibility Rules

External artifacts are useful only if agents can reason about accessibility.

`ssyubix` should assume three categories:

1. `team-readable`
   Everyone relevant can access it.
2. `partially shareable`
   Some agents may need a connector or token the room cannot assume.
3. `agent-specific`
   Only one agent can read it, so it cannot be the sole source of critical
   task state.

Rule:

No critical task state should depend only on an `agent-specific` artifact.

If an artifact is not broadly readable, the room manifest still needs enough
shared metadata for handoff and continuity.

## Connector Rule

Connectors and external MCP servers should be treated as optional work planes,
not mandatory control planes.

That means:

- `ssyubix` may point to shared systems owned by the team
- `ssyubix` may use connector-aware metadata to describe accessibility
- `ssyubix` must not assume every agent has the same connector installed
- `ssyubix` must not make one agent's private connector the only home of a
  critical task definition

This keeps the system cheap without making collaboration fragile.

## Failure and Fallback Rules

If an external reference becomes unavailable:

- the task manifest still remains visible in the room
- ownership and status remain synchronized
- the task can be re-routed, blocked, or clarified
- agents still know whom to ask next

If a connector is not installed on one agent:

- that agent can still see the task manifest
- that agent can still understand the artifact summary and accessibility
- that agent should not pretend it can read the external content

## Minimal Task Manifest Example

```json
{
  "task_id": "task_001",
  "title": "Prepare release smoke checklist",
  "status": "accepted",
  "delegated_by": "PLANNER01",
  "responsible_agent_id": "WORKER02",
  "point_of_contact_agent_id": "WORKER02",
  "priority": "normal",
  "lease_until": "2026-03-09T02:30:00Z",
  "artifact_refs": [
    {
      "artifact_id": "art_001",
      "title": "Checklist draft",
      "uri": "github://syuaibsyuaib/ssyubix/issues/42",
      "backend": "github",
      "summary": "Draft checklist for smoke verification",
      "shared": true,
      "readable_by_all": true,
      "access_caveat": null
    }
  ],
  "decision_refs": [],
  "created_at": "2026-03-09T01:00:00Z",
  "updated_at": "2026-03-09T01:15:00Z"
}
```

This is enough for routing, follow-up, and recovery without turning the room
into a full document database.

## Non-Goals

This design does not assume:

- every task document lives in Cloudflare
- every agent has identical connectors
- every external system is always available
- local drafts are trustworthy room state

## Acceptance Criteria

- task manifests are explicitly metadata-first
- artifact references can point to external shared systems
- critical task state never depends only on one agent's local cache or private
  connector
- the design remains compatible with mixed-agent environments
- the design gives later task/delegation features a clear cost boundary

## Follow-Up Backlog

1. Classify task fields into `cloud-sync`, `external-ref`, and `local-draft`
   buckets.
2. Add connector-aware artifact accessibility metadata.
3. Design delegation and task ownership flows on top of the minimal manifest.
