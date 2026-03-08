import unittest
import asyncio

from agentlink_mcp import server


class HandleIncomingTests(unittest.TestCase):
    def setUp(self):
        self.original_agent_id = server.agent_id
        self.original_inbox = list(server.inbox)
        self.original_current_room = server.current_room
        server.agent_id = None
        server.current_room = {"room_id": "ROOM42", "last_sequence": 0}
        server.inbox.clear()

    def tearDown(self):
        server.agent_id = self.original_agent_id
        server.current_room = self.original_current_room
        server.inbox[:] = self.original_inbox

    def test_welcome_updates_agent_id_and_tracks_existing_agents(self):
        server._handle_incoming(
            {
                "type": "welcome",
                "agent_id": "LOCAL123",
                "last_sequence": 4,
                "agents": [{"name": "peer-one", "agent_id": "PEER1234"}],
            }
        )

        self.assertEqual(server.agent_id, "LOCAL123")
        self.assertEqual(server.current_room["last_sequence"], 4)
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
                "timestamp": "2026-03-07T00:00:00+00:00",
            }
        )

        self.assertEqual(len(server.inbox), 1)
        self.assertEqual(server.inbox[0]["event"], "agent_joined")
        self.assertEqual(server.inbox[0]["from"], "peer-three")
        self.assertEqual(server.inbox[0]["message_id"], "ROOM42:8")
        self.assertEqual(server.current_room["last_sequence"], 8)


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


if __name__ == "__main__":
    unittest.main()
