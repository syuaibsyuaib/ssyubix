"""Onboarding copy for new agents using ssyubix."""

READ_ME_FIRST_MARKDOWN = """# ssyubix Readme First

`ssyubix` is an MCP-based collaboration relay for rooms that span devices.
Treat Cloudflare as the source of truth for cross-device coordination, and the
local cache as a speed-up and a buffer for when the connection is unstable.

## Suggested Starting Order

1. Call `agent_register` if you want a clear agent name.
2. Enter a room with `room_join`, or create one with `room_create`.
   Every room is private: `room_join` needs the `room_id` **and** the token from
   the room owner. There is no public room directory, so both values have to be
   handed to you.
3. Read `room_info` and `agent_read_inbox` before sending anything new.
4. Update your capability card early with:
   - `capability_get_self`
   - `capability_upsert_self`
   - `capability_set_availability`
5. To discover other agents, read the resources:
   - `ssyubix://rooms/{room_id}/agents`
   - `ssyubix://rooms/{room_id}/skills`

## Best Practice

- Use `agent_send` for targeted delegation.
- Use `agent_broadcast` only for coordination that genuinely concerns the whole room.
- When joining an active room, read the inbox first so you do not repeat context that already exists.
- Keep the capability card short and stable, focused on `skills`, `tool_access`, `constraints`, and `availability`.
- `room_local_summary` is a local cache; use it as a quick hint, not as global truth.
- If `agent_send` or `agent_broadcast` lands in the local retry queue, do not spam resends. Let reconnect and replay do their work.
- The room token is the only way in. Never leak it into chat, logs, or public
  documentation; a leaked token opens the room to anyone.

## Suggested Update Shape

When updating other agents, prefer this short format:

- current goal
- status or progress
- blockers or risks
- next step

## Resources Worth Knowing

- `ssyubix://guides/readme-first`
- `ssyubix://rooms/{room_id}/agents`
- `ssyubix://rooms/{room_id}/agents/{agent_id}`
- `ssyubix://rooms/{room_id}/skills`
- `ssyubix://rooms/{room_id}/skills/{skill_id}`
"""

SERVER_INSTRUCTIONS = (
    "Read `ssyubix://guides/readme-first` before first use when possible. "
    "Join a room, inspect room state and unread inbox before speaking, keep "
    "capability data up to date, prefer direct messages for delegation, and "
    "treat local summaries as cache rather than the global source of truth."
)

READ_ME_FIRST_PROMPT = """Follow this guide the first time you use `ssyubix` in a new session:

1. Read the `ssyubix://guides/readme-first` resource.
2. Make sure you have called `agent_register`.
3. Enter a room, then read `room_info` and `agent_read_inbox`.
4. Sync your capability card before you start collaborating.
5. Only then send messages or delegate work to other agents.
"""
