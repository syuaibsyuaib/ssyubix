import test from "node:test";
import assert from "node:assert/strict";

import {
  grantRoomAdmin,
  hasRoomPower,
  normalizeRoomRoleState,
  resolveRoomPowers,
  resolveRoomRoleLabel,
  revokeRoomAdmin,
  ROOM_POWER_VALUES,
} from "./room-roles";

const OWNER = "stable-owner-1";

test("normalizeRoomRoleState removes duplicate admins and owner duplicates", () => {
  const roleState = normalizeRoomRoleState({
    owner_stable_identity_id: "stable-owner-1",
    admin_stable_identity_ids: [
      "stable-owner-1",
      "stable-admin-1",
      "stable-admin-1",
      "stable-admin-2",
    ],
  });

  assert.equal(roleState.owner_stable_identity_id, "stable-owner-1");
  assert.deepEqual(roleState.admin_stable_identity_ids, [
    "stable-admin-1",
    "stable-admin-2",
  ]);
});

test("resolveRoomRoleLabel maps owner, admin, and member correctly", () => {
  const roleState = normalizeRoomRoleState({
    owner_stable_identity_id: "stable-owner-1",
    admin_stable_identity_ids: ["stable-admin-1"],
  });

  assert.equal(resolveRoomRoleLabel(roleState, "stable-owner-1"), "owner");
  assert.equal(resolveRoomRoleLabel(roleState, "stable-admin-1"), "admin");
  assert.equal(resolveRoomRoleLabel(roleState, "stable-member-1"), "member");
});

