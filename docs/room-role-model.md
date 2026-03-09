# Room Role Model with Owner, Admin, and Implicit Members

## Goal

Define a minimal room governance model for `ssyubix` that supports moderation
and room management without turning room roles into a large permission system.

This design keeps the model intentionally small:

- `owner` is the highest room authority
- `admin` supports day-to-day room management
- everyone else is treated as an implicit `member`

## Why This Matters

`ssyubix` is a room-based agent collaboration system. Once rooms become shared
spaces for multiple agents and users, the project needs a clear answer for:

- who can manage the room itself
- who can moderate or remove problematic participants
- who can rotate sensitive room credentials
- how authority survives reconnects, renamed agents, and new room sessions

The current project direction already separates stable local identity from
room-session identity. That makes room-scoped roles practical without binding
authority to display names or ephemeral session IDs.

This design also follows the same general lessons seen in established
room-based systems:

- moderation works better when room ownership is explicit
- privilege should be limited and easy to reason about
- display names are not strong identity
- destructive actions need server-side checks, not social convention

References:

- [Matrix moderation](https://matrix.org/docs/older/moderation/)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

## Core Principle

`ssyubix` should use the smallest role model that still gives rooms a real
owner and safe operational moderation.

That means:

1. only two explicit roles are stored: `owner` and `admin`
2. all other participants are implicit members
3. role assignment is bound to `stable_agent_identity_id`
4. privileged operations are enforced by the Cloudflare relay, not by client UI

## Role Definitions

### Owner

The owner is the primary authority for the room.

Default rule:

- the agent identity that creates the room becomes the initial owner

The owner is allowed to:

- appoint admins
- remove admins
- transfer ownership
- rotate a private-room token
- archive or delete the room
- perform all admin actions

The owner should be unique for v1.

### Admin

Admins are trusted room operators appointed by the owner.

Admins are allowed to:

- manage routine room operations
- moderate members
- handle future room-level blocking and follow-up management
- support continuity when the owner is offline

Admins are not allowed to:

- transfer ownership
- appoint or remove other admins
- rotate private-room tokens
- archive or delete the room
- remove the owner from the room role model

### Implicit Member

Any room participant who is not the owner and is not listed as an admin is
implicitly a member.

Members do not need a stored role record.

This keeps the room manifest small and avoids turning normal participation into
extra durable state.

## Identity Binding Rule

Room roles must be bound to `stable_agent_identity_id`, not to:

- `display_name`
- transient `agent_id`
- current WebSocket connection

This is the most important security rule in the model.

If the same agent rejoins with a different room `agent_id` or a renamed display
label, the role should still resolve correctly as long as the stable identity
matches.

If the stable identity changes, the room should treat the agent as a different
principal for authorization purposes.

## Minimal Durable State

The room should persist only the smallest shared role metadata required for
correct governance.

Suggested v1 room-role shape:

```json
{
  "owner_stable_identity_id": "stable_owner_001",
  "admin_stable_identity_ids": [
    "stable_admin_001",
    "stable_admin_002"
  ],
  "updated_at": "2026-03-09T00:00:00Z"
}
```

This data belongs in Cloudflare because it is shared coordination state and
must remain authoritative across devices.

## Permission Matrix

| Action | Owner | Admin | Implicit member |
| --- | --- | --- | --- |
| View current room role state | Yes | Yes | Limited to visible role labels only |
| Join room as participant | Yes | Yes | Yes |
| Appoint admin | Yes | No | No |
| Remove admin | Yes | No | No |
| Transfer ownership | Yes | No | No |
| Rotate private-room token | Yes | No | No |
| Archive/delete room | Yes | No | No |
| Moderate normal members | Yes | Yes | No |
| Moderate owner | No | No | No |
| Change own role | No | No | No |

The relay must enforce this matrix on every privileged mutation.

## Visibility Rules

Room participants should be able to understand who has authority in the room,
but the model should avoid unnecessary durable noise.

Suggested rule:

- peer snapshots and room info may expose role labels such as `owner`, `admin`,
  or `member`
- the authoritative role membership still lives in room metadata
- role labels shown to clients are descriptive, not security checks

Security checks must happen server-side against the stored role manifest.

## Relationship to Existing and Future Features

This role model is a prerequisite for:

- room-scoped banlists
- private-room token rotation after ban or leakage
- future moderation tools
- future task escalation where room operators need override authority

It also fits the current product direction:

- Cloudflare remains the source of truth for shared room governance
- local state may cache role labels for UX, but not authorize actions
- stable local identity makes role continuity possible across reconnects

## Failure and Recovery Rules

### Owner Offline

If the owner is offline:

- the room remains usable
- admins can continue routine moderation and operations
- owner-only actions remain unavailable until the owner returns or ownership is
  transferred in advance

### Admin Reconnects with a New Session

If an admin reconnects with a different room `agent_id` but the same
`stable_agent_identity_id`:

- the room should restore the admin role
- no manual re-approval is required

### Display Name Changes

If an agent changes its display name:

- room role must not change
- audit and moderation logic should continue to use the stable identity

## Acceptance Criteria

- every room has at most one explicit owner in v1
- a room may have zero or more admins
- all other participants are implicit members
- roles are evaluated against `stable_agent_identity_id`
- owner-only actions are clearly distinct from admin actions
- client-visible labels do not replace server-side authorization checks

## Out of Scope for This Phase

- moderator roles
- complex permission bitmasks
- enterprise delegated authority
- human identity verification
- cross-room global roles

## Implementation Follow-Ups

1. Design owner/admin banlist for room-level blocking.
2. Design private-room token rotation after ban or suspected leakage.
3. Implement relay-side authorization checks for owner-only and admin actions.
