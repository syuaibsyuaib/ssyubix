import type { AgentPresenceSnapshot } from "./presence";

export const ROOM_CAPABILITY_REGISTRY_KEY = "room:capabilities";
export const CAPABILITY_AVAILABILITY_VALUES = [
  "available",
  "busy",
  "away",
  "dnd",
] as const;

export type CapabilityAvailability =
  typeof CAPABILITY_AVAILABILITY_VALUES[number];

export interface CapabilitySkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
  input_modes: string[];
  output_modes: string[];
}

export interface StoredCapabilityProfile {
  agent_id: string;
  stable_agent_identity_id?: string;
  display_name: string;
  summary: string;
  version: string;
  presence: "online" | "offline";
  availability: CapabilityAvailability;
  joined_at: string;
  last_seen_at: string;
  updated_at: string;
  verification: "self_declared";
  tool_access: string[];
  constraints: string[];
  max_concurrent_tasks: number | null;
  current_load: number;
  skills: CapabilitySkill[];
}

export interface CapabilityRegistryManifest {
  updated_at: string;
  profiles: Record<string, StoredCapabilityProfile>;
}

export interface CapabilityPresenceOverlay extends AgentPresenceSnapshot {
  updated_at?: string;
}

export interface CapabilitySkillIndexAgent {
  agent_id: string;
  stable_agent_identity_id?: string;
  display_name: string;
  presence: "online" | "offline";
  availability: CapabilityAvailability;
}

export interface CapabilitySkillIndexEntry {
  skill_id: string;
  name: string;
  description: string;
  agent_count: number;
  agents: CapabilitySkillIndexAgent[];
}

export interface CapabilityProfilePatch {
  summary?: string;
  version?: string;
  availability?: CapabilityAvailability;
  tool_access?: string[];
  constraints?: string[];
  max_concurrent_tasks?: number | null;
  current_load?: number;
  skills?: CapabilitySkill[];
}

export interface CapabilityPatchValidationResult {
  ok: boolean;
  patch?: CapabilityProfilePatch;
  errors: string[];
}

function sanitizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function sanitizeBoundedString(
  value: unknown,
  params: { field: string; maxLength: number; fallback?: string; allowEmpty?: boolean },
): { value?: string; error?: string } {
  const fallback = params.fallback ?? "";
  if (value === undefined) {
    return { value: fallback };
  }
  if (value === null) {
    if (params.allowEmpty) {
      return { value: "" };
    }
    return { error: `${params.field} tidak boleh null.` };
  }
  if (typeof value !== "string") {
    return { error: `${params.field} harus berupa string.` };
  }
  const normalized = value.trim();
  if (!normalized && !params.allowEmpty) {
    return { error: `${params.field} tidak boleh kosong.` };
  }
  if (normalized.length > params.maxLength) {
    return { error: `${params.field} maksimal ${params.maxLength} karakter.` };
  }
  return { value: normalized };
}

function sanitizeIdentifier(
  value: unknown,
  params: { field: string; maxLength: number },
): { value?: string; error?: string } {
  const normalized = sanitizeBoundedString(value, {
    field: params.field,
    maxLength: params.maxLength,
  });
  if (normalized.error || normalized.value === undefined) {
    return normalized;
  }
  const slug = normalized.value.toLowerCase().replace(/\s+/g, "_");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
    return {
      error:
        `${params.field} hanya boleh berisi huruf kecil, angka, titik, underscore, atau dash.`,
    };
  }
  return { value: slug };
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    sanitized.push(normalized);
  }
  return sanitized;
}

function sanitizeNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}

function sanitizeOptionalPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function sanitizeSkill(value: unknown): CapabilitySkill | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const id = sanitizeString(raw.id);
  const name = sanitizeString(raw.name);
  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    description: sanitizeString(raw.description),
    tags: sanitizeStringList(raw.tags),
    examples: sanitizeStringList(raw.examples),
    input_modes: sanitizeStringList(raw.input_modes),
    output_modes: sanitizeStringList(raw.output_modes),
  };
}

