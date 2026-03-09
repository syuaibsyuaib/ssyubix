import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCapabilityProfilePatch,
  buildCapabilitySkillIndex,
  createCapabilityRegistryManifest,
  listCapabilityProfiles,
  removeCapabilityProfile,
  upsertCapabilityProfile,
  validateCapabilityProfilePatch,
} from "./capability-registry";

test("upsertCapabilityProfile creates a default self-declared profile", () => {
  const manifest = createCapabilityRegistryManifest(undefined, "2026-03-09T00:00:00.000Z");

  const { changed, profile } = upsertCapabilityProfile(manifest, {
    agentId: "AGENT42",
    stableAgentIdentityId: "stable-agent-42",
    displayName: "alpha-agent",
    presence: "online",
    joinedAt: "2026-03-09T00:00:00.000Z",
    lastSeenAt: "2026-03-09T00:00:10.000Z",
    updatedAt: "2026-03-09T00:00:10.000Z",
  });

  assert.equal(changed, true);
  assert.deepEqual(profile, {
    agent_id: "AGENT42",
    stable_agent_identity_id: "stable-agent-42",
    display_name: "alpha-agent",
    summary: "",
    version: "1",
    presence: "online",
    availability: "available",
    joined_at: "2026-03-09T00:00:00.000Z",
    last_seen_at: "2026-03-09T00:00:10.000Z",
    updated_at: "2026-03-09T00:00:10.000Z",
    verification: "self_declared",
    tool_access: [],
    constraints: [],
    max_concurrent_tasks: null,
    current_load: 0,
    skills: [],
  });
});

test("upsertCapabilityProfile preserves custom fields while refreshing room presence", () => {
  const manifest = createCapabilityRegistryManifest(
    {
      updated_at: "2026-03-09T00:00:00.000Z",
      profiles: {
        AGENT42: {
          agent_id: "AGENT42",
          stable_agent_identity_id: "stable-agent-42",
          display_name: "alpha-agent",
          summary: "Code reviewer",
          version: "1",
          presence: "offline",
          availability: "busy",
          joined_at: "2026-03-09T00:00:00.000Z",
          last_seen_at: "2026-03-09T00:00:10.000Z",
          updated_at: "2026-03-09T00:00:10.000Z",
          verification: "self_declared",
          tool_access: ["github", "web"],
          constraints: ["read_only"],
          max_concurrent_tasks: 2,
          current_load: 1,
          skills: [
            {
              id: "code_review",
              name: "Code Review",
              description: "Review diffs and regressions",
              tags: ["review"],
              examples: [],
              input_modes: ["text"],
              output_modes: ["text"],
            },
          ],
        },
      },
    },
    "2026-03-09T00:00:00.000Z",
  );

  const { profile } = upsertCapabilityProfile(manifest, {
    agentId: "AGENT42",
    stableAgentIdentityId: "stable-agent-42",
    displayName: "alpha-agent-v2",
    presence: "online",
    joinedAt: "2026-03-09T00:00:00.000Z",
    lastSeenAt: "2026-03-09T00:00:30.000Z",
    updatedAt: "2026-03-09T00:00:30.000Z",
  });

  assert.equal(profile.display_name, "alpha-agent-v2");
  assert.equal(profile.presence, "online");
  assert.equal(profile.summary, "Code reviewer");
  assert.deepEqual(profile.tool_access, ["github", "web"]);
  assert.equal(profile.max_concurrent_tasks, 2);
  assert.equal(profile.current_load, 1);
  assert.equal(profile.skills[0]?.id, "code_review");
});

