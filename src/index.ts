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

import { createAck, createRoomEvent, createRoomMessage } from "./message-protocol";
import {
  buildHeartbeatConfig,
  shouldCheckpointPresence,
  shouldHydrateActiveSessions,
  toHydratedPresenceState,
  shouldResumeSession,
  toPresenceSnapshot,
  type AgentPresenceSnapshot,
  type StoredRoomSession,
} from "./presence";
import { listPublicRooms, type StoredRoomMeta } from "./room-meta";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Env {
  AGENTLINK_ROOM: DurableObjectNamespace;
  AGENTLINK_REGISTRY: DurableObjectNamespace;
}

interface RoomMeta extends StoredRoomMeta {
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

interface AgentSessionState extends StoredRoomSession {
  room_id: string;
}

interface WsMessage {
  type: "send" | "broadcast" | "ping" | "pong" | "message" | "event" | "info";
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
        version: "2.0.3",
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
      const rooms = await resp.json() as ReturnType<typeof listPublicRooms>;
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
  private sequenceCounter: number | null = null;
  private lastHydratedAt: string | null = null;

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const agentName = request.headers.get("X-Agent-Name") || "unknown";
    const roomId    = request.headers.get("X-Room-Id") || "unknown";
    const sessionId = new URL(request.url).searchParams.get("session_id") || generateId(16);
    const now = new Date().toISOString();
    await this.ensureActiveSessionsHydrated(now);
    const session = await this.resolveSession({
      sessionId,
      agentName,
      now,
    });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Pakai Hibernation API
    this.ctx.acceptWebSocket(server, [session.agentId, agentName, roomId, sessionId]);
    let state: AgentSessionState = {
      session_id: sessionId,
      agent_id: session.agentId,
      name: agentName,
      room_id: roomId,
      joined_at: session.joinedAt,
      last_seen_at: now,
      presence: "online",
    };
    this.writeAgentState(server, state);
    state = await this.maybeCheckpointSessionState(server, {
      previousState: state,
      nextState: state,
      force: true,
    });
    this.closeDuplicateSessions(server, sessionId);

    const joinSequence = await this.nextSequence();
    const heartbeat = buildHeartbeatConfig();

    // Kirim info ke agent yang baru join
    const existingAgents = this.listActiveAgents({
      excludeAgentId: state.agent_id,
      excludeSessionId: sessionId,
    });

    server.send(JSON.stringify({
      type: "welcome",
      agent_id: state.agent_id,
      name: agentName,
      room_id: roomId,
      last_sequence: joinSequence,
      joined_at: state.joined_at,
      last_seen_at: state.last_seen_at,
      presence: state.presence,
      session_resumed: session.reconnected,
      heartbeat_interval_seconds: heartbeat.heartbeat_interval_seconds,
      heartbeat_timeout_seconds: heartbeat.heartbeat_timeout_seconds,
      reconnect_window_seconds: heartbeat.reconnect_window_seconds,
      presence_checkpoint_interval_seconds: heartbeat.presence_checkpoint_interval_seconds,
      agents: existingAgents,
      message: session.reconnected
        ? `Berhasil terhubung kembali ke room '${roomId}'.`
        : `Selamat datang di room '${roomId}'.`,
    }));

    // Broadcast ke semua agent lain: ada yang join
    const eventName = session.reconnected ? "agent_reconnected" : "agent_joined";
    this.broadcast(server, JSON.stringify(createRoomEvent({
      roomId,
      sequence: joinSequence,
      timestamp: now,
      event: eventName,
      agentId: state.agent_id,
      name: agentName,
      presence: state.presence,
      joinedAt: state.joined_at,
      lastSeenAt: state.last_seen_at,
      sessionResumed: session.reconnected,
    })));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: WsMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
      return;
    }

    await this.ensureActiveSessionsHydrated(new Date().toISOString());
    const agentState = await this.touchAgentState(ws);
    const agentId = agentState.agent_id;
    const name = agentState.name;
    const roomId = agentState.room_id;

    // Handle ping
    if (msg.type === "ping") {
      const heartbeat = buildHeartbeatConfig();
      ws.send(JSON.stringify({
        type: "pong",
        room_id: roomId,
        agent_id: agentId,
        presence: agentState.presence,
        timestamp: agentState.last_seen_at,
        last_seen_at: agentState.last_seen_at,
        heartbeat_interval_seconds: heartbeat.heartbeat_interval_seconds,
        heartbeat_timeout_seconds: heartbeat.heartbeat_timeout_seconds,
        presence_checkpoint_interval_seconds: heartbeat.presence_checkpoint_interval_seconds,
        echo_sent_at: typeof msg.sent_at === "string" ? msg.sent_at : undefined,
      }));
      return;
    }