function sanitizeAvailability(
  value: unknown,
  fallback: CapabilityAvailability = "available",
): { value?: CapabilityAvailability; error?: string } {
  if (value === undefined) {
    return { value: fallback };
  }
  if (typeof value !== "string") {
    return { error: "availability harus berupa string." };
  }
  const normalized = value.trim().toLowerCase();
  if (
    CAPABILITY_AVAILABILITY_VALUES.includes(
      normalized as CapabilityAvailability,
    )
  ) {
    return { value: normalized as CapabilityAvailability };
  }
  return {
    error:
      `availability harus salah satu dari: ${CAPABILITY_AVAILABILITY_VALUES.join(", ")}.`,
  };
}

function validateSkill(value: unknown, index: number): { skill?: CapabilitySkill; errors: string[] } {
  if (!value || typeof value !== "object") {
    return { errors: [`skills[${index}] harus berupa object.`] };
  }

  const raw = value as Record<string, unknown>;
  const errors: string[] = [];
  const id = sanitizeIdentifier(raw.id, {
    field: `skills[${index}].id`,
    maxLength: 64,
  });
  const name = sanitizeBoundedString(raw.name, {
    field: `skills[${index}].name`,
    maxLength: 80,
  });
  const description = sanitizeBoundedString(raw.description ?? "", {
    field: `skills[${index}].description`,
    maxLength: 240,
    allowEmpty: true,
  });
  if (id.error) {
    errors.push(id.error);
  }
  if (name.error) {
    errors.push(name.error);
  }
  if (description.error) {
    errors.push(description.error);
  }

  const tags = sanitizeStringList(raw.tags).slice(0, 10);
  const examples = sanitizeStringList(raw.examples).slice(0, 5);
  const inputModes = sanitizeStringList(raw.input_modes).slice(0, 10);
  const outputModes = sanitizeStringList(raw.output_modes).slice(0, 10);

  if (errors.length > 0 || !id.value || !name.value || description.value === undefined) {
    return { errors };
  }

  return {
    skill: {
      id: id.value,
      name: name.value,
      description: description.value,
      tags,
      examples,
      input_modes: inputModes,
      output_modes: outputModes,
    },
    errors,
  };
}

function sanitizeSkills(value: unknown): CapabilitySkill[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const skills: CapabilitySkill[] = [];
  for (const entry of value) {
    const skill = sanitizeSkill(entry);
    if (!skill || seen.has(skill.id)) {
      continue;
    }
    seen.add(skill.id);
    skills.push(skill);
  }
  return skills;
}

function normalizeProfile(
  existing: Partial<StoredCapabilityProfile> | undefined,
  params: {
    agentId: string;
    stableAgentIdentityId?: string;
    displayName: string;
    presence: "online" | "offline";
    joinedAt: string;
    lastSeenAt: string;
    updatedAt: string;
  },
): StoredCapabilityProfile {
  const previous = existing ?? {};

  return {
    agent_id: params.agentId,
    stable_agent_identity_id:
      sanitizeString(
        params.stableAgentIdentityId,
        sanitizeString(previous.stable_agent_identity_id),
      ) || undefined,
    display_name: sanitizeString(params.displayName, sanitizeString(previous.display_name, params.agentId)),
    summary: sanitizeString(previous.summary),
    version: sanitizeString(previous.version, "1"),
    presence: params.presence,
    availability: sanitizeAvailability(previous.availability, "available").value ?? "available",
    joined_at: sanitizeString(previous.joined_at, params.joinedAt),
    last_seen_at: sanitizeString(params.lastSeenAt, sanitizeString(previous.last_seen_at, params.updatedAt)),
    updated_at: params.updatedAt,
    verification: "self_declared",
    tool_access: sanitizeStringList(previous.tool_access),
    constraints: sanitizeStringList(previous.constraints),
    max_concurrent_tasks: sanitizeOptionalPositiveInteger(previous.max_concurrent_tasks),
    current_load: sanitizeNonNegativeInteger(previous.current_load),
    skills: sanitizeSkills(previous.skills),
  };
}

