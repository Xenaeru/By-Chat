# 🔒 By Chat

Aplikasi chat ala WhatsApp dengan **end-to-end encryption** yang beneran — pesan, **file**,
**status 24 jam**, dan **panggilan suara/video**. Server cuma perantara buta: dia nggak punya
private key siapa pun, nggak bisa baca isi pesan, nggak bisa buka isi file, dan nggak pernah
menyentuh audio/video.

Setiap akun harus **mengklaim satu username** setelah login. Nama itu unik dan dijaga server:
`Andi` dan `andi` dianggap sama, dan begitu juga `a.n.d.i` — supaya nggak ada yang bisa nyamar
mirip orang lain.

Chat baru nggak lahir dari daftar "siapa yang sedang online": tombol **＋** membuka halaman
**tambah kontak**, dan di situ kamu mencari orangnya pakai **email, nomor HP, atau @username**.
Baru setelah ketemu, percakapannya bisa dibuka — termasuk kalau orangnya sedang offline.

Ada juga **halaman admin** (`/admin.html`) buat membaca **laporan pengguna** dan **memblokir
akun** yang bermasalah. Siapa yang jadi admin ditentukan server lewat `ADMIN_EMAILS`/`ADMIN_UIDS`,
bukan lewat tombol di aplikasi.

## Jalanin cepat (mode dev, tanpa akun apa pun)

```
npm install
npm start          # buka http://localhost:3000 di dua jendela berbeda
```

Tanpa file `.env`, aplikasi jalan di **mode dev**: login cukup ketik nama, file disimpan di
disk lokal, dan panggilan pakai STUN publik. Cukup buat nyoba semuanya di lokal.
**Mode dev nolak jalan kalau `NODE_ENV=production`** — lihat bagian Setup di bawah.

## Fitur

| | |
|---|---|
| **Chat** | 1:1 dan grup, semua terenkripsi. Status online, indikator menulis, badge belum dibaca, ✓/✓✓, antrian pesan offline. |
| **File** | Enkripsi di browser sebelum dikirim, chunked AES-GCM, progress bar, gambar tampil inline. Nama file dan kuncinya cuma ada di dalam pesan terenkripsi. |
| **Panggilan** | Suara, video, dan bagikan layar 1:1 lewat WebRTC. Nyalakan kamera di tengah panggilan suara tanpa renegosiasi. |
| **Status** | Teks atau foto, hilang sendiri setelah 24 jam. Isinya tetap terenkripsi end-to-end, dan yang sudah dilihat ditandai cincin ala WhatsApp. |
| **Profil** | Username unik + foto profil yang bisa diganti dari Pengaturan. Foto profil **nggak** dienkripsi (memang buat dilihat orang) — lihat catatan di bawah. |
| **Kontak** | Chat cuma bisa dibuka setelah kontaknya dicari lewat email, nomor HP, atau @username. Pencocokan dikerjakan server, dan hasilnya tetap ketemu walau orangnya offline. Nomor HP **nggak** lagi disiarkan ke semua klien. |
| **Laporan** | Dari header chat: pilih alasan (spam, pelecehan, penipuan, akun palsu, lainnya) + catatan. Yang terkirim cuma yang kamu tulis — isi chat nggak ikut. |
| **Halaman admin** | `/admin.html`: baca laporan, tandai selesai/abaikan, cari pengguna, **blokir** dan **buka blokir**. Blokir ditegakkan server: sesi yang sedang jalan langsung ditendang. |
| **Login** | Google atau nomor HP (OTP SMS) lewat Firebase Authentication. |
| **Verifikasi** | Safety number ala WhatsApp buat mastiin nggak ada kunci yang disisipin. |

## Setup buat server beneran

```bash
cp .env.example .env      # lalu isi
npm run check-env         # cek: mana yang masih kosong / salah
npm run check-env -- --live   # plus tes kunci Supabase ke project aslinya
```

`check-env` nggak pernah menampilkan nilai rahasia — cuma status dan alasannya. Dia keluar
kode 1 selama masih ada kunci wajib yang belum benar.

### 1. Login — Firebase Authentication

1. Bikin project di <https://console.firebase.google.com>.
2. **Authentication → Sign-in method**: aktifkan **Google** dan **Phone**.
3. **Project settings → Your apps** → daftarkan Web app, salin config-nya ke
   `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`,
   `FIREBASE_MESSAGING_SENDER_ID`.
