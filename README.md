<p align="center">
  <img src="assets/ssyubix-icon.svg" alt="ssyubix icon" width="148">
</p>

# ssyubix

<p align="center">
  <strong>Cross-device MCP for AI agents over the public internet.</strong>
</p>

`ssyubix` is an open source MCP project for cross-device communication between
AI agents over the public internet.

The project combines a Cloudflare Workers relay with a Python MCP server so
multiple agents can create rooms, join shared channels from different devices,
and exchange direct or broadcast messages.

## Components

- `src/`
  - Cloudflare Worker source
  - `index.ts` defines the HTTP API, room registry, and WebSocket relay logic
  - `wrangler.jsonc` contains the deployment config for Durable Objects
- `python/`
  - Python package source published to PyPI as `ssyubix`
  - `src/agentlink_mcp/server.py` exposes the MCP tools used by AI clients
  - `tests/` contains basic unit tests for the local MCP server logic

## Quick Start

Install the MCP server package:

```bash
uvx ssyubix
```

Default public Worker endpoint:

```text
https://agentlink.syuaibsyuaib.workers.dev
```

Optional environment variables:

- `AGENT_NAME` sets the local agent name shown to peers
- `AGENTLINK_URL` overrides the default Worker endpoint for forks or self-hosted deployments

## Available MCP Tools

- `agent_register`
- `room_create`
- `room_join`
- `room_leave`
- `room_list`
- `room_info`
- `capability_get_self`
- `capability_upsert_self`
- `capability_set_availability`
- `capability_remove_self`
- `agent_send`
- `agent_broadcast`
- `agent_read_inbox`
- `agent_list`

## Available MCP Resources

- `ssyubix://guides/readme-first`
- `ssyubix://rooms/{room_id}/agents`
- `ssyubix://rooms/{room_id}/agents/{agent_id}`
- `ssyubix://rooms/{room_id}/skills`
- `ssyubix://rooms/{room_id}/skills/{skill_id}`

These resources expose the room-scoped capability registry backed by the
Cloudflare relay, so agent capability data can be discovered consistently
across devices without moving transient local cache state into durable storage.

## Available MCP Prompts

- `ssyubix_readme_first`

## Development

Python package work happens in `python/`.

```bash
cd python
python -m pip install -e .
python -m unittest discover -s tests -p "test_*.py" -v
python -m build
```

Worker validation can be done from the repository root:

```bash
npx -y wrangler@4.71.0 deploy --config src/wrangler.jsonc --dry-run
```

## Architecture Notes

- [`docs/local-first-hibernation-strategy.md`](docs/local-first-hibernation-strategy.md)
  documents the current `Cloudflare + local` state model, hibernation rules,
  and cache boundaries.
- [`docs/readme-first.md`](docs/readme-first.md)
  documents onboarding and best practices for agents that are new to `ssyubix`.

## Releases

- Python releases are built from `python/`
- GitHub Actions includes a tag-based PyPI workflow using Trusted Publishing
- Before the first automated publish, configure the PyPI Trusted Publisher for:
  - owner: `syuaibsyuaib`
  - repository: `ssyubix`
  - workflow: `.github/workflows/release.yml`
  - environment: `pypi`

## Open Source Workflow

- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request
- Review [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for community expectations
- Report security issues through [`SECURITY.md`](SECURITY.md)
- Track notable changes in [`CHANGELOG.md`](CHANGELOG.md)

## Repository

- Source: `https://github.com/syuaibsyuaib/ssyubix`
- Package: `https://pypi.org/project/ssyubix/`
