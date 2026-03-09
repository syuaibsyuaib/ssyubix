import assert from "node:assert/strict";
import test from "node:test";

import {
  HEARTBEAT_INTERVAL_SECONDS,
  HEARTBEAT_TIMEOUT_SECONDS,
  PRESENCE_CHECKPOINT_INTERVAL_SECONDS,
  RECONNECT_WINDOW_SECONDS,
  TRANSIENT_CHECKPOINT_BATCH_DELAY_SECONDS,
  buildHeartbeatConfig,
  shouldCheckpointPresence,
  shouldHydrateActiveSessions,
  shouldPruneSessionCheckpoint,
  shouldResumeSession,
  toHydratedPresenceState,
  toPresenceSnapshot,
} from "./presence";

test("buildHeartbeatConfig exposes the room heartbeat defaults", () => {
  assert.deepEqual(buildHeartbeatConfig(), {
    heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
    heartbeat_timeout_seconds: HEARTBEAT_TIMEOUT_SECONDS,
    reconnect_window_seconds: RECONNECT_WINDOW_SECONDS,
    presence_checkpoint_interval_seconds: PRESENCE_CHECKPOINT_INTERVAL_SECONDS,
  });
  assert.equal(TRANSIENT_CHECKPOINT_BATCH_DELAY_SECONDS, 5);
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
      stable_agent_identity_id: "stable-agent-42",
      name: "peer-one",
      joined_at: "2026-03-08T00:00:00.000Z",
      last_seen_at: "2026-03-08T00:00:30.000Z",
      presence: "online",
    }),
    {
      agent_id: "AGENT42",
      stable_agent_identity_id: "stable-agent-42",
      name: "peer-one",
      joined_at: "2026-03-08T00:00:00.000Z",
      last_seen_at: "2026-03-08T00:00:30.000Z",
      presence: "online",
    },
  );
});

test("shouldCheckpointPresence skips writes inside the coarse checkpoint window", () => {
  assert.equal(
    shouldCheckpointPresence({
      lastCheckpointAt: "2026-03-09T00:00:00.000Z",
      nextLastSeenAt: "2026-03-09T00:00:30.000Z",
      previousPresence: "online",
      nextPresence: "online",
      checkpointIntervalSeconds: 60,
    }),
    false,
  );
});

test("shouldCheckpointPresence persists immediately when presence changes", () => {
  assert.equal(
    shouldCheckpointPresence({
      lastCheckpointAt: "2026-03-09T00:00:00.000Z",
      nextLastSeenAt: "2026-03-09T00:00:10.000Z",
      previousPresence: "online",
      nextPresence: "offline",
      checkpointIntervalSeconds: 60,
    }),
    true,
  );
});

test("shouldHydrateActiveSessions fires when the room wakes without a recent hydration marker", () => {
  assert.equal(
    shouldHydrateActiveSessions({
      lastHydratedAt: null,
      now: "2026-03-09T00:01:00.000Z",
    }),
    true,
  );
});

test("shouldHydrateActiveSessions skips redundant room hydration inside the max age", () => {
  assert.equal(
    shouldHydrateActiveSessions({
      lastHydratedAt: "2026-03-09T00:01:00.000Z",
      now: "2026-03-09T00:01:20.000Z",
      maxAgeSeconds: 30,
    }),
    false,
  );
});

test("toHydratedPresenceState refreshes the last seen timestamp while keeping identity fields", () => {
  assert.deepEqual(
    toHydratedPresenceState({
      session_id: "SESSION1",
      agent_id: "AGENT42",
      stable_agent_identity_id: "stable-agent-42",
      name: "peer-one",
      joined_at: "2026-03-09T00:00:00.000Z",
      last_seen_at: "2026-03-09T00:00:30.000Z",
      presence: "offline" as const,
      checkpointed_at: "2026-03-09T00:00:00.000Z",
    }, "2026-03-09T00:01:00.000Z"),
    {
      session_id: "SESSION1",
      agent_id: "AGENT42",
      stable_agent_identity_id: "stable-agent-42",
      name: "peer-one",
      joined_at: "2026-03-09T00:00:00.000Z",
      last_seen_at: "2026-03-09T00:01:00.000Z",
      presence: "online",
      checkpointed_at: "2026-03-09T00:00:00.000Z",
    },
  );
});

test("shouldPruneSessionCheckpoint removes stale reconnect state outside the resume window", () => {
  assert.equal(
    shouldPruneSessionCheckpoint({
      session: {
        session_id: "SESSION1",
        agent_id: "AGENT42",
        stable_agent_identity_id: "stable-agent-42",
        name: "peer-one",
        joined_at: "2026-03-09T00:00:00.000Z",
        last_seen_at: "2026-03-09T00:00:00.000Z",
        presence: "offline",
      },
      now: "2026-03-09T00:03:01.000Z",
      reconnectWindowSeconds: 120,
    }),
    true,
  );
});

test("shouldPruneSessionCheckpoint keeps reconnect state inside the resume window", () => {
  assert.equal(
    shouldPruneSessionCheckpoint({
      session: {
        session_id: "SESSION1",
        agent_id: "AGENT42",
        stable_agent_identity_id: "stable-agent-42",
        name: "peer-one",
        joined_at: "2026-03-09T00:00:00.000Z",
        last_seen_at: "2026-03-09T00:01:30.000Z",
        presence: "offline",
      },
      now: "2026-03-09T00:02:00.000Z",
      reconnectWindowSeconds: 120,
    }),
    false,
  );
});
