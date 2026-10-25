# Struktur Project

Dokumen ini menjelaskan di mana setiap bagian project tinggal, bagaimana request
HTTP masuk, dan bagaimana event Socket.IO mengalir. Untuk cara pakai dan setup
environment, lihat [`README.md`](../README.md).

## Peta folder

```
By-Chat/
├── src/                  Kode server (Node.js, ES module)
│   ├── server.js         Entry point: Express + Socket.IO + boot
│   ├── config.js         Baca .env, pilih driver, pisah config publik/rahasia
│   ├── auth.js           Verifikasi ID token (firebase | dev)
│   ├── storage.js        Driver blob (supabase | local)
│   ├── usernames.js      Namespace @nama
│   ├── moderation.js     Laporan + daftar blokir
│   ├── accounts.js       Indeks email/nomor HP (arsip; pencarian kontak pakai ID)
│   ├── profiles.js       ID pengguna, status, tahun lahir, profil publik, jabatan, riwayat chat
│   ├── channels.js       Saluran: pengikut, admin, postingan, foto
│   └── push.js           Web Push (VAPID, langganan, pengiriman)
│
├── public/               Aset yang disajikan Express (document root)
│   ├── index.html        Halaman chat
│   ├── admin.html        Halaman admin
│   ├── sw.js             Service worker (harus di root agar scope-nya "/")
│   ├── manifest.webmanifest
│   ├── js/
│   │   ├── app.js        UI + orkestrasi
│   │   ├── admin.js      UI admin (REST saja, tanpa socket)
│   │   ├── auth-client.js Login Google / dev
│   │   ├── crypto.js     Primitif E2EE (WebCrypto)
│   │   ├── files.js      Enkripsi/upload/unduh/dekripsi lampiran
│   │   ├── call.js       WebRTC mesh (1:1 & grup)
│   │   └── notifications.js
│   ├── css/style.css
│   └── assets/           logo.svg, logo-lockup.svg, icon-192.png, icon-512.png
│
├── scripts/              Alat bantu (bukan bagian runtime)
│   ├── check-env.mjs
│   ├── render-env.mjs
│   ├── set-service-account.mjs
│   ├── verify-firebase-token.mjs
│   ├── browser-check.mjs
│   └── screenshot.mjs
│
├── test/                 Test otomatis `node --test`
├── docs/STRUCTURE.md     Dokumen ini
├── data/                 Dibuat saat runtime oleh driver local (tidak di-commit)
├── DESIGN.md             Sistem desain UI
├── render.yaml           Blueprint deploy Render
└── .env.example          Daftar environment variable
```

Semua path data lokal dihitung dari **root project** (`src/config.js` memakai
`projectRoot`), jadi menjalankan `npm start` dari mana pun tetap menulis ke
`<root>/data/`.

### Di mana data disimpan (driver local)

| Data | Path default |
|---|---|
| Lampiran terenkripsi | `data/attachments/` |
| Foto profil | `data/avatars/` |
| Namespace username | `data/usernames.json` |
| Laporan + blokir | `data/moderation.json` |
| Indeks email/nomor HP | `data/accounts.json` |
| Profil publik + ID + jabatan + riwayat chat | `data/profiles.json` |
| Saluran + pengikut + postingan | `data/channels.json` |
| Langganan + kunci push | `data/push.json` |

Dengan driver `supabase`, file JSON di atas pindah ke objek `registry/*.json`
di bucket yang sama dengan lampiran, dan foto profil ke folder `avatars/`.

## Titik masuk

`npm start` menjalankan `node src/server.js`. Urutan boot:

1. `config.js` membaca `.env` (kalau ada) dan environment.
2. Driver auth, storage, username, moderation, accounts, dan push disiapkan.
3. Express middleware dan route dipasang.
4. Socket.IO dipasang (`io.use` untuk autentikasi, lalu `io.on('connection')`).
5. `server.listen(config.port)` — dilewati kalau `NO_LISTEN=1` (dipakai test).

`src/server.js` mengekspor `app`, `server`, `io`, dan state runtime (`directory`,
`inbox`, `calls`, `statuses`, dll.) supaya test dan script bisa memeriksanya.

