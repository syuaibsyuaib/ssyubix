import assert from "node:assert/strict";
import test from "node:test";

import {
  HEARTBEAT_INTERVAL_SECONDS,
  HEARTBEAT_TIMEOUT_SECONDS,
  RECONNECT_WINDOW_SECONDS,
  buildHeartbeatConfig,
  shouldResumeSession,
  toPresenceSnapshot,
} from "./presence";

test("buildHeartbeatConfig exposes the room heartbeat defaults", () => {
  assert.deepEqual(buildHeartbeatConfig(), {
    heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
    heartbeat_timeout_seconds: HEARTBEAT_TIMEOUT_SECONDS,
    reconnect_window_seconds: RECONNECT_WINDOW_SECONDS,
  });
});

test("shouldResumeSession accepts reconnects inside the resume window", () => {
  assert.equal(
    shouldResumeSession({
      lastSeenAt: "2026-03-08T00:00:00.000Z",
      now: "2026-03-08T00:01:30.000Z",
      reconnectWindowSeconds: 120,
    }),
    true,
  );
});

test("shouldResumeSession rejects reconnects outside the resume window", () => {
  assert.equal(
    shouldResumeSession({
      lastSeenAt: "2026-03-08T00:00:00.000Z",
      now: "2026-03-08T00:03:01.000Z",
      reconnectWindowSeconds: 120,
    }),
    false,
  );
});

test("toPresenceSnapshot strips session-only state", () => {
  assert.deepEqual(
    toPresenceSnapshot({
      agent_id: "AGENT42",
      name: "peer-one",
      joined_at: "2026-03-08T00:00:00.000Z",
      last_seen_at: "2026-03-08T00:00:30.000Z",
      presence: "online",
    }),
    {
      agent_id: "AGENT42",
      name: "peer-one",
      joined_at: "2026-03-08T00:00:00.000Z",
      last_seen_at: "2026-03-08T00:00:30.000Z",
      presence: "online",
    },
  );
});
