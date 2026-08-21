# Task: Perbaikan Score Glama — ssyubix

**Tujuan:** Meningkatkan score Glama dari 83% dengan memperbaiki docstring 23 MCP tools.

**Masalah utama:**
- Usage Guidelines: 1–2/5 (tidak ada panduan kapan pakai vs. alternatif)
- Behavior disclosure: 2/5 (tidak disclose mutasi/read-only, reversible, side effects)
- Parameter semantics: 2/5 (Glama tidak membaca Pydantic Field — harus kompensasi di docstring)

**File target:** `python/src/agentlink_mcp/server.py`

---

## Progress Docstring Update

- [x] agent_register
- [x] room_create
- [x] room_join
- [x] room_leave
- [x] room_list
- [x] room_info
- [x] room_local_summary
- [x] capability_get_self
- [x] capability_upsert_self
- [x] capability_set_availability
- [x] capability_remove_self
- [x] task_offer
- [x] task_accept
- [x] task_reject
- [x] task_defer
- [x] task_list
- [x] task_get
- [x] agent_send
- [x] agent_broadcast
- [x] agent_read_inbox
- [x] agent_list
- [x] room_admin_add
- [x] room_admin_remove

## Status
- [x] Unit test passed (35/35, `pytest` di `python/`)


---

# Task: Room Dashboard (agentlink-rooms-frontend → src/public)

**Tujuan:** Integrasikan dashboard HTML (hasil scaffold Cloudflare AI, awalnya di folder
terpisah `agentlink-rooms-frontend` dengan nested git) untuk menampilkan daftar room
aktif 3 hari terakhir, memanfaatkan endpoint `GET /rooms` yang sudah ada di Worker utama.

**Keputusan arsitektur:** Digabung ke Worker utama (`src/`) via Cloudflare Workers
Static Assets, disajikan di path `/dashboard` — bukan Worker terpisah. Alasan:
`GET /rooms` sudah ada dan bentuk datanya (`room_id`, `name`, `created_at`,
`agent_count`) sudah cocok 1:1 dengan yang dibutuhkan dashboard.

## Yang sudah dikerjakan
- [x] Review kode `index.html` (kontras warna WCAG AA, `aria-live` status region,
      escape `room_id`, `:focus-visible`, responsive stat cards di layar sempit)
- [x] File final: `src/public/dashboard/index.html`
- [x] `src/wrangler.jsonc` — tambah blok `assets` (`directory: ./public`, `binding: ASSETS`)
- [x] Hapus folder lama `agentlink-rooms-frontend` (termasuk nested `.git`-nya)
- [x] Jalankan seluruh unit test Worker (6 file, bukan cuma 3 yang dijalankan CI)
- [x] Validasi bundle via `wrangler deploy --config src/wrangler.jsonc --dry-run`

## Hasil validasi
- Unit test: **36/36 pass** (setelah fix di bawah).
- Dry-run deploy: sukses. Binding `env.ASSETS` terpasang berdampingan dengan
  `AGENTLINK_ROOM` & `AGENTLINK_REGISTRY` tanpa konflik.

## Fix tambahan: 2 test gagal di message-protocol.test.ts (pre-existing, tidak
terkait dashboard — ditemukan saat validasi, sekalian diperbaiki)
- **Akar masalah:** `createRoomEvent`/`createAck` di `message-protocol.ts` selalu
  menuliskan key `role_label`, `room_roles`, `target_agent_id`,
  `target_stable_identity_id`, `target_role_label` (nilai `undefined` kalau tidak
  di-pass). Field ini ditambahkan belakangan (fitur room-roles) tapi
  `message-protocol.test.ts` (pakai `node:assert/strict`, jadi `deepEqual` = strict)
  tidak pernah diupdate — objek `{key: undefined}` dianggap beda dari `{}` di strict
  mode. Bukan bug runtime: `JSON.stringify()` sudah membuang key `undefined` sebelum
  dikirim ke client, jadi tidak ada dampak ke behavior WebSocket.
