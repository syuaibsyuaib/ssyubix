import type { AgentPresenceSnapshot } from "./presence";

export const ROOM_CAPABILITY_REGISTRY_KEY = "room:capabilities";

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
  display_name: string;
  summary: string;
  version: string;
  presence: "online" | "offline";
  availability: string;
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
  display_name: string;
  presence: "online" | "offline";
  availability: string;
}

export interface CapabilitySkillIndexEntry {
  skill_id: string;
  name: string;
  description: string;
  agent_count: number;
  agents: CapabilitySkillIndexAgent[];
}

function sanitizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
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
    display_name: sanitizeString(params.displayName, sanitizeString(previous.display_name, params.agentId)),
    summary: sanitizeString(previous.summary),
    version: sanitizeString(previous.version, "1"),
    presence: params.presence,
    availability: sanitizeString(previous.availability, "available"),
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

function overlayCapabilityProfile(
  profile: StoredCapabilityProfile,
  overlay?: CapabilityPresenceOverlay,
): StoredCapabilityProfile {
  if (!overlay) {
    return profile;
  }

  return {
    ...profile,
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
