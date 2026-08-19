import test from "node:test";
import assert from "node:assert/strict";

import {
  grantRoomAdmin,
  normalizeRoomRoleState,
  resolveRoomRoleLabel,
  revokeRoomAdmin,
} from "./room-roles";

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
  assert.match(result.error ?? "", /Only the owner may grant admin/);
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
