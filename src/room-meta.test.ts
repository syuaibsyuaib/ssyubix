import assert from "node:assert/strict";
import test from "node:test";

import { listPublicRooms, toPublicRoomMeta, type StoredRoomMeta } from "./room-meta";

test("toPublicRoomMeta removes private-only metadata", () => {
  const room: StoredRoomMeta = {
    room_id: "ABC123",
    name: "public-room",
    is_private: false,
    token: "SECRET",
    created_at: "2026-03-08T00:00:00.000Z",
    agent_count: 2,
  };

  assert.deepEqual(toPublicRoomMeta(room), {
    room_id: "ABC123",
    name: "public-room",
    is_private: false,
    created_at: "2026-03-08T00:00:00.000Z",
    agent_count: 2,
  });
});

test("listPublicRooms excludes private rooms and secret tokens", () => {
  const rooms: StoredRoomMeta[] = [
    {
      room_id: "PUB123",
      name: "public-room",
      is_private: false,
      token: "",
      created_at: "2026-03-08T00:00:00.000Z",
      agent_count: 1,
    },
    {
      room_id: "PRI123",
      name: "private-room",
      is_private: true,
      token: "TOPSECRET",
      created_at: "2026-03-08T00:05:00.000Z",
      agent_count: 1,
    },
  ];

  assert.deepEqual(listPublicRooms(rooms), [
    {
      room_id: "PUB123",
      name: "public-room",
      is_private: false,
      created_at: "2026-03-08T00:00:00.000Z",
      agent_count: 1,
    },
  ]);
});