    // Handle send ke target tertentu (direct message)
    if (msg.type === "send" && msg.to) {
      const targetId = msg.to as string;
      const sockets  = this.ctx.getWebSockets();
      let delivered  = false;
      let messageId: string | undefined;
      let sequence: number | undefined;
      const requestId = typeof msg.request_id === "string" ? msg.request_id : undefined;
      const timestamp = new Date().toISOString();

      for (const sock of sockets) {
        const sockTags = this.ctx.getTags(sock);
        if (sockTags[0] === targetId) {
          sequence = await this.nextSequence();
          const payload = createRoomMessage({
            roomId,
            sequence,
            timestamp,
            from: agentId,
            fromName: name,
            content: msg.content,
            msgType: typeof msg.msg_type === "string" ? msg.msg_type : "text",
          });
          messageId = payload.message_id;
          sock.send(JSON.stringify(payload));
          delivered = true;
          break;
        }
      }

      ws.send(JSON.stringify(createAck({
        action: "send",
        roomId,
        requestId,
        delivered,
        recipientCount: delivered ? 1 : 0,
        timestamp,
        messageId,
        sequence,
        to: targetId,
      })));
      return;
    }

    // Handle broadcast ke semua
    if (msg.type === "broadcast") {
      const timestamp = new Date().toISOString();
      const sequence = await this.nextSequence();
      const payload = createRoomMessage({
        roomId,
        sequence,
        timestamp,
        from: agentId,
        fromName: name,
        content: msg.content,
        msgType: typeof msg.msg_type === "string" ? msg.msg_type : "text",
        broadcast: true,
      });
      const recipientCount = this.broadcast(ws, JSON.stringify(payload));
      const requestId = typeof msg.request_id === "string" ? msg.request_id : undefined;

      ws.send(JSON.stringify(createAck({
        action: "broadcast",
        roomId,
        requestId,
        delivered: recipientCount > 0,
        recipientCount,
        timestamp,
        messageId: payload.message_id,
        sequence: payload.sequence,
        broadcast: true,
      })));
      return;
    }

    ws.send(JSON.stringify({
      type: "error",
      error: `Unknown type: ${msg.type}`,
    }));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const state = this.readAgentState(ws);
    if (state.session_id && this.hasActiveSession(state.session_id, ws)) {
      return;
    }

    const timestamp = new Date().toISOString();
    const offlineState: AgentSessionState = {
      ...state,
      last_seen_at: timestamp,
      presence: "offline",
    };
    await this.maybeCheckpointSessionState(ws, {
      previousState: state,
      nextState: offlineState,
      force: true,
    });
    const sequence = await this.nextSequence();

