import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMessageId,
  createAck,
  createRoomEvent,
  createRoomMessage,
} from "./message-protocol";

test("buildMessageId uses room id and room-local sequence", () => {
  assert.equal(buildMessageId("ROOM42", 17), "ROOM42:17");
});

test("createRoomMessage includes message identity and ordering fields", () => {
  assert.deepEqual(
    createRoomMessage({
      roomId: "ROOM42",
      sequence: 17,
      timestamp: "2026-03-08T00:00:00.000Z",
      from: "AGENT1",
      fromName: "agent-one",
      content: "hello",
      msgType: "text",
      broadcast: true,
    }),
    {
      type: "message",
      room_id: "ROOM42",
      message_id: "ROOM42:17",
      sequence: 17,
      timestamp: "2026-03-08T00:00:00.000Z",
      from: "AGENT1",
      from_name: "agent-one",
      content: "hello",
      msg_type: "text",
      broadcast: true,
    },
  );
});

test("createRoomEvent includes message identity and ordering fields", () => {
  assert.deepEqual(
    createRoomEvent({
      roomId: "ROOM42",
      sequence: 18,
      timestamp: "2026-03-08T00:01:00.000Z",
      event: "agent_joined",
      agentId: "AGENT2",
      name: "agent-two",
      presence: "online",
      joinedAt: "2026-03-08T00:00:55.000Z",
      lastSeenAt: "2026-03-08T00:01:00.000Z",
      sessionResumed: false,
    }),
    {
      type: "event",
      room_id: "ROOM42",
      message_id: "ROOM42:18",
      sequence: 18,
      timestamp: "2026-03-08T00:01:00.000Z",
      event: "agent_joined",
      agent_id: "AGENT2",
      name: "agent-two",
      presence: "online",
      joined_at: "2026-03-08T00:00:55.000Z",
      last_seen_at: "2026-03-08T00:01:00.000Z",
      session_resumed: false,
    },
  );
});

test("createAck keeps correlation metadata for clients", () => {
  assert.deepEqual(
    createAck({
      action: "send",
      roomId: "ROOM42",
      requestId: "REQ123",
      delivered: true,
      recipientCount: 1,
      timestamp: "2026-03-08T00:02:00.000Z",
      messageId: "ROOM42:19",
      sequence: 19,
      to: "AGENT2",
    }),
    {
      type: "ack",
      action: "send",
      room_id: "ROOM42",
      request_id: "REQ123",
      accepted: true,
      delivered: true,
      recipient_count: 1,
      timestamp: "2026-03-08T00:02:00.000Z",
      message_id: "ROOM42:19",
      sequence: 19,
      to: "AGENT2",
      broadcast: undefined,
    },
  );
});