## Alur HTTP

Autentikasi REST memakai header `Authorization: Bearer <ID token>`
(`authenticateRequest`). Akun yang diblokir langsung ditolak dengan `403`.

| Method | Path | Auth | Fungsi |
|---|---|---|---|
| GET | `/` | publik | `public/index.html` |
| GET | `/admin.html` | publik (UI) | `public/admin.html`; keputusan admin tetap dicek server |
| GET | `/config.json` | publik | Config browser + kunci publik VAPID (`Cache-Control: no-store`) |
| GET | `/healthz` | publik | Status server: auth, storage, jumlah user/room/laporan |
| POST | `/api/push/subscribe` | Bearer | Simpan subscription Web Push milik uid |
| POST | `/api/push/unsubscribe` | Bearer | Hapus subscription berdasarkan endpoint |
| GET | `/api/avatar/:uid` | publik | Ambil foto profil (binary) |
| POST | `/api/profile/avatar` | Bearer | Unggah foto profil (`image/png`, `image/jpeg`, `image/webp`, maks 2 MB; tipe dicek dari byte) |
| DELETE | `/api/profile/avatar` | Bearer | Hapus foto profil |
| GET | `/api/channel/:id/avatar` | publik | Foto saluran (binary) |
| POST | `/api/channel/:id/avatar` | Bearer + admin saluran | Ganti foto saluran (jenis dan ukuran diperiksa dari byte) |
| GET | `/api/admin/overview` | Bearer + admin | Statistik, laporan, blokir, daftar user |
| POST | `/api/admin/ban` | Bearer + admin | Blokir uid + putus socket aktif |
| POST | `/api/admin/unban` | Bearer + admin | Buka blokir uid |
| POST | `/api/admin/role` | Bearer + admin | Beri/cabut jabatan atau centang biru (aturan sama dengan `role:set`) |
| POST | `/api/admin/report` | Bearer + admin | Ubah status laporan (mis. `resolved`) |
| POST | `/api/attachments/request-upload` | Bearer | Buat path + URL upload (Supabase signed URL atau route blob lokal) |
| POST | `/api/attachments/link` | Bearer | Buat URL unduh untuk path blob |
| PUT | `/api/blob/*` | Bearer | **Khusus driver local**: terima upload blob mentah |
| GET | `/api/blob/*` | Bearer | **Khusus driver local**: kirim blob mentah |

Aset `public/` lainnya (`/js/*`, `/css/*`, `/assets/*`, `/sw.js`,
`/manifest.webmanifest`) disajikan oleh `express.static` sebelum route API
lampiran. Route API yang butuh auth tetap dicocokkan lebih dulu atau tidak
bertabrakan dengan path aset.

### Alur request yang penting

**Login / konfigurasi**

```
browser → GET /config.json
        → auth-client.js (Firebase atau dev)
        → dapat ID token
```

**Foto profil**

```
browser → POST /api/profile/avatar (Bearer, raw image)
        → verifikasi token + cek blokir
        → sniffImageType(buffer) → storage.putAvatar()
        → avatars.set(uid) → broadcastDirectory()
        → GET /api/avatar/:uid?v=...  (publik)
```

**Lampiran**

```
driver supabase:
  browser → POST /api/attachments/request-upload → signed upload URL → PUT ke Supabase
  browser → POST /api/attachments/link          → signed download URL

driver local:
  browser → POST /api/attachments/request-upload → path + PUT /api/blob/<path>
  browser → POST /api/attachments/link          → GET /api/blob/<path>
```

**Admin**

```
admin.js → GET /api/admin/overview
         → POST /api/admin/ban | /api/admin/unban | /api/admin/report | /api/admin/role
         → server memeriksa isAdmin(profile) dari ADMIN_UIDS / ADMIN_EMAILS
```

## Alur Socket.IO

Handshake (`io.use`) memerlukan:

```js
io(url, {
  auth: {
    token: "<ID token>",
    publicKey: { /* JWK publik milik user */ },
  },
});
```

Server menolak handshake tanpa `publicKey.x`, token tidak valid, atau akun yang
sedang diblokir (`err.data = { banned: true, reason }`).

