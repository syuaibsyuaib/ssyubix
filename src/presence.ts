export const HEARTBEAT_INTERVAL_SECONDS = 30;
export const HEARTBEAT_TIMEOUT_SECONDS = 90;
export const RECONNECT_WINDOW_SECONDS = 120;
export const PRESENCE_CHECKPOINT_INTERVAL_SECONDS = Math.max(
  HEARTBEAT_INTERVAL_SECONDS * 2,
  60,
);
export const TRANSIENT_CHECKPOINT_BATCH_DELAY_SECONDS = 5;

export interface AgentPresenceSnapshot {
  agent_id: string;
  stable_agent_identity_id?: string;
  name: string;
  joined_at: string;
  last_seen_at: string;
  presence: "online" | "offline";
}

export interface StoredRoomSession extends AgentPresenceSnapshot {
  session_id: string;
  checkpointed_at?: string;
}

export interface RoomHeartbeatConfig {
  heartbeat_interval_seconds: number;
  heartbeat_timeout_seconds: number;
  reconnect_window_seconds: number;
  presence_checkpoint_interval_seconds: number;
}

export function buildHeartbeatConfig(): RoomHeartbeatConfig {
  return {
    heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
    heartbeat_timeout_seconds: HEARTBEAT_TIMEOUT_SECONDS,
    reconnect_window_seconds: RECONNECT_WINDOW_SECONDS,
    presence_checkpoint_interval_seconds: PRESENCE_CHECKPOINT_INTERVAL_SECONDS,
  };
}

export function shouldCheckpointPresence(params: {
  lastCheckpointAt?: string;
  nextLastSeenAt: string;
  nextPresence: "online" | "offline";
  previousPresence?: "online" | "offline";
  checkpointIntervalSeconds?: number;
  force?: boolean;
}): boolean {
  if (params.force) {
    return true;
  }

  if (
    params.previousPresence &&
    params.previousPresence !== params.nextPresence
  ) {
    return true;
  }

  const lastCheckpointMs = Date.parse(params.lastCheckpointAt ?? "");
  const nextLastSeenMs = Date.parse(params.nextLastSeenAt);

  if (Number.isNaN(nextLastSeenMs)) {
    return false;
  }

  if (Number.isNaN(lastCheckpointMs)) {
    return true;
  }

  const checkpointIntervalSeconds =
    params.checkpointIntervalSeconds ?? PRESENCE_CHECKPOINT_INTERVAL_SECONDS;

  return nextLastSeenMs - lastCheckpointMs >= checkpointIntervalSeconds * 1000;
}

export function shouldHydrateActiveSessions(params: {
  lastHydratedAt?: string | null;
  now: string;
  maxAgeSeconds?: number;
}): boolean {
  const lastHydratedMs = Date.parse(params.lastHydratedAt ?? "");
  const nowMs = Date.parse(params.now);

  if (Number.isNaN(nowMs)) {
    return false;
  }

  if (Number.isNaN(lastHydratedMs)) {
    return true;
  }

  const maxAgeSeconds = params.maxAgeSeconds ?? HEARTBEAT_INTERVAL_SECONDS;
  return nowMs - lastHydratedMs >= maxAgeSeconds * 1000;
}

export function toHydratedPresenceState<T extends {
  last_seen_at: string;
  presence: "online" | "offline";
}>(state: T, now: string): T {
  return {
    ...state,
    last_seen_at: now,
    presence: "online",
  };
}

export function shouldPruneSessionCheckpoint(params: {
  session: StoredRoomSession;
  now: string;
  reconnectWindowSeconds?: number;
}): boolean {
  return !shouldResumeSession({
    lastSeenAt: params.session.last_seen_at,
    now: params.now,
    reconnectWindowSeconds: params.reconnectWindowSeconds,
  });
}

export function shouldResumeSession(params: {
  lastSeenAt: string;
  now: string;
  reconnectWindowSeconds?: number;
}): boolean {
  const reconnectWindowSeconds =
    params.reconnectWindowSeconds ?? RECONNECT_WINDOW_SECONDS;
  const lastSeenMs = Date.parse(params.lastSeenAt);
  const nowMs = Date.parse(params.now);

  if (Number.isNaN(lastSeenMs) || Number.isNaN(nowMs)) {
    return false;
  }

  return nowMs - lastSeenMs <= reconnectWindowSeconds * 1000;
}

export function toPresenceSnapshot(state: {
  agent_id: string;
  stable_agent_identity_id?: string;
  name: string;
  joined_at: string;
  last_seen_at: string;
  presence: "online" | "offline";
}): AgentPresenceSnapshot {
  return {
    agent_id: state.agent_id,
    stable_agent_identity_id: state.stable_agent_identity_id,
    name: state.name,
    joined_at: state.joined_at,
    last_seen_at: state.last_seen_at,
    presence: state.presence,
  };
}
