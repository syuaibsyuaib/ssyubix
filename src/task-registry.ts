export const ROOM_TASK_REGISTRY_KEY = "room:tasks";

export const TASK_PRIORITY_VALUES = ["low", "normal", "high"] as const;
export const TASK_STATUS_VALUES = [
  "waiting_for_acceptance",
  "accepted",
  "rejected",
  "deferred",
] as const;
export const TASK_OFFER_STATE_VALUES = [
  "offered",
  "accepted",
  "rejected",
  "deferred",
] as const;
export const TASK_ACCEPTANCE_STATE_VALUES = [
  "pending",
  "accepted",
  "rejected",
  "deferred",
] as const;

export type TaskPriority = typeof TASK_PRIORITY_VALUES[number];
export type TaskStatus = typeof TASK_STATUS_VALUES[number];
export type TaskOfferState = typeof TASK_OFFER_STATE_VALUES[number];
export type TaskAcceptanceState = typeof TASK_ACCEPTANCE_STATE_VALUES[number];

export interface StoredTaskManifest {
  task_id: string;
  title: string;
  status: TaskStatus;
  offer_state: TaskOfferState;
  acceptance_state: TaskAcceptanceState;
  delegated_by: string;
  delegated_by_identity_id?: string;
  offered_to_agent_id: string;
  offered_to_identity_id?: string;
  responsible_agent_id: string | null;
  responsible_identity_id?: string;
  point_of_contact_agent_id: string;
  point_of_contact_identity_id?: string;
  created_at: string;
  updated_at: string;
  lease_until: string | null;
  priority: TaskPriority;
  visibility: "room";
  artifact_refs: unknown[];
  decision_refs: unknown[];
  watcher_ids: string[];
  mentioned_agent_ids: string[];
  response_reason: string | null;
  deferred_until: string | null;
}

export interface TaskRegistryManifest {
  updated_at: string;
  tasks: Record<string, StoredTaskManifest>;
}

function sanitizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function sanitizeOptionalString(value: unknown): string | undefined {
  const normalized = sanitizeString(value);
  return normalized || undefined;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (const entry of value) {
    const normalized = sanitizeString(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    items.push(normalized);
  }
  return items;
}

function sanitizeTaskPriority(value: unknown, fallback: TaskPriority = "normal"): TaskPriority {
  return typeof value === "string" && TASK_PRIORITY_VALUES.includes(value as TaskPriority)
    ? value as TaskPriority
    : fallback;
}

function sanitizeTaskStatus(
  value: unknown,
  fallback: TaskStatus = "waiting_for_acceptance",
): TaskStatus {
  return typeof value === "string" && TASK_STATUS_VALUES.includes(value as TaskStatus)
    ? value as TaskStatus
    : fallback;
}

function sanitizeOfferState(
  value: unknown,
  fallback: TaskOfferState = "offered",
): TaskOfferState {
  return typeof value === "string" && TASK_OFFER_STATE_VALUES.includes(value as TaskOfferState)
    ? value as TaskOfferState
    : fallback;
}

function sanitizeAcceptanceState(
  value: unknown,
  fallback: TaskAcceptanceState = "pending",
): TaskAcceptanceState {
  return typeof value === "string" && TASK_ACCEPTANCE_STATE_VALUES.includes(value as TaskAcceptanceState)
    ? value as TaskAcceptanceState
    : fallback;
}

function sanitizeIsoString(value: unknown, fallback: string | null = null): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  const normalized = value.trim();
  return Number.isNaN(Date.parse(normalized)) ? fallback : normalized;
}