4. **Project settings → Service accounts → Generate new private key**. Kamu dapat file
   `.json`. Pilih salah satu:
   - **Paling gampang** — biarkan file itu di mana saja, lalu isi path-nya di `.env`:
     `GOOGLE_APPLICATION_CREDENTIALS=C:/path/ke/firebase-adminsdk-xxxx.json`
   - **Satu baris** — jalanin helper, dia yang ngisi `.env` (nol copy-paste):
     ```bash
     node scripts/set-service-account.mjs "C:/path/ke/firebase-adminsdk-xxxx.json"
     ```
   - Manual: `node -e "console.log(JSON.stringify(require('C:/path/ke/key.json')))"`, lalu
     tempel outputnya ke `FIREBASE_SERVICE_ACCOUNT=`. Jangan pakai kutip, jangan ada spasi.
     Perlu satu baris karena parser `.env` berhenti di akhir baris — JSON yang masih ada
     indentasinya bakal kebaca cuma `{`.
5. **Authentication → Settings → Authorized domains**: tambahkan domainmu. Tanpa ini,
   login bakal gagal dengan `auth/unauthorized-domain`.

`FIREBASE_SERVICE_ACCOUNT` cuma dipakai server buat ngecek ID token. **Jangan pernah taruh
di kode client.**

### 2. Kirim file — Supabase Storage

1. Bikin project di <https://supabase.com/dashboard>.
2. **Storage → New bucket**, bikin bucket bernama `attachments`. Biarkan PRIVATE.
3. **Project settings → API keys**: salin Project URL ke `SUPABASE_URL`, lalu salin kunci
   **rahasia** ke `SUPABASE_SERVICE_ROLE_KEY`.

   ⚠️ Supabase punya beberapa kunci dan namanya mirip. Yang benar cuma satu:

   | Kunci di dashboard | Boleh dipakai? |
   |---|---|
   | `sb_secret_…` (Secret key, format baru) | ✅ ini yang dipakai |
   | `service_role` JWT (mulai `eyJ…`) | ✅ sama saja, versi lama |
   | `sb_publishable_…` (Publishable key) | ❌ kunci publik, upload bakal ditolak |
   | `anon` JWT | ❌ sama, kunci publik |

   Kalau kunci yang salah dipakai, errornya `new row violates row-level security policy`
   waktu upload — bukan pesan yang jelas menyebut kunci salah.

Service role key itu kunci rahasia — dia cuma dipakai server buat bikin signed URL, dan
nggak pernah dikirim ke browser. Klien upload/download langsung ke Supabase lewat signed URL,
jadi byte-nya nggak lewat server kita.

**Batas ukuran file.** Supabase membatasi ukuran **per objek**, dan satu file = satu objek
(chunking cuma buat integritas AES-GCM, bukan buat upload). Free plan mentok 50 MB — sudah
dites, 51 MiB ditolak `413 EntityTooLarge`. Karena itu `.env.example` menyetel
`MAX_UPLOAD_BYTES=47185920` (45 MiB), biar ditolak di aplikasi dengan pesan yang jelas,
bukan gagal di tengah upload. Naikkan hanya kalau paket Supabase-mu menaikkan batas objek.

### 3. Panggilan — TURN

STUN publik udah dipakai otomatis, tapi STUN doang **gagal di NAT ketat dan CGNAT operator
seluler** (~10-20% panggilan). Kalau aplikasinya buat dipakai orang banyak, isi TURN:

