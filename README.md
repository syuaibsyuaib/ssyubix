# ssyubix

`ssyubix` is an MCP project for cross-device, internet-accessible communication between AI agents.

It has two main parts:

- A Cloudflare Workers backend with Durable Objects for room management and WebSocket relay
- A Python MCP server package published to PyPI as `ssyubix`

## Project Structure

- `src/`
  - Cloudflare Worker source
  - `index.ts` defines HTTP endpoints, room registry, and WebSocket messaging
  - `wrangler.jsonc` contains the Worker deployment config
- `python-src/ssyubix-2.0.0/`
  - Python MCP package source
  - `agentlink_mcp/server.py` exposes the MCP tools used by AI clients

## Install

```bash
uvx ssyubix
```

## Public Worker

The current deployed Worker endpoint is:

`https://agentlink.syuaibsyuaib.workers.dev`

## MCP Tools

- `agent_register`
- `room_create`
- `room_join`
- `room_leave`
- `room_list`
- `room_info`
- `agent_send`
- `agent_broadcast`
- `agent_read_inbox`
- `agent_list`