function normalizeTask(
  existing: Partial<StoredTaskManifest> | undefined,
  params: {
    taskId: string;
    title: string;
    delegatedBy: string;
    delegatedByIdentityId?: string;
    offeredToAgentId: string;
    offeredToIdentityId?: string;
    pointOfContactAgentId: string;
    pointOfContactIdentityId?: string;
    createdAt: string;
    updatedAt: string;
    priority?: TaskPriority;
  },
): StoredTaskManifest {
  const previous = existing ?? {};
  return {
    task_id: params.taskId,
    title: sanitizeString(params.title, sanitizeString(previous.title, params.taskId)),
    status: sanitizeTaskStatus(previous.status, "waiting_for_acceptance"),
    offer_state: sanitizeOfferState(previous.offer_state, "offered"),
    acceptance_state: sanitizeAcceptanceState(previous.acceptance_state, "pending"),
    delegated_by: sanitizeString(previous.delegated_by, params.delegatedBy),
    delegated_by_identity_id: sanitizeOptionalString(
      previous.delegated_by_identity_id ?? params.delegatedByIdentityId,
    ),
    offered_to_agent_id: sanitizeString(previous.offered_to_agent_id, params.offeredToAgentId),
    offered_to_identity_id: sanitizeOptionalString(
      previous.offered_to_identity_id ?? params.offeredToIdentityId,
    ),
    responsible_agent_id:
      typeof previous.responsible_agent_id === "string" && previous.responsible_agent_id
        ? previous.responsible_agent_id
        : null,
    responsible_identity_id: sanitizeOptionalString(previous.responsible_identity_id),
    point_of_contact_agent_id: sanitizeString(
      previous.point_of_contact_agent_id,
      params.pointOfContactAgentId,
    ),
    point_of_contact_identity_id: sanitizeOptionalString(
      previous.point_of_contact_identity_id ?? params.pointOfContactIdentityId,
    ),
    created_at: sanitizeString(previous.created_at, params.createdAt),
    updated_at: params.updatedAt,
    lease_until: sanitizeIsoString(previous.lease_until),
    priority: sanitizeTaskPriority(previous.priority, params.priority ?? "normal"),
    visibility: "room",
    artifact_refs: Array.isArray(previous.artifact_refs) ? previous.artifact_refs : [],
    decision_refs: Array.isArray(previous.decision_refs) ? previous.decision_refs : [],
    watcher_ids: sanitizeStringArray(previous.watcher_ids),
    mentioned_agent_ids: sanitizeStringArray(previous.mentioned_agent_ids),
    response_reason: sanitizeString(previous.response_reason) || null,
    deferred_until: sanitizeIsoString(previous.deferred_until),
  };
}