```
TURN_URLS=turn:global.turn.twilio.com:3478?transport=udp,turn:global.turn.twilio.com:3478?transport=tcp
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

Sumbernya bisa [Twilio Network Traversal](https://console.twilio.com), Vonage, atau
[coturn](https://github.com/coturn/coturn) yang di-host sendiri.

### 4. HTTPS

**Wajib kalau diakses lewat domain atau IP LAN.** `crypto.subtle` (dipakai semua enkripsi)
dan `getUserMedia` (kamera/mikrofon) cuma jalan di *secure context*. `localhost` sudah
dianggap aman; selain itu kamu perlu TLS — taruh di belakang nginx/Caddy, atau pakai
Cloudflare Tunnel.

### 5. Deploy ke Render (gratis)

Butuh host yang bisa jalanin proses Node terus-menerus **dan** mendukung WebSocket — Render
masuk kriteria itu (Vercel, Netlify, dan Cloudflare Workers **tidak**, karena servernya nggak
punya proses panjang). `render.yaml` di repo ini sudah menyiapkan setelannya sendiri: region
`singapore` (~20 ms dari Jakarta), health check `/healthz`, `NODE_ENV=production`,
`AUTH_MODE=firebase`, `STORAGE_DRIVER=supabase`. Jadi yang perlu kamu tempel cuma 9 nilai rahasia.

**a. Push dulu** — remote `origin` dan branch `main` sudah siap di repo ini:

```bash
git push -u origin main
```

**b. Siapkan 9 nilainya tanpa mengetik manual** (ini bagian yang paling sering salah kalau
diketik tangan):

```bash
npm run check-env               # pastikan semua isi .env sudah benar
npm run render-env -- --copy    # tulis render-env.txt + salin ke clipboard
```

`render-env.txt` berisi rahasia asli, jadi: sudah masuk `.gitignore`, dan hapus setelah dipakai
(`rm render-env.txt`). Isinya sengaja **tidak** memuat `NODE_ENV`, `PORT`, atau `STORAGE_DRIVER`
supaya setelan dari `render.yaml` nggak ketimpa nilai dev seperti `development`/`3000`.

**c. Di Render:** **New → Blueprint** → pilih repo-nya (repo privat: kamu perlu memberi izin
akses repo itu ke GitHub App milik Render dulu) → Render membaca `render.yaml` dan menampilkan
form variabel → tekan **Add from .env**, tempel isi clipboard → **Deploy web service**.

Kalau lebih suka mengisi satu per satu, ini asal tiap nilainya:

| Yang ditanya Render | Ambil dari |
|---|---|
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID` | Firebase Console → Project settings → Your apps |
| `FIREBASE_SERVICE_ACCOUNT` | nilai satu baris di `.env` (lihat langkah 1 di atas) |
| `SUPABASE_URL` | Supabase → Project settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret key Supabase (bukan publishable) |
| `ADMIN_EMAILS` | Email kamu (akun Google buat buka `/admin.html`). Boleh beberapa, pisahkan dengan koma. Login pakai nomor HP? Isi `ADMIN_UIDS` di dashboard Render dengan uid dari aplikasi → Pengaturan. |

Sesudah jalan, server ini menyimpan beberapa hal di luar memori: **blob lampiran** terenkripsi
(lewat Supabase), **daftar username**, **foto profil**, **daftar blokir + laporan**, dan
**indeks email/nomor HP**. Dengan `STORAGE_DRIVER=supabase`, username jadi objek
`registry/usernames.json`, laporan + blokir jadi `registry/moderation.json`, indeks kontak jadi
`registry/accounts.json`, dan foto profil masuk folder `avatars/` — semua di bucket yang sama,
jadi tetap ada walau service-nya tidur atau di-deploy ulang. Kalau kamu pakai driver `local` di
host yang disk-nya ephemeral, semuanya ikut hilang tiap restart.

`render.yaml` sengaja **tidak** menyetel `PORT` — Render yang menentukan port dan
menyuntikkannya lewat variabel `PORT`, dan `config.js` sudah membacanya. Health check
memakai `/healthz` yang sudah ada di server.

⚠️ Dua kesalahan yang paling gampang terjadi kalau form itu diisi manual: menambah baris
`PORT` (service-nya lalu mendengarkan port yang salah), dan mengubah `NODE_ENV` jadi
`development` — di mode dev server mempercayai uid apa pun yang diklaim browser, jadi siapa pun
bisa mengaku sebagai akun siapa saja.

**d. Wajib setelah dapat domain:** di dashboard Render, buka service-mu dan salin
`https://<nama-service>.onrender.com`, lalu tambahkan domain itu (tanpa `https://`) ke
**Firebase → Authentication → Settings → Authorized domains**. Tanpa ini login Google gagal
dengan `auth/unauthorized-domain`. HTTPS dari Render otomatis, jadi `crypto.subtle` dan
kamera langsung jalan.

**e. Buktikan hasil deploy-nya bekerja:**

```bash
npm run verify-token -- https://nama-app-mu.onrender.com
```

Script itu bikin ID token asli bertanda tangan Google, menyambung ke server, dan
memastikan token palsu ditolak — tanpa kamu perlu login manual di browser.

