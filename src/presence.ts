export const HEARTBEAT_INTERVAL_SECONDS = 30;
export const HEARTBEAT_TIMEOUT_SECONDS = 90;
export const RECONNECT_WINDOW_SECONDS = 120;

export interface AgentPresenceSnapshot {
  agent_id: string;
  name: string;
  joined_at: string;
  last_seen_at: string;
  presence: "online" | "offline";
}

export interface StoredRoomSession extends AgentPresenceSnapshot {
  session_id: string;
}

export interface RoomHeartbeatConfig {
  heartbeat_interval_seconds: number;
  heartbeat_timeout_seconds: number;
  reconnect_window_seconds: number;
}

export function buildHeartbeatConfig(): RoomHeartbeatConfig {
  return {
    heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
    heartbeat_timeout_seconds: HEARTBEAT_TIMEOUT_SECONDS,
    reconnect_window_seconds: RECONNECT_WINDOW_SECONDS,
  };
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
  name: string;
  joined_at: string;
  last_seen_at: string;
  presence: "online" | "offline";
}): AgentPresenceSnapshot {
  return {
    agent_id: state.agent_id,
    name: state.name,
    joined_at: state.joined_at,
    last_seen_at: state.last_seen_at,
    presence: state.presence,
  };
}