function profileEquals(
  left: StoredCapabilityProfile | undefined,
  right: StoredCapabilityProfile,
): boolean {
  if (!left) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createCapabilityRegistryManifest(
  stored: Partial<CapabilityRegistryManifest> | undefined,
  now: string,
): CapabilityRegistryManifest {
  const profiles =
    stored && typeof stored.profiles === "object" && stored.profiles
      ? stored.profiles
      : {};

  return {
    updated_at:
      typeof stored?.updated_at === "string" ? stored.updated_at : now,
    profiles: profiles as Record<string, StoredCapabilityProfile>,
  };
}

export function upsertCapabilityProfile(
  manifest: CapabilityRegistryManifest,
  params: {
    agentId: string;
    stableAgentIdentityId?: string;
    displayName: string;
    presence: "online" | "offline";
    joinedAt: string;
    lastSeenAt: string;
    updatedAt: string;
  },
): { changed: boolean; profile: StoredCapabilityProfile } {
  const nextProfile = normalizeProfile(manifest.profiles[params.agentId], params);
  const changed = !profileEquals(manifest.profiles[params.agentId], nextProfile);
  if (changed) {
    manifest.profiles[params.agentId] = nextProfile;
    manifest.updated_at = params.updatedAt;
  }
  return { changed, profile: nextProfile };
}

export function validateCapabilityProfilePatch(
  raw: unknown,
  options: {
    allowAvailability?: boolean;
    availabilityOnly?: boolean;
  } = {},
): CapabilityPatchValidationResult {
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      errors: ["Payload capability update harus berupa object JSON."],
    };
  }

  const input = raw as Record<string, unknown>;
  const patch: CapabilityProfilePatch = {};
  const errors: string[] = [];
  const allowedKeys = new Set([
    "summary",
    "version",
    "tool_access",
    "constraints",
    "max_concurrent_tasks",
    "current_load",
    "skills",
    ...(options.allowAvailability ? ["availability"] : []),
  ]);

  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      errors.push(`Field '${key}' tidak didukung untuk capability update.`);
    }
  }

  if ("summary" in input) {
    const result = sanitizeBoundedString(input.summary, {
      field: "summary",
      maxLength: 500,
      allowEmpty: true,
    });
    if (result.error) {
      errors.push(result.error);
    } else if (result.value !== undefined) {
      patch.summary = result.value;
    }
  }

  if ("version" in input) {
    const result = sanitizeBoundedString(input.version, {
      field: "version",
      maxLength: 64,
      allowEmpty: true,
    });
    if (result.error) {
      errors.push(result.error);
    } else if (result.value !== undefined) {
      patch.version = result.value || "1";
    }
  }

  if ("tool_access" in input) {
    if (input.tool_access !== null && !Array.isArray(input.tool_access)) {
      errors.push("tool_access harus berupa array string atau null.");
    } else {
      patch.tool_access =
        input.tool_access === null ? [] : sanitizeStringList(input.tool_access).slice(0, 20);
    }
  }

  if ("constraints" in input) {
    if (input.constraints !== null && !Array.isArray(input.constraints)) {
      errors.push("constraints harus berupa array string atau null.");
    } else {
      patch.constraints =
        input.constraints === null ? [] : sanitizeStringList(input.constraints).slice(0, 20);
    }
  }

  if ("max_concurrent_tasks" in input) {
    if (input.max_concurrent_tasks === null) {
      patch.max_concurrent_tasks = null;
    } else if (
      typeof input.max_concurrent_tasks === "number" &&
      Number.isFinite(input.max_concurrent_tasks)
    ) {
      const normalized = Math.trunc(input.max_concurrent_tasks);
      if (normalized < 1 || normalized > 100) {
        errors.push("max_concurrent_tasks harus antara 1 dan 100, atau null.");
      } else {
        patch.max_concurrent_tasks = normalized;
      }
    } else {
      errors.push("max_concurrent_tasks harus berupa integer atau null.");
    }
  }

  if ("current_load" in input) {
    if (
      typeof input.current_load === "number" &&
      Number.isFinite(input.current_load)
    ) {
      const normalized = Math.trunc(input.current_load);
      if (normalized < 0 || normalized > 100) {
        errors.push("current_load harus antara 0 dan 100.");
      } else {
        patch.current_load = normalized;
      }
    } else {
      errors.push("current_load harus berupa integer.");
    }
  }

  if ("skills" in input) {
    if (input.skills !== null && !Array.isArray(input.skills)) {
      errors.push("skills harus berupa array object atau null.");
    } else if (Array.isArray(input.skills)) {
      const skills: CapabilitySkill[] = [];
      const seen = new Set<string>();
      for (const [index, entry] of input.skills.entries()) {
        const validated = validateSkill(entry, index);
        errors.push(...validated.errors);
        if (!validated.skill || seen.has(validated.skill.id)) {
          continue;
        }
        seen.add(validated.skill.id);
        skills.push(validated.skill);
      }
      patch.skills = skills.slice(0, 20);
    } else {
      patch.skills = [];
    }
  }

  if (options.allowAvailability && "availability" in input) {
    const availability = sanitizeAvailability(input.availability);
    if (availability.error) {
      errors.push(availability.error);
    } else if (availability.value !== undefined) {
      patch.availability = availability.value;
    }
  }

  if (
    patch.max_concurrent_tasks !== undefined &&
    patch.current_load !== undefined &&
    patch.max_concurrent_tasks !== null &&
    patch.current_load > patch.max_concurrent_tasks
  ) {
    errors.push("current_load tidak boleh melebihi max_concurrent_tasks.");
  }

  const providedFields = Object.keys(patch);
  if (providedFields.length === 0 && errors.length === 0) {
    errors.push(
      options.availabilityOnly
        ? "Setidaknya satu field availability/current_load harus dikirim."
        : "Setidaknya satu field capability yang dapat diubah harus dikirim.",
    );
  }

  return {
    ok: errors.length === 0,
    patch: errors.length === 0 ? patch : undefined,
    errors,
  };
}

