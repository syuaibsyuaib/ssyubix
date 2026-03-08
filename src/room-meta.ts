export interface StoredRoomMeta {
  room_id: string;
  name: string;
  is_private: boolean;
  token: string;
  created_at: string;
  agent_count?: number;
}

export interface PublicRoomMeta {
  room_id: string;
  name: string;
  is_private: false;
  created_at: string;
  agent_count: number;
}

export function toPublicRoomMeta(room: StoredRoomMeta): PublicRoomMeta {
  return {
    room_id: room.room_id,
    name: room.name,
    is_private: false,
    created_at: room.created_at,
    agent_count: room.agent_count ?? 0,
  };
}

export function listPublicRooms(rooms: Iterable<StoredRoomMeta>): PublicRoomMeta[] {
  return [...rooms]
    .filter((room) => !room.is_private)
    .map(toPublicRoomMeta);
}
