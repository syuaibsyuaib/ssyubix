export interface StoredRoomMeta {
  room_id: string;
  name: string;
  token: string;
  created_at: string;
  owner_stable_identity_id?: string;
  admin_stable_identity_ids?: string[];
  /** Kuasa per admin; lihat `room-roles.ts`. Room lama tidak punya field ini. */
  admin_powers?: Record<string, string[]>;
  agent_count?: number;
}

/**
 * Statistik agregat untuk dashboard publik.
 *
 * Semua room bersifat private, jadi bentuk ini sengaja tidak memuat room_id,
 * nama room, maupun token — hanya angka yang tidak bisa dipakai untuk join.
 */
export interface RoomActivityStats {
  active_room_count: number;
  total_room_count: number;
  total_agent_count: number;
  window_days: number;
  generated_at: string;
}

/**
 * Room warisan mode publik tersimpan tanpa token join, sehingga tidak punya
 * kunci yang bisa diverifikasi. Registry menolaknya, jadi room seperti ini
 * permanen tidak bisa dimasuki dan aman dibuang.
 *
 * Sengaja hanya token yang diperiksa: umur room, nama, dan kepemilikan tidak
 * boleh ikut menentukan, supaya tidak ada room hidup yang ikut terhapus.
 */
export function isUnjoinableRoom(room: Pick<StoredRoomMeta, "token">): boolean {
  return typeof room.token !== "string" || room.token.length === 0;
}

/** Room dihitung "aktif" bila dibuat dalam rentang hari ini. */
export const ROOM_ACTIVITY_WINDOW_DAYS = 3;

const WINDOW_MS = ROOM_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export function summarizeRoomActivity(
  rooms: Iterable<StoredRoomMeta>,
  now: Date = new Date(),
): RoomActivityStats {
  const nowMs = now.getTime();
  let active_room_count = 0;
  let total_room_count = 0;
  let total_agent_count = 0;

  for (const room of rooms) {
    total_room_count += 1;
    const createdMs = new Date(room.created_at).getTime();
    if (!Number.isFinite(createdMs) || nowMs - createdMs > WINDOW_MS) continue;
    active_room_count += 1;
    total_agent_count += room.agent_count ?? 0;
  }

  return {
    active_room_count,
    total_room_count,
    total_agent_count,
    window_days: ROOM_ACTIVITY_WINDOW_DAYS,
    generated_at: now.toISOString(),
  };
}