export function applyCapabilityProfilePatch(
  manifest: CapabilityRegistryManifest,
  params: {
    agentId: string;
    stableAgentIdentityId?: string;
    displayName: string;
    presence: "online" | "offline";
    joinedAt: string;
    lastSeenAt: string;
    updatedAt: string;
    patch: CapabilityProfilePatch;
  },
): { changed: boolean; profile: StoredCapabilityProfile } {
  const baseProfile = normalizeProfile(manifest.profiles[params.agentId], {
    agentId: params.agentId,
    stableAgentIdentityId: params.stableAgentIdentityId,
    displayName: params.displayName,
    presence: params.presence,
    joinedAt: params.joinedAt,
    lastSeenAt: params.lastSeenAt,
    updatedAt: params.updatedAt,
  });

  const nextProfile: StoredCapabilityProfile = {
    ...baseProfile,
    summary: params.patch.summary ?? baseProfile.summary,
    version: params.patch.version ?? baseProfile.version,
    availability: params.patch.availability ?? baseProfile.availability,
    tool_access: params.patch.tool_access ?? baseProfile.tool_access,
    constraints: params.patch.constraints ?? baseProfile.constraints,
    max_concurrent_tasks:
      params.patch.max_concurrent_tasks !== undefined
        ? params.patch.max_concurrent_tasks
        : baseProfile.max_concurrent_tasks,
    current_load:
      params.patch.current_load !== undefined
        ? params.patch.current_load
        : baseProfile.current_load,
    skills: params.patch.skills ?? baseProfile.skills,
    updated_at: params.updatedAt,
    last_seen_at: params.lastSeenAt,
    presence: params.presence,
  };

  const changed = !profileEquals(manifest.profiles[params.agentId], nextProfile);
  if (changed) {
    manifest.profiles[params.agentId] = nextProfile;
    manifest.updated_at = params.updatedAt;
  }
  return { changed, profile: nextProfile };
}