- **Fix:** tambahkan 5 field itu (value `undefined`) ke `expected` object di 2 test
  (`createRoomEvent`, `createAck`) supaya sesuai bentuk payload saat ini. Test-only
  change, tidak menyentuh `message-protocol.ts`.

## Belum dikerjakan
- [x] Commit + push perubahan ke branch main — sudah masuk main & origin/main
      (commit `5c2f732` "ssyubix" dan `11234c9` "Dashboard for looking up active public rooms").
- [x] Deploy sungguhan (`wrangler deploy` tanpa `--dry-run`) — sudah dijalankan manual
      oleh user (2026-08-19).

---

# Task: Hapus sistem room publik — semua room private

> dari syuaib:
> sediakan sistem keamanan room, tidak perlu ada room public, hanya ada room yang
> terkunci dan hanya bisa dimasuki oleh agent yang memiliki kuncinya

**Tujuan:** Tidak ada lagi room publik. Setiap room wajib pakai kode kunci (token)
untuk join, dan tidak ada permukaan apa pun untuk menemukan room tanpa token.

**Keputusan (dikonfirmasi user):**
1. `GET /rooms` diubah jadi **statistik agregat anonim**, bukan dihapus — dashboard
   tetap hidup sebagai halaman aktivitas relay. Tidak ada `room_id`/nama/token yang dikirim.
2. `is_private` **dihapus dari schema** (bukan diterima-lalu-diabaikan), supaya caller
   lama gagal keras dengan error validasi, bukan gagal diam-diam.

## Worker (`src/`)
- [x] `room-meta.ts` — `listPublicRooms`/`toPublicRoomMeta` diganti `summarizeRoomActivity`
      yang hanya mengembalikan `active_room_count`, `total_room_count`,
      `total_agent_count`, `window_days`, `generated_at`.
- [x] `POST /rooms` — selalu generate token; parameter `is_private` dibuang dari body handler.
- [x] `GET /rooms` — mengembalikan statistik agregat, tidak pernah membocorkan identitas room.
- [x] Registry `check` — token kini **wajib** untuk semua room (dulu hanya kalau `is_private`).
- [x] Payload `welcome` — `is_private` di-hardcode `true`.
- [x] `room-meta.test.ts` — ditulis ulang; ada test eksplisit bahwa output tidak
      mengandung room_id/nama/token.

## Dashboard (`src/public/index.html`)
- [x] Dari daftar room → panel statistik + penjelasan kenapa daftar room tidak ditampilkan.
- [x] Aksesibilitas lama dipertahankan (`aria-live` status, `:focus-visible`, responsive).
- [x] **Dipindah dari `/dashboard` ke root `/`** (file: `src/public/dashboard/index.html`
      → `src/public/index.html`). Static Assets melayani `/` sebelum Worker jalan, jadi
      JSON info server dipindah dari `GET /` ke `GET /info`, dan `/dashboard` +
      `/dashboard/` dibuat 301 redirect ke `/` supaya link lama tidak mati.

## Python MCP (`python/`)
- [x] `CreateRoomInput.is_private` dihapus (`extra="forbid"` → caller lama error jelas).
- [x] `JoinRoomInput.token` jadi **wajib** (`min_length=1`), tidak lagi `Optional`.
- [x] Tool `room_list` **dihapus** — fungsinya cuma menemukan room publik, yang kini
      mustahil; menyisakannya akan menyesatkan agent.
- [x] Docstring `room_create` & `room_join` diperbarui (token wajib, sekali tampil).
- [x] 4 test baru di `PrivateOnlyRoomTests`.

## Dokumentasi
- [x] `README.md` + `python/README.md` — bullet `room_list` dihapus, deskripsi dashboard
      & aturan token ditambahkan.
- [x] `docs/room-token-rotation.md` — pengecualian "public rooms" dihapus; rotasi kini
      berlaku untuk semua room.
- [x] `onboarding.py` — readme-first menegaskan token wajib.

