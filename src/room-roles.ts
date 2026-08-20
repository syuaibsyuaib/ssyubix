export const ROOM_ROLE_LABEL_VALUES = ["owner", "admin", "member"] as const;

export type RoomRoleLabel = typeof ROOM_ROLE_LABEL_VALUES[number];

/**
 * Kuasa yang bisa didelegasikan owner ke admin, atau admin ke admin lain.
 *
 * Sengaja daftar terbuka: fitur seperti ban, kick, dan rotasi token yang sudah
 * dirancang di `docs/` tinggal menambah nilai di sini tanpa mengubah bentuk
 * penyimpanan maupun aturan delegasinya.
 */
export const ROOM_POWER_VALUES = ["grant_admin", "revoke_admin"] as const;

export type RoomPower = typeof ROOM_POWER_VALUES[number];

export interface StoredRoomRoleState {
  owner_stable_identity_id?: string;
  admin_stable_identity_ids: string[];
  /**
   * Kuasa per admin. Admin yang tidak punya entri di sini tidak punya kuasa apa
   * pun — itu tepat menggambarkan admin dari room lama, yang label-nya memang
   * tidak pernah memberi wewenang apa-apa. Upgrade tidak boleh diam-diam
   * menaikkan wewenang siapa pun.
   */
  admin_powers?: Record<string, RoomPower[]>;
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

export function sanitizeRoomPowers(value: unknown): RoomPower[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const allowed = new Set<string>(ROOM_POWER_VALUES);
  const powers: RoomPower[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && allowed.has(entry) && !powers.includes(entry as RoomPower)) {
      powers.push(entry as RoomPower);
    }
  }
  return powers;
}

