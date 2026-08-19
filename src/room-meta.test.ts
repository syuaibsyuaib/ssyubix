import assert from "node:assert/strict";
import test from "node:test";

import {
  isUnjoinableRoom,
  ROOM_ACTIVITY_WINDOW_DAYS,
  summarizeRoomActivity,
  type StoredRoomMeta,
} from "./room-meta";

const NOW = new Date("2026-03-08T12:00:00.000Z");

function room(overrides: Partial<StoredRoomMeta> = {}): StoredRoomMeta {
  return {
    room_id: "ABC123",
    name: "private-room",
    token: "TOPSECRET",
    created_at: "2026-03-08T00:00:00.000Z",
    agent_count: 2,
    ...overrides,
  };
}

test("summarizeRoomActivity never leaks room ids, names, or tokens", () => {
  const stats = summarizeRoomActivity([room()], NOW);

  assert.deepEqual(Object.keys(stats).sort(), [
    "active_room_count",
    "generated_at",
    "total_agent_count",
    "total_room_count",
    "window_days",
  ]);

  const serialized = JSON.stringify(stats);
  assert.ok(!serialized.includes("ABC123"));
  assert.ok(!serialized.includes("private-room"));
  assert.ok(!serialized.includes("TOPSECRET"));
});

test("summarizeRoomActivity counts only rooms inside the activity window", () => {
  const outsideWindow = new Date(
    NOW.getTime() - (ROOM_ACTIVITY_WINDOW_DAYS * 24 + 1) * 60 * 60 * 1000,
  ).toISOString();

  const stats = summarizeRoomActivity([
    room({ room_id: "NEW001", created_at: "2026-03-08T00:00:00.000Z", agent_count: 2 }),
    room({ room_id: "NEW002", created_at: "2026-03-06T12:00:00.000Z", agent_count: 3 }),
    room({ room_id: "OLD001", created_at: outsideWindow, agent_count: 9 }),
  ], NOW);

  assert.equal(stats.active_room_count, 2);
  assert.equal(stats.total_room_count, 3);
  // Agent dari room di luar window tidak ikut dihitung.
  assert.equal(stats.total_agent_count, 5);
  assert.equal(stats.window_days, ROOM_ACTIVITY_WINDOW_DAYS);
  assert.equal(stats.generated_at, NOW.toISOString());
});

test("summarizeRoomActivity tolerates missing agent_count and unparsable dates", () => {
  const stats = summarizeRoomActivity([
    room({ room_id: "NOCNT", agent_count: undefined }),
    room({ room_id: "BADDT", created_at: "not-a-date", agent_count: 4 }),
  ], NOW);

  assert.equal(stats.active_room_count, 1);
  assert.equal(stats.total_room_count, 2);
  assert.equal(stats.total_agent_count, 0);
});

test("summarizeRoomActivity returns zeroes for an empty registry", () => {
  const stats = summarizeRoomActivity([], NOW);

  assert.equal(stats.active_room_count, 0);
  assert.equal(stats.total_room_count, 0);
  assert.equal(stats.total_agent_count, 0);
});

test("isUnjoinableRoom flags only rooms with no verifiable join key", () => {
  // Warisan mode publik: tidak ada kunci, registry menolaknya.
  assert.equal(isUnjoinableRoom({ token: "" }), true);
  assert.equal(isUnjoinableRoom({ token: undefined as unknown as string }), true);
  assert.equal(isUnjoinableRoom({ token: null as unknown as string }), true);

  // Room hidup harus selamat, termasuk token yang bentuknya tidak lazim.
  assert.equal(isUnjoinableRoom({ token: "TOPSECRET" }), false);
  assert.equal(isUnjoinableRoom({ token: "0" }), false);
  assert.equal(isUnjoinableRoom({ token: " " }), false);
});

test("isUnjoinableRoom ignores age, name, and ownership", () => {
  const ancientButJoinable: StoredRoomMeta = {
    room_id: "OLD001",
    name: "",
    token: "STILLVALID",
    created_at: "2020-01-01T00:00:00.000Z",
    owner_stable_identity_id: undefined,
  };
  const freshButDead: StoredRoomMeta = {
    room_id: "NEW001",
    name: "baru tapi tanpa kunci",
    token: "",
    created_at: NOW.toISOString(),
    owner_stable_identity_id: "stable_owner",
  };

  // Umur tidak boleh jadi alasan menghapus: room lama yang masih punya kunci
  // tetap bisa dimasuki pemiliknya.
  assert.equal(isUnjoinableRoom(ancientButJoinable), false);
  assert.equal(isUnjoinableRoom(freshButDead), true);
});
