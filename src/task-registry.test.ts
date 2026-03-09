import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptDelegationOffer,
  createDelegationOffer,
  createTaskRegistryManifest,
  deferDelegationOffer,
  getTask,
  listTasks,
  rejectDelegationOffer,
} from "./task-registry";

test("createDelegationOffer stores a compact shared task manifest", () => {
  const manifest = createTaskRegistryManifest(undefined, "2026-03-09T00:00:00.000Z");
  const { changed, task } = createDelegationOffer(manifest, {
    taskId: "TASK001",
    title: "Review deployment checklist",
    delegatedBy: "PLANNER1",
    delegatedByIdentityId: "stable-planner-1",
    offeredToAgentId: "WORKER1",
    offeredToIdentityId: "stable-worker-1",
    pointOfContactAgentId: "PLANNER1",
    pointOfContactIdentityId: "stable-planner-1",
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z",
    priority: "high",
  });

  assert.equal(changed, true);
  assert.equal(task.status, "waiting_for_acceptance");
  assert.equal(task.offer_state, "offered");
  assert.equal(task.acceptance_state, "pending");
  assert.equal(task.delegated_by_identity_id, "stable-planner-1");
  assert.equal(task.offered_to_identity_id, "stable-worker-1");
  assert.deepEqual(task.watcher_ids, ["PLANNER1", "WORKER1"]);
});

test("acceptDelegationOffer uses stable identity when the worker reconnects with a new room agent id", () => {
  const manifest = createTaskRegistryManifest(undefined, "2026-03-09T00:00:00.000Z");
  createDelegationOffer(manifest, {
    taskId: "TASK001",
    title: "Review deployment checklist",
    delegatedBy: "PLANNER1",
    delegatedByIdentityId: "stable-planner-1",
    offeredToAgentId: "WORKER1",
    offeredToIdentityId: "stable-worker-1",
    pointOfContactAgentId: "PLANNER1",
    pointOfContactIdentityId: "stable-planner-1",
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z",
  });

  const result = acceptDelegationOffer(manifest, {
    taskId: "TASK001",
    actorAgentId: "WORKER9",
    actorIdentityId: "stable-worker-1",
    updatedAt: "2026-03-09T00:05:00.000Z",
    leaseUntil: "2026-03-09T01:05:00.000Z",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.task?.status, "accepted");
  assert.equal(result.task?.responsible_agent_id, "WORKER9");
  assert.equal(result.task?.responsible_identity_id, "stable-worker-1");
});

test("rejectDelegationOffer blocks unrelated agents", () => {
  const manifest = createTaskRegistryManifest(undefined, "2026-03-09T00:00:00.000Z");
  createDelegationOffer(manifest, {
    taskId: "TASK001",
    title: "Review deployment checklist",
    delegatedBy: "PLANNER1",
    delegatedByIdentityId: "stable-planner-1",
    offeredToAgentId: "WORKER1",
    offeredToIdentityId: "stable-worker-1",
    pointOfContactAgentId: "PLANNER1",
    pointOfContactIdentityId: "stable-planner-1",
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z",
  });

  const result = rejectDelegationOffer(manifest, {
    taskId: "TASK001",
    actorAgentId: "INTRUDER",
    actorIdentityId: "stable-intruder",
    updatedAt: "2026-03-09T00:05:00.000Z",
    reason: "nope",
  });

  assert.equal(result.changed, false);
  assert.match(result.error ?? "", /Hanya agent tujuan/);
});

test("deferDelegationOffer stores the defer reason and schedule hint", () => {
  const manifest = createTaskRegistryManifest(undefined, "2026-03-09T00:00:00.000Z");
  createDelegationOffer(manifest, {
    taskId: "TASK001",
    title: "Review deployment checklist",
    delegatedBy: "PLANNER1",
    delegatedByIdentityId: "stable-planner-1",
    offeredToAgentId: "WORKER1",
    offeredToIdentityId: "stable-worker-1",
    pointOfContactAgentId: "PLANNER1",
    pointOfContactIdentityId: "stable-planner-1",
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z",
  });

  const result = deferDelegationOffer(manifest, {
    taskId: "TASK001",
    actorAgentId: "WORKER2",
    actorIdentityId: "stable-worker-1",
    updatedAt: "2026-03-09T00:02:00.000Z",
    deferredUntil: "2026-03-09T01:00:00.000Z",
    reason: "Busy with another deploy",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.task?.status, "deferred");
  assert.equal(result.task?.deferred_until, "2026-03-09T01:00:00.000Z");
  assert.equal(result.task?.response_reason, "Busy with another deploy");
});

test("listTasks sorts by most recently updated task first", () => {
  const manifest = createTaskRegistryManifest(undefined, "2026-03-09T00:00:00.000Z");
  createDelegationOffer(manifest, {
    taskId: "TASK001",
    title: "First",
    delegatedBy: "PLANNER1",
    offeredToAgentId: "WORKER1",
    pointOfContactAgentId: "PLANNER1",
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z",
  });
  createDelegationOffer(manifest, {
    taskId: "TASK002",
    title: "Second",
    delegatedBy: "PLANNER1",
    offeredToAgentId: "WORKER2",
    pointOfContactAgentId: "PLANNER1",
    createdAt: "2026-03-09T00:01:00.000Z",
    updatedAt: "2026-03-09T00:01:00.000Z",
  });

  assert.deepEqual(
    listTasks(manifest).map((task) => task.task_id),
    ["TASK002", "TASK001"],
  );
  assert.equal(getTask(manifest, "TASK001")?.title, "First");
});
