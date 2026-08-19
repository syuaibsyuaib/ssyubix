export const ROOM_ROLE_LABEL_VALUES = ["owner", "admin", "member"] as const;

export type RoomRoleLabel = typeof ROOM_ROLE_LABEL_VALUES[number];

export interface StoredRoomRoleState {
  owner_stable_identity_id?: string;
  admin_stable_identity_ids: string[];
}

export interface RoomAdminMutationResult {
  ok: boolean;
  changed: boolean;
  role_state: StoredRoomRoleState;
  error?: string;
}

function sanitizeStableIdentityId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) {
    return undefined;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)
    ? normalized
    : undefined;
}

function sanitizeStableIdentityIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const normalized = sanitizeStableIdentityId(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    items.push(normalized);
  }
  return items;
}

export function normalizeRoomRoleState(
  input: Partial<StoredRoomRoleState> | undefined,
): StoredRoomRoleState {
  const owner = sanitizeStableIdentityId(input?.owner_stable_identity_id);
  const admins = sanitizeStableIdentityIds(input?.admin_stable_identity_ids).filter(
    (entry) => entry !== owner,
  );
  return {
    owner_stable_identity_id: owner,
    admin_stable_identity_ids: admins,
  };
}

export function resolveRoomRoleLabel(
  roleState: Partial<StoredRoomRoleState> | undefined,
  stableAgentIdentityId: unknown,
): RoomRoleLabel {
  const normalizedState = normalizeRoomRoleState(roleState);
  const stableIdentityId = sanitizeStableIdentityId(stableAgentIdentityId);
  if (
    stableIdentityId
    && normalizedState.owner_stable_identity_id === stableIdentityId
  ) {
    return "owner";
  }
  if (
    stableIdentityId
    && normalizedState.admin_stable_identity_ids.includes(stableIdentityId)
  ) {
    return "admin";
  }
  return "member";
}

export function grantRoomAdmin(
  roleState: Partial<StoredRoomRoleState> | undefined,
  params: {
    actorStableIdentityId: unknown;
    targetStableIdentityId: unknown;
  },
): RoomAdminMutationResult {
  const normalizedState = normalizeRoomRoleState(roleState);
  const actorStableIdentityId = sanitizeStableIdentityId(
    params.actorStableIdentityId,
  );
  const targetStableIdentityId = sanitizeStableIdentityId(
    params.targetStableIdentityId,
  );

  if (!normalizedState.owner_stable_identity_id) {
    return {
      ok: false,
      changed: false,
      role_state: normalizedState,
      error: "The room has no valid owner yet.",
    };
  }
  if (!actorStableIdentityId) {
    return {
      ok: false,
      changed: false,
      role_state: normalizedState,
      error: "The actor's stable identity is invalid.",
    };
  }
  if (actorStableIdentityId !== normalizedState.owner_stable_identity_id) {
    return {
      ok: false,
      changed: false,
      role_state: normalizedState,
      error: "Only the owner may grant admin.",
    };
  }
  if (!targetStableIdentityId) {
    return {
      ok: false,
      changed: false,
      role_state: normalizedState,
      error: "The target's stable identity is invalid.",
    };
  }
  if (targetStableIdentityId === normalizedState.owner_stable_identity_id) {
    return {
      ok: true,
      changed: false,
      role_state: normalizedState,
    };
  }
  if (normalizedState.admin_stable_identity_ids.includes(targetStableIdentityId)) {
    return {
      ok: true,
      changed: false,
      role_state: normalizedState,
    };
  }

  const nextState = normalizeRoomRoleState({
    owner_stable_identity_id: normalizedState.owner_stable_identity_id,
    admin_stable_identity_ids: [
      ...normalizedState.admin_stable_identity_ids,
      targetStableIdentityId,
    ],
  });
  return {
    ok: true,
    changed: true,
    role_state: nextState,
  };
}

export function revokeRoomAdmin(
  roleState: Partial<StoredRoomRoleState> | undefined,
  params: {
    actorStableIdentityId: unknown;
    targetStableIdentityId: unknown;
  },
): RoomAdminMutationResult {
  const normalizedState = normalizeRoomRoleState(roleState);
  const actorStableIdentityId = sanitizeStableIdentityId(
    params.actorStableIdentityId,
  );
  const targetStableIdentityId = sanitizeStableIdentityId(
    params.targetStableIdentityId,
  );

  if (!normalizedState.owner_stable_identity_id) {
    return {
      ok: false,
      changed: false,
      role_state: normalizedState,
      error: "The room has no valid owner yet.",
    };
  }
  if (!actorStableIdentityId) {
    return {
      ok: false,
      changed: false,
      role_state: normalizedState,
      error: "The actor's stable identity is invalid.",
    };
  }
  if (actorStableIdentityId !== normalizedState.owner_stable_identity_id) {
    return {
      ok: false,
      changed: false,
      role_state: normalizedState,
      error: "Only the owner may revoke admin.",
    };
  }
  if (!targetStableIdentityId) {
    return {
      ok: false,
      changed: false,
      role_state: normalizedState,
      error: "The target's stable identity is invalid.",
    };
  }
  if (targetStableIdentityId === normalizedState.owner_stable_identity_id) {
    return {
      ok: false,
      changed: false,
      role_state: normalizedState,
      error: "The owner cannot be stripped of the owner role through revoke admin.",
    };
  }
  if (!normalizedState.admin_stable_identity_ids.includes(targetStableIdentityId)) {
    return {
      ok: true,
      changed: false,
      role_state: normalizedState,
    };
  }

  const nextState = normalizeRoomRoleState({
    owner_stable_identity_id: normalizedState.owner_stable_identity_id,
    admin_stable_identity_ids:
      normalizedState.admin_stable_identity_ids.filter(
        (entry) => entry !== targetStableIdentityId,
      ),
  });
  return {
    ok: true,
    changed: true,
    role_state: nextState,
  };
}
