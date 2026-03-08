import unittest
import asyncio
import json
import tempfile
from pathlib import Path

from agentlink_mcp import server


class HandleIncomingTests(unittest.TestCase):
    def setUp(self):
        self.original_agent_id = server.agent_id
        self.original_inbox = list(server.inbox)
        self.original_current_room = server.current_room
        self.original_local_state_dir = server.local_state_dir
        self.tempdir = tempfile.TemporaryDirectory()
        server.local_state_dir = Path(self.tempdir.name)
        server.agent_id = None
        server.current_room = {"room_id": "ROOM42", "last_sequence": 0}
        server.inbox.clear()

    def tearDown(self):
        server.agent_id = self.original_agent_id
        server.current_room = self.original_current_room
        server.inbox[:] = self.original_inbox
        server.local_state_dir = self.original_local_state_dir
        self.tempdir.cleanup()

    def test_welcome_updates_agent_id_and_tracks_existing_agents(self):
        server._handle_incoming(
            {
                "type": "welcome",
                "agent_id": "LOCAL123",
                "last_sequence": 4,
                "joined_at": "2026-03-08T00:00:00+00:00",
                "last_seen_at": "2026-03-08T00:00:10+00:00",
                "presence": "online",
                "heartbeat_interval_seconds": 30,
                "heartbeat_timeout_seconds": 90,
                "agents": [{"name": "peer-one", "agent_id": "PEER1234"}],
            }
        )

        self.assertEqual(server.agent_id, "LOCAL123")
        self.assertEqual(server.current_room["last_sequence"], 4)
        self.assertEqual(server.current_room["heartbeat_interval_seconds"], 30)
        self.assertEqual(server.current_room["heartbeat_timeout_seconds"], 90)
        self.assertIn("PEER1234", server.current_room["peers"])
        self.assertEqual(len(server.inbox), 1)
        self.assertEqual(server.inbox[0]["event"], "agent_online")
        self.assertEqual(server.inbox[0]["agent_id"], "PEER1234")

    def test_message_appends_message_to_inbox(self):
        server._handle_incoming(
            {
                "type": "message",
                "from_name": "peer-two",
                "from": "PEER5678",
                "content": "hello from another device",
                "msg_type": "text",
                "broadcast": True,
                "message_id": "ROOM42:7",
                "sequence": 7,
                "room_id": "ROOM42",
                "timestamp": "2026-03-07T00:00:00+00:00",
            }
        )

        self.assertEqual(len(server.inbox), 1)
        self.assertEqual(server.inbox[0]["from"], "peer-two")
        self.assertTrue(server.inbox[0]["broadcast"])
        self.assertEqual(server.inbox[0]["message_id"], "ROOM42:7")
        self.assertEqual(server.inbox[0]["sequence"], 7)
        self.assertEqual(server.current_room["last_sequence"], 7)

    def test_event_appends_room_event_to_inbox(self):
        server._handle_incoming(
            {
                "type": "event",
                "event": "agent_joined",
                "name": "peer-three",
                "agent_id": "PEER9999",
                "message_id": "ROOM42:8",
                "sequence": 8,
                "room_id": "ROOM42",
                "presence": "online",
                "joined_at": "2026-03-08T00:00:00+00:00",
                "last_seen_at": "2026-03-08T00:00:10+00:00",
                "timestamp": "2026-03-07T00:00:00+00:00",
            }
        )

        self.assertEqual(len(server.inbox), 1)
        self.assertEqual(server.inbox[0]["event"], "agent_joined")
        self.assertEqual(server.inbox[0]["from"], "peer-three")
        self.assertEqual(server.inbox[0]["message_id"], "ROOM42:8")
        self.assertEqual(server.current_room["last_sequence"], 8)
        self.assertEqual(server.current_room["peers"]["PEER9999"]["presence"], "online")

    def test_agent_left_event_removes_peer_from_snapshot(self):
        server.current_room["peers"] = {
            "PEER0001": {
                "agent_id": "PEER0001",
                "name": "peer-left",
                "presence": "online",
                "joined_at": "2026-03-08T00:00:00+00:00",
                "last_seen_at": "2026-03-08T00:00:10+00:00",
            }
        }

        server._handle_incoming(
            {
                "type": "event",
                "event": "agent_left",
                "name": "peer-left",
                "agent_id": "PEER0001",
                "message_id": "ROOM42:10",
                "sequence": 10,
                "room_id": "ROOM42",
                "presence": "offline",
                "timestamp": "2026-03-08T00:01:00+00:00",
            }
        )

        self.assertNotIn("PEER0001", server.current_room["peers"])

    def test_pong_updates_room_heartbeat_state(self):
        server._handle_incoming(
            {
                "type": "pong",
                "timestamp": "2026-03-08T00:01:00+00:00",
                "last_seen_at": "2026-03-08T00:01:00+00:00",
                "heartbeat_interval_seconds": 25,
                "heartbeat_timeout_seconds": 75,
            }
        )

        self.assertEqual(server.current_room["last_seen_at"], "2026-03-08T00:01:00+00:00")
        self.assertEqual(server.current_room["heartbeat_interval_seconds"], 25)
        self.assertEqual(server.current_room["heartbeat_timeout_seconds"], 75)
        self.assertIn("last_pong_monotonic", server.current_room)


class AckHandlingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_pending = dict(server.pending_acks)
        server.pending_acks.clear()

    def tearDown(self):
        server.pending_acks.clear()
        server.pending_acks.update(self.original_pending)

    async def test_ack_resolves_pending_future(self):
        future = asyncio.get_running_loop().create_future()
        server.pending_acks["REQ123"] = future

        server._handle_incoming(
            {
                "type": "ack",
                "request_id": "REQ123",
                "message_id": "ROOM42:9",
                "sequence": 9,
                "accepted": True,
                "delivered": True,
            }
        )

        result = await future
        self.assertEqual(result["message_id"], "ROOM42:9")
        self.assertTrue(result["delivered"])


class LocalInboxCacheTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_agent_id = server.agent_id
        self.original_inbox = list(server.inbox)
        self.original_current_room = server.current_room
        self.original_local_state_dir = server.local_state_dir
        self.original_ws_conn = server.ws_conn
        self.original_retry_replay_task = server.retry_replay_task
        self.original_pending = dict(server.pending_acks)
        self.original_await_ack = server._await_ack
        self.tempdir = tempfile.TemporaryDirectory()
        server.local_state_dir = Path(self.tempdir.name)
        server.agent_id = "LOCAL123"
        server.current_room = None
        server.ws_conn = None
        server.retry_replay_task = None
        server.pending_acks.clear()
        server.inbox.clear()

    def tearDown(self):
        server.agent_id = self.original_agent_id
        server.current_room = self.original_current_room
        server.inbox[:] = self.original_inbox
        server.local_state_dir = self.original_local_state_dir
        server.ws_conn = self.original_ws_conn
        server.retry_replay_task = self.original_retry_replay_task
        server.pending_acks.clear()
        server.pending_acks.update(self.original_pending)
        server._await_ack = self.original_await_ack
        self.tempdir.cleanup()

    def test_persist_and_restore_local_room_cache(self):
        server.current_room = {
            "room_id": "ROOM42",
            "last_sequence": 7,
            "last_read_sequence": 5,
            "retry_queue": [
                {
                    "retry_id": "retry-1",
                    "room_id": "ROOM42",
                    "action": "send",
                    "payload": {"type": "send", "to": "PEER0001", "content": "retry", "msg_type": "text"},
                    "created_at": "2026-03-09T00:00:00+00:00",
                    "updated_at": "2026-03-09T00:00:00+00:00",
                    "expires_at": "2026-03-09T06:00:00+00:00",
                    "attempts": 1,
                    "last_error": "offline",
                    "next_retry_at": "2026-03-09T00:00:05+00:00",
                }
            ],
        }
        server.inbox[:] = [
            {
                "type": "message",
                "from": "peer-one",
                "agent_id": "PEER0001",
                "content": "cached hello",
                "msg_type": "text",
                "broadcast": False,
                "message_id": "ROOM42:6",
                "sequence": 6,
                "room_id": "ROOM42",
                "timestamp": "2026-03-09T00:00:00+00:00",
            },
            {
                "type": "event",
                "event": "agent_joined",
                "from": "peer-two",
                "agent_id": "PEER0002",
                "message_id": "ROOM42:7",
                "sequence": 7,
                "room_id": "ROOM42",
                "timestamp": "2026-03-09T00:00:01+00:00",
            },
        ]

        server._persist_local_room_state()
        cache_path = server._room_cache_path("ROOM42")
        self.assertTrue(cache_path.exists())

        server.inbox[:] = []
        server.current_room = {"room_id": "ROOM42", "last_sequence": 9}
        server._restore_local_room_state("ROOM42")

        self.assertEqual(len(server.inbox), 2)
        self.assertEqual(server.current_room["last_read_sequence"], 5)
        self.assertEqual(server.current_room["local_cached_message_count"], 2)
        self.assertEqual(server.current_room["local_cached_last_sequence"], 7)
        self.assertTrue(server.current_room["local_cache_restored"])
        self.assertEqual(server.current_room["local_retry_queue_count"], 1)
        self.assertEqual(server.current_room["retry_queue"][0]["retry_id"], "retry-1")

    async def test_agent_read_inbox_updates_local_cursor(self):
        server.current_room = {
            "room_id": "ROOM42",
            "last_sequence": 3,
            "last_read_sequence": 2,
            "local_cache_path": str(server._room_cache_path("ROOM42")),
        }
        server.inbox[:] = [
            {
                "type": "message",
                "from": "peer-one",
                "agent_id": "PEER0001",
                "content": "msg-1",
                "msg_type": "text",
                "broadcast": False,
                "message_id": "ROOM42:1",
                "sequence": 1,
                "room_id": "ROOM42",
                "timestamp": "2026-03-09T00:00:00+00:00",
            },
            {
                "type": "message",
                "from": "peer-one",
                "agent_id": "PEER0001",
                "content": "msg-2",
                "msg_type": "text",
                "broadcast": False,
                "message_id": "ROOM42:2",
                "sequence": 2,
                "room_id": "ROOM42",
                "timestamp": "2026-03-09T00:00:01+00:00",
            },
            {
                "type": "message",
                "from": "peer-one",
                "agent_id": "PEER0001",
                "content": "msg-3",
                "msg_type": "text",
                "broadcast": False,
                "message_id": "ROOM42:3",
                "sequence": 3,
                "room_id": "ROOM42",
                "timestamp": "2026-03-09T00:00:02+00:00",
            },
        ]
        server._persist_local_room_state()

        payload = json.loads(
            await server.agent_read_inbox(
                server.ReadInboxInput(limit=10, only_unread=True, mark_read=True, clear=False)
            )
        )

        self.assertEqual(len(payload["messages"]), 1)
        self.assertEqual(payload["messages"][0]["sequence"], 3)
        self.assertEqual(payload["last_read_sequence"], 3)
        self.assertEqual(payload["unread_count"], 0)

        cached = json.loads(server._room_cache_path("ROOM42").read_text(encoding="utf-8"))
        self.assertEqual(cached["last_read_sequence"], 3)

    async def test_agent_read_inbox_clear_updates_local_cache(self):
        server.current_room = {
            "room_id": "ROOM42",
            "last_sequence": 2,
            "last_read_sequence": 0,
            "local_cache_path": str(server._room_cache_path("ROOM42")),
        }
        server.inbox[:] = [
            {
                "type": "message",
                "from": "peer-one",
                "agent_id": "PEER0001",
                "content": "msg-1",
                "msg_type": "text",
                "broadcast": False,
                "message_id": "ROOM42:1",
                "sequence": 1,
                "room_id": "ROOM42",
                "timestamp": "2026-03-09T00:00:00+00:00",
            },
            {
                "type": "message",
                "from": "peer-one",
                "agent_id": "PEER0001",
                "content": "msg-2",
                "msg_type": "text",
                "broadcast": False,
                "message_id": "ROOM42:2",
                "sequence": 2,
                "room_id": "ROOM42",
                "timestamp": "2026-03-09T00:00:01+00:00",
            },
        ]

        payload = json.loads(
            await server.agent_read_inbox(
                server.ReadInboxInput(limit=10, only_unread=False, mark_read=True, clear=True)
            )
        )

        self.assertEqual(payload["count"], 2)
        self.assertEqual(payload["last_read_sequence"], 2)
        self.assertEqual(payload["total_in_inbox"], 0)

        cached = json.loads(server._room_cache_path("ROOM42").read_text(encoding="utf-8"))
        self.assertEqual(cached["messages"], [])
        self.assertEqual(cached["last_read_sequence"], 2)

    async def test_agent_send_queues_when_disconnected(self):
        server.current_room = {
            "room_id": "ROOM42",
            "last_sequence": 0,
            "last_read_sequence": 0,
            "retry_queue": [],
        }
        server.ws_conn = None

        payload = json.loads(
            await server.agent_send(
                server.SendInput(peer_id="PEER0001", message="queued", msg_type="text")
            )
        )

        self.assertFalse(payload["success"])
        self.assertTrue(payload["queued_for_retry"])
        self.assertEqual(payload["retry_queue_count"], 1)
        self.assertEqual(server.current_room["retry_queue"][0]["action"], "send")
        self.assertEqual(server.current_room["retry_queue"][0]["payload"]["to"], "PEER0001")

    async def test_agent_send_queues_when_not_delivered(self):
        async def fake_await_ack(payload, timeout=5.0):
            return "REQ123", {
                "accepted": False,
                "delivered": False,
                "recipient_count": 0,
                "message_id": None,
                "sequence": None,
            }

        server._await_ack = fake_await_ack
        server.current_room = {
            "room_id": "ROOM42",
            "last_sequence": 0,
            "last_read_sequence": 0,
            "retry_queue": [],
        }
        server.ws_conn = object()

        payload = json.loads(
            await server.agent_send(
                server.SendInput(peer_id="PEER0001", message="queued", msg_type="text")
            )
        )

        self.assertFalse(payload["success"])
        self.assertTrue(payload["queued_for_retry"])
        self.assertEqual(server.current_room["local_retry_queue_count"], 1)

    async def test_replay_retry_queue_removes_successful_entry(self):
        async def fake_await_ack(payload, timeout=5.0):
            return "REQ123", {
                "accepted": True,
                "delivered": True,
                "recipient_count": 1,
                "message_id": "ROOM42:4",
                "sequence": 4,
            }

        server._await_ack = fake_await_ack
        server.current_room = {
            "room_id": "ROOM42",
            "last_sequence": 3,
            "last_read_sequence": 0,
            "retry_queue": [
                {
                    "retry_id": "retry-1",
                    "room_id": "ROOM42",
                    "action": "send",
                    "payload": {"type": "send", "to": "PEER0001", "content": "retry", "msg_type": "text"},
                    "created_at": "2000-01-01T00:00:00+00:00",
                    "updated_at": "2000-01-01T00:00:00+00:00",
                    "expires_at": "2099-03-09T06:00:00+00:00",
                    "attempts": 0,
                    "last_error": "offline",
                    "next_retry_at": "2000-01-01T00:00:00+00:00",
                }
            ],
        }
        server.ws_conn = object()

        await server._replay_retry_queue()

        self.assertEqual(server.current_room["retry_queue"], [])
        self.assertEqual(server.current_room["local_retry_queue_count"], 0)


if __name__ == "__main__":
    unittest.main()