**f. Biar nggak tidur (opsional, tetap gratis).** Service gratis Render **tidur setelah 15 menit
tanpa trafik** — termasuk trafik WebSocket — dan bangunnya sekitar satu menit. Ping
`https://<nama-service>.onrender.com/healthz` tiap 10–14 menit lewat cron-job.org atau
UptimeRobot, dan service-nya terus bangun. Hitungannya masih masuk: 31 hari × 24 jam = 744 jam,
di bawah jatah 750 jam-instance per bulan.

Kalau dibiarkan tidur pun nggak masalah: disk-nya ephemeral (file ada di Supabase, jadi aman),
tapi semua state (direktori user, antrian pesan offline) cuma di memori — restart = orang harus
login ulang.

## Cara enkripsinya bekerja

| Langkah | Yang terjadi |
|---|---|
| 1 | Tiap akun punya key pair **ECDH P-256** yang dibuat di browser. Private key disimpan di `localStorage`, **nggak pernah dikirim ke server**. |
| 2 | Ke server cuma dikirim **public key** — itu yang jadi daftar kontak. |
| 3 | Dua orang nurunin shared secret lewat ECDH → HKDF-SHA256 → kunci AES-256-GCM. |
| 4 | Tiap pesan pakai **kunci acak sekali pakai**. Teksnya dienkripsi sekali, lalu kuncinya dibungkus terpisah buat tiap anggota grup. |
| 5 | Server cuma lihat blob: ciphertext + bungkusan kunci. |

**File** ikut jalur yang sama. File dienkripsi per 4 MiB dengan kuncinya sendiri, dan
**kunci + nama file ditaruh di dalam pesan terenkripsi** — jadi penyimpanan dan server
dua-duanya nggak pernah lihat kuncinya. Nomor chunk dan jumlah totalnya masuk sebagai
*additional authenticated data*, jadi blob yang diacak urutannya atau dipotong bakal
ketahuan, bukan diterima diam-diam.

**Panggilan** pakai WebRTC, jadi medianya dienkripsi **DTLS-SRTP** langsung antar dua
browser. Server cuma meneruskan SDP dan ICE. Kalau pakai TURN, relay-nya juga cuma
meneruskan paket yang sudah terenkripsi — TURN lihat ciphertext, sama kayak server chat.

## Apa yang bisa dan nggak bisa dilihat server

| Bisa | Nggak bisa |
|---|---|
| uid, username, email, nomor HP, dan **public** key | private key siapa pun |
| Pesan terenkripsi selama penerima offline | isi pesan |
| Nama acak blob file dan isinya yang terenkripsi | nama file asli, tipe, kunci, atau isinya |
| Siapa menelepon siapa dan kapan | audio/video panggilan |
| Siapa memasang status dan kapan | isi status (teks maupun fotonya) |
| Laporan yang **diketik pelapornya** + siapa diblokir dan alasannya | isi percakapan yang dilaporkan |
| **Foto profil** apa adanya | — |

Email dan nomor HP tetap ada di server (dari penyedia login yang sudah memverifikasinya), tapi
sekarang **nggak lagi disiarkan ke setiap klien** seperti sebelumnya. Yang dikirim ke klien cuma
nama, foto, dan public key. Email dan nomor cuma keluar lewat dua jalur: hasil pencarian kontak
(yang **tidak** mengembalikan nilainya, cuma uid + nama + status online) dan halaman admin.

Foto profil adalah satu-satunya unggahan yang **tidak** dienkripsi. Ini disengaja: foto profil
memang untuk dilihat semua orang yang melihat namamu, jadi kalau dienkripsi pun kuncinya harus
terbuka buat mereka. Ukuran (maks 2 MB) dan jenis gambarnya diperiksa server dari byte aslinya,
bukan dari header yang dikirim browser. Kalau itu mengganggu, hapus fotonya — aplikasinya jalan
normal tanpa foto profil.

## Struktur