## Hasil validasi
- Worker unit test: **38/38 pass** (6 file).
- Python unit test: **39/39 pass** (35 lama + 4 baru).
- `wrangler deploy --dry-run`: sukses, binding `ASSETS` tetap terpasang.
- Uji end-to-end di `wrangler dev --local`:
  - `GET /rooms` → agregat saja, tidak ada ID/nama/token.
  - `POST /rooms` dengan `is_private: false` → tetap private + token (tidak bisa opt out).
  - Akses room tanpa token → **403**; token salah → **403**; token benar → **200**.
  - `/` → halaman dashboard render benar (HTML, bukan JSON), tanpa error console.
  - `/info` → JSON info server.
  - `/dashboard` dan `/dashboard/` → **301** ke `/`.

## Catatan penting
- **Room lama warisan mode publik tersimpan dengan `token: ""`.** Room seperti itu kini
  ditolak (`check` menolak room tanpa token) daripada dibiarkan bisa dimasuki tanpa kunci.
  Konsekuensinya: room publik yang sudah ada **tidak bisa dimasuki lagi** — pengguna harus
  membuat room baru. Ini konsekuensi langsung dari "hapus sistem room publik".
- **Breaking change untuk client lama:** `room_join` tanpa token dan `room_create` dengan
  `is_private` akan error. Sudah di-bump ke **3.0.0** (major, sesuai SemVer).

---

# Task: UI web room (form masuk + lobby + tab)

**Tujuan:** Halaman root bisa dipakai masuk ke room lewat kunci, lalu menampilkan daftar
agent di room, terbagi jadi beberapa bagian dengan lobby sebagai default.

**Keputusan (dikonfirmasi user):**
1. **Tidak ada daftar room.** Masuk lewat form berisi input Room ID + input kunci.
   Menampilkan daftar room akan membatalkan keputusan privasi sebelumnya.
2. Kunci disimpan di **sessionStorage** — hilang saat tab ditutup.
3. Bagian yang dibangun: Lobby, Pekerjaan (rincian + progres), Skills, dan detail agent.

## Worker
- [x] Token bisa dikirim lewat header `X-Room-Token`, bukan cuma `?token=`
      (helper `readRoomToken`). Query param dipertahankan untuk MCP client lama.
      Alasan: kunci di URL bocor ke history, header `Referer`, dan log akses.
- [x] CORS `Access-Control-Allow-Headers` ditambah `X-Room-Token`.
- [x] WebSocket `/connect` tetap pakai query param — browser tidak bisa set header
      di WebSocket upgrade, dan MCP client memang lewat situ.

## UI (`src/public/index.html`)
- [x] **Gate**: statistik agregat + form Room ID & kunci. Kunci dikirim via header.
- [x] **Lobby** (default): daftar agent + presence, availability, beban kerja, jumlah skill.
- [x] **Detail agent**: profil lengkap — summary, skills+tags, tool_access, constraints,
      beban kerja, waktu bergabung & terakhir terlihat.
- [x] **Pekerjaan**: daftar task + bar progres per status + detail per task
      (tahap siklus, penanggung jawab, alasan jawaban, watcher).
- [x] **Skills**: indeks skill + agent penyedianya.
- [x] Polling 20 detik, berhenti saat tab tidak terlihat.
- [x] Kunci dicabut saat halaman terbuka → otomatis balik ke form dengan pesan jelas.
- [x] Aksesibilitas: `aria-live` status, `aria-selected` pada tab, `aria-label` pada
      kartu yang bisa diklik, `:focus-visible`, `meta referrer=no-referrer`.
- [x] UI adalah **pengamat murni** — baca lewat REST, tidak pernah ikut jadi agent di room.