test("listCapabilityProfiles overlays active socket presence and includes live-only agents", () => {
  const manifest = createCapabilityRegistryManifest(undefined, "2026-03-09T00:00:00.000Z");
  upsertCapabilityProfile(manifest, {
    agentId: "AGENT1",
    stableAgentIdentityId: "stable-agent-1",
    displayName: "alpha",
    presence: "offline",
    joinedAt: "2026-03-09T00:00:00.000Z",
    lastSeenAt: "2026-03-09T00:00:05.000Z",
    updatedAt: "2026-03-09T00:00:05.000Z",
  });

  const profiles = listCapabilityProfiles(manifest, [
    {
      agent_id: "AGENT1",
      stable_agent_identity_id: "stable-agent-1",
      name: "alpha-live",
      presence: "online",
      joined_at: "2026-03-09T00:00:00.000Z",
      last_seen_at: "2026-03-09T00:01:00.000Z",
    },
    {
      agent_id: "AGENT2",
      stable_agent_identity_id: "stable-agent-2",
      name: "beta-live",
      presence: "online",
      joined_at: "2026-03-09T00:00:30.000Z",
      last_seen_at: "2026-03-09T00:01:00.000Z",
    },
  ]);

  assert.deepEqual(
    profiles.map((profile) => ({
      agent_id: profile.agent_id,
      stable_agent_identity_id: profile.stable_agent_identity_id,
      display_name: profile.display_name,
      presence: profile.presence,
    })),
    [
      {
        agent_id: "AGENT1",
        stable_agent_identity_id: "stable-agent-1",
        display_name: "alpha-live",
        presence: "online",
      },
      {
        agent_id: "AGENT2",
        stable_agent_identity_id: "stable-agent-2",
        display_name: "beta-live",
        presence: "online",
      },
    ],
  );
});

test("buildCapabilitySkillIndex groups agents by declared skill", () => {
  const profiles = [
    {
      agent_id: "AGENT1",
      stable_agent_identity_id: "stable-agent-1",
      display_name: "alpha",
      summary: "",
      version: "1",
      presence: "online" as const,
      availability: "available",
      joined_at: "2026-03-09T00:00:00.000Z",
      last_seen_at: "2026-03-09T00:01:00.000Z",
      updated_at: "2026-03-09T00:01:00.000Z",
      verification: "self_declared" as const,
      tool_access: [],
      constraints: [],
      max_concurrent_tasks: null,
      current_load: 0,
      skills: [
        {
          id: "code_review",
          name: "Code Review",
          description: "Review diffs",
          tags: [],
          examples: [],
          input_modes: ["text"],
          output_modes: ["text"],
        },
      ],
    },
    {
      agent_id: "AGENT2",
      stable_agent_identity_id: "stable-agent-2",
      display_name: "beta",
      summary: "",
      version: "1",
      presence: "offline" as const,
      availability: "busy",
      joined_at: "2026-03-09T00:00:00.000Z",
      last_seen_at: "2026-03-09T00:01:00.000Z",
      updated_at: "2026-03-09T00:01:00.000Z",
      verification: "self_declared" as const,
      tool_access: [],
      constraints: [],
      max_concurrent_tasks: null,
      current_load: 1,
      skills: [
        {
          id: "code_review",
          name: "Code Review",
          description: "Review diffs",
          tags: [],
          examples: [],
          input_modes: ["text"],
          output_modes: ["text"],
        },
      ],
    },
  ];

  assert.deepEqual(buildCapabilitySkillIndex(profiles), [
    {
      skill_id: "code_review",
      name: "Code Review",
      description: "Review diffs",
      agent_count: 2,
      agents: [
        {
          agent_id: "AGENT1",
          stable_agent_identity_id: "stable-agent-1",
          display_name: "alpha",
          presence: "online",
          availability: "available",
        },
        {
          agent_id: "AGENT2",
          stable_agent_identity_id: "stable-agent-2",
          display_name: "beta",
          presence: "offline",
          availability: "busy",
        },
      ],
    },
  ]);
});