```
config.js          Baca .env, pilih driver, pisah config publik vs rahasia.
auth.js            Verifikasi ID token. Driver: firebase | dev (dev diblokir di production).
storage.js         Driver blob: supabase | local. Path selalu dibuat server.
usernames.js       Namespace @nama (normalisasi, nama sistem, simpan permanen).
moderation.js      Laporan pengguna + daftar blokir, disimpan permanen.
accounts.js        Indeks email/nomor HP buat mencari kontak yang belum pernah online.
server.js          Relay + direktori kunci + endpoint lampiran + signaling + endpoint admin.
public/crypto.js   Semua primitif E2EE. Pakai WebCrypto, jalan di browser dan Node.
public/auth-client.js  Login Google / OTP nomor HP / dev.
public/files.js    Enkripsi, upload, unduh, dekripsi lampiran.
public/call.js     WebRTC 1:1: suara, video, layar.
public/app.js      UI + orkestrasi.
public/admin.html  Halaman admin (laporan + blokir).
public/admin.js    Ambil data admin lewat REST dan render; nggak buka socket.
```

## Testing

```
npm test              # 92 test: kripto, file, auth, storage, username, status, kontak, moderasi, relay, signaling, tooling
npm run test:browser  # 108 cek: UI asli di Chrome, termasuk panggilan WebRTC beneran
CALL_DEBUG=1 npm run test:browser   # nyalain jejak negosiasi WebRTC di console
```

Alat bantu setup (semuanya nggak pernah menampilkan nilai rahasia):

```
npm run check-env            # cek .env: mana yang kosong/salah, keluar kode 1 kalau ada
npm run check-env -- --live  # plus tes kunci Supabase ke project aslinya
npm run render-env -- --copy # 9 nilai Render dalam satu file siap tempel (berisi rahasia!)
npm run set-service-account -- "C:/path/key.json"   # isi FIREBASE_SERVICE_ACCOUNT 1 baris
npm run verify-token -- https://app.onrender.com    # buktikan verifikasi ID token jalan
npm run screenshots          # ambil gambar layar UI ke screenshots/ (butuh Chrome)
```

`test:browser` butuh Chrome. Kalau nggak di lokasi default, set `CHROME_PATH`.
Panggilan diuji pakai perangkat kamera/mikrofon palsu bawaan Chrome.

Yang diverifikasi antara lain: envelope nggak mengandung plaintext (dicek dari memori
server), blob di disk benar-benar ciphertext dan byte hasil dekripsi identik dengan
aslinya, chunk file yang diubah/dipotong/diacak urutannya kedeteksi, server nggak
pernah pegang private key, token ngawur ditolak, pihak ketiga nggak bisa nyusup ke
signaling panggilan orang lain, dan di browser: dua profil login, mencari kontak lewat halaman
**tambah kontak** (＋), kirim pesan, kirim file, lalu **panggilan suara tersambung, kamera
dinyalakan di tengah panggilan terlihat lawan bicara, dan hangup menutup di dua sisi**.
Di jalur yang sama juga diuji: melaporkan orang dari header chat, halaman admin membaca
laporannya, memblokir akun itu (sesi yang sedang jalan di sisi korban langsung berhenti dan
menampilkan alasannya), lalu membuka blokirnya lagi dan akunnya jalan seperti semula.

## Batasan — baca ini

Kriptonya beneran, tapi ini masih belum siap buat data yang beneran sensitif:

- **Belum ada forward secrecy.** Kunci identitas statis. Kalau private key bocor, pesan
  lama yang ciphertext-nya sempat direkam bisa dibuka. Butuh Double Ratchet.
- **Private key disimpan polos di `localStorage`.** Belum dienkripsi pakai password.
- **Server tetap otoritas kunci.** Kalau server jahat, dia bisa nukar public key (MITM).
  Mitigasinya cuma safety number manual; belum ada peringatan otomatis (TOFU).
- **Belum ada proteksi replay** dan nggak ada nomor urut pesan, jadi relay bisa mengirim
  ulang envelope lama.
- **Metadata bocor**: siapa ngobrol sama siapa, kapan, panjang pesan (nggak di-padding),
  dan siapa menelepon siapa.
- **Grup tanpa kontrol akses.** Daftar anggota dikirim dari client dan dipercaya; nggak ada
  admin, nggak bisa nambah/hapus anggota setelah grup dibikin.
- **Panggilan cuma 1:1.** Panggilan grup butuh SFU, itu pekerjaan terpisah.
- **Nggak ada multi-device.** Satu akun aktif di satu jendela; login di tempat lain bikin
  sesi lama berhenti. Belum ada lampiran gambar berukuran besar buat panggilan; belum ada
  voice note, hapus/edit pesan, atau pencarian dalam chat.