    // Broadcast ke semua: ada yang leave
    this.broadcast(ws, JSON.stringify(createRoomEvent({
      roomId: state.room_id,
      sequence,
      timestamp,
      event: "agent_left",
      agentId: state.agent_id,
      name: state.name,
      presence: offlineState.presence,
      joinedAt: state.joined_at,
      lastSeenAt: offlineState.last_seen_at,
    })));
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket error:", error);
    ws.close(1011, "Internal error");
  }

  private async getCurrentSequence(): Promise<number> {
    if (this.sequenceCounter === null) {
      this.sequenceCounter = (await this.ctx.storage.get<number>("room:sequence")) ?? 0;
    }
    return this.sequenceCounter;
  }

  private async nextSequence(): Promise<number> {
    const next = (await this.getCurrentSequence()) + 1;
    this.sequenceCounter = next;
    await this.ctx.storage.put("room:sequence", next);
    return next;
  }

  private readAgentState(ws: WebSocket): AgentSessionState {
    const attachment = ws.deserializeAttachment();
    if (attachment && typeof attachment === "object") {
      return attachment as AgentSessionState;
    }

    const tags = this.ctx.getTags(ws);
    const timestamp = new Date().toISOString();
    return {
      session_id: tags[3] || "",
      agent_id: tags[0] || "unknown",
      name: tags[1] || "unknown",
      room_id: tags[2] || "unknown",
      joined_at: timestamp,
      last_seen_at: timestamp,
      presence: "online",
      checkpointed_at: undefined,
    };
  }

  private writeAgentState(ws: WebSocket, state: AgentSessionState): AgentSessionState {
    ws.serializeAttachment(state);
    return state;
  }

  private async touchAgentState(ws: WebSocket): Promise<AgentSessionState> {
    const previousState = this.readAgentState(ws);
    const nextState = toHydratedPresenceState(previousState, new Date().toISOString());
    this.writeAgentState(ws, nextState);
    return this.maybeCheckpointSessionState(ws, {
      previousState,
      nextState,
    });
  }

  private listActiveAgents(options: {
    excludeAgentId?: string;
    excludeSessionId?: string;
  } = {}): AgentPresenceSnapshot[] {
    const snapshots = new Map<string, AgentPresenceSnapshot>();
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.readAgentState(ws);
      if (options.excludeAgentId && state.agent_id === options.excludeAgentId) {
        continue;
      }
      if (options.excludeSessionId && state.session_id === options.excludeSessionId) {
        continue;
      }
      snapshots.set(state.agent_id, toPresenceSnapshot(state));
    }
    return [...snapshots.values()];
  }

  private hasActiveSession(sessionId: string, excludedWs: WebSocket): boolean {
    return this.findActiveSession(sessionId, excludedWs) !== null;
  }

  private closeDuplicateSessions(currentWs: WebSocket, sessionId: string): void {
    if (!sessionId) {
      return;
    }

    for (const ws of this.ctx.getWebSockets()) {
      if (ws === currentWs) {
        continue;
      }
      if (this.readAgentState(ws).session_id === sessionId) {
        try {
          ws.close(1012, "Session resumed elsewhere");
        } catch {}
      }
    }
  }

  private async storeSessionState(state: AgentSessionState): Promise<void> {
    if (!state.session_id) {
      return;
    }

    const stored: StoredRoomSession = {
      session_id: state.session_id,
      agent_id: state.agent_id,
      name: state.name,
      joined_at: state.joined_at,
      last_seen_at: state.last_seen_at,
      presence: state.presence,
      checkpointed_at: state.checkpointed_at,
    };
    await this.ctx.storage.put(`session:${state.session_id}`, stored);
  }

  private async maybeCheckpointSessionState(ws: WebSocket, params: {
    previousState: AgentSessionState;
    nextState: AgentSessionState;
    force?: boolean;
  }): Promise<AgentSessionState> {
    if (!shouldCheckpointPresence({
      lastCheckpointAt: params.nextState.checkpointed_at,
      nextLastSeenAt: params.nextState.last_seen_at,
      nextPresence: params.nextState.presence,
      previousPresence: params.previousState.presence,
      force: params.force,
    })) {
      return params.nextState;
    }

    const persistedState: AgentSessionState = {
      ...params.nextState,
      checkpointed_at: params.nextState.last_seen_at,
    };
    this.writeAgentState(ws, persistedState);
    await this.storeSessionState(persistedState);
    return persistedState;
  }

  private async ensureActiveSessionsHydrated(now: string): Promise<void> {
    if (!shouldHydrateActiveSessions({
      lastHydratedAt: this.lastHydratedAt,
      now,
    })) {
      return;
    }

    for (const ws of this.ctx.getWebSockets()) {
      const previousState = this.readAgentState(ws);
      const nextState = toHydratedPresenceState(previousState, now);
      this.writeAgentState(ws, nextState);
      await this.maybeCheckpointSessionState(ws, {
        previousState,
        nextState,
      });
    }

    this.lastHydratedAt = now;
  }

  private findActiveSession(
    sessionId: string,
    excludedWs?: WebSocket,
  ): AgentSessionState | null {
    if (!sessionId) {
      return null;
    }

    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludedWs) {
        continue;
      }
      const state = this.readAgentState(ws);
      if (state.session_id === sessionId) {
        return state;
      }
    }

    return null;
  }

  private async resolveSession(params: {
    sessionId: string;
    agentName: string;
    now: string;
  }): Promise<{ agentId: string; joinedAt: string; reconnected: boolean }> {
    const active = this.findActiveSession(params.sessionId);
    if (active) {
      return {
        agentId: active.agent_id,
        joinedAt: active.joined_at,
        reconnected: true,
      };
    }

    const stored = await this.ctx.storage.get<StoredRoomSession>(
      `session:${params.sessionId}`,
    );

    if (
      stored &&
      shouldResumeSession({ lastSeenAt: stored.last_seen_at, now: params.now })
    ) {
      return {
        agentId: stored.agent_id,
        joinedAt: stored.joined_at,
        reconnected: true,
      };
    }

    return {
      agentId: generateId(8),
      joinedAt: params.now,
      reconnected: false,
    };
  }

  // Broadcast ke semua kecuali sender
  private broadcast(sender: WebSocket | null, message: string): number {
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== sender) {
        try {
          ws.send(message);
          delivered += 1;
        } catch {}
      }
    }
    return delivered;
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
      const rooms = listPublicRooms(all.values());
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