## Hasil validasi
- Worker unit test **38/38**, Python **39/39**, `wrangler deploy --dry-run` sukses.
- Uji end-to-end di relay lokal dengan data nyata (3 agent + 4 task + 4 skill via WebSocket):
  - Header token benar → **200**; salah → **403**; tanpa token → **403**;
    `?token=` lama → **200** (kompatibilitas terjaga).
  - Kunci salah di form → pesan "Room ID atau kunci salah", tidak masuk.
  - Kunci benar → lobby tampil; keempat status task ter-render benar
    (diterima / menunggu / ditunda / ditolak).
  - Reload → sesi pulih dari sessionStorage; "Keluar" → sessionStorage bersih.
  - **Log akses relay: nol `?token=`** — kunci tidak pernah masuk URL.

## Catatan
- Model task **tidak punya status "selesai"** (`waiting_for_acceptance`, `accepted`,
  `rejected`, `deferred`). Jadi "progres" ditampilkan sebagai tahap penerimaan delegasi,
  bukan persentase penyelesaian. Kalau ingin progres pengerjaan sungguhan, relay perlu
  status baru (mis. `in_progress`, `done`) — belum ada.

## Sudah dikerjakan
- [x] Commit + push (3 commit) dan [PR #47](https://github.com/syuaibsyuaib/ssyubix/pull/47) — sudah di-merge.
- [x] Bump versi ke **3.0.0** dan publish ke PyPI lewat tag `v3.0.0`
      (Trusted Publishing/OIDC, tanpa API token). Diverifikasi dengan mengunduh
      wheel dari PyPI: `room_list` hilang, `is_private` hilang, token wajib.
- [x] Deploy Worker ke production (versi `7267a4ec`, dari branch atas persetujuan user).

---

# Task: Bersihkan room mati warisan mode publik

**Tujuan:** Buang entri registry untuk room yang sudah tidak bisa dimasuki siapa pun
setelah semua room jadi private.

## Yang dibangun
- [x] `isUnjoinableRoom()` di `room-meta.ts` — **hanya** memeriksa token, sengaja
      mengabaikan umur/nama/kepemilikan supaya tidak ada room hidup yang terjaring.
- [x] Aksi `prune-unjoinable` di registry DO, hapus di-chunk 128 key (batas storage).
- [x] `POST /admin/prune-rooms` dengan tiga lapis pengaman:
      404 bila `REGISTRY_ADMIN_TOKEN` tidak diset · butuh header `X-Admin-Token`
      (dibanding waktu-konstan) · **default dry-run**, hapus hanya dengan `confirm=true`.
- [x] 2 test baru (total Worker 40/40).

## Hasil di production (19 Agu 2026)
| | |
|---|---|
| Sebelum | 104 room |
| Terdeteksi mati (tanpa token) | **65** |
| Dipertahankan (punya token) | **39** |
| Terhapus | **65** |
| Sesudah | **39 room** |

Verifikasi: `total_room_count` 104 → 39; room sampel (`24X3YH`, `44BVG2`, `9BEEPE`)
balas "tidak ditemukan"; `active_room_count` tetap 1 — room bertoken yang dibuat hari
itu **selamat**, bukti room hidup tidak ikut terhapus.

## Catatan
- **Storage Durable Object milik 65 room itu tidak ikut terhapus** — hanya entri
  registry. Isinya (pesan, capability, task) jadi yatim: tidak bisa dijangkau, tapi
  masih ada. Untuk membersihkannya perlu tiap room DO menghapus isinya sendiri.
- Endpoint `/admin/prune-rooms` sengaja dibiarkan hidup (keputusan user), terkunci secret.

## Sudah selesai
- [x] [PR #48](https://github.com/syuaibsyuaib/ssyubix/pull/48) (CI Node 22) — di-merge.
- [x] Commit prune sudah masuk `main` lewat [PR #49](https://github.com/syuaibsyuaib/ssyubix/pull/49).
- [x] **Bug `agent_count`** — diperbaiki, lihat bagian di bawah.

---

# Task: Rilis 3.0.1 — endpoint default menunjuk host mati

**Ditemukan saat menilai apakah README benar-benar mengajari orang memakai AgentLink.**

Commit `5c2f732` mengganti nama Worker dari nama produk (`agentlink`) ke nama brand
(`ssyubix`). Hostname lama berhenti ada — Cloudflare error 1042 — tapi default di
klien Python tidak ikut pindah. Akibatnya **setiap install tanpa `AGENTLINK_URL`
memanggil host yang tidak ada**, dan errornya (`404` + keluhan mimetype JSON) sama
sekali tidak menyebut bahwa endpoint-nya lenyap.

Sudah terlanjur beredar di PyPI 3.0.0, jadi dirilis sebagai **3.0.1**, bukan ditahan.

- [x] `DEFAULT_AGENTLINK_URL` → `https://ssyubix.syuaibsyuaib.workers.dev`
- [x] 4 test penjaga: nilai persis, larangan kembali ke host pensiun, bentuk origin
      `https` telanjang, dan **kedua README wajib menyebut endpoint yang sama**.
      Test terakhir **gagal di jalan pertama** dan langsung menangkap README basi.
- [x] README: endpoint mati, 3 tool hilang (`room_local_summary`, `room_admin_add`,
      `room_admin_remove`), contoh use case yang join lewat *nama* room tanpa token,
      alur create→bagikan→join yang tak pernah dijelaskan, "Pekerjaan" yang tertinggal,
      wrangler 4.71.0, dan URL badge Glama yang hanya jalan lewat 301.
- [x] Bagian konfigurasi **OpenCode** — disebut 4 kali di README tapi tak pernah
      dijelaskan. Formatnya beda di 3 hal: `mcp` bukan `mcpServers`, `command` berupa
      array gabungan, `environment` bukan `env`.

**Catatan rilis:** tag `v3.0.1` awalnya menunjuk commit yang masih berisi `3.0.0`,
jadi workflow membangun 3.0.0 dan ditolak PyPI sebagai duplikat. Rilis akhirnya lewat
`workflow_dispatch`. Tag lalu dipindahkan ke commit yang benar, setelah
[PR #54](https://github.com/syuaibsyuaib/ssyubix/pull/54) menambahkan `skip-existing`
supaya rilis ulang tidak gagal hanya karena versinya sudah terbit.

---

# Task: Semua teks jadi bahasa Inggris

- [x] **UI web** — judul, label, tombol, empty state, error, nama tab, `aria-label`,
      pengumuman pembaca layar. Format tanggal `id-ID` → `en-GB`, dan jamak dipilih
      sesuai angka (tadinya "2 skill", "1 tasks").
- [x] **Semua pesan relay & klien** — error validasi/otorisasi, penolakan capability
      & task registry, ACK timeout, pesan retry queue, teks sambutan room, deskripsi
      parameter tool MCP, dan panduan `ssyubix://guides/readme-first`.
- [x] Komentar kode **tetap Indonesia**, mengikuti konvensi codebase.

**Jebakan:** 3 assertion test ditulis sebagai **regex**, bukan string berkutip, jadi
lolos dari penyaringan pertama dan baru ketahuan saat suite memerah.

---

# Task: Perbaikan dari pengujian nyata (Antigravity + OpenCode + Claude Code)

Semua di bawah ini lahir dari **menjalankan** AgentLink lintas tiga app, bukan dari
membaca kode.

## `agent_count` selalu nol — bug sejak commit dashboard `11234c9`
- [x] Field `agent_count` dideklarasikan tapi **tidak pernah ditulis** ke registry,
      jadi selalu jatuh ke `?? 0`. Dashboard lama pun angkanya fiktif.
- [x] Room DO kini melaporkan sendiri jumlahnya. Tiga keputusan menjaganya murah:
      **nilai absolut** (bukan selisih, jadi galat tidak menumpuk saat putus koneksi
      tidak bersih), menumpang **alarm debounce 5 detik** yang sudah ada (bukan jalur
      join), dan **dilewati kalau angkanya tidak berubah**.
- [x] Room perlu menyimpan ID-nya sendiri — DO tidak tahu ID-nya di luar konteks
      request, padahal alarm butuh itu justru saat agent terakhir sudah keluar.

## Oracle keberadaan room
- [x] "Token salah" vs "room tidak ditemukan" adalah oracle: memastikan sebuah Room ID
      **ada** tanpa perlu tokennya. Kini satu pesan seragam. Kasus "tanpa token" tetap
      punya pesan sendiri, tapi diperiksa **sebelum** room dibaca.
- [x] Perbandingan token pakai helper waktu-konstan.

## UI berkedip tiap 20 detik
- [x] `renderActiveTab` mengosongkan panel jadi "Loading…" tiap polling. Kini
      penyegaran latar belakang melewati placeholder, dan `setBody` melewati penulisan
      DOM bila markup-nya sama.
- **Pengukuran pertama saya tidak sah**: pane browser di latar belakang,
  `document.hidden` true, badan polling tidak pernah jalan — "tidak berkedip" saat itu
  cuma berarti "tidak ada polling".

## Capability tidak bisa diperbarui sebagian
- [x] Docstring menjanjikan patch parsial dan `current_load` opsional; **keduanya
      mustahil**. Validator sudah benar (`"key" in input`) — yang merusak adalah kedua
      handler pesan yang menyusun ulang payload dengan **menyebut semua field**, jadi
      field yang tidak dikirim tetap hadir bernilai `undefined` lalu ditolak.
- [x] 3 test, termasuk kebalikannya: key yang **ada tapi undefined** harus tetap ditolak.
- Dugaan saya soal bug ketiga (`capability_get_self` mengembalikan None) **salah** —
  profilnya bersarang di kunci `agent`, saya membacanya di tingkat atas.

## Semua agent di satu perangkat jadi `owner`
- [x] Identitas stabil dikunci **hanya** oleh endpoint relay, jadi setiap app di satu
      mesin membaca berkas yang sama — bukan tiga agent dengan satu alamat, melainkan
      **satu identitas memakai tiga nama**. Relay mencocokkan kepemilikan lewat
      identitas itu, jadi semuanya jadi owner.
- [x] Identitas kini juga dikunci `AGENT_NAME`. Install tanpa `AGENT_NAME` memakai
      jalur lama, jadi tidak ada identitas yang berubah diam-diam saat upgrade.
- [x] Diuji dengan 3 proses terpisah berbagi state dir: pembuat `owner`, dua penggabung
      `member`.
- **Konsekuensi:** kepemilikan mengikuti `AGENT_NAME`. Ganti nama = identitas baru =
  kehilangan owner atas room lama. Bisa dipulihkan: kembalikan nama, atau pin
  `SSYUBIX_STABLE_AGENT_IDENTITY_ID`. Keduanya sudah diuji berhasil.

## Admin sebagai himpunan kuasa (model WhatsApp, tanpa promosi otomatis)
- [x] **Temuan:** peran `admin` selama ini **tidak memberi kuasa apa pun**. Dua-satunya
      aksi yang dijaga peran menuntut *owner*, jadi admin sama saja dengan member.
- [x] `room_admin_add` menerima `powers` opsional — kosongkan untuk mewariskan seluruh
      kuasa, sebut sebagian untuk delegasi sempit. Himpunan dimulai `grant_admin` +
      `revoke_admin`; ban/kick/rotasi token nanti tinggal menambah nilai.
- [x] Tiga aturan: **tidak boleh memberi kuasa yang tidak dimiliki** (anti-eskalasi
      lewat perantara), owner punya semua kuasa implisit & tak bisa dicopot,
      pencopotan menghapus kuasanya sekaligus.
- [x] Admin dari room lama **tidak punya kuasa** — persis yang label itu berikan
      sebelumnya. Upgrade tidak boleh menyerahkan wewenang yang tak pernah dimiliki.
- **Keputusan user:** tidak ada promosi otomatis. Admin tidak aktif adalah urusan room
  itu sendiri. Di sinilah model berpisah dari WhatsApp, yang memilih anggota acak demi
  menghindari grup tanpa admin.

## Handle agent yang bisa dibaca manusia
- [x] Nama agent tidak unik — di pengujian nyata muncul dua baris `claude-code-agent`
      yang hanya bisa dibedakan lewat ID 8 karakter.
- [x] Lobby kini memakai handle **hewan + warna + kata kerja** (`raven-indigo-charts`),
      dengan nama asli diredam di bawahnya. ID mentah hilang dari kartu, tetap terlihat
      saat agent diklik.
- [x] Diturunkan dari **identitas stabil**, bukan `agent_id` — `agent_id` berganti tiap
      sesi, jadi handle-nya akan berubah tiap reconnect dan tidak berguna diingat.
      Nama agent sengaja bukan bahan, supaya dua app ber-`AGENT_NAME` sama tetap beda.
- [x] 32 × 16 × 32 = 16.384 kombinasi; 1000 identitas acak → 963 handle unik. Bentrok
      ditangani sufiks potongan `agent_id`.

## Hasil validasi
- Worker **52/52**, Python **47/47**, `wrangler deploy --dry-run` bersih.
- Paket terbangun & terverifikasi dari PyPI sebagai `ssyubix-3.0.1`.

---

# Audit keamanan endpoint (19 Agu 2026)

Diuji langsung ke production, bukan dibaca dari kode.

| Permukaan | Hasil |
|---|---|
| `GET /` | halaman statis, nol pola rahasia |
| `GET /info` | nama/versi/daftar endpoint, tanpa info akun |
| `GET /rooms` | agregat saja |
| `/capabilities/*`, `/tasks/*`, `WS /connect/*` | **403** tanpa token |
| `POST /admin/prune-rooms` | **403** tanpa secret; GET → 404 |
| `/.env`, `/wrangler.jsonc`, `/index.ts`, `/src/index.ts` | semua **404** |

- **Isolasi antar-room diuji dua arah:** token room A ditolak di room B pada
  capabilities, tasks, dan WebSocket.
- **Tidak ada kebocoran data.**

## Temuan
- **`POST /rooms` tanpa autentikasi.** Dibuktikan: 15 room dibuat berurutan tanpa
  kredensial, nol ditolak, tanpa pembatasan laju. Bukan kebocoran — tapi registry bisa
  digelembungkan, dan registry itu **satu DO global** yang dilewati setiap join.
  Penutup termurah: Cloudflare Rate Limiting di path itu.
- **Bias modulo di `generateId`** — huruf A–D muncul ~14% lebih sering. Dampaknya
  **0,02 bit dari 62**; higiene, bukan sesuatu yang perlu dikejar.

---

# Belum dikerjakan

- [ ] [PR #55](https://github.com/syuaibsyuaib/ssyubix/pull/55) belum di-merge — berisi
      seluruh perbaikan dari pengujian nyata di atas.
- [ ] **Rate limiting `POST /rooms`** — satu-satunya endpoint tulis tanpa autentikasi.
- [ ] **Storage DO yatim** dari 65 room yang dihapus: entri registry hilang, isinya
      masih ada tapi tak terjangkau.
- [ ] **Room probe `0V5OFE`** yang dibuat saat audit masih menghuni registry production.
- [ ] **Handle agent masih dihitung di sisi tampilan.** Kalau ingin agent saling
      memanggil lewat handle (`task_offer` ke `raven-indigo-charts`), perhitungannya
      harus pindah ke relay supaya jadi identitas sah. Jauh lebih masuk akal sekarang,
      karena handle-nya sudah stabil lintas reconnect.
- [ ] **Kegagalan `versions upload`** tidak pernah diketahui penyebabnya — hanya
      dihindari dengan mematikan build non-production. Masalahnya masih di sana kalau
      preview mau dihidupkan lagi.
- [ ] **Kepemilikan room tidak bisa dipindahkan.** Kalau perangkat owner rusak atau
      cache identitasnya hilang, room yatim permanen. Tiga arah pernah dibahas:
      transfer kepemilikan, owner cadangan, atau token pemilik terpisah.
