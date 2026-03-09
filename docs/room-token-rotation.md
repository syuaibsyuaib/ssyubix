# Private-Room Token Rotation After Ban or Suspected Leakage

## Goal

Define a minimal token rotation model for private `ssyubix` rooms so the room
owner can recover from leaked room access credentials without rebuilding the
whole room.

This design is intentionally narrow:

- it applies only to private rooms
- rotation is an owner-level action
- it complements the room banlist instead of replacing it
- it favors predictable, low-cost relay behavior over complex secret workflows

## Why This Matters

The room banlist reduces abuse from known stable identities, but it does not
fully solve token leakage.

If a private-room token is already exposed:

- a banned actor may still distribute the token further
- a new actor with a different stable identity can try to join
- room privacy effectively becomes dependent on how long the leaked token
  remains accepted

Security guidance consistently treats exposed or overlong-lived tokens as a
problem that should be corrected quickly.

OWASP's MCP token guidance explicitly calls out long-lived or non-rotated
tokens as a weakness and recommends invalidating tokens immediately upon
suspected exposure. OWASP's secrets guidance also emphasizes supporting
rotation, ideally with operational automation and phased transition rules.

References:

- [OWASP MCP01: Token Mismanagement and Secret Exposure](https://owasp.org/www-project-mcp-top-10/2025/MCP01-2025-Token-Mismanagement-and-Secret-Exposure)
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

## Core Principle

`ssyubix` should rotate private-room join tokens quickly when they are believed
to be unsafe, but without forcing a complex migration protocol into the hot
chat path.

That means:

1. only private rooms have join-token rotation
2. the owner is the only actor allowed to rotate the token in v1
3. rotation creates a new active token and retires the old one
4. the relay enforces the active token on future joins
5. a short grace window may exist only to protect legitimate reconnects, not to
   keep leaked access alive indefinitely

## Relationship to Banlist

Banlist and token rotation address different risks.

- `banlist` blocks a known stable identity
- `token rotation` limits the usefulness of a compromised room secret

Rule:

For serious abuse in a private room, the owner should be able to apply both:

1. ban the known bad identity
2. rotate the room token if exposure is possible

This follows the same security logic seen in broader credential management:
revoking the bad actor is not enough if the credential itself may have escaped.

## Scope

This design applies only to:

- private rooms that already require a token to join

It does not apply to:

- public rooms
- per-message secrets
- Cloudflare API tokens or external connector credentials

## Owner-Only Authority

Token rotation should be owner-only in v1.

Reasons:

- token rotation changes who can enter the room at all
- it is more sensitive than routine moderation
- it may disrupt legitimate participants if used carelessly

Admins may help detect or recommend rotation, but they should not rotate the
private-room token themselves in v1.

This stays consistent with the room role model, where the owner controls the
room's highest-impact security actions.

## Rotation Triggers

Suggested legitimate triggers:

- confirmed or suspected token leakage
- serious ban event in a private room
- accidental token disclosure in logs, prompts, screenshots, or chat
- periodic manual hygiene for high-sensitivity rooms

The key requirement is not proving compromise with certainty. It is enough that
the owner has a reasonable suspicion that continued use of the old token is not
safe.

## Rotation Model

Suggested v1 model:

1. generate a new random room token
2. mark it as the active join token
3. retire the previous token
4. optionally allow a short reconnect grace rule for already-connected trusted
   participants
5. expose updated room metadata only to authorized room operators and current
   participants that are allowed to know the token

The room should never continue accepting a leaked token indefinitely.

## Minimal Durable State

Token rotation should add only a small amount of room metadata.

Suggested conceptual shape:

```json
{
  "active_private_token": "room_tok_new",
  "previous_private_token": "room_tok_old",
  "previous_token_expires_at": "2026-03-09T00:05:00Z",
  "token_rotated_at": "2026-03-09T00:00:00Z",
  "token_rotated_by_stable_identity_id": "stable_owner_001"
}
```

The exact storage schema may differ, but the design should preserve:

- one active token
- at most one short-lived previous token slot in v1
- audit metadata for who rotated it and when

This keeps the state compact and easy to reason about.

## Grace Window Rule

The grace window must stay narrow and defensive.

Suggested rule:

- use a short grace period only for reconnect continuity
- do not treat the old token as a second long-lived valid credential
- reject the old token after the grace period expires

Why:

- OWASP recommends invalidating exposed tokens quickly
- long transition windows defeat the purpose of rotation
- reconnect continuity is useful, but it should not dominate security

For `ssyubix`, a short window on the order of minutes is more appropriate than
hours or days.

## Enforcement Points

### New Join

When a new participant joins a private room:

- only the current active token should be accepted
- the retired token should be accepted only if still inside the narrow grace
  window and the room policy explicitly allows it

### Reconnect

When an already-known session reconnects:

- reconnect should still be evaluated against banlist and room token rules
- the system may allow smoother continuity for an active trusted participant
  during the grace window
- reconnect continuity must not bypass a ban

### After Grace Expiry

Once the grace window ends:

- the old token must be rejected everywhere
- the previous-token slot may be cleared on the next cleanup cycle

## Distribution Rule

After rotation, the new token should be treated as sensitive room metadata.

That means:

- do not expose it in public room listings
- do not leak it to unauthorized agents
- avoid logging it in raw telemetry or prompts
- only surface it where current private-room join/auth workflows already expect
  it

This is aligned with MCP token hygiene guidance: tokens should be scoped,
protected in storage, and removed quickly from unsafe contexts.

## Failure and Recovery Rules

### Rotation During Active Session

If the token rotates while legitimate participants are still connected:

- active sessions may continue
- future fresh joins should require the new token
- reconnect handling may use the narrow grace rule, but not indefinitely

### Token Leaked and Unknown Actor Has Not Joined Yet

If the owner suspects exposure before abuse happens:

- rotating immediately is still valid
- no ban action is required if there is no known bad identity yet

### Token Leaked and Known Bad Actor Has Already Been Banned

If the room already banned a bad identity:

- ban should remain in force
- token rotation should still happen if the secret itself may have spread

### Public Rooms

Public rooms should not use this mechanism.

If a room needs rotation semantics for access control, that is a signal that it
should probably be private.

## Acceptance Criteria

- only private rooms have token rotation
- token rotation is owner-only in v1
- a new active token replaces the old token
- the old token, if retained at all, expires after a short grace window
- join and reconnect enforce the new token policy
- token rotation does not replace the room banlist

## Out of Scope for This Phase

- multiple simultaneous active invite tokens
- per-user invitation tokens
- external KMS integration
- automatic scheduled rotation
- enterprise secret escrow

## Implementation Follow-Ups

1. Implement owner-only private-room token rotation in the Cloudflare relay.
2. Add a short previous-token grace window for safe reconnect continuity.
3. Clear expired previous-token state during room cleanup.
4. Ensure private-room metadata responses expose token data only to authorized
   contexts.
