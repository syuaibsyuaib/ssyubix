# Local-First Transient State and Hibernation Strategy

## Goal

Keep `ssyubix` fast and inexpensive by treating Cloudflare as the coordination
source of truth and each device as a local cache/checkpoint layer.

This strategy is specifically meant to:

- reduce unnecessary Durable Object duration and storage writes
- preserve fast local UX for reconnect and offline inspection
- keep cross-device coordination correct when rooms hibernate and wake again

## Why This Matters

The current product direction is `Cloudflare + local`, not `Cloudflare + many
services`.

Official Cloudflare guidance and pricing make that tradeoff clear:

- WebSocket hibernation avoids Durable Object duration charges while the object
  is idle
- incoming WebSocket messages are billed at a `20:1` ratio, so chat traffic is
  cheaper than heavy storage churn
- SQLite-backed Durable Object writes are more expensive than reads, so
  transient state should not be written on every heartbeat or cursor change
- alarms should be scheduled only when actual cleanup work is needed

References:

- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare Durable Objects Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [MCP Resources](https://modelcontextprotocol.io/docs/concepts/resources)

## Design Principles

1. Cloudflare stores coordination state, not every transient interaction.
2. Local disk stores reconstructable cache, not global source-of-truth state.
3. Heartbeats must refresh live presence, but must not force durable writes on
   every ping.
4. Room wake-up after hibernation must be able to rebuild live routing from
   WebSocket attachments plus small durable checkpoints.
5. New collaboration features must declare their state model up front:
   `Cloud-only`, `Local-only`, or `Synced`.

## State Model

| State class | Examples | Persistence rule |
| --- | --- | --- |
| Cloud authoritative | room registry, room sequence, session resume entries, private room metadata, future task/artifact/decision manifests | Persist in Durable Objects storage. This is the shared source of truth. |
| Durable but coarse checkpoint | reconnect window metadata, coarse room membership checkpoint, future capability profiles | Persist only on join, leave, reconnect, explicit mutation, or bounded checkpoint intervals. |
| Local-first persistent cache | inbox cache, read cursor, retry queue, room summary snapshot, peer snapshot cache, draft artifacts | Persist only on the local device. Safe to rebuild or discard. |
| Ephemeral live state | open sockets, pending ack waiters, heartbeat timers, live peer routing, in-memory presence | Keep in memory or WebSocket attachments. Rebuild on wake if needed. |
| Derived state | unread counts, stale flags, recent activity preview, candidate lists | Compute from cache or authoritative state. Do not persist unless needed for recovery. |

## Rules for `ssyubix`

### Keep Local-Only

- inbox cache
- last-read cursor
- retry queue and retry attempt metadata
- room summary snapshot
- peer snapshot cache used for offline context
- draft artifacts and working notes

### Keep Cloud-Authoritative

- room creation and privacy metadata
- room message `sequence`
- reconnect session lease and agent identity reuse
- explicit collaboration records that must survive devices, such as future
  capability cards, task metadata, artifact manifests, and decision logs

### Do Not Write to Cloud by Default

- heartbeat ticks
- unread cursor movement
- local inbox cache updates
- local room summary refresh
- every peer presence refresh

If any of these must be visible cross-device, they should be checkpointed
coarsely rather than written on each event.

## Hibernation Strategy

### Worker Side

- Use Durable Objects as the room coordinator and keep the room `sequence`
  durable.
- Store the minimum state required to restore correctness after wake:
  room metadata, sequence, reconnect sessions, and future collaboration records.
- Keep live peer routing in WebSocket attachments and reconstruct room state
  from connected sockets when the object wakes up.
- Avoid using storage writes as the primary heartbeat mechanism.
- Use alarms only for cleanup tasks such as expiring reconnect sessions,
  pruning stale durable records, or deferred compaction work.

### Client Side

- Restore local inbox cache, retry queue, room summary, and peer snapshot before
  the first fresh network sync completes.
- Keep retry queue and summary snapshots per room on local disk.
- Treat local cache as eventually refreshed, not authoritative.
- Mark snapshots stale with age metadata rather than forcing eager network
  refreshes.

## Sync Boundaries

### Join / Reconnect

- Client restores local cache immediately.
- Worker returns the authoritative room welcome payload.
- Client merges local cache with remote ordering state.

### Message Delivery

- Worker owns `message_id`, `sequence`, and final ack correlation.
- Client may queue outbound actions locally when offline or when ack fails.
- Local retry state is replayed after reconnect, but remote ordering remains
  authoritative.

### Presence

- Live online/offline state should come from active sockets first.
- Durable checkpoints should record only what is needed for reconnect windows
  and coarse room continuity.
- App-level heartbeat may remain for liveness semantics, but it should not
  become a write-heavy persistence path.

## Acceptance Criteria for This Strategy

- A room can hibernate without losing correctness of sequence or reconnect
  semantics.
- Local cache restore works even when the network is slow or temporarily down.
- Presence and cursor updates do not create high-frequency durable writes.
- New collaboration features declare their state model before implementation.
- Cloudflare remains the source of truth for shared coordination, while local
  state remains safe to rebuild.

## Implementation Follow-Ups

1. Implement hibernation-safe room rehydration and coarse presence checkpoints.
2. Reduce transient Durable Object writes with batched checkpoint policy.
3. Add local cache retention, compaction, and recovery policy.

## Out of Scope for This Phase

- Supabase, R2, or third-party data planes
- full transcript archival in the cloud
- enterprise authorization or delegated authority
- automatic workflow orchestration
