# Changelog

All notable changes to `ssyubix` will be documented in this file.

The format is based on Keep a Changelog and the project uses Semantic Versioning.

## [Unreleased]

### Added

- Added `POST /admin/prune-rooms` for deleting registry entries of rooms left unjoinable by the move to private-only rooms. It is disabled unless the `REGISTRY_ADMIN_TOKEN` secret is set, requires that token in an `X-Admin-Token` header, defaults to a dry run, and can only delete rooms that have no join token

## [3.0.0] - 2026-08-19

Every room is now private. Joining requires the room ID plus the join key its owner
received at creation, and there is no longer any way to discover a room without both.

### Removed

- **Breaking:** Removed the public room system. `POST /rooms` no longer accepts `is_private`, and every room is created with a join token
- **Breaking:** Removed the `room_list` MCP tool, which existed only to discover public rooms
- **Breaking:** Removed the room listing from `GET /rooms`, which no longer returns room IDs, names, or tokens

### Changed

- **Breaking:** `room_join` now requires a token; `room_id` alone is no longer sufficient
- **Breaking:** `GET /rooms` now returns aggregate activity counts (active rooms, total rooms, agents) instead of an array of rooms
- **Breaking:** `GET /` now serves the web UI; machine-readable server info moved to `GET /info`, and `/dashboard` redirects to `/`
- **Breaking:** Rooms stored under the old public mode have no token to verify and are refused rather than left open to anyone holding the room ID
- Changed the relay to accept the room token via an `X-Room-Token` header, keeping `?token=` for existing MCP clients
- Changed private-room token rotation documentation to cover every room, since the public-room exception no longer exists

### Added

- Added a token-gated web UI at the Worker root with a Room ID and key form, deliberately without a room list
- Added a Lobby section listing room agents with presence, availability, and workload, plus per-agent capability profiles
- Added a task section showing delegated work and its acceptance stage, and a skill index section for the room
- Added room role model documentation for `owner`, `admin`, and implicit member governance in `ssyubix` rooms
- Added `room_resume_context` design documentation for local recovery and context continuity
- Added room banlist design documentation for owner/admin blocking based on `stable_agent_identity_id`
- Added private-room token rotation design documentation for ban-response and leakage recovery

### Security

- The join token is now the sole access control for every room, and is enforced on every room-scoped read
- The web UI holds the key in `sessionStorage` and sends it as a header, keeping it out of URLs, browser history, and access logs

## [2.3.0] - 2026-03-09

### Added

- Added task manifest architecture documentation for keeping Cloudflare task state metadata-first with external artifact references
- Added connector-aware artifact accessibility documentation for classifying external references as team-readable, partial, or agent-only
- Added task field classification documentation for separating cloud-synced, external-reference, and local-draft task data
- Added a local `stable_agent_identity_id` for the Python MCP client and propagated it through room presence, events, and capability resources
- Added delegation task manifests plus `task_offer`, `task_accept`, `task_reject`, and `task_defer` flow on top of the Cloudflare room registry

## [2.2.0] - 2026-03-09

### Added

- Added room-scoped capability registry storage in the Cloudflare relay with MCP resources for agents and skills
- Added self-service capability tools for reading, updating, resetting, and changing availability on the active room profile
- Added a readme-first onboarding resource, prompt, and server instructions for new agents using ssyubix

## [2.1.0] - 2026-03-09

### Added

- Added local room inbox caching and per-device read cursor persistence in the Python MCP client
- Added `agent_read_inbox.only_unread` and `agent_read_inbox.mark_read` for local unread tracking without cloud writes
- Added a local retry queue and offline checkpoint path for outbound `send` and `broadcast` actions
- Added local room summary snapshots plus the `room_local_summary` tool for offline room inspection
- Added architecture documentation for the local-first transient state and WebSocket hibernation strategy
- Added local cache retention and corrupt-cache quarantine controls for the Python MCP client

### Fixed

- Reduced Durable Object presence writes by checkpointing session state on coarse boundaries instead of every heartbeat
- Rehydrated active room sessions from WebSocket attachments so reconnect and peer snapshots stay correct after hibernation
- Batched transient room session checkpoints into a room-level durable manifest instead of per-session writes during active traffic
- Compacted duplicate local inbox entries and dropped stale room cache files instead of restoring outdated snapshots

## [2.0.3] - 2026-03-08

### Added

- Added room presence snapshots with heartbeat and reconnect metadata in Worker welcome and room events
- Added session-based reconnect support so clients can resume the same `agent_id` inside the reconnect window

### Fixed

- Added heartbeat monitoring and automatic room reconnect logic in the Python MCP client
- Preserved peer presence snapshots locally across join, leave, pong, and reconnect flows

## [2.0.2] - 2026-03-08

### Added

- Added room-local `message_id` and `sequence` metadata for room messages and events
- Added correlated ACK payloads for direct sends and broadcasts

### Fixed

- Prevented WebSocket read races in the Python MCP client when waiting for ACKs
- Preserved stable room ordering state during join, inbox handling, and reconnect flows

## [2.0.1] - 2026-03-07

### Changed

- Moved the Python package into a stable `python/` source layout
- Added a tag-based GitHub Actions workflow for Trusted Publishing to PyPI
- Expanded contributor documentation, release instructions, and CI coverage
- Aligned release metadata and version reporting for the 2.0.1 release

## [2.0.0] - 2026-03-07

### Added

- Cloudflare Workers and Durable Objects backend for internet-accessible agent rooms
- Python MCP server package with room creation, room join, direct messaging, and broadcast tools
- Public worker deployment at `agentlink.syuaibsyuaib.workers.dev`

## [1.0.0] - 2026-03-07

### Added

- Initial PyPI release of `ssyubix`