### Event dari client → server

| Event | Payload | Ack | Fungsi |
|---|---|---|---|
| `publish_key` | `key` (JWK) | — | Perbarui kunci publik user |
| `sync` | — | `{ ok, directory }` | Ambil direktori user online |
| `username:check` | `name` | hasil cek | Cek ketersediaan username |
| `username:claim` | `name` | `{ ok, username }` | Klaim username |
| `contact:lookup` | ID pengguna (6–12 angka) | `{ ok, results }` | Cari kontak lewat ID (rate limit 30/menit); email/nomor/username ditolak |
| `profile:get` | `{ uid }` | `{ ok, profile }` | Kartu profil publik untuk panel info (juga saat offline) |
| `profile:settings` | `{ about, birthYear, publicProfile }` | `{ ok, me }` | Ubah status, tahun lahir, dan sakelar profil publik |
| `role:set` | `{ uid, key: 'admin'|'moderator'|'verified', value }` | `{ ok, profile }` | Beri/cabut jabatan sesuai peringkat pemberi |
| `channel:list` | — | `{ ok, channels }` | Semua saluran (untuk Jelajahi) + status ikut |
| `channel:create` | `{ name, description }` | `{ ok, channel }` | Buat saluran; pembuat jadi pemilik + admin |
| `channel:open` | `{ channelId }` | `{ ok, channel, members, memberCount }` | Buka saluran + 100 postingan terakhir; `members` hanya untuk admin saluran |
| `channel:update` | `{ channelId, name, description }` | `{ ok, channel }` | Ubah nama/deskripsi (admin saluran) |
| `channel:follow` / `channel:unfollow` | `{ channelId }` | `{ ok, channel }` | Ikuti / berhenti ikuti |
| `channel:members` | `{ channelId }` | `{ ok, members }` | Daftar pengikut; ditolak untuk non-admin saluran |
| `channel:admin` | `{ channelId, uid, value }` | `{ ok, channel }` | Angkat/cabut admin saluran (hanya pemilik saluran) |
| `channel:post` | `{ channelId, payload }` | `{ ok, post }` | Kirim postingan (admin saluran); envelope menyembunyikan penulis dari pengikut |
| `report:submit` | `{ uid, reason, detail, roomId }` | `{ ok, id }` | Kirim laporan (tanpa isi pesan) |
| `send` | `{ roomId, roomName, type, members, payload }` | `{ ok, id, at, delivered, queued }` | Relay envelope terenkripsi (DM/grup) |
| `message:delete` | `{ id }` | `{ ok, delivered, queued }` | Hapus untuk semua (hanya pengirim asli) |
| `status:publish` | `{ payload, members }` | `{ ok, id, at, reached }` | Terbitkan status (TTL 24 jam) |
| `status:remove` | `id` | `{ ok }` | Hapus status milik sendiri |
| `typing` | `{ roomId, members, typing }` | — | Teruskan indikator mengetik |
| `profile:update` | `{ displayName }` | `{ ok, username }` | Ganti nama tampilan lewat registry username |
| `call:invite` | `{ toUid, video, callId? }` | `{ ok, callId, members, ... }` | Mulai panggilan / tambah peserta |
| `call:signal` | `{ callId, toUid, data }` | — | Relay SDP/ICE antar anggota yang sudah accepted |
| `call:accept` | `{ callId }` | `{ ok, members, answeredAt }` | Terima panggilan |
| `call:reject` | `{ callId }` | `{ ok }` | Tolak panggilan |
| `call:leave` | `{ callId }` | `{ ok }` | Keluar dari panggilan |
| `call:end` | `{ callId }` | `{ ok }` | Akhiri panggilan (perilaku sama dengan leave) |

### Event dari server → client

