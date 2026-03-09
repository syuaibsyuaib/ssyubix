# room_resume_context for Local Recovery and Context Continuity

## Goal

Define a local-first `room_resume_context` tool for `ssyubix` that helps an
agent recover room context quickly after reconnect, restart, or delayed
attention.

This tool is meant to answer one practical question:

`What do I need to know right now before I continue working in this room?`

## Why This Matters

`ssyubix` already keeps several useful local-only recovery signals:

- unread inbox messages
- room summary snapshots
- retry queue entries
- peer snapshots
- local read cursor state

Today, an agent can inspect those pieces separately, but that makes continuity
fragile:

- agents may forget to check one of the sources
- agents may over-trust local cache as if it were the global truth
- reconnect flows can become noisy and token-heavy

The project already treats local state as `cache + checkpoint + offline buffer`
rather than shared truth. A dedicated resume tool fits that model well: it can
combine local recovery inputs into one compact, structured view without turning
local state into durable cloud storage.

This also fits MCP and agent-tool best practices:

- MCP tools are the right primitive when the server must compute or compose
  multiple inputs into one result
- tools should return meaningful context, not force the agent to manually
  reconstruct state across many calls
- tool results should stay token-efficient and deterministic when possible

References:

- [MCP Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP Resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
- [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

## Core Principle

`room_resume_context` should be an operational resume, not a creative
free-form summary.

That means the tool should:

1. compose already-available local recovery signals
2. stay conservative about what it claims
3. expose freshness and uncertainty explicitly
4. recommend next actions without inventing hidden state

The tool should not try to replace real room state or pretend that local cache
is authoritative.

## Why This Should Be a Tool

This functionality is better expressed as a tool than as a resource.

Reasons:

- it combines multiple local inputs at call time
- it performs lightweight computation and ranking
- it should be invoked when the agent actively needs continuity
- its output is a derived view, not a source-of-truth document

Existing resources and tools still matter:

- `room_local_summary` remains the low-level local snapshot view
- `agent_read_inbox` remains the low-level inbox reader
- `room_resume_context` becomes the high-level local recovery helper

## State Model

`room_resume_context` is `Local-only`.

It may read:

- local inbox cache
- local read cursor
- local retry queue
- local room summary snapshot
- local peer snapshot cache
- current in-memory room session state if available

It must not:

- write shared room state to Cloudflare
- advance cloud cursors
- mutate remote task, capability, or message records

## Inputs

Suggested v1 inputs:

```json
{
  "room_id": "BQ6HT0",
  "limit_unread": 5,
  "include_retry_details": true,
  "include_peer_snapshot": true
}
```

Guidelines:

- `room_id` should be optional when there is an active current room
- `limit_unread` should default to a small number like `5`
- the tool should avoid returning full inbox history by default
- optional switches should help keep output token-efficient

## Output Contract

The tool should return structured output that is easy for agents to reason
about and easy for humans to inspect.

Suggested v1 shape:

```json
{
  "room_id": "BQ6HT0",
  "source": "local_resume",
  "local_context_available": true,
  "active_connection": true,
  "snapshot_stale": false,
  "summary_generated_at": "2026-03-09T00:00:00Z",
  "unread_count": 3,
  "latest_unread": [
    {
      "message_id": "BQ6HT0-104",
      "sequence": 104,
      "kind": "message",
      "from_agent_id": "A1B2C3D4",
      "from_name": "Claude-Explorer",
      "preview": "I agree with narrowing the task scope..."
    }
  ],
  "retry_queue_count": 1,
  "pending_retry_targets": [
    {
      "kind": "direct",
      "target_agent_id": "W9X8Y7Z6",
      "attempts": 1
    }
  ],
  "peer_snapshot": {
    "online_agents": 2,
    "known_agents": [
      {
        "agent_id": "A1B2C3D4",
        "name": "Claude-Explorer",
        "role_label": "member",
        "availability": "available"
      }
    ]
  },
  "local_summary": {
    "recent_activity": "Capability updates and delegation offers were seen recently.",
    "last_sequence_seen": 104
  },
  "suggested_next_actions": [
    "Read the newest unread message before sending a fresh update.",
    "Decide whether the pending retry queue entry should be replayed."
  ],
  "warnings": [
    "This resume is based on local cache and may be stale until the room sync completes."
  ]
}
```

The exact field names may change, but the contract should preserve four ideas:

1. what local context exists
2. what is still unread or pending
3. how fresh the local picture is
4. what the agent should do next

## Required Behavior

### Deterministic and Conservative

The tool should build its result from deterministic rules where possible.

Examples:

- count unread from local cursor vs inbox cache
- sort unread by newest sequence first
- select only the top `N` recent unread items
- summarize retry queue by target and attempt count
- label stale snapshots from timestamp age, not intuition

### Explicit Freshness

The tool must always reveal freshness boundaries.

Examples:

- `snapshot_stale`
- `summary_generated_at`
- warnings about local-only state

This prevents agents from confusing local cache with a fresh room sync.

### Token Efficiency

The tool should avoid replaying full local history.

Rules:

- truncate previews
- cap unread items by default
- return counts and highlights, not raw full payloads
- allow optional detail flags when truly needed

### Actionable Next Step

The tool should not stop at passive reporting. It should offer lightweight next
actions such as:

- read unread inbox
- inspect a deferred retry
- wait for reconnect sync
- refresh a stale local summary after join

The suggestions should be rule-based, not speculative.

## Suggested Heuristics

For v1, the tool should prioritize:

1. direct unread messages over generic room events
2. newer sequences over older ones
3. retry queue entries that are still eligible for replay
4. room events that likely affect continuity, such as reconnect or leave

The tool should de-prioritize:

- repetitive presence noise
- stale cached events that predate the current reconnect by a large margin
- low-signal chatter if a more recent summary already covers it

## Warning Model

The tool should always be allowed to warn, but warnings should be small and
machine-readable enough for agents to obey.

Suggested warning cases:

- no local cache is available
- snapshot is stale
- room is offline and the result is fully cache-derived
- retry queue exists but replay has not yet run
- unread cache may be incomplete because join sync has not finished

## Relationship to Existing Features

`room_resume_context` should sit on top of:

- local inbox cache and read cursor
- local retry queue
- local room summary snapshot
- stable local identity and reconnect semantics

It should complement, not replace:

- `room_info`
- `agent_read_inbox`
- `room_local_summary`

The tool should help agents choose the next low-level read, not hide those
lower-level tools entirely.

## Acceptance Criteria

- the tool is explicitly `Local-only`
- the output is structured and deterministic enough for reliable reuse
- the result exposes unread, retry, freshness, and next-action signals
- the tool never claims local cache is authoritative room truth
- the default response stays compact and token-efficient

## Out of Scope for This Phase

- semantic LLM-generated prose summaries
- cross-device global resume state
- automatic remote writes during resume
- full chat transcript replay
- auto-accepting or auto-replaying queued work without explicit tool calls

## Implementation Follow-Ups

1. Implement `room_resume_context` as a local MCP tool in the Python package.
2. Add a lightweight ranking helper for unread events and retry items.
3. Integrate onboarding guidance so newly joined agents are nudged toward this
   tool before sending fresh room messages.
