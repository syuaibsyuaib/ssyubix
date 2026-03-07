/**
 * AgentLink — Cloudflare Workers + Durable Objects
 * WebSocket relay/signaling server untuk komunikasi antar Claude agent.
 *
 * Endpoints:
 *   GET  /                        → info server
 *   GET  /rooms                   → list room public aktif
 *   WS   /connect/:room_id        → join room (query: ?name=&token=)
 *   POST /rooms                   → buat room baru (body: {name, is_private})
 */

import { DurableObject } from "cloudflare:workers";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Env {
  AGENTLINK_ROOM: DurableObjectNamespace;
  AGENTLINK_REGISTRY: DurableObjectNamespace;
}

interface RoomMeta {
  room_id: string;
  name: string;
  is_private: boolean;
  token: string;
  created_at: string;
  agent_count: number;
}

interface AgentInfo {
  agent_id: string;
  name: string;
  joined_at: string;
}

interface WsMessage {
  type: "message" | "event" | "ping" | "pong" | "info";
  [key: string]: unknown;
}

// ─── Worker Entry ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ── GET / ── info server
    if (path === "/" && request.method === "GET") {
      return Response.json({
        name: "AgentLink",
        version: "2.0.0",
        backend: "Cloudflare Workers + Durable Objects",
        endpoints: {
          list_rooms: "GET /rooms",
          create_room: "POST /rooms",
          connect: "WS /connect/:room_id?name=<name>&token=<token>",
        },
      }, { headers: corsHeaders });
    }

    // ── GET /rooms ── list semua room public
    if (path === "/rooms" && request.method === "GET") {
      const registry = env.AGENTLINK_REGISTRY.get(
        env.AGENTLINK_REGISTRY.idFromName("global")
      );
      const resp = await registry.fetch(new Request("http://internal/list"));
      const rooms = await resp.json() as RoomMeta[];
      return Response.json(rooms, { headers: corsHeaders });
    }

    // ── POST /rooms ── buat room baru
    if (path === "/rooms" && request.method === "POST") {
      let body: { name?: string; is_private?: boolean } = {};
      try {
        body = await request.json();
      } catch {}

      const name = (body.name || "unnamed").slice(0, 50);
      const is_private = body.is_private === true;
      const room_id = generateId(6);
      const token = is_private ? generateId(12) : "";
      const created_at = new Date().toISOString();

      // Simpan ke registry
      const registry = env.AGENTLINK_REGISTRY.get(
        env.AGENTLINK_REGISTRY.idFromName("global")
      );
      await registry.fetch(new Request("http://internal/register", {
        method: "POST",
        body: JSON.stringify({ room_id, name, is_private, token, created_at }),
      }));

      return Response.json({
        success: true,
        room_id,
        name,
        is_private,
        token: is_private ? token : undefined,
        message: is_private
          ? `Bagikan room_id '${room_id}' dan token ke peer.`
          : `Bagikan room_id '${room_id}' ke peer untuk join.`,
      }, { headers: corsHeaders });
    }

    // ── WS /connect/:room_id ── join room via WebSocket
    const wsMatch = path.match(/^\/connect\/([A-Z0-9]{6})$/i);
    if (wsMatch) {
      const room_id = wsMatch[1].toUpperCase();
      const agentName = url.searchParams.get("name") || `agent-${generateId(4)}`;
      const token = url.searchParams.get("token") || "";

      // Verifikasi room ada + token valid (via registry)
      const registry = env.AGENTLINK_REGISTRY.get(
        env.AGENTLINK_REGISTRY.idFromName("global")
      );
      const checkResp = await registry.fetch(new Request(
        `http://internal/check?room_id=${room_id}&token=${encodeURIComponent(token)}`
      ));
      const check = await checkResp.json() as { ok: boolean; error?: string };

      if (!check.ok) {
        return new Response(check.error || "Unauthorized", { status: 403 });
      }

      // Forward ke Durable Object room
      const roomDO = env.AGENTLINK_ROOM.get(
        env.AGENTLINK_ROOM.idFromName(room_id)
      );

      // Tambahkan header agent name untuk DO
      const newReq = new Request(request.url, {
        method: request.method,
        headers: {
          ...Object.fromEntries(request.headers),
          "X-Agent-Name": agentName,
          "X-Room-Id": room_id,
        },
      });

      return roomDO.fetch(newReq);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
};

// ─── Durable Object: Room ─────────────────────────────────────────────────────

