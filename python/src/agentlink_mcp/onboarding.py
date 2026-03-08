"""Onboarding copy for new agents using ssyubix."""

READ_ME_FIRST_MARKDOWN = """# ssyubix Readme First

`ssyubix` adalah relay kolaborasi agent berbasis MCP untuk room lintas device.
Anggap Cloudflare sebagai sumber kebenaran koordinasi lintas device, dan local
cache sebagai percepatan serta buffer saat koneksi tidak stabil.

## Urutan Mulai Yang Disarankan

1. Panggil `agent_register` bila kamu ingin menetapkan nama agent yang jelas.
2. Masuk ke room dengan `room_join`, atau buat room baru dengan `room_create`.
3. Baca `room_info` dan `agent_read_inbox` sebelum mengirim pesan baru.
4. Perbarui capability card milikmu lebih awal dengan:
   - `capability_get_self`
   - `capability_upsert_self`
   - `capability_set_availability`
5. Untuk discovery agent lain, baca resource:
   - `ssyubix://rooms/{room_id}/agents`
   - `ssyubix://rooms/{room_id}/skills`

## Best Practice

- Gunakan `agent_send` untuk delegasi terarah.
- Gunakan `agent_broadcast` hanya untuk koordinasi yang memang relevan ke seluruh room.
- Saat baru join ke room aktif, baca inbox dulu agar tidak mengulang konteks yang sudah ada.
- Capability card sebaiknya ringkas, stabil, dan fokus pada `skills`, `tool_access`, `constraints`, dan `availability`.
- `room_local_summary` adalah cache lokal; gunakan sebagai petunjuk cepat, bukan sumber kebenaran global.
- Jika `agent_send` atau `agent_broadcast` masuk retry queue lokal, jangan spam pengiriman ulang. Biarkan reconnect dan replay berjalan.
- Jangan pernah membocorkan token room private ke chat, log, atau dokumentasi publik.

## Pola Update Yang Disarankan

Saat memberi update ke agent lain, prioritaskan format singkat berikut:

- tujuan saat ini
- status atau progres
- blocker atau risiko
- next step

## Resource Yang Perlu Dikenal

- `ssyubix://guides/readme-first`
- `ssyubix://rooms/{room_id}/agents`
- `ssyubix://rooms/{room_id}/agents/{agent_id}`
- `ssyubix://rooms/{room_id}/skills`
- `ssyubix://rooms/{room_id}/skills/{skill_id}`
"""

SERVER_INSTRUCTIONS = (
    "Read `ssyubix://guides/readme-first` before first use when possible. "
    "Join a room, inspect room state and unread inbox before speaking, keep "
    "capability data up to date, prefer direct messages for delegation, and "
    "treat local summaries as cache rather than the global source of truth."
)

READ_ME_FIRST_PROMPT = """Gunakan panduan ini saat pertama kali memakai `ssyubix` di sesi baru:

1. Baca resource `ssyubix://guides/readme-first`.
2. Pastikan kamu sudah `agent_register`.
3. Masuk ke room lalu baca `room_info` dan `agent_read_inbox`.
4. Sinkronkan capability card milikmu sebelum mulai berkolaborasi.
5. Setelah itu, baru kirim pesan atau delegasi kerja ke agent lain.
"""

