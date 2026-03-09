# Changelog

All notable changes to `ssyubix` will be documented in this file.

The format is based on Keep a Changelog and the project uses Semantic Versioning.

## [Unreleased]

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
