import unittest

from agentlink_mcp import server


class HandleIncomingTests(unittest.TestCase):
    def setUp(self):
        self.original_agent_id = server.agent_id
        self.original_inbox = list(server.inbox)
        server.agent_id = None
        server.inbox.clear()

    def tearDown(self):
        server.agent_id = self.original_agent_id
        server.inbox[:] = self.original_inbox

    def test_welcome_updates_agent_id_and_tracks_existing_agents(self):
        server._handle_incoming(
            {
                "type": "welcome",
                "agent_id": "LOCAL123",
                "agents": [{"name": "peer-one", "agent_id": "PEER1234"}],
            }
        )

        self.assertEqual(server.agent_id, "LOCAL123")
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
                "timestamp": "2026-03-07T00:00:00+00:00",
            }
        )

        self.assertEqual(len(server.inbox), 1)
        self.assertEqual(server.inbox[0]["from"], "peer-two")
        self.assertTrue(server.inbox[0]["broadcast"])

    def test_event_appends_room_event_to_inbox(self):
        server._handle_incoming(
            {
                "type": "event",
                "event": "agent_joined",
                "name": "peer-three",
                "agent_id": "PEER9999",
                "timestamp": "2026-03-07T00:00:00+00:00",
            }
        )

        self.assertEqual(len(server.inbox), 1)
        self.assertEqual(server.inbox[0]["event"], "agent_joined")
        self.assertEqual(server.inbox[0]["from"], "peer-three")


if __name__ == "__main__":
    unittest.main()
