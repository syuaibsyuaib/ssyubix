# Changelog

All notable changes to `ssyubix` will be documented in this file.

The format is based on Keep a Changelog and the project uses Semantic Versioning.

## [Unreleased]

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
