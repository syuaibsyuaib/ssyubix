# Task Field Classification

## Goal

Classify task-related fields in `ssyubix` into three buckets:

- `cloud-sync`
- `external-ref`
- `local-draft`

This keeps future task features aligned with the `Cloudflare + local` strategy
while still allowing agents to collaborate through external systems and mixed
connector setups.

## Why This Matters

Once `ssyubix` starts carrying tasks, the main cost risk is not task count by
itself. The real risk is turning task updates into frequent Durable Object
writes or stuffing large payloads into Cloudflare that could have stayed local
or lived in a shared external system.

Cloudflare's pricing makes that boundary important:

- Durable Object duration is billed while the object stays active and cannot
  hibernate
- incoming WebSocket messages are relatively cheap compared with heavy storage
  churn
- SQLite-backed Durable Object writes are materially more expensive than reads
- `setAlarm()` is also a billed storage write

References:

- [Cloudflare Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [MCP Resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
- [MCP Roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

## Classification Rules

### `cloud-sync`

Use this for fields that must be visible and consistent for all agents in the
room.

Properties:

- small
- coordination-critical
- safe to store in shared room state
- required for routing, ownership, or recovery

### `external-ref`

Use this for fields that point to shared content outside `ssyubix`.

Properties:

- a reference, not the payload
- may depend on connector or external access
- should be small enough to include in the task manifest
- should contain enough metadata for handoff and accessibility reasoning

### `local-draft`

Use this for fields that help one device work efficiently but do not need to be
shared immediately.

Properties:

- temporary
- reconstructable
- often high-churn
- dangerous or wasteful to treat as shared truth too early

## Field Table

| Field | Classification | Why |
| --- | --- | --- |
| `task_id` | `cloud-sync` | Required to identify the task across devices. |
| `title` | `cloud-sync` | Needed for shared understanding and routing. |
| `status` | `cloud-sync` | Core coordination state. |
| `delegated_by` | `cloud-sync` | Needed to track delegation origin. |
| `responsible_agent_id` | `cloud-sync` | Needed to know who owns execution. |
| `point_of_contact_agent_id` | `cloud-sync` | Needed for follow-up routing. |
| `created_at` | `cloud-sync` | Stable lifecycle metadata. |
| `updated_at` | `cloud-sync` | Stable lifecycle metadata. |
| `lease_until` | `cloud-sync` | Needed for ownership timeout and recovery. |
| `priority` | `cloud-sync` | Small and coordination-relevant. |
| `visibility` | `cloud-sync` | Needed to reason about who should see the task. |
| `offer_state` | `cloud-sync` | Shared negotiation state for delegation. |
| `acceptance_state` | `cloud-sync` | Shared commitment state after delegation. |
| `artifact_refs` | `cloud-sync` | Shared manifest field, but stores only references. |
| `decision_refs` | `cloud-sync` | Shared manifest field for linked decisions. |
| `watcher_ids` | `cloud-sync` | Small coordination metadata for follow-up. |
| `mentioned_agent_ids` | `cloud-sync` | Shared routing metadata. |
| `artifact_refs[].uri` | `external-ref` | Points to external content. |
| `artifact_refs[].backend` | `external-ref` | Explains the integration family. |
| `artifact_refs[].summary` | `external-ref` | Short context for handoff without copying payload. |
| `artifact_refs[].shared` | `external-ref` | Accessibility intent for the room. |
| `artifact_refs[].readable_by_all` | `external-ref` | Signals whether the room can rely on the artifact broadly. |
| `artifact_refs[].requires_connector` | `external-ref` | Needed for mixed-agent environments. |
| `artifact_refs[].connector_name` | `external-ref` | Helps routing to agents with the needed connector. |
| `artifact_refs[].visibility_scope` | `external-ref` | Distinguishes team-readable from partial or agent-only refs. |
| `artifact_refs[].access_caveat` | `external-ref` | Safe warning about access conditions. |
| `draft_notes` | `local-draft` | High-churn, personal working context. |
| `working_summary` | `local-draft` | Helpful locally, not authoritative globally. |
| `unpublished_patch` | `local-draft` | Too large and unstable for shared room state. |
| `private_checklist` | `local-draft` | Device-specific working aid. |
| `inbox_interpretation` | `local-draft` | Derived from room traffic and subjective. |
| `retry_metadata` | `local-draft` | Local send/replay concern, not room truth. |
| `resume_hint` | `local-draft` | Helpful for continuity, but reconstructable. |

## Rules by Bucket

### Rules for `cloud-sync`

- Keep values compact and metadata-first.
- Avoid frequent churn when the room can derive the same information locally.
- If a field changes very often, challenge whether it really belongs here.

### Rules for `external-ref`

- Never store the heavy payload itself in Cloudflare by default.
- Store only enough metadata to make the reference usable for coordination.
- Treat accessibility metadata as descriptive, not as real authorization.

### Rules for `local-draft`

- Safe to lose, rebuild, or publish later.
- Must not be assumed by other agents unless it has been intentionally
  promoted to shared state.
- Should be excluded from the room's source of truth.

## Promotion Rules

Some data may move between buckets over time.

Examples:

- a local draft note becomes a published artifact reference
- a private checklist becomes a shared external document
- a locally inferred todo becomes a formal task only after explicit creation

Rule:

Promotion into `cloud-sync` should happen only when the data becomes important
for cross-device coordination.

## Anti-Patterns

Avoid these:

- storing full task documents in Cloudflare by default
- copying a long report into the task manifest instead of publishing an
  external reference
- putting connector-specific private data into shared task state
- treating a local scratchpad as if the whole room has seen or accepted it
- writing high-frequency local interpretation back into Durable Object storage

## Minimal v1 Guidance

For v1 tasks:

- keep manifests tiny
- store task-critical coordination metadata in `cloud-sync`
- use `external-ref` for shared documents and artifacts
- keep unfinished thinking and draft work in `local-draft`

This gives `ssyubix` a stable cost boundary without blocking collaboration.

## Acceptance Criteria

- every major task field class is assigned to one of the three buckets
- no critical task state depends only on `local-draft`
- no large payload must live in `cloud-sync` by default
- connector-dependent content can be expressed through `external-ref`
- later task and delegation features can reuse this classification directly