- **Status cuma hidup di memori server.** Dia hilang kalau server restart (jatah 24 jamnya juga
  ikut hilang). Username dan foto profil tidak, karena keduanya disimpan permanen.
- **Status dibagikan ke semua kontak.** Audience-nya seluruh isi direktori, sama seperti
  "kontak saya" di aplikasi lain — belum ada pilihan per orang.
- **Nggak ada daftar "siapa yang sudah melihat statusku".** Yang tersimpan cuma status
  *kamu* sudah membuka yang mana, dan itu di perangkatmu sendiri, bukan di server.
- **Foto profil nggak dienkripsi** dan siapa pun yang tahu URL-nya bisa membukanya.
- **Rate limiting masih tipis.** Pencarian kontak dibatasi 30 kali per menit per koneksi dan
  laporan 10 per jam per akun; relay pesan dan endpoint lampiran belum dibatasi sama sekali.
- **Mencari kontak cuma menemukan orang yang pernah login.** Server cuma mengenal akun yang
  pernah menyapa — email harus sama persis, dan nomor HP dicocokkan pada 9 angka terakhir (jadi
  `+62 812…` dan `0812…` menemukan orang yang sama). Di mode dev nggak ada email/nomor dari
  penyedia login, jadi yang bisa dipakai cuma `@username`.
- **Laporan cuma bisa soal akun, bukan potongan percakapan.** Tombol Laporkan ada di chat pribadi,
  dan yang terkirim ke admin adalah alasan + tulisan pelapornya. Admin tetap nggak bisa membuka
  chat yang dilaporkan.
- **Halaman admin menyegarkan sendiri tiap 15 detik, bukan langsung.** Halaman itu sengaja nggak
  membuka socket: server cuma mengizinkan satu sesi hidup per akun, jadi kalau menyambung, tab
  chat milik admin sendiri yang tertendang.
- **Admin ditentukan env, bukan aplikasi.** `ADMIN_EMAILS` (email) atau `ADMIN_UIDS` (uid). Akun
  yang ada di daftar itu nggak bisa diblokir dari halaman admin — harus dihapus dulu dari env.
- **Blokir berlaku per akun**, bukan perangkat atau per IP: orangnya cukup bikin akun baru buat
  kembali masuk.
- **State server in-memory** (direktori kunci + antrian offline); restart = antrian hilang.

## Yang belum bisa gw verifikasi

Dua jalur ini butuh kredensial yang cuma bisa kamu bikin, jadi gw nggak bisa nge-tes ujungnya:

- **Verifikasi ID token Firebase asli.** Kode path `firebase-admin` (termasuk dukungan
  Auth Emulator) sudah ditulis, tapi yang terverifikasi jalan di sini baru driver `dev`.
  Begitu `.env` kamu terisi, cek dengan login Google/nomor HP lalu pastikan server
  menerima token tanpa error.
- **Supabase Storage.** Endpoint signed-upload/signed-download sudah dites lewat driver
  `local`, tapi panggilan sebenarnya ke Supabase butuh project kamu. Setelah `.env`
  terisi, kirim satu file lalu pastikan bucket-nya berisi satu objek dengan nama acak.
- **Penyimpanan username & foto profil di Supabase.** Kode jalur Supabase-nya sudah ada dan
  dipilih otomatis begitu `STORAGE_DRIVER=supabase`, tapi yang terverifikasi di sini baru jalur
  file lokal (`data/usernames.json`, `data/moderation.json`, `data/accounts.json`, `data/avatars/`).
  Setelah deploy, cek bucket-mu: harus ada `registry/usernames.json`, `registry/moderation.json`,
  `registry/accounts.json`, dan folder `avatars/` begitu ada yang klaim username, melapor, diblokir,
  atau memasang foto profil.
- **Mencari kontak pakai email/nomor HP asli.** Alurnya sudah diuji ujung-ke-ujung, tapi lewat
  token dev yang berisi email/nomor. Email yang datang dari Google/Firebase baru akan terlihat
  setelah `.env` terisi — login Google, lalu coba cari akun itu dari akun lain.
- **Halaman admin di jalur Firebase.** Yang diuji di sini jalur dev, yang mengenali admin dari
  uid. Di produksi admin dikenali dari email di ID token; setelah `ADMIN_EMAILS` diisi, buka
  `/admin.html` dan pastikan dasbornya muncul, bukan layar "bukan admin".