| Event | Kapan dikirim | Isi |
|---|---|---|
| `ready` | Setelah handshake | Profil, username, directory, status, inbox tertunda, call log, flag admin |
| `directory` | User online/offline, kunci publik berubah, foto berubah | Daftar user publik (tanpa email/nomor HP) |
| `session:replaced` | Akun yang sama membuka sesi lain | Sesi lama diputus |
| `session:banned` | Admin memblokir saat user online | Alasan blokir, lalu socket diputus |
| `message` | `send` atau pesan tertunda | Envelope terenkripsi |
| `status:new` | `status:publish` | Status baru (publik disiarkan ke semua yang tersambung; privat hanya ke kontak) |
| `status:removed` | `status:remove` | Id status yang hilang |
| `profile:roles` | Jabatan/centang biru akun sendiri berubah | Profil terbaru |
| `channel:update` | Saluran yang diikuti berubah (nama, deskripsi, foto, admin) | Ringkasan saluran |
| `channel:post` | Admin saluran mengirim postingan | `{ channelId, id, at, payload }` tanpa uid penulis |
| `typing` | `typing` | Indikator mengetik |
| `call:incoming` | `call:invite` atau saat reconnect di tengah ringing | Detail panggilan |
| `call:joined` | `call:accept` (ke penerima) | Roster lengkap |
| `call:member-joined` | `call:accept` (ke anggota lain) | Anggota baru |
| `call:accepted` | `call:accept` | Kompatibilitas klien lama |
| `call:signal` | `call:signal` | SDP/ICE |
| `call:rejected` | `call:reject` | Anggota menolak |
| `call:member-left` | `call:leave` / disconnect | Anggota keluar |
| `call:ended` | Panggilan selesai / timeout / ditolak | `{ callId, reason, duration, answered }` |
| `call:log` | Panggilan selesai atau saat reconnect | Riwayat panggilan (termasuk missed/busy) |

### Alur pesan (DM/grup)

```
pengirim (app.js)
  → enkripsi payload (crypto.js)
  → socket.emit('send', { roomId, members, payload })
  → server: validasi username + envelope
  → simpan pemilik id di sentMessages (bukan isi pesan)
  → penerima online  : io.to(socketId).emit('message', record)
  → penerima offline : inbox.set(uid, [...]) (maks 500)
  → saat reconnect   : inbox dikirim lewat event 'ready'
```

Hapus untuk semua:

```
pengirim → socket.emit('message:delete', { id })
         → server cek sentMessages.get(id).from === uid
         → anggota lain menerima { deleted: true, id, roomId }
```

### Alur status

```
pengirim → status:publish { payload, members, mode }
         mode 'public' : payload membawa kuncinya sendiri (`key`)
                         → server menyiarkan ke semua socket + menyimpan
         mode 'contacts': satu kunci per kontak di `keys`
                         → server menyaring `members`: profil privat cuma
                           boleh berisi orang yang pernah chat
         → siapapun yang reconnect menerima status lewat 'ready' bila berhak
           (publik + profil penulis publik, atau pernah chat)
         → status kedaluwarsa setelah 24 jam (dipangkas saat diakses)
```

### Alur saluran

```
admin saluran → channel:post { channelId, payload }
              → server menyimpan blob (maks 300 postingan) tanpa uid penulis
              → semua pengikut + admin menerima 'channel:post'
              → pengikut baru membaca postingan lama lewat channel:open
```

### Alur panggilan (WebRTC)

```
pemanggil → call:invite
          → server membuat room (maks 8 anggota) + timer ringing
          → penerima online  : 'call:incoming'
          → penerima offline : Web Push (type: 'call')
penerima  → call:accept
          → server kirim 'call:joined' / 'call:member-joined' + roster
kedua sisi → call:signal (SDP/ICE) — hanya antar anggota accepted
selesai   → call:end / call:leave / disconnect / timeout
          → server kirim 'call:ended' + 'call:log' ke semua yang pernah terlibat
```

Server tidak pernah menyentuh audio/video; media terenkripsi DTLS-SRTP antar
browser. TURN hanya meneruskan paket yang sudah terenkripsi.

## Testing

```bash
npm test              # seluruh test/ (node --test)
npm run test:browser  # cek UI di Chromium (butuh Chrome/Chromium)
npm run screenshots   # hasilkan screenshot ke screenshots/
```

Test mengimpor `src/server.js` langsung dan memakai `NO_LISTEN=1` agar tidak
membuka port tambahan.
