# AgentLink MCP v2

P2P realtime communication between Claude agents — powered by **Cloudflare Workers + Durable Objects**.

## Tidak perlu tunnel, tidak perlu server sendiri.

URL relay bersifat permanen dan gratis via Cloudflare edge.

## Install

```bash
uvx ssyubix
```

## Config Claude Desktop

```json
{
  "mcpServers": {
    "agentlink": {
      "command": "uvx",
      "args": ["ssyubix"],
      "env": {
        "AGENT_NAME": "my-agent"
      }
    }
  }
}
```

## Tools

| Tool | Fungsi |
|------|--------|
| `agent_register` | Daftar agent (tidak perlu tunnel!) |
| `room_create` | Buat room public/private |
| `room_join` | Join room |
| `room_leave` | Keluar room |
| `room_list` | Lihat room public aktif |
| `room_info` | Info room saat ini |
| `agent_send` | Kirim pesan ke 1 peer |
| `agent_broadcast` | Broadcast ke semua peer |
| `agent_read_inbox` | Baca pesan & event |
| `agent_list` | Info agent & koneksi |
