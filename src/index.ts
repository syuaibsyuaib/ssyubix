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

import {
  applyCapabilityProfilePatch,
  buildCapabilitySkillIndex,
  CAPABILITY_AVAILABILITY_VALUES,
  createCapabilityRegistryManifest,
  listCapabilityProfiles,
  removeCapabilityProfile,
  ROOM_CAPABILITY_REGISTRY_KEY,
  upsertCapabilityProfile,
  validateCapabilityProfilePatch,
  type CapabilityPresenceOverlay,
  type CapabilityRegistryManifest,
} from "./capability-registry";
import { createAck, createRoomEvent, createRoomMessage } from "./message-protocol";
import {
  buildHeartbeatConfig,
  shouldCheckpointPresence,
  shouldHydrateActiveSessions,
  shouldPruneSessionCheckpoint,
  toHydratedPresenceState,
  shouldResumeSession,
  toPresenceSnapshot,
  TRANSIENT_CHECKPOINT_BATCH_DELAY_SECONDS,
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
  type:
    | "send"
    | "broadcast"
    | "ping"
    | "pong"
    | "message"
    | "event"
    | "info"
    | "capability_upsert"
    | "capability_set_availability"
    | "capability_remove";
  [key: string]: unknown;
}

interface RoomSessionCheckpointManifest {
  updated_at: string;
  sessions: Record<string, StoredRoomSession>;
}