function sanitizeAdminPowers(
  value: unknown,
  admins: string[],
): Record<string, RoomPower[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const known = new Set(admins);
  const out: Record<string, RoomPower[]> = {};
  for (const [rawId, rawPowers] of Object.entries(value as Record<string, unknown>)) {
    const id = sanitizeStableIdentityId(rawId);
    // Kuasa yang menggantung tanpa admin-nya hanya akan hidup kembali diam-diam
    // kalau identitas itu diangkat lagi nanti.
    if (!id || !known.has(id)) {
      continue;
    }
    const powers = sanitizeRoomPowers(rawPowers);
    if (powers.length) {
      out[id] = powers;
    }
  }
  return out;
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
    admin_powers: sanitizeAdminPowers(input?.admin_powers, admins),
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

/** Kuasa efektif seseorang. Owner selalu punya semuanya. */
export function resolveRoomPowers(
  roleState: Partial<StoredRoomRoleState> | undefined,
  stableAgentIdentityId: unknown,
): RoomPower[] {
  const state = normalizeRoomRoleState(roleState);
  const id = sanitizeStableIdentityId(stableAgentIdentityId);
  if (!id) {
    return [];
  }
  if (state.owner_stable_identity_id === id) {
    return [...ROOM_POWER_VALUES];
  }
  return state.admin_powers?.[id] ?? [];
}

export function hasRoomPower(
  roleState: Partial<StoredRoomRoleState> | undefined,
  stableAgentIdentityId: unknown,
  power: RoomPower,
): boolean {
  return resolveRoomPowers(roleState, stableAgentIdentityId).includes(power);
}

function guardActor(
  state: StoredRoomRoleState,
  actorStableIdentityId: string | undefined,
  targetStableIdentityId: string | undefined,
  power: RoomPower,
  deniedMessage: string,
): RoomAdminMutationResult | null {
  if (!state.owner_stable_identity_id) {
    return {
      ok: false,
      changed: false,
      role_state: state,
      error: "The room has no valid owner yet.",
    };
  }
  if (!actorStableIdentityId) {
    return {
      ok: false,
      changed: false,
      role_state: state,
      error: "The actor's stable identity is invalid.",
    };
  }
  if (!hasRoomPower(state, actorStableIdentityId, power)) {
    return { ok: false, changed: false, role_state: state, error: deniedMessage };
  }
  if (!targetStableIdentityId) {
    return {
      ok: false,
      changed: false,
      role_state: state,
      error: "The target's stable identity is invalid.",
    };
  }
  return null;
}

export function grantRoomAdmin(
  roleState: Partial<StoredRoomRoleState> | undefined,
  params: {
    actorStableIdentityId: unknown;
    targetStableIdentityId: unknown;
    /** Bila tidak diisi, target mewarisi seluruh kuasa yang dimiliki pemberi. */
    powers?: unknown;
  },
): RoomAdminMutationResult {
  const state = normalizeRoomRoleState(roleState);
  const actor = sanitizeStableIdentityId(params.actorStableIdentityId);
  const target = sanitizeStableIdentityId(params.targetStableIdentityId);

  const denied = guardActor(
    state, actor, target, "grant_admin",
    "Granting admin requires the grant_admin power.",
  );
  if (denied) {
    return denied;
  }

  const actorPowers = resolveRoomPowers(state, actor);
  const requested = params.powers === undefined
    ? actorPowers
    : sanitizeRoomPowers(params.powers);

  // Tidak ada yang boleh membagikan kuasa yang ia sendiri tidak punya; tanpa
  // aturan ini seorang admin bisa menaikkan wewenangnya lewat perantara.
  const escalation = requested.filter((power) => !actorPowers.includes(power));
  if (escalation.length) {
    return {
      ok: false,
      changed: false,
      role_state: state,
      error: `Cannot grant powers the actor does not hold: ${escalation.join(", ")}.`,
    };
  }

  if (target === state.owner_stable_identity_id) {
    return { ok: true, changed: false, role_state: state };
  }

  const nextAdmins = state.admin_stable_identity_ids.includes(target!)
    ? state.admin_stable_identity_ids
    : [...state.admin_stable_identity_ids, target!];
  const nextPowers = { ...(state.admin_powers ?? {}) };
  const before = nextPowers[target!] ?? [];
  nextPowers[target!] = requested;

  const next = normalizeRoomRoleState({
    owner_stable_identity_id: state.owner_stable_identity_id,
    admin_stable_identity_ids: nextAdmins,
    admin_powers: nextPowers,
  });
  const changed =
    nextAdmins.length !== state.admin_stable_identity_ids.length
    || before.join(",") !== requested.join(",");
  return { ok: true, changed, role_state: next };
}

export function revokeRoomAdmin(
  roleState: Partial<StoredRoomRoleState> | undefined,
  params: {
    actorStableIdentityId: unknown;
    targetStableIdentityId: unknown;
  },
): RoomAdminMutationResult {
  const state = normalizeRoomRoleState(roleState);
  const actor = sanitizeStableIdentityId(params.actorStableIdentityId);
  const target = sanitizeStableIdentityId(params.targetStableIdentityId);

  const denied = guardActor(
    state, actor, target, "revoke_admin",
    "Revoking admin requires the revoke_admin power.",
  );
  if (denied) {
    return denied;
  }

  if (target === state.owner_stable_identity_id) {
    return {
      ok: false,
      changed: false,
      role_state: state,
      error: "The owner cannot be stripped of the owner role through revoke admin.",
    };
  }
  if (!state.admin_stable_identity_ids.includes(target!)) {
    return { ok: true, changed: false, role_state: state };
  }

  const nextPowers = { ...(state.admin_powers ?? {}) };
  delete nextPowers[target!];
  const next = normalizeRoomRoleState({
    owner_stable_identity_id: state.owner_stable_identity_id,
    admin_stable_identity_ids: state.admin_stable_identity_ids.filter(
      (entry) => entry !== target,
    ),
    admin_powers: nextPowers,
  });
  return { ok: true, changed: true, role_state: next };
}