export function removeCapabilityProfile(
  manifest: CapabilityRegistryManifest,
  agentId: string,
  updatedAt: string,
): boolean {
  if (!(agentId in manifest.profiles)) {
    return false;
  }
  delete manifest.profiles[agentId];
  manifest.updated_at = updatedAt;
  return true;
}

function overlayCapabilityProfile(
  profile: StoredCapabilityProfile,
  overlay?: CapabilityPresenceOverlay,
): StoredCapabilityProfile {
  if (!overlay) {
    return profile;
  }

  return {
    ...profile,
    stable_agent_identity_id: sanitizeString(
      overlay.stable_agent_identity_id,
      profile.stable_agent_identity_id ?? "",
    ) || undefined,
    display_name: sanitizeString(overlay.name, profile.display_name),
    presence: overlay.presence,
    joined_at: sanitizeString(overlay.joined_at, profile.joined_at),
    last_seen_at: sanitizeString(overlay.last_seen_at, profile.last_seen_at),
    updated_at: sanitizeString(overlay.updated_at, overlay.last_seen_at || profile.updated_at),
  };
}

export function listCapabilityProfiles(
  manifest: CapabilityRegistryManifest,
  overlays: Iterable<CapabilityPresenceOverlay> = [],
): StoredCapabilityProfile[] {
  const overlayMap = new Map<string, CapabilityPresenceOverlay>();
  for (const overlay of overlays) {
    overlayMap.set(overlay.agent_id, overlay);
  }

  const hydrated = new Map<string, StoredCapabilityProfile>();
  for (const profile of Object.values(manifest.profiles)) {
    hydrated.set(
      profile.agent_id,
      overlayCapabilityProfile(profile, overlayMap.get(profile.agent_id)),
    );
  }

  for (const overlay of overlayMap.values()) {
    if (hydrated.has(overlay.agent_id)) {
      continue;
    }
    hydrated.set(
      overlay.agent_id,
      normalizeProfile(undefined, {
        agentId: overlay.agent_id,
        stableAgentIdentityId: overlay.stable_agent_identity_id,
        displayName: overlay.name,
        presence: overlay.presence,
        joinedAt: overlay.joined_at,
        lastSeenAt: overlay.last_seen_at,
        updatedAt: sanitizeString(overlay.updated_at, overlay.last_seen_at),
      }),
    );
  }

  return [...hydrated.values()].sort((left, right) => {
    const byName = left.display_name.localeCompare(right.display_name, "en", {
      sensitivity: "base",
    });
    if (byName !== 0) {
      return byName;
    }
    return left.agent_id.localeCompare(right.agent_id, "en", {
      sensitivity: "base",
    });
  });
}

export function buildCapabilitySkillIndex(
  profiles: StoredCapabilityProfile[],
): CapabilitySkillIndexEntry[] {
  const index = new Map<string, CapabilitySkillIndexEntry>();

  for (const profile of profiles) {
    for (const skill of profile.skills) {
      const existing = index.get(skill.id) ?? {
        skill_id: skill.id,
        name: skill.name,
        description: skill.description,
        agent_count: 0,
        agents: [],
      };

      existing.agents.push({
        agent_id: profile.agent_id,
        stable_agent_identity_id: profile.stable_agent_identity_id,
        display_name: profile.display_name,
        presence: profile.presence,
        availability: profile.availability,
      });
      existing.agent_count = existing.agents.length;
      index.set(skill.id, existing);
    }
  }

  return [...index.values()]
    .map((entry) => ({
      ...entry,
      agents: entry.agents.sort((left, right) =>
        left.display_name.localeCompare(right.display_name, "en", {
          sensitivity: "base",
        }),
      ),
    }))
    .sort((left, right) =>
      left.name.localeCompare(right.name, "en", { sensitivity: "base" }),
    );
}