const ROOM_SESSION_CHECKPOINTS_KEY = "room:session-checkpoints";

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
        version: "2.1.0",
        backend: "Cloudflare Workers + Durable Objects",
        endpoints: {
          list_rooms: "GET /rooms",
          create_room: "POST /rooms",
          connect: "WS /connect/:room_id?name=<name>&token=<token>",
          capability_agents: "GET /capabilities/:room_id/agents?token=<token>",
          capability_agent: "GET /capabilities/:room_id/agents/:agent_id?token=<token>",
          capability_skills: "GET /capabilities/:room_id/skills?token=<token>",
          capability_skill: "GET /capabilities/:room_id/skills/:skill_id?token=<token>",
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

    const capabilityMatch = path.match(
      /^\/capabilities\/([A-Z0-9]{6})\/(agents|skills)(?:\/([^/]+))?$/i,
    );
    if (capabilityMatch && request.method === "GET") {
      const room_id = capabilityMatch[1].toUpperCase();
      const collection = capabilityMatch[2].toLowerCase();
      const entryId = capabilityMatch[3]
        ? decodeURIComponent(capabilityMatch[3])
        : undefined;
      const token = url.searchParams.get("token") || "";

      const registry = env.AGENTLINK_REGISTRY.get(
        env.AGENTLINK_REGISTRY.idFromName("global"),
      );
      const checkResp = await registry.fetch(new Request(
        `http://internal/check?room_id=${room_id}&token=${encodeURIComponent(token)}`,
      ));
      const check = await checkResp.json() as { ok: boolean; error?: string };

      if (!check.ok) {
        return Response.json(
          { success: false, error: check.error || "Unauthorized" },
          { status: 403, headers: corsHeaders },
        );
      }

      const roomDO = env.AGENTLINK_ROOM.get(
        env.AGENTLINK_ROOM.idFromName(room_id),
      );
      const internalPath = entryId
        ? `http://internal/capabilities/${collection}/${encodeURIComponent(entryId)}?room_id=${room_id}`
        : `http://internal/capabilities/${collection}?room_id=${room_id}`;
      const roomResp = await roomDO.fetch(new Request(internalPath));
      return new Response(await roomResp.text(), {
        status: roomResp.status,
        headers: {
          ...corsHeaders,
          "Content-Type": roomResp.headers.get("Content-Type") ?? "application/json",
        },
      });
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
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.startsWith("/capabilities/")) {
      const now = new Date().toISOString();
      await this.ensureActiveSessionsHydrated(now);
      return this.handleCapabilityRequest(url);
    }

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
    await this.upsertCapabilityState(state);

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

    if (msg.type === "capability_upsert") {
      const timestamp = new Date().toISOString();
      const requestId = typeof msg.request_id === "string" ? msg.request_id : undefined;
      const validation = validateCapabilityProfilePatch({
        summary: msg.summary,
        version: msg.version,
        tool_access: msg.tool_access,
        constraints: msg.constraints,
        max_concurrent_tasks: msg.max_concurrent_tasks,
        current_load: msg.current_load,
        skills: msg.skills,
      });
      if (!validation.ok || !validation.patch) {
        ws.send(JSON.stringify({
          type: "error",
          error: validation.errors.join(" "),
          request_id: requestId,
          code: "invalid_capability_profile",
          allowed_availability: [...CAPABILITY_AVAILABILITY_VALUES],
        }));
        return;
      }

      const { changed } = await this.applyCapabilityMutation(agentState, {
        patch: validation.patch,
        timestamp,
      });
      const sequence = await this.broadcastCapabilityChange(ws, {
        agentState,
        timestamp,
        event: "capability_updated",
        changed,
      });

      ws.send(JSON.stringify(createAck({
        action: "capability_upsert",
        roomId,
        requestId,
        delivered: true,
        recipientCount: sequence ? Math.max(0, this.ctx.getWebSockets().length - 1) : 0,
        timestamp,
        sequence: sequence ?? undefined,
        messageId: sequence ? `${roomId}:${sequence}` : undefined,
      })));
      return;
    }

    if (msg.type === "capability_set_availability") {
      const timestamp = new Date().toISOString();
      const requestId = typeof msg.request_id === "string" ? msg.request_id : undefined;
      const validation = validateCapabilityProfilePatch({
        availability: msg.availability,
        current_load: msg.current_load,
      }, {
        allowAvailability: true,
        availabilityOnly: true,
      });
      if (!validation.ok || !validation.patch) {
        ws.send(JSON.stringify({
          type: "error",
          error: validation.errors.join(" "),
          request_id: requestId,
          code: "invalid_capability_availability",
          allowed_availability: [...CAPABILITY_AVAILABILITY_VALUES],
        }));
        return;
      }

      const { changed } = await this.applyCapabilityMutation(agentState, {
        patch: validation.patch,
        timestamp,
      });
      const sequence = await this.broadcastCapabilityChange(ws, {
        agentState,
        timestamp,
        event: "capability_updated",
        changed,
      });

      ws.send(JSON.stringify(createAck({
        action: "capability_set_availability",
        roomId,
        requestId,
        delivered: true,
        recipientCount: sequence ? Math.max(0, this.ctx.getWebSockets().length - 1) : 0,
        timestamp,
        sequence: sequence ?? undefined,
        messageId: sequence ? `${roomId}:${sequence}` : undefined,
      })));
      return;
    }

    if (msg.type === "capability_remove") {
      const timestamp = new Date().toISOString();
      const requestId = typeof msg.request_id === "string" ? msg.request_id : undefined;
      const removed = await this.removeStoredCapabilityProfile(agentState.agent_id, timestamp);
      const sequence = await this.broadcastCapabilityChange(ws, {
        agentState,
        timestamp,
        event: "capability_removed",
        changed: removed,
      });

      ws.send(JSON.stringify(createAck({
        action: "capability_remove",
        roomId,
        requestId,
        delivered: true,
        recipientCount: sequence ? Math.max(0, this.ctx.getWebSockets().length - 1) : 0,
        timestamp,
        sequence: sequence ?? undefined,
        messageId: sequence ? `${roomId}:${sequence}` : undefined,
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
    await this.upsertCapabilityState(offlineState);
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

  async alarm(): Promise<void> {
    const now = new Date().toISOString();
    await this.flushTransientSessionCheckpoints(now);
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

    const manifest = await this.loadSessionCheckpointManifest();
    manifest.sessions[state.session_id] = this.toStoredSession(state);
    this.pruneExpiredSessionCheckpoints(manifest, state.last_seen_at);
    manifest.updated_at = state.last_seen_at;
    await this.ctx.storage.put(ROOM_SESSION_CHECKPOINTS_KEY, manifest);
  }

  private async loadCapabilityRegistryManifest(
    now = new Date().toISOString(),
  ): Promise<CapabilityRegistryManifest> {
    const stored = await this.ctx.storage.get<CapabilityRegistryManifest>(
      ROOM_CAPABILITY_REGISTRY_KEY,
    );
    return createCapabilityRegistryManifest(stored, now);
  }

  private listCapabilityPresenceOverlays(): CapabilityPresenceOverlay[] {
    return this.listActiveAgents().map((snapshot) => ({
      ...snapshot,
      updated_at: snapshot.last_seen_at,
    }));
  }

  private async upsertCapabilityState(state: AgentSessionState): Promise<void> {
    const manifest = await this.loadCapabilityRegistryManifest(state.last_seen_at);
    const { changed } = upsertCapabilityProfile(manifest, {
      agentId: state.agent_id,
      displayName: state.name,
      presence: state.presence,
      joinedAt: state.joined_at,
      lastSeenAt: state.last_seen_at,
      updatedAt: state.last_seen_at,
    });
    if (!changed) {
      return;
    }
    await this.ctx.storage.put(ROOM_CAPABILITY_REGISTRY_KEY, manifest);
  }

  private async applyCapabilityMutation(
    agentState: AgentSessionState,
    params: {
      patch: Parameters<typeof applyCapabilityProfilePatch>[1]["patch"];
      timestamp: string;
    },
  ) {
    const manifest = await this.loadCapabilityRegistryManifest(params.timestamp);
    const result = applyCapabilityProfilePatch(manifest, {
      agentId: agentState.agent_id,
      displayName: agentState.name,
      presence: agentState.presence,
      joinedAt: agentState.joined_at,
      lastSeenAt: agentState.last_seen_at,
      updatedAt: params.timestamp,
      patch: params.patch,
    });
    if (result.changed) {
      await this.ctx.storage.put(ROOM_CAPABILITY_REGISTRY_KEY, manifest);
    }
    return result;
  }

  private async removeStoredCapabilityProfile(
    agentId: string,
    timestamp: string,
  ): Promise<boolean> {
    const manifest = await this.loadCapabilityRegistryManifest(timestamp);
    const changed = removeCapabilityProfile(manifest, agentId, timestamp);
    if (changed) {
      await this.ctx.storage.put(ROOM_CAPABILITY_REGISTRY_KEY, manifest);
    }
    return changed;
  }

  private async broadcastCapabilityChange(
    sender: WebSocket,
    params: {
      agentState: AgentSessionState;
      timestamp: string;
      event: "capability_updated" | "capability_removed";
      changed: boolean;
    },
  ): Promise<number | null> {
    if (!params.changed) {
      return null;
    }
    const sequence = await this.nextSequence();
    this.broadcast(sender, JSON.stringify(createRoomEvent({
      roomId: params.agentState.room_id,
      sequence,
      timestamp: params.timestamp,
      event: params.event,
      agentId: params.agentState.agent_id,
      name: params.agentState.name,
      presence: params.agentState.presence,
      joinedAt: params.agentState.joined_at,
      lastSeenAt: params.agentState.last_seen_at,
    })));
    return sequence;
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

    if (!params.force) {
      await this.scheduleTransientCheckpoint(params.nextState.last_seen_at);
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

    let shouldScheduleCheckpoint = false;
    for (const ws of this.ctx.getWebSockets()) {
      const previousState = this.readAgentState(ws);
      const nextState = toHydratedPresenceState(previousState, now);
      this.writeAgentState(ws, nextState);
      shouldScheduleCheckpoint ||= shouldCheckpointPresence({
        lastCheckpointAt: nextState.checkpointed_at,
        nextLastSeenAt: nextState.last_seen_at,
        nextPresence: nextState.presence,
        previousPresence: previousState.presence,
      });
    }

    if (shouldScheduleCheckpoint) {
      await this.scheduleTransientCheckpoint(now);
    }

    this.lastHydratedAt = now;
  }

  private async scheduleTransientCheckpoint(now: string): Promise<void> {
    const dueAt = Date.parse(now) + TRANSIENT_CHECKPOINT_BATCH_DELAY_SECONDS * 1000;
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm !== null && existingAlarm <= dueAt) {
      return;
    }
    await this.ctx.storage.setAlarm(dueAt);
  }

  private async flushTransientSessionCheckpoints(now: string): Promise<void> {
    const manifest = await this.loadSessionCheckpointManifest();
    let changed = false;

    for (const ws of this.ctx.getWebSockets()) {
      const state = this.readAgentState(ws);
      const stored = manifest.sessions[state.session_id];
      const shouldPersist =
        !stored ||
        shouldCheckpointPresence({
          lastCheckpointAt: stored?.checkpointed_at ?? state.checkpointed_at,
          nextLastSeenAt: state.last_seen_at,
          nextPresence: state.presence,
          previousPresence: stored?.presence ?? state.presence,
        });

      if (!shouldPersist) {
        continue;
      }

      const persistedState: AgentSessionState = {
        ...state,
        checkpointed_at: state.last_seen_at,
      };
      this.writeAgentState(ws, persistedState);
      manifest.sessions[persistedState.session_id] = this.toStoredSession(persistedState);
      changed = true;
    }

    changed = this.pruneExpiredSessionCheckpoints(manifest, now) || changed;

    if (!changed) {
      return;
    }

    manifest.updated_at = now;
    await this.ctx.storage.put(ROOM_SESSION_CHECKPOINTS_KEY, manifest);
  }

  private async handleCapabilityRequest(url: URL): Promise<Response> {
    const manifest = await this.loadCapabilityRegistryManifest();
    const profiles = listCapabilityProfiles(
      manifest,
      this.listCapabilityPresenceOverlays(),
    );
    const segments = url.pathname.split("/").filter(Boolean);
    const collection = segments[1];
    const entryId = segments[2] ? decodeURIComponent(segments[2]) : undefined;
    const roomId = url.searchParams.get("room_id") || "unknown";

    if (collection === "agents" && !entryId) {
      return Response.json({
        success: true,
        room_id: roomId,
        updated_at: manifest.updated_at,
        count: profiles.length,
        agents: profiles,
      });
    }

    if (collection === "agents" && entryId) {
      const agent = profiles.find((profile) => profile.agent_id === entryId);
      if (!agent) {
        return Response.json(
          { success: false, error: `Capability profile '${entryId}' tidak ditemukan.` },
          { status: 404 },
        );
      }
      return Response.json({
        success: true,
        room_id: roomId,
        updated_at: manifest.updated_at,
        agent,
      });
    }

    const skills = buildCapabilitySkillIndex(profiles);
    if (collection === "skills" && !entryId) {
      return Response.json({
        success: true,
        room_id: roomId,
        updated_at: manifest.updated_at,
        count: skills.length,
        skills,
      });
    }

    if (collection === "skills" && entryId) {
      const skill = skills.find((entry) => entry.skill_id === entryId);
      if (!skill) {
        return Response.json(
          { success: false, error: `Skill '${entryId}' tidak ditemukan.` },
          { status: 404 },
        );
      }
      return Response.json({
        success: true,
        room_id: roomId,
        updated_at: manifest.updated_at,
        skill,
      });
    }

    return new Response("Not Found", { status: 404 });
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

  private toStoredSession(state: AgentSessionState): StoredRoomSession {
    return {
      session_id: state.session_id,
      agent_id: state.agent_id,
      name: state.name,
      joined_at: state.joined_at,
      last_seen_at: state.last_seen_at,
      presence: state.presence,
      checkpointed_at: state.checkpointed_at,
    };
  }

  private async loadSessionCheckpointManifest(): Promise<RoomSessionCheckpointManifest> {
    const stored =
      (await this.ctx.storage.get<RoomSessionCheckpointManifest>(ROOM_SESSION_CHECKPOINTS_KEY)) ??
      {
        updated_at: new Date().toISOString(),
        sessions: {},
      };

    return {
      updated_at: typeof stored.updated_at === "string"
        ? stored.updated_at
        : new Date().toISOString(),
      sessions: typeof stored.sessions === "object" && stored.sessions
        ? stored.sessions
        : {},
    };
  }

  private pruneExpiredSessionCheckpoints(
    manifest: RoomSessionCheckpointManifest,
    now: string,
  ): boolean {
    let changed = false;
    for (const [sessionId, stored] of Object.entries(manifest.sessions)) {
      if (this.findActiveSession(sessionId)) {
        continue;
      }
      if (shouldPruneSessionCheckpoint({ session: stored, now })) {
        delete manifest.sessions[sessionId];
        changed = true;
      }
    }
    return changed;
  }

  private async getStoredSession(sessionId: string, now: string): Promise<StoredRoomSession | null> {
    const manifest = await this.loadSessionCheckpointManifest();
    const fromManifest = manifest.sessions[sessionId];
    if (fromManifest) {
      if (shouldPruneSessionCheckpoint({ session: fromManifest, now })) {
        delete manifest.sessions[sessionId];
        manifest.updated_at = now;
        await this.ctx.storage.put(ROOM_SESSION_CHECKPOINTS_KEY, manifest);
        return null;
      }
      return fromManifest;
    }

    const legacy = await this.ctx.storage.get<StoredRoomSession>(`session:${sessionId}`);
    if (!legacy) {
      return null;
    }

    if (shouldPruneSessionCheckpoint({ session: legacy, now })) {
      return null;
    }

    return legacy;
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

    const stored = await this.getStoredSession(params.sessionId, params.now);

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