test("validateCapabilityProfilePatch accepts normalized self-service fields", () => {
  assert.deepEqual(
    validateCapabilityProfilePatch(
      {
        summary: "  Reviews code and deployment plans  ",
        version: " 2026.03 ",
        tool_access: ["github", " github ", "web"],
        constraints: ["read_only", "no_secrets"],
        max_concurrent_tasks: 3,
        current_load: 1,
        skills: [
          {
            id: "Code Review",
            name: "Code Review",
            description: "Review diffs",
            tags: ["review", "review"],
            input_modes: ["text"],
            output_modes: ["text"],
          },
        ],
      },
      { allowAvailability: false },
    ),
    {
      ok: true,
      patch: {
        summary: "Reviews code and deployment plans",
        version: "2026.03",
        tool_access: ["github", "web"],
        constraints: ["read_only", "no_secrets"],
        max_concurrent_tasks: 3,
        current_load: 1,
        skills: [
          {
            id: "code_review",
            name: "Code Review",
            description: "Review diffs",
            tags: ["review"],
            examples: [],
            input_modes: ["text"],
            output_modes: ["text"],
          },
        ],
      },
      errors: [],
    },
  );
});

test("validateCapabilityProfilePatch rejects unsupported and invalid values", () => {
  const result = validateCapabilityProfilePatch(
    {
      availability: "offline",
      current_load: 5,
      max_concurrent_tasks: 2,
      unknown_field: true,
    },
    { allowAvailability: true },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "Field 'unknown_field' tidak didukung untuk capability update.",
    "availability harus salah satu dari: available, busy, away, dnd.",
    "current_load tidak boleh melebihi max_concurrent_tasks.",
  ]);
});

test("applyCapabilityProfilePatch updates mutable capability fields without losing identity", () => {
  const manifest = createCapabilityRegistryManifest(undefined, "2026-03-09T00:00:00.000Z");
  upsertCapabilityProfile(manifest, {
    agentId: "AGENT42",
    stableAgentIdentityId: "stable-agent-42",
    displayName: "alpha-agent",
    presence: "online",
    joinedAt: "2026-03-09T00:00:00.000Z",
    lastSeenAt: "2026-03-09T00:00:05.000Z",
    updatedAt: "2026-03-09T00:00:05.000Z",
  });

  const { changed, profile } = applyCapabilityProfilePatch(manifest, {
    agentId: "AGENT42",
    stableAgentIdentityId: "stable-agent-42",
    displayName: "alpha-agent",
    presence: "online",
    joinedAt: "2026-03-09T00:00:00.000Z",
    lastSeenAt: "2026-03-09T00:01:00.000Z",
    updatedAt: "2026-03-09T00:01:00.000Z",
    patch: {
      availability: "busy",
      current_load: 2,
      max_concurrent_tasks: 3,
      summary: "Focused on code review",
    },
  });

  assert.equal(changed, true);
  assert.equal(profile.agent_id, "AGENT42");
  assert.equal(profile.stable_agent_identity_id, "stable-agent-42");
  assert.equal(profile.display_name, "alpha-agent");
  assert.equal(profile.availability, "busy");
  assert.equal(profile.current_load, 2);
  assert.equal(profile.max_concurrent_tasks, 3);
  assert.equal(profile.summary, "Focused on code review");
});

test("removeCapabilityProfile deletes only the targeted stored profile", () => {
  const manifest = createCapabilityRegistryManifest(undefined, "2026-03-09T00:00:00.000Z");
  upsertCapabilityProfile(manifest, {
    agentId: "AGENT42",
    stableAgentIdentityId: "stable-agent-42",
    displayName: "alpha-agent",
    presence: "online",
    joinedAt: "2026-03-09T00:00:00.000Z",
    lastSeenAt: "2026-03-09T00:00:05.000Z",
    updatedAt: "2026-03-09T00:00:05.000Z",
  });
  upsertCapabilityProfile(manifest, {
    agentId: "AGENT99",
    stableAgentIdentityId: "stable-agent-99",
    displayName: "beta-agent",
    presence: "online",
    joinedAt: "2026-03-09T00:00:10.000Z",
    lastSeenAt: "2026-03-09T00:00:15.000Z",
    updatedAt: "2026-03-09T00:00:15.000Z",
  });

  assert.equal(
    removeCapabilityProfile(manifest, "AGENT42", "2026-03-09T00:02:00.000Z"),
    true,
  );
  assert.equal(manifest.profiles.AGENT42, undefined);
  assert.notEqual(manifest.profiles.AGENT99, undefined);
});
