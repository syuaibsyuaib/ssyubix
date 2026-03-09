export interface SequencedRoomPayload {
  room_id: string;
  message_id: string;
  sequence: number;
  timestamp: string;
}

export interface RoomMessagePayload extends SequencedRoomPayload {
  type: "message";
  from: string;
  from_name: string;
  content: unknown;
  msg_type: string;
  broadcast: boolean;
}

export interface RoomEventPayload extends SequencedRoomPayload {
  type: "event";
  event: string;
  agent_id: string;
  stable_agent_identity_id?: string;
  name: string;
  task_id?: string;
  task?: unknown;
  presence?: "online" | "offline";
  joined_at?: string;
  last_seen_at?: string;
  session_resumed?: boolean;
}

export interface AckPayload {
  type: "ack";
  action:
    | "send"
    | "broadcast"
    | "task_offer"
    | "task_accept"
    | "task_reject"
    | "task_defer"
    | "capability_upsert"
    | "capability_set_availability"
    | "capability_remove";
  room_id: string;
  request_id?: string;
  accepted: boolean;
  delivered: boolean;
  recipient_count: number;
  timestamp: string;
  message_id?: string;
  sequence?: number;
  task_id?: string;
  to?: string;
  broadcast?: boolean;
}

export function buildMessageId(roomId: string, sequence: number): string {
  return `${roomId}:${sequence}`;
}

export function createRoomMessage(params: {
  roomId: string;
  sequence: number;
  timestamp: string;
  from: string;
  fromName: string;
  content: unknown;
  msgType?: string;
  broadcast?: boolean;
}): RoomMessagePayload {
  return {
    type: "message",
    room_id: params.roomId,
    message_id: buildMessageId(params.roomId, params.sequence),
    sequence: params.sequence,
    timestamp: params.timestamp,
    from: params.from,
    from_name: params.fromName,
    content: params.content,
    msg_type: params.msgType || "text",
    broadcast: params.broadcast === true,
  };
}

export function createRoomEvent(params: {
  roomId: string;
  sequence: number;
  timestamp: string;
  event: string;
  agentId: string;
  stableAgentIdentityId?: string;
  name: string;
  taskId?: string;
  task?: unknown;
  presence?: "online" | "offline";
  joinedAt?: string;
  lastSeenAt?: string;
  sessionResumed?: boolean;
}): RoomEventPayload {
  return {
    type: "event",
    room_id: params.roomId,
    message_id: buildMessageId(params.roomId, params.sequence),
    sequence: params.sequence,
    timestamp: params.timestamp,
    event: params.event,
    agent_id: params.agentId,
    stable_agent_identity_id: params.stableAgentIdentityId,
    name: params.name,
    task_id: params.taskId,
    task: params.task,
    presence: params.presence,
    joined_at: params.joinedAt,
    last_seen_at: params.lastSeenAt,
    session_resumed: params.sessionResumed,
  };
}

export function createAck(params: {
  action:
    | "send"
    | "broadcast"
    | "task_offer"
    | "task_accept"
    | "task_reject"
    | "task_defer"
    | "capability_upsert"
    | "capability_set_availability"
    | "capability_remove";
  roomId: string;
  requestId?: string;
  accepted?: boolean;
  delivered: boolean;
  recipientCount: number;
  timestamp: string;
  messageId?: string;
  sequence?: number;
  taskId?: string;
  to?: string;
  broadcast?: boolean;
}): AckPayload {
  return {
    type: "ack",
    action: params.action,
    room_id: params.roomId,
    request_id: params.requestId,
    accepted: params.accepted ?? true,
    delivered: params.delivered,
    recipient_count: params.recipientCount,
    timestamp: params.timestamp,
    message_id: params.messageId,
    sequence: params.sequence,
    task_id: params.taskId,
    to: params.to,
    broadcast: params.broadcast,
  };
}