test("grantRoomAdmin requires the owner as actor", () => {
  const result = grantRoomAdmin(
    {
      owner_stable_identity_id: "stable-owner-1",
      admin_stable_identity_ids: [],
    },
    {
      actorStableIdentityId: "stable-member-1",
      targetStableIdentityId: "stable-admin-1",
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /requires the grant_admin power/);
});

test("grantRoomAdmin adds a new admin once", () => {
  const result = grantRoomAdmin(
    {
      owner_stable_identity_id: "stable-owner-1",
      admin_stable_identity_ids: [],
    },
    {
      actorStableIdentityId: "stable-owner-1",
      targetStableIdentityId: "stable-admin-1",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.role_state.admin_stable_identity_ids, ["stable-admin-1"]);
});

test("revokeRoomAdmin rejects attempts to revoke the owner", () => {
  const result = revokeRoomAdmin(
    {
      owner_stable_identity_id: "stable-owner-1",
      admin_stable_identity_ids: ["stable-admin-1"],
    },
    {
      actorStableIdentityId: "stable-owner-1",
      targetStableIdentityId: "stable-owner-1",
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /owner cannot be stripped/);
});

test("revokeRoomAdmin removes an admin for the owner", () => {
  const result = revokeRoomAdmin(
    {
      owner_stable_identity_id: "stable-owner-1",
      admin_stable_identity_ids: ["stable-admin-1", "stable-admin-2"],
    },
    {
      actorStableIdentityId: "stable-owner-1",
      targetStableIdentityId: "stable-admin-2",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.role_state.admin_stable_identity_ids, ["stable-admin-1"]);
});

test("the owner holds every power without being listed as an admin", () => {
  const state = { owner_stable_identity_id: OWNER, admin_stable_identity_ids: [] };

  assert.deepEqual(resolveRoomPowers(state, OWNER), [...ROOM_POWER_VALUES]);
  assert.equal(resolveRoomRoleLabel(state, OWNER), "owner");
});

test("an admin carried over from an older room has no powers", () => {
  // Sebelum kuasa granular ada, label admin tidak memberi wewenang apa pun.
  // Upgrade tidak boleh diam-diam menaikkan wewenang admin lama.
  const legacy = {
    owner_stable_identity_id: OWNER,
    admin_stable_identity_ids: ["stable-admin-1"],
  };

  assert.equal(resolveRoomRoleLabel(legacy, "stable-admin-1"), "admin");
  assert.deepEqual(resolveRoomPowers(legacy, "stable-admin-1"), []);
});

test("granting without an explicit list passes on everything the actor holds", () => {
  const result = grantRoomAdmin(
    { owner_stable_identity_id: OWNER, admin_stable_identity_ids: [] },
    { actorStableIdentityId: OWNER, targetStableIdentityId: "stable-admin-1" },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    resolveRoomPowers(result.role_state, "stable-admin-1"),
    [...ROOM_POWER_VALUES],
  );
});

test("the owner can hand over only part of the powers", () => {
  const result = grantRoomAdmin(
    { owner_stable_identity_id: OWNER, admin_stable_identity_ids: [] },
    {
      actorStableIdentityId: OWNER,
      targetStableIdentityId: "stable-admin-1",
      powers: ["grant_admin"],
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(resolveRoomPowers(result.role_state, "stable-admin-1"), ["grant_admin"]);
  assert.equal(hasRoomPower(result.role_state, "stable-admin-1", "revoke_admin"), false);
});

test("an admin holding grant_admin can appoint another admin", () => {
  const state = {
    owner_stable_identity_id: OWNER,
    admin_stable_identity_ids: ["stable-admin-1"],
    admin_powers: { "stable-admin-1": ["grant_admin" as const] },
  };

  const result = grantRoomAdmin(state, {
    actorStableIdentityId: "stable-admin-1",
    targetStableIdentityId: "stable-admin-2",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(resolveRoomPowers(result.role_state, "stable-admin-2"), ["grant_admin"]);
});

test("an admin cannot pass on a power it does not hold", () => {
  // Tanpa aturan ini, admin bisa menaikkan wewenangnya lewat perantara.
  const state = {
    owner_stable_identity_id: OWNER,
    admin_stable_identity_ids: ["stable-admin-1"],
    admin_powers: { "stable-admin-1": ["grant_admin" as const] },
  };

  const result = grantRoomAdmin(state, {
    actorStableIdentityId: "stable-admin-1",
    targetStableIdentityId: "stable-admin-2",
    powers: ["grant_admin", "revoke_admin"],
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /does not hold: revoke_admin/);
});

test("an admin without revoke_admin cannot remove anyone", () => {
  const state = {
    owner_stable_identity_id: OWNER,
    admin_stable_identity_ids: ["stable-admin-1", "stable-admin-2"],
    admin_powers: { "stable-admin-1": ["grant_admin" as const] },
  };

  const result = revokeRoomAdmin(state, {
    actorStableIdentityId: "stable-admin-1",
    targetStableIdentityId: "stable-admin-2",
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /requires the revoke_admin power/);
});

test("an admin holding revoke_admin can remove another admin, but never the owner", () => {
  const state = {
    owner_stable_identity_id: OWNER,
    admin_stable_identity_ids: ["stable-admin-1", "stable-admin-2"],
    admin_powers: {
      "stable-admin-1": ["revoke_admin" as const],
      "stable-admin-2": ["grant_admin" as const],
    },
  };

  const removed = revokeRoomAdmin(state, {
    actorStableIdentityId: "stable-admin-1",
    targetStableIdentityId: "stable-admin-2",
  });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.role_state.admin_stable_identity_ids, ["stable-admin-1"]);
  // Kuasa ikut terhapus, tidak menggantung untuk hidup lagi diam-diam.
  assert.deepEqual(resolveRoomPowers(removed.role_state, "stable-admin-2"), []);

  const atOwner = revokeRoomAdmin(state, {
    actorStableIdentityId: "stable-admin-1",
    targetStableIdentityId: OWNER,
  });
  assert.equal(atOwner.ok, false);
});

test("unknown power names are discarded rather than stored", () => {
  const result = grantRoomAdmin(
    { owner_stable_identity_id: OWNER, admin_stable_identity_ids: [] },
    {
      actorStableIdentityId: OWNER,
      targetStableIdentityId: "stable-admin-1",
      powers: ["grant_admin", "delete_everything"],
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(resolveRoomPowers(result.role_state, "stable-admin-1"), ["grant_admin"]);
});
