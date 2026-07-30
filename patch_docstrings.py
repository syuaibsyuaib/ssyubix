"""
Script untuk memperbaiki docstring semua MCP tools di server.py
Mengganti docstring lama dengan versi yang lebih informatif sesuai standar Glama.
"""

import re

SOURCE = r"python\src\agentlink_mcp\server.py"

REPLACEMENTS = [
    # ─── agent_register ───────────────────────────────────────────────────────
    (
        r'    """\n    Daftarkan agent ke AgentLink\. Wajib dipanggil pertama\.\n    Tidak perlu tunnel — relay via Cloudflare Workers permanen\.\n\n    Args:\n        params: name \(opsional\)\n    Returns:\n        str: JSON berisi status agent\n    """',
        '''    """
    Daftarkan agent ke AgentLink. Wajib dipanggil pertama sebelum tools lain.

    Operasi ringan — tidak membuka WebSocket, hanya mengatur nama dan identitas lokal.
    Gunakan segera setelah startup, sebelum room_create atau room_join. Memanggil
    berulang aman dan idempoten (hanya memperbarui nama jika params.name diberikan).
    Stable agent identity ID dipertahankan antar-sesi secara otomatis via cache lokal.
    Relay via Cloudflare Workers permanen — tidak perlu tunnel atau konfigurasi server.

    Args:
        params.name (str, opsional): Nama display agent. Jika kosong, nama acak digunakan.

    Returns:
        str: JSON berisi name, server URL, stable_agent_identity_id, dan pesan konfirmasi.
    """'''
    ),
    # ─── room_create ──────────────────────────────────────────────────────────
    (
        r'    """\n    Buat room baru di Cloudflare\.\n\n    Public: siapa saja bisa join dengan room_id\.\n    Private: butuh room_id \+ token otomatis — bagikan ke peer\.\n\n    Args:\n        params: name \(nama room\), is_private \(True/False\)\n    Returns:\n        str: JSON berisi room_id dan token \(jika private\)\n    """',
        '''    """
    Buat room baru di Cloudflare. Menghasilkan room_id unik 6 karakter.

    Operasi mutasi — membuat room baru di Cloudflare Durable Object.
    Gunakan setelah agent_register. Setelah membuat room, jalankan room_join dengan
    room_id yang dihasilkan untuk masuk ke room tersebut. Gunakan room_join (bukan
    room_create) jika room sudah ada. Room public bisa diakses siapa saja via room_id.
    Room private menghasilkan token — bagikan room_id + token ke peer agar bisa join.

    Prasyarat: agent_register sudah dipanggil. Tidak perlu sudah join room.

    Args:
        params.name (str, 1-50 karakter, wajib): Nama display room.
        params.is_private (bool, default False): True = private room (butuh token untuk join).

    Returns:
        str: JSON berisi room_id, token (jika private), nama room, dan status pembuatan.
    """'''
    ),
    # ─── room_join ────────────────────────────────────────────────────────────
    (
        r'    """\n    Join room yang sudah ada\. Koneksi WebSocket ke Cloudflare terbentuk otomatis\.\n\n    Public: cukup room_id\. Private: butuh room_id \+ token dari owner\.\n\n    Args:\n        params: room_id \(6 karakter\), token \(opsional untuk private\)\n    Returns:\n        str: JSON info room \+ daftar agent yang sudah ada\n    """',
        '''    """
    Join room yang sudah ada. Membuka koneksi WebSocket ke Cloudflare relay secara otomatis.

    Operasi mutasi — menutup koneksi room sebelumnya jika ada dan membuka koneksi baru.
    Gunakan untuk room yang sudah dibuat oleh agent ini atau peer lain. Gunakan room_create
    jika room belum ada. Auto-reconnect aktif setelah room_join berhasil. Jika ada sesi
    tersimpan sebelumnya, pesan lokal di-restore dari cache secara otomatis.

    Peringatan: memanggil room_join saat sudah join room lain akan memutus koneksi
    room sebelumnya secara permanen (tidak bisa kembali tanpa room_join ulang).

    Prasyarat: agent_register sudah dipanggil.

    Args:
        params.room_id (str, 6 karakter, wajib, contoh: "ABC123"): ID room tujuan.
        params.token (str, opsional): Token private room — hanya untuk room is_private=True.

    Returns:
        str: JSON berisi room_id, my_agent_id, daftar agent yang sudah ada, dan sesi lokal.
    """'''
    ),
    # ─── room_leave ───────────────────────────────────────────────────────────
    (
        r'    """\n    Keluar dari room saat ini\.\n\n    Returns:\n        str: JSON status keluar\n    """',
        '''    """
    Keluar dari room saat ini dan tutup koneksi WebSocket.

    Operasi mutasi — menonaktifkan auto-reconnect, membersihkan retry queue lokal,
    dan menutup WebSocket. Setelah keluar, agent tidak menerima pesan baru sampai
    room_join dipanggil kembali. Operasi ini tidak menghapus room dari Cloudflare.
    Gunakan sebelum berganti room, lalu ikuti dengan room_join ke room lain.

    Prasyarat: harus sedang di dalam room (room_join sudah dipanggil).
    Error: mengembalikan error jika tidak sedang di dalam room.

    Returns:
        str: JSON berisi status keluar dan pesan konfirmasi.
    """'''
    ),
    # ─── room_list ────────────────────────────────────────────────────────────
    (
        r'    """\n    Lihat daftar room public yang aktif di Cloudflare\.\n\n    Returns:\n        str: JSON daftar room\n    """',
        '''    """
    Lihat daftar room public yang aktif di Cloudflare.

    Read-only — mengambil data dari relay Cloudflare, tidak mengubah state lokal.
    Hanya menampilkan room public. Room private tidak muncul di sini. Gunakan untuk
    menemukan room yang tersedia sebelum room_join. Tidak perlu sudah join room.
    Gunakan room_info untuk detail room yang sedang aktif saat ini.

    Prasyarat: agent_register sudah dipanggil (http_session aktif).

    Returns:
        str: JSON berisi daftar room public beserta jumlahnya.
    """'''
    ),
    # ─── room_info ────────────────────────────────────────────────────────────
    (
        r'    """\n    Info room saat ini: ID, status koneksi, agent ID\.\n\n    Returns:\n        str: JSON info room\n    """',
        '''    """
    Info lengkap room aktif saat ini: ID, nama, status koneksi, daftar peer, dan metadata.

    Read-only — namun memperbarui retry queue count dan mempersist state lokal sebagai
    efek samping ringan. Gunakan untuk memeriksa status koneksi, daftar peer, atau
    metadata room saat ini. Gunakan room_local_summary untuk snapshot cache offline tanpa
    memerlukan koneksi aktif. Gunakan agent_list untuk info identitas agent sendiri.

    Prasyarat: harus sedang join room (room_join sudah dipanggil).
    Error: mengembalikan error jika tidak sedang di dalam room.

    Returns:
        str: JSON berisi detail room, my_agent_id, stable_agent_identity_id, dan status connected.
    """'''
    ),
    # ─── room_local_summary ───────────────────────────────────────────────────
    (
        r'    """\n    Baca snapshot ringkasan room dari cache lokal device ini\.\n\n    Jika `room_id` kosong dan sedang join room, pakai room saat ini\.\n    Jika `room_id` kosong dan sedang offline, kembalikan semua snapshot lokal yang tersedia\.\n\n    Args:\n        params: room_id \(opsional\)\n    Returns:\n        str: JSON ringkasan snapshot lokal\n    """',
        '''    """
    Baca snapshot ringkasan room dari cache lokal device ini.

    Read-only — membaca dari disk lokal tanpa akses jaringan. Data bisa stale jika
    koneksi terputus lama (ditandai is_stale: true di hasil). Gunakan untuk triage
    pesan offline, fast recovery saat reconnect, atau memeriksa unread_count tanpa
    membuka inbox. Berbeda dengan room_info yang memerlukan koneksi aktif, tool ini
    berjalan sepenuhnya offline.

    Jika room_id kosong dan sedang join room: pakai snapshot room saat ini.
    Jika room_id kosong dan sedang offline: kembalikan semua snapshot lokal tersedia.

    Args:
        params.room_id (str, opsional, 6 karakter): ID room tertentu untuk dibaca.
            Kosongkan untuk pakai room aktif atau semua snapshot lokal.

    Returns:
        str: JSON snapshot lokal berisi summary, unread_count, peers, dan metadata cache.
    """'''
    ),
    # ─── capability_get_self ──────────────────────────────────────────────────
    (
        r'    """\n    Baca capability profile agent ini pada room yang sedang aktif\.\n\n    Returns:\n        str: JSON capability profile diri sendiri\n    """',
        '''    """
    Baca capability profile agent ini pada room yang sedang aktif.

    Read-only — mengambil profil dari Cloudflare relay, tidak mengubah state apapun.
    Gunakan sebelum capability_upsert_self untuk memeriksa profil terkini, atau untuk
    memverifikasi perubahan setelah upsert. Gunakan capability_upsert_self untuk membuat
    atau memperbarui profil. Gunakan capability_set_availability untuk update status
    ketersediaan saja.

    Prasyarat: harus sedang join room dan WebSocket aktif.

    Returns:
        str: JSON berisi capability profile lengkap: skills, availability, constraints, dll.
    """'''
    ),
    # ─── capability_upsert_self ───────────────────────────────────────────────
    (
        r'    """\n    Simpan atau perbarui capability card agent ini pada room aktif\.\n\n    Returns:\n        str: JSON status update \+ profile terbaru\n    """',
        '''    """
    Simpan atau perbarui capability card agent ini pada room aktif.

    Operasi mutasi — idempoten, hanya field yang dikirim yang diperbarui (partial update).
    Gunakan untuk mendaftarkan skills, mengatur availability, atau memperbarui metadata
    agent. Gunakan capability_set_availability jika hanya ingin update availability/load
    tanpa menyentuh field lain. Gunakan capability_remove_self untuk menghapus profil.

    Prasyarat: harus sedang join room dan WebSocket aktif.
    Side effect: profil tersimpan di Cloudflare relay dan terlihat oleh peer lain di room.
    Error: ACK timeout jika koneksi tidak stabil; perubahan mungkin tidak tersimpan.

    Args:
        params.summary (str, max 500 karakter, opsional): Ringkasan kemampuan agent.
        params.version (str, max 64 karakter, opsional): Versi capability card.
        params.availability (str, opsional): "available" | "busy" | "away" | "dnd".
        params.current_load (int 0-100, opsional): Beban kerja saat ini (harus <= max_concurrent_tasks).
        params.max_concurrent_tasks (int 1-100, opsional): Batas tugas paralel.
        params.tool_access (list[str], opsional): Daftar tool yang bisa diakses agent.
        params.constraints (list[str], opsional): Batasan atau guardrail agent.
        params.skills (list, opsional): Skill yang dideklarasikan — tiap skill wajib punya
            id (snake_case, max 64 karakter) dan name (max 80 karakter).

    Returns:
        str: JSON berisi status update dan capability profile terbaru.
    """'''
    ),
    # ─── capability_set_availability ─────────────────────────────────────────
    (
        r'    """\n    Update availability dan current load capability card agent ini\.\n\n    Returns:\n        str: JSON status update \+ profile terbaru\n    """',
        '''    """
    Perbarui availability dan beban kerja (current_load) capability card agent ini.

    Operasi mutasi ringan — hanya memperbarui availability dan current_load tanpa
    menyentuh skill, summary, atau field lain. Gunakan ini daripada capability_upsert_self
    jika hanya ingin mengubah status ketersediaan. Gunakan capability_upsert_self untuk
    update field lain sekaligus. Gunakan capability_get_self untuk membaca status terkini.

    Prasyarat: harus sedang join room dan WebSocket aktif.
    Side effect: status availability terlihat oleh peer lain di room secara real-time.

    Args:
        params.availability (str, wajib): Status ketersediaan agent —
            "available" (siap menerima tugas) | "busy" (sedang sibuk) |
            "away" (tidak aktif sementara) | "dnd" (tidak ingin diganggu).
        params.current_load (int 0-100, opsional): Perkiraan beban kerja saat ini
            (0 = kosong, 100 = penuh).

    Returns:
        str: JSON berisi status update dan capability profile terbaru.
    """'''
    ),
    # ─── capability_remove_self ───────────────────────────────────────────────
    (
        r'    """\n    Hapus capability card kustom agent ini dan kembali ke profil minimal room\.\n\n    Returns:\n        str: JSON status reset capability\n    """',
        '''    """
    Hapus capability card kustom agent ini dan kembalikan ke profil minimal room.

    Operasi mutasi destruktif — menghapus seluruh capability card kustom (skills,
    summary, constraints, dll). Profil kembali ke entri minimal yang dibuat otomatis
    saat room_join. Operasi ini tidak reversibel; gunakan capability_upsert_self
    untuk membuat ulang profil baru setelahnya.

    Prasyarat: harus sedang join room dan WebSocket aktif.
    Side effect: profil terhapus dari Cloudflare relay — peer lain tidak lagi melihat
    skills agent ini.

    Returns:
        str: JSON berisi status penghapusan dan profil minimal yang tersisa.
    """'''
    ),
    # ─── task_offer ───────────────────────────────────────────────────────────
    (
        r'    """\n    Tawarkan satu task delegasi ke agent tertentu pada room aktif\.\n\n    Returns:\n        str: JSON status offer \+ task terbaru\n    """',
        '''    """
    Tawarkan satu delegation task ke agent tertentu pada room aktif.

    Operasi mutasi — membuat task baru di Cloudflare relay dan mengirim offer ke
    agent tujuan. Agent penerima akan mendapat notifikasi di inbox-nya. Gunakan
    task_list atau resource ssyubix://rooms/{room_id}/tasks untuk memantau task.
    Gunakan agent_send untuk pesan bebas (bukan delegasi task terstruktur).

    Prasyarat: harus sedang join room, WebSocket aktif, dan agent tujuan ada di room.
    Side effect: task tersimpan di Cloudflare relay dan terlihat oleh semua agent di room.
    Error: ACK timeout jika koneksi tidak stabil; task mungkin tidak terkirim.

    Args:
        params.title (str, 1-140 karakter, wajib): Judul singkat task yang ditawarkan.
        params.to_agent_id (str, wajib): Agent ID penerima — ambil dari agent_list atau room_info.
        params.priority (str, default "normal"): Prioritas — "low" | "normal" | "high".
        params.point_of_contact_agent_id (str, opsional): Agent ID titik kontak follow-up.
            Default: pengirim offer (agent ini).

    Returns:
        str: JSON berisi task_id, status offer, resource_uri, dan detail task terbaru.
    """'''
    ),
    # ─── task_accept ──────────────────────────────────────────────────────────
    (
        r'    """\n    Terima delegation offer yang ditujukan ke agent ini\.\n    """',
        '''    """
    Terima delegation offer task yang ditujukan ke agent ini.

    Operasi mutasi — mengubah status task dari "offered" menjadi "accepted" di
    Cloudflare relay. Gunakan setelah menerima notifikasi offer di inbox
    (agent_read_inbox). Gunakan task_reject untuk menolak atau task_defer untuk
    menunda. Setelah accepted, task menjadi tanggung jawab agent ini.
    Tidak bisa di-unaccept — koordinasi manual diperlukan untuk membatalkan.

    Prasyarat: harus sedang join room, WebSocket aktif, dan task_id valid di room aktif.
    Side effect: status task diperbarui di relay; pengirim offer mendapat notifikasi.

    Args:
        params.task_id (str, wajib): ID task yang diterima — ambil dari agent_read_inbox
            atau task_list.
        params.reason (str, max 240 karakter, opsional): Catatan penerimaan (jarang diisi).

    Returns:
        str: JSON berisi task_id, status task terbaru, my_agent_id, dan resource_uri.
    """'''
    ),
    # ─── task_reject ──────────────────────────────────────────────────────────
    (
        r'    """\n    Tolak delegation offer yang ditujukan ke agent ini\.\n    """',
        '''    """
    Tolak delegation offer task yang ditujukan ke agent ini.

    Operasi mutasi — mengubah status task menjadi "rejected" di Cloudflare relay.
    Gunakan ketika tidak bisa atau tidak ingin mengerjakan task yang ditawarkan.
    Gunakan task_defer jika ingin menunda bukan menolak. Gunakan task_accept untuk
    menerima. Setelah rejected, pengirim offer mendapat notifikasi.

    Prasyarat: harus sedang join room, WebSocket aktif, dan task_id valid di room aktif.
    Side effect: status task diperbarui di relay; pengirim offer mendapat notifikasi.

    Args:
        params.task_id (str, wajib): ID task yang ditolak — ambil dari agent_read_inbox
            atau task_list.
        params.reason (str, max 240 karakter, opsional): Alasan penolakan — disarankan
            diisi agar pengirim bisa memahami dan mencari alternatif.

    Returns:
        str: JSON berisi task_id, status task terbaru, my_agent_id, dan resource_uri.
    """'''
    ),
    # ─── task_defer ───────────────────────────────────────────────────────────
    (
        r'    """\n    Tunda delegation offer yang ditujukan ke agent ini\.\n    """',
        '''    """
    Tunda delegation offer task yang ditujukan ke agent ini untuk ditinjau ulang nanti.

    Operasi mutasi — mengubah status task menjadi "deferred" di Cloudflare relay.
    Gunakan ketika tidak bisa langsung merespons tapi berencana meninjau ulang nanti.
    Berbeda dengan task_reject (penolakan final), defer memberi sinyal "belum bisa sekarang".
    Gunakan task_accept atau task_reject setelah siap merespons task yang ditunda.

    Prasyarat: harus sedang join room, WebSocket aktif, dan task_id valid di room aktif.
    Side effect: status task diperbarui di relay; pengirim offer mendapat notifikasi.

    Args:
        params.task_id (str, wajib): ID task yang ditunda — ambil dari agent_read_inbox
            atau task_list.
        params.reason (str, max 240 karakter, opsional): Alasan penundaan.
        params.deferred_until (str, opsional): Waktu ISO-8601 kapan task bisa ditinjau
            ulang, contoh: "2025-01-15T09:00:00Z".

    Returns:
        str: JSON berisi task_id, status task terbaru, my_agent_id, dan resource_uri.
    """'''
    ),
    # ─── task_list ────────────────────────────────────────────────────────────
    (
        r'    """\n    Lihat daftar delegation task pada room aktif\.\n    """',
        '''    """
    Lihat semua delegation task pada room aktif saat ini.

    Read-only — mengambil data dari Cloudflare relay, tidak mengubah status task apapun.
    Menampilkan semua task di room (offered, accepted, rejected, deferred). Gunakan
    task_get untuk detail satu task tertentu. Gunakan agent_read_inbox untuk notifikasi
    task real-time. Gunakan resource ssyubix://rooms/{room_id}/tasks untuk akses
    langsung via MCP resource.

    Prasyarat: harus sedang join room dan WebSocket aktif.

    Returns:
        str: JSON berisi daftar delegation task beserta status dan metadata masing-masing.
    """'''
    ),
    # ─── task_get ─────────────────────────────────────────────────────────────
    (
        r'    """\n    Baca satu delegation task dari room aktif\.\n    """',
        '''    """
    Baca detail satu delegation task dari room aktif berdasarkan task_id.

    Read-only — mengambil satu task dari Cloudflare relay tanpa mengubah statusnya.
    Gunakan setelah mendapat task_id dari task_offer, task_list, atau notifikasi inbox.
    Gunakan task_list untuk melihat semua task tanpa tahu task_id terlebih dahulu.

    Prasyarat: harus sedang join room, WebSocket aktif, dan task_id valid di room aktif.

    Args:
        params.task_id (str, wajib): ID task yang ingin dibaca — string non-kosong.

    Returns:
        str: JSON berisi detail task: judul, status, prioritas, pengirim, penerima, timestamps.
    """'''
    ),
    # ─── agent_send ───────────────────────────────────────────────────────────
    (
        r'    """\n    Kirim pesan langsung ke satu peer via Cloudflare relay\.\n\n    Args:\n        params: peer_id, message, msg_type \(\'text\'/\'data\'/\'command\'\)\n    Returns:\n        str: JSON status pengiriman\n    """',
        '''    """
    Kirim pesan langsung (point-to-point) ke satu peer via Cloudflare relay.

    Operasi mutasi — mengirim pesan ke satu agent tertentu. Jika peer offline atau
    koneksi terputus, pesan otomatis masuk ke retry queue lokal dan dikirim ulang saat
    koneksi pulih (maks 5 percobaan, TTL 6 jam default). Gunakan agent_broadcast untuk
    mengirim ke semua agent di room. Gunakan task_offer untuk delegasi task terstruktur.

    Prasyarat: harus sedang join room (WebSocket tidak harus aktif — ada retry queue).
    Side effect: pesan masuk ke inbox peer; jika gagal, masuk retry queue lokal.

    Args:
        params.peer_id (str, wajib): Agent ID penerima — ambil dari agent_list atau room_info.
        params.message (str, 1-10000 karakter, wajib): Isi pesan.
        params.msg_type (str, default "text"): Tipe pesan —
            "text" (teks biasa) | "data" (payload JSON) | "command" (instruksi ke peer).

    Returns:
        str: JSON berisi status delivered, recipient_count, message_id, sequence, dan retry info.
    """'''
    ),
    # ─── agent_broadcast ──────────────────────────────────────────────────────
    (
        r'    """\n    Kirim pesan ke semua agent di room via Cloudflare relay\.\n\n    Args:\n        params: message, msg_type\n    Returns:\n        str: JSON status broadcast\n    """',
        '''    """
    Kirim pesan ke semua agent yang online di room aktif via Cloudflare relay.

    Operasi mutasi — mengirim pesan ke seluruh agent yang sedang online di room. Jika
    tidak ada penerima aktif atau koneksi terputus, pesan masuk ke retry queue lokal.
    Gunakan agent_send untuk pesan private ke satu peer. Gunakan task_offer untuk
    delegasi task terstruktur (bukan pesan bebas).

    Prasyarat: harus sedang join room (WebSocket tidak harus aktif — ada retry queue).
    Side effect: pesan masuk ke inbox semua peer di room; jika gagal, masuk retry queue lokal.

    Args:
        params.message (str, wajib): Isi pesan broadcast.
        params.msg_type (str, default "text"): Tipe pesan —
            "text" (teks biasa) | "data" (payload JSON) | "command" (instruksi ke peer).

    Returns:
        str: JSON berisi status delivered, recipient_count, message_id, sequence, dan retry info.
    """'''
    ),
    # ─── agent_read_inbox ─────────────────────────────────────────────────────
    (
        r'    """\n    Baca pesan masuk dan event room \(join/leave\)\.\n\n    Args:\n        params: limit \(default 10\), clear \(hapus setelah dibaca\)\n    Returns:\n        str: JSON daftar pesan dan event\n    """',
        '''    """
    Baca pesan masuk dan event room (join/leave) dari inbox lokal.

    Membaca dari buffer lokal — tidak perlu akses jaringan. Menampilkan pesan dan event
    terbaru dari semua agent di room aktif. Gunakan only_unread=True untuk hanya melihat
    pesan baru. Gunakan mark_read=True (default) agar cursor baca diperbarui sehingga
    panggilan berikutnya tidak menampilkan pesan yang sama. Gunakan clear=True dengan
    hati-hati karena menghapus inbox tidak bisa dibatalkan.

    Prasyarat: tidak wajib join room — bisa membaca cache offline.
    Side effect: jika mark_read=True, cursor baca lokal diperbarui. Jika clear=True,
    seluruh inbox dihapus dari buffer dan cache lokal (tidak reversibel).

    Args:
        params.limit (int 1-100, default 10): Jumlah maksimal pesan yang dikembalikan.
        params.only_unread (bool, default False): True = hanya tampilkan pesan baru sejak
            last_read_sequence terakhir.
        params.mark_read (bool, default True): True = perbarui cursor baca lokal ke
            sequence tertinggi dari pesan yang dikembalikan.
        params.clear (bool, default False): True = hapus seluruh inbox setelah dibaca.
            Tidak reversibel — gunakan hanya jika yakin semua pesan sudah diproses.

    Returns:
        str: JSON berisi daftar pesan/event, unread_count, last_read_sequence, dan status inbox.
    """'''
    ),
    # ─── agent_list ───────────────────────────────────────────────────────────
    (
        r'    """\n    Lihat info agent ini: ID, nama, room, status koneksi\.\n\n    Returns:\n        str: JSON info agent\n    """',
        '''    """
    Lihat info identitas dan status koneksi agent ini (bukan daftar semua agent di room).

    Read-only — membaca state lokal, tidak ada akses jaringan. Menampilkan identitas,
    nama, room aktif, dan status WebSocket agent ini. Berbeda dengan room_info yang
    menampilkan state seluruh room termasuk peer lain, tool ini hanya menampilkan
    info self. Gunakan room_info untuk melihat daftar peer di room.

    Prasyarat: agent_register sudah dipanggil (tidak perlu join room).

    Returns:
        str: JSON berisi my_agent_id, my_name, stable_agent_identity_id, current_room,
            connected status, retry_queue_count, dan server URL.
    """'''
    ),
    # ─── room_admin_add ───────────────────────────────────────────────────────
    (
        r'    """\n    Jadikan agent aktif lain sebagai admin room saat ini\.\n\n    Hanya owner room yang boleh menjalankan aksi ini\.\n    """',
        '''    """
    Jadikan agent aktif lain sebagai admin room saat ini.

    Operasi mutasi — mengubah role agent dari "member" menjadi "admin" di Cloudflare relay.
    Hanya owner room yang boleh menjalankan aksi ini (agent yang membuat room).
    Gunakan room_admin_remove untuk mencabut role admin. Admin dapat mengelola member
    tapi tidak bisa mengganti owner. Perubahan role disiarkan ke semua agent di room.

    Prasyarat: harus sedang join room, WebSocket aktif, dan agent ini adalah owner room.
    Side effect: role agent target diperbarui di relay dan di semua client yang terhubung.

    Args:
        params.target_agent_id (str, wajib): Agent ID yang akan dijadikan admin.
            Harus agent yang sedang aktif di room — ambil dari room_info.

    Returns:
        str: JSON berisi status, room_id, target_agent_id, role baru, dan daftar admin terkini.
    """'''
    ),
    # ─── room_admin_remove ────────────────────────────────────────────────────
    (
        r'    """\n    Cabut role admin dari agent aktif lain pada room saat ini\.\n\n    Hanya owner room yang boleh menjalankan aksi ini\.\n    """',
        '''    """
    Cabut role admin dari agent aktif lain pada room saat ini.

    Operasi mutasi — mengubah role agent dari "admin" kembali ke "member" di Cloudflare relay.
    Hanya owner room yang boleh menjalankan aksi ini. Gunakan room_admin_add untuk
    memberikan role admin. Owner tidak bisa dicabut role-nya dengan tool ini.
    Perubahan role disiarkan ke semua agent di room.

    Prasyarat: harus sedang join room, WebSocket aktif, dan agent ini adalah owner room.
    Side effect: role agent target diperbarui di relay dan di semua client yang terhubung.

    Args:
        params.target_agent_id (str, wajib): Agent ID yang akan dicabut role admin-nya.
            Harus agent yang sedang aktif di room — ambil dari room_info.

    Returns:
        str: JSON berisi status, room_id, target_agent_id, role baru, dan daftar admin terkini.
    """'''
    ),
]


def apply_replacements(content: str) -> tuple[str, list[str]]:
    results = []
    for pattern, replacement in REPLACEMENTS:
        # Normalize CRLF -> LF for matching, then restore
        normalized = content.replace('\r\n', '\n')
        new_content = re.sub(pattern, replacement, normalized, count=1)
        if new_content == normalized:
            # Extract tool name from replacement for reporting
            first_line = replacement.strip().split('\n')[1].strip()
            results.append(f"  SKIP (not found): {first_line[:60]}")
        else:
            first_line = replacement.strip().split('\n')[1].strip()
            results.append(f"  OK: {first_line[:60]}")
            content = new_content.replace('\n', '\r\n')
    return content, results


if __name__ == "__main__":
    with open(SOURCE, 'r', encoding='utf-8') as f:
        original = f.read()

    updated, report = apply_replacements(original)

    print("=== Patch Report ===")
    for line in report:
        print(line)

    skipped = [r for r in report if r.startswith("  SKIP")]
    if skipped:
        print(f"\n{len(skipped)} replacement(s) not applied. Check patterns above.")
    else:
        with open(SOURCE, 'w', encoding='utf-8') as f:
            f.write(updated)
        print(f"\nAll {len(REPLACEMENTS)} replacements applied successfully.")
