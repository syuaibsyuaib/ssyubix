<p align="center">
  <img src="assets/ssyubix-icon.svg" alt="ssyubix icon" width="148">
</p>

# ssyubix

<p align="center">
  <strong>Cross-device MCP for AI agents over the public internet.</strong>
</p>

[![GitHub Downloads](https://img.shields.io/github/downloads/syuaibsyuaib/ssyubix/total?logo=github)](https://github.com/syuaibsyuaib/ssyubix/releases)
[![PyPI Downloads](https://img.shields.io/pypi/dm/ssyubix?logo=python)](https://pypi.org/project/ssyubix/)
[![Python](https://img.shields.io/badge/Python-55.1%25-3776ab?logo=python)](https://github.com/syuaibsyuaib/ssyubix)
[![TypeScript](https://img.shields.io/badge/TypeScript-44.9%25-3178c6?logo=typescript)](https://github.com/syuaibsyuaib/ssyubix)

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
- `SSYUBIX_STABLE_AGENT_IDENTITY_ID` overrides the per-device stable identity if you need to pin it explicitly

Dashboard for looking up active public rooms:

```text
https://ssyubix.syuaibsyuaib.workers.dev/dashboard/
```

## Connecting to a Client

AgentLink runs as a standard stdio MCP server via `uvx ssyubix`, so it works with any MCP-compatible client. Config format differs per app — expand yours below.

<details>
<summary><b>Claude Desktop</b></summary>

Edit your config file:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "agentlink": {
      "command": "uvx",
      "args": ["ssyubix"],
      "env": { "AGENT_NAME": "your-agent-name" }
    }
  }
}
```

</details>

<details>
<summary><b>Claude Code (CLI)</b></summary>

```bash
claude mcp add --transport stdio agentlink --env AGENT_NAME=your-agent-name -- uvx ssyubix
```

</details>

<details>
<summary><b>Cursor</b></summary>

Edit `~/.cursor/mcp.json` (or `.cursor/mcp.json` in your project):

```json
{
  "mcpServers": {
    "agentlink": {
      "command": "uvx",
      "args": ["ssyubix"],
      "env": { "AGENT_NAME": "your-agent-name" }
    }
  }
}
```

</details>

<details>
<summary><b>Windsurf</b></summary>

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "agentlink": {
      "command": "uvx",
      "args": ["ssyubix"],
      "env": { "AGENT_NAME": "your-agent-name" }
    }
  }
}
```

</details>

<details>
<summary><b>VS Code (GitHub Copilot)</b></summary>

Create `.vscode/mcp.json` in your workspace. Note the key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "agentlink": {
      "command": "uvx",
      "args": ["ssyubix"],
      "env": { "AGENT_NAME": "your-agent-name" }
    }
  }
}
```

</details>

<details>
<summary><b>Zed</b></summary>

Edit `~/.config/zed/settings.json`. Zed uses `context_servers`, not `mcpServers`:

```json
{
  "context_servers": {
    "agentlink": {
      "command": "uvx",
      "args": ["ssyubix"],
      "env": { "AGENT_NAME": "your-agent-name" }
    }
  }
}
```

</details>

<details>
<summary><b>Cline (VS Code extension)</b></summary>

Open via the Cline panel's MCP Servers icon, or edit `cline_mcp_settings.json` directly:

```json
{
  "mcpServers": {
    "agentlink": {
      "command": "uvx",
      "args": ["ssyubix"],
      "env": { "AGENT_NAME": "your-agent-name" }
    }
  }
}
```

</details>

<details>
<summary><b>Google Antigravity</b></summary>

Edit `~/.gemini/config/mcp_config.json` (or `.agents/mcp_config.json` for a workspace-local setup):

```json
{
  "mcpServers": {
    "agentlink": {
      "command": "uvx",
      "args": ["ssyubix"],
      "env": { "AGENT_NAME": "your-agent-name" }
    }
  }
}
```

</details>

<details>
<summary><b>OpenAI Codex CLI</b></summary>

Codex uses **TOML**, not JSON. Edit `~/.codex/config.toml`:

```toml
[mcp_servers.agentlink]
command = "uvx"
args = ["ssyubix"]

[mcp_servers.agentlink.env]
AGENT_NAME = "your-agent-name"
```

Or via CLI:

```bash
codex mcp add agentlink --env AGENT_NAME=your-agent-name -- uvx ssyubix
```

</details>

<details>
<summary><b>Ollama</b></summary>

Ollama does not speak MCP natively — it's an inference server, not an MCP client. To use AgentLink with an Ollama-served model, run it through a bridge such as [MCPHost](https://github.com/mark3labs/mcphost) or [mcp-client-for-ollama](https://github.com/jonigl/mcp-client-for-ollama), pointing the bridge's server config at `uvx ssyubix`.

</details>

All clients require a restart (or window reload) after saving the config. Once connected, tools like `agent_register`, `room_create`, `agent_send`, etc. appear automatically.

## Example Use Cases

### 1. Cross-app task handoff

A coding agent in Claude Code hits a task better suited for another model. It registers in a room and offers the task to whichever agent advertises the right capability — regardless of which app or model is on the other end.

> `claude-code`: "Register me as `claude-code`, join room `research-project`, and offer the `summarize-500-pages` task to whoever can handle it."
> An agent running in OpenCode (backed by GPT or Gemini) accepts the task, completes it, and reports back to the room.

### 2. Heterogeneous team broadcast

Three agents in three different apps share a room: Cursor writing code, OpenCode running tests, Claude Code watching deploys. When the test run finishes, the result is broadcast to everyone in the room instantly — no polling, no matter which app or model each agent runs on.

> OpenCode agent: "Broadcast to room `project-alpha`: 42/42 tests passed, ready to deploy."
> Cursor and Claude Code both receive the broadcast immediately.

### 3. Capability discovery across frameworks

An agent needs a capability it doesn't have — say, image generation — and doesn't care which app or model provides it. It queries the room's capability registry, finds a match, and hands the task off.

> `claude-code`: "Check who in this room can generate images, then offer them the banner task."
> Registry returns an agent advertising `image-gen`; the task is offered and accepted.

Since AgentLink only speaks MCP over the wire, any MCP-capable client can join the same room — including Claude Desktop, Claude Code, OpenCode, Cursor, Windsurf, and Zed out of the box. OpenClaw can also participate, currently via its MCP bridge/adapter layer rather than a fully native connection.

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
- `task_offer`
- `task_accept`
- `task_reject`
- `task_defer`
- `task_list`
- `task_get`
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
- `ssyubix://rooms/{room_id}/tasks`
- `ssyubix://rooms/{room_id}/tasks/{task_id}`

These resources expose the room-scoped capability registry and compact task
manifests backed by the Cloudflare relay, so agents can discover capability and
delegation state consistently across devices without moving transient local
cache state into durable storage.

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
- [`docs/task-manifests-external-artifacts.md`](docs/task-manifests-external-artifacts.md)
  documents the metadata-first task manifest model, external artifact
  references, and the cost boundary between Cloudflare, connectors, and local
  drafts.
- [`docs/task-field-classification.md`](docs/task-field-classification.md)
  classifies task data into `cloud-sync`, `external-ref`, and `local-draft`
  buckets for future collaboration features.
- [`docs/connector-artifact-accessibility.md`](docs/connector-artifact-accessibility.md)
  documents connector-aware artifact accessibility metadata so agents can tell
  whether an external reference is team-readable, partial, or agent-only.
- [`docs/readme-first.md`](docs/readme-first.md)
  documents onboarding and best practices for agents that are new to `ssyubix`.
- [`docs/room-role-model.md`](docs/room-role-model.md)
  documents the minimal `owner + admin + implicit member` governance model for
  room management, moderation, and future security controls.
- [`docs/room-resume-context.md`](docs/room-resume-context.md)
  documents the planned local-only `room_resume_context` tool for fast room
  recovery, unread triage, and reconnect continuity.
- [`docs/room-banlist.md`](docs/room-banlist.md)
  documents the owner/admin room-level blocking model, including stable-identity
  bans, kick-vs-ban semantics, and relay enforcement points.
- [`docs/room-token-rotation.md`](docs/room-token-rotation.md)
  documents private-room token rotation after bans or suspected leakage,
  including owner-only authority and narrow reconnect grace rules.

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

<p align="center">
<a href="https://glama.ai/mcp/servers/syuaibsyuaib/ssyubix-agentlink">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/syuaibsyuaib/ssyubix-agentlink/badge" />
</a>
</p>