function taskEquals(
  left: StoredTaskManifest | undefined,
  right: StoredTaskManifest,
): boolean {
  if (!left) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createTaskRegistryManifest(
  stored: Partial<TaskRegistryManifest> | undefined,
  now: string,
): TaskRegistryManifest {
  const tasks =
    stored && typeof stored.tasks === "object" && stored.tasks
      ? stored.tasks
      : {};
  return {
    updated_at: typeof stored?.updated_at === "string" ? stored.updated_at : now,
    tasks: tasks as Record<string, StoredTaskManifest>,
  };
}

export function createDelegationOffer(
  manifest: TaskRegistryManifest,
  params: {
    taskId: string;
    title: string;
    delegatedBy: string;
    delegatedByIdentityId?: string;
    offeredToAgentId: string;
    offeredToIdentityId?: string;
    pointOfContactAgentId: string;
    pointOfContactIdentityId?: string;
    createdAt: string;
    updatedAt: string;
    priority?: TaskPriority;
  },
): { changed: boolean; task: StoredTaskManifest } {
  const base = normalizeTask(manifest.tasks[params.taskId], params);
  const nextTask: StoredTaskManifest = {
    ...base,
    status: "waiting_for_acceptance",
    offer_state: "offered",
    acceptance_state: "pending",
    responsible_agent_id: null,
    responsible_identity_id: undefined,
    lease_until: null,
    response_reason: null,
    deferred_until: null,
    watcher_ids: sanitizeStringArray([
      ...base.watcher_ids,
      params.delegatedBy,
      params.offeredToAgentId,
    ]),
    mentioned_agent_ids: sanitizeStringArray([
      ...base.mentioned_agent_ids,
      params.offeredToAgentId,
    ]),
    updated_at: params.updatedAt,
  };
  const changed = !taskEquals(manifest.tasks[params.taskId], nextTask);
  if (changed) {
    manifest.tasks[params.taskId] = nextTask;
    manifest.updated_at = params.updatedAt;
  }
  return { changed, task: nextTask };
}

export function listTasks(manifest: TaskRegistryManifest): StoredTaskManifest[] {
  return [...Object.values(manifest.tasks)].sort((left, right) => {
    const updatedDiff = Date.parse(right.updated_at) - Date.parse(left.updated_at);
    if (!Number.isNaN(updatedDiff) && updatedDiff !== 0) {
      return updatedDiff;
    }
    return left.task_id.localeCompare(right.task_id, "en", { sensitivity: "base" });
  });
}

export function getTask(
  manifest: TaskRegistryManifest,
  taskId: string,
): StoredTaskManifest | null {
  return manifest.tasks[taskId] ?? null;
}

export function acceptDelegationOffer(
  manifest: TaskRegistryManifest,
  params: {
    taskId: string;
    actorAgentId: string;
    actorIdentityId?: string;
    updatedAt: string;
    leaseUntil: string | null;
  },
): { changed: boolean; task?: StoredTaskManifest; error?: string } {
  const task = manifest.tasks[params.taskId];
  if (!task) {
    return { changed: false, error: "Task tidak ditemukan." };
  }
  if (task.offered_to_identity_id) {
    if (task.offered_to_identity_id !== params.actorIdentityId) {
      return { changed: false, error: "Hanya agent tujuan yang boleh menerima task ini." };
    }
  } else if (task.offered_to_agent_id !== params.actorAgentId) {
    return { changed: false, error: "Hanya agent tujuan yang boleh menerima task ini." };
  }
  if (task.acceptance_state === "rejected") {
    return { changed: false, error: "Task yang sudah ditolak harus ditawarkan ulang, bukan diterima langsung." };
  }
  if (task.acceptance_state === "accepted") {
    return { changed: false, task };
  }
  const nextTask: StoredTaskManifest = {
    ...task,
    status: "accepted",
    offer_state: "accepted",
    acceptance_state: "accepted",
    responsible_agent_id: params.actorAgentId,
    responsible_identity_id: params.actorIdentityId,
    lease_until: params.leaseUntil,
    response_reason: null,
    deferred_until: null,
    updated_at: params.updatedAt,
  };
  const changed = !taskEquals(task, nextTask);
  if (changed) {
    manifest.tasks[params.taskId] = nextTask;
    manifest.updated_at = params.updatedAt;
  }
  return { changed, task: nextTask };
}

export function rejectDelegationOffer(
  manifest: TaskRegistryManifest,
  params: {
    taskId: string;
    actorAgentId: string;
    actorIdentityId?: string;
    updatedAt: string;
    reason?: string;
  },
): { changed: boolean; task?: StoredTaskManifest; error?: string } {
  const task = manifest.tasks[params.taskId];
  if (!task) {
    return { changed: false, error: "Task tidak ditemukan." };
  }
  if (task.offered_to_identity_id) {
    if (task.offered_to_identity_id !== params.actorIdentityId) {
      return { changed: false, error: "Hanya agent tujuan yang boleh menolak task ini." };
    }
  } else if (task.offered_to_agent_id !== params.actorAgentId) {
    return { changed: false, error: "Hanya agent tujuan yang boleh menolak task ini." };
  }
  if (task.acceptance_state === "rejected") {
    return { changed: false, task };
  }
  if (task.acceptance_state === "accepted") {
    return { changed: false, error: "Task sudah diterima dan tidak bisa ditolak lagi." };
  }
  const nextTask: StoredTaskManifest = {
    ...task,
    status: "rejected",
    offer_state: "rejected",
    acceptance_state: "rejected",
    responsible_agent_id: null,
    responsible_identity_id: undefined,
    lease_until: null,
    response_reason: sanitizeString(params.reason) || null,
    deferred_until: null,
    updated_at: params.updatedAt,
  };
  const changed = !taskEquals(task, nextTask);
  if (changed) {
    manifest.tasks[params.taskId] = nextTask;
    manifest.updated_at = params.updatedAt;
  }
  return { changed, task: nextTask };
}

export function deferDelegationOffer(
  manifest: TaskRegistryManifest,
  params: {
    taskId: string;
    actorAgentId: string;
    actorIdentityId?: string;
    updatedAt: string;
    deferredUntil: string | null;
    reason?: string;
  },
): { changed: boolean; task?: StoredTaskManifest; error?: string } {
  const task = manifest.tasks[params.taskId];
  if (!task) {
    return { changed: false, error: "Task tidak ditemukan." };
  }
  if (task.offered_to_identity_id) {
    if (task.offered_to_identity_id !== params.actorIdentityId) {
      return { changed: false, error: "Hanya agent tujuan yang boleh menunda task ini." };
    }
  } else if (task.offered_to_agent_id !== params.actorAgentId) {
    return { changed: false, error: "Hanya agent tujuan yang boleh menunda task ini." };
  }
  if (task.acceptance_state === "rejected") {
    return { changed: false, error: "Task yang sudah ditolak tidak bisa di-defer lagi." };
  }
  if (task.acceptance_state === "accepted") {
    return { changed: false, error: "Task yang sudah diterima tidak bisa di-defer lagi." };
  }
  const nextTask: StoredTaskManifest = {
    ...task,
    status: "deferred",
    offer_state: "deferred",
    acceptance_state: "deferred",
    responsible_agent_id: null,
    responsible_identity_id: undefined,
    lease_until: null,
    response_reason: sanitizeString(params.reason) || null,
    deferred_until: params.deferredUntil,
    updated_at: params.updatedAt,
  };
  const changed = !taskEquals(task, nextTask);
  if (changed) {
    manifest.tasks[params.taskId] = nextTask;
    manifest.updated_at = params.updatedAt;
  }
  return { changed, task: nextTask };
}
