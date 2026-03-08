import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCapabilitySkillIndex,
  createCapabilityRegistryManifest,
  listCapabilityProfiles,
  upsertCapabilityProfile,
} from "./capability-registry";

test("upsertCapabilityProfile creates a default self-declared profile", () => {
  const manifest = createCapabilityRegistryManifest(undefined, "2026-03-09T00:00:00.000Z");

  const { changed, profile } = upsertCapabilityProfile(manifest, {
    agentId: "AGENT42",
    displayName: "alpha-agent",
    presence: "online",
    joinedAt: "2026-03-09T00:00:00.000Z",
    lastSeenAt: "2026-03-09T00:00:10.000Z",
    updatedAt: "2026-03-09T00:00:10.000Z",
  });

  assert.equal(changed, true);
  assert.deepEqual(profile, {
    agent_id: "AGENT42",
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
    displayName: "alpha",
    presence: "offline",
    joinedAt: "2026-03-09T00:00:00.000Z",
    lastSeenAt: "2026-03-09T00:00:05.000Z",
    updatedAt: "2026-03-09T00:00:05.000Z",
  });

  const profiles = listCapabilityProfiles(manifest, [
    {
      agent_id: "AGENT1",
      name: "alpha-live",
      presence: "online",
      joined_at: "2026-03-09T00:00:00.000Z",
      last_seen_at: "2026-03-09T00:01:00.000Z",
    },
    {
      agent_id: "AGENT2",
      name: "beta-live",
      presence: "online",
      joined_at: "2026-03-09T00:00:30.000Z",
      last_seen_at: "2026-03-09T00:01:00.000Z",
    },
  ]);

  assert.deepEqual(
    profiles.map((profile) => ({
      agent_id: profile.agent_id,
      display_name: profile.display_name,
      presence: profile.presence,
    })),
    [
      {
        agent_id: "AGENT1",
        display_name: "alpha-live",
        presence: "online",
      },
      {
        agent_id: "AGENT2",
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
          display_name: "alpha",
          presence: "online",
          availability: "available",
        },
        {
          agent_id: "AGENT2",
          display_name: "beta",
          presence: "offline",
          availability: "busy",
        },
      ],
    },
  ]);
});