export class AgentLinkRoom extends DurableObject {
  private agents: Map<WebSocket, AgentInfo> = new Map();

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const agentName = request.headers.get("X-Agent-Name") || "unknown";
    const roomId    = request.headers.get("X-Room-Id") || "unknown";
    const agentId   = generateId(8);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Pakai Hibernation API
    this.ctx.acceptWebSocket(server, [agentId, agentName, roomId]);

    // Kirim info ke agent yang baru join
    const existingAgents = [...this.ctx.getWebSockets()].map(ws => {
      const tags = this.ctx.getTags(ws);
      return { agent_id: tags[0], name: tags[1] };
    }).filter(a => a.agent_id !== agentId);

    server.send(JSON.stringify({
      type: "welcome",
      agent_id: agentId,
      name: agentName,
      room_id: roomId,
      agents: existingAgents,
      message: `Selamat datang di room '${roomId}'.`,
    }));

    // Broadcast ke semua agent lain: ada yang join
    this.broadcast(server, JSON.stringify({
      type: "event",
      event: "agent_joined",
      agent_id: agentId,
      name: agentName,
      timestamp: new Date().toISOString(),
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const tags    = this.ctx.getTags(ws);
    const agentId = tags[0];
    const name    = tags[1];

    let msg: WsMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
      return;
    }

    // Handle ping
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      return;
    }

    // Handle send ke target tertentu (direct message)
    if (msg.type === "send" && msg.to) {
      const targetId = msg.to as string;
      const sockets  = this.ctx.getWebSockets();
      let delivered  = false;

      for (const sock of sockets) {
        const sockTags = this.ctx.getTags(sock);
        if (sockTags[0] === targetId) {
          sock.send(JSON.stringify({
            type: "message",
            from: agentId,
            from_name: name,
            content: msg.content,
            msg_type: msg.msg_type || "text",
            timestamp: new Date().toISOString(),
          }));
          delivered = true;
          break;
        }
      }

      ws.send(JSON.stringify({
        type: "ack",
        delivered,
        to: targetId,
      }));
      return;
    }

    // Handle broadcast ke semua
    if (msg.type === "broadcast") {
      this.broadcast(ws, JSON.stringify({
        type: "message",
        from: agentId,
        from_name: name,
        content: msg.content,
        msg_type: msg.msg_type || "text",
        broadcast: true,
        timestamp: new Date().toISOString(),
      }));
      ws.send(JSON.stringify({ type: "ack", delivered: true, broadcast: true }));
      return;
    }

    ws.send(JSON.stringify({ type: "error", error: `Unknown type: ${msg.type}` }));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const tags    = this.ctx.getTags(ws);
    const agentId = tags[0];
    const name    = tags[1];

    // Broadcast ke semua: ada yang leave
    this.broadcast(ws, JSON.stringify({
      type: "event",
      event: "agent_left",
      agent_id: agentId,
      name,
      timestamp: new Date().toISOString(),
    }));

    ws.close(code, "Closing");
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket error:", error);
    ws.close(1011, "Internal error");
  }

  // Broadcast ke semua kecuali sender
  private broadcast(sender: WebSocket | null, message: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== sender) {
        try { ws.send(message); } catch {}
      }
    }
  }
}

// ─── Durable Object: Registry ─────────────────────────────────────────────────
// Menyimpan metadata room (nama, private/public, token)

export class AgentLinkRegistry extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url    = new URL(request.url);
    const action = url.pathname.replace("/", "");

    // List semua room
    if (action === "list") {
      const all = await this.ctx.storage.list<RoomMeta>({ prefix: "room:" });
      const rooms = [...all.values()];
      return Response.json(rooms);
    }

    // Register room baru
    if (action === "register" && request.method === "POST") {
      const data = await request.json() as RoomMeta;
      await this.ctx.storage.put(`room:${data.room_id}`, data);
      return Response.json({ ok: true });
    }

    // Check room + token validity
    if (action === "check") {
      const room_id = url.searchParams.get("room_id") || "";
      const token   = url.searchParams.get("token") || "";
      const room    = await this.ctx.storage.get<RoomMeta>(`room:${room_id}`);

      if (!room) {
        return Response.json({ ok: false, error: `Room '${room_id}' tidak ditemukan.` });
      }
      if (room.is_private && room.token !== token) {
        return Response.json({ ok: false, error: "Token salah." });
      }
      return Response.json({ ok: true, room });
    }

    // Delete room (cleanup)
    if (action === "delete" && request.method === "POST") {
      const { room_id } = await request.json() as { room_id: string };
      await this.ctx.storage.delete(`room:${room_id}`);
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}
