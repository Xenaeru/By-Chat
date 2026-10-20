# 🔒 By Chat

Aplikasi chat dengan **end-to-end encryption** yang beneran — pesan, **file**, **pesan suara**,
**status 24 jam**, dan **panggilan suara/video**. Server cuma perantara buta: dia nggak punya
private key siapa pun, nggak bisa baca isi pesan, nggak bisa buka isi file, dan nggak pernah
menyentuh audio/video.

Setiap akun harus **mengklaim satu username** setelah login. Huruf besar/kecil didukung dan
tampil apa adanya (`XenaboutYou` tetap `XenaboutYou`), tapi nama itu unik dan dijaga server:
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
| **Chat** | 1:1 dan grup, semua terenkripsi. Status online, indikator menulis, badge belum dibaca, ✓/✓✓, antrian pesan offline, pembatas hari. |
| **Pilihan pesan** | Arahkan kursor ke gelembung → muncul **panah kecil di sudutnya** (ala WhatsApp Web) yang membuka menu; bisa juga klik kanan (mouse) atau tahan pesan (hp). Yang lain diblur, yang dipilih tetap tajam, lalu muncul reaksi cepat + **Balas, Teruskan, Salin, Beri bintang, Laporkan, Hapus untuk saya, Hapus untuk semua orang**. |
| **Menu chat** | Arahkan kursor ke baris chat → **panah di sudutnya** (di hp: tahan barisnya). Isinya **Tandai sudah/belum dibaca**, **Bersihkan chat** (semua pesannya dihapus, chatnya tetap ada), dan **Hapus chat** (chatnya dibuang dari perangkat ini). Dua terakhir selalu minta konfirmasi. |
| **File** | Enkripsi di browser sebelum dikirim, chunked AES-GCM, progress bar. Foto/video dibuka **selayar penuh** di dalam aplikasi (bukan diunduh, bukan tab blob: baru); dokumen lain baru diunduh. Nama file dan kuncinya cuma ada di dalam pesan terenkripsi. |
| **Pesan suara** | Kolom kosong mengubah tombol kirim jadi **mikrofon**. Ketuk untuk merekam (maksimal 5 menit), lalu **kirim** atau **buang** dari bar rekaman yang menampilkan timer dan gelombang berjalan. Rekamannya masuk jalur lampiran yang sama: **dienkripsi di browser** sebelum diunggah, jadi server cuma melihat ciphertext. Di bubble, penerima mendapat tombol putar, gelombang yang ikut terisi, durasi, dan **kecepatan 1x / 1,5x / 2x**; suaranya baru diunduh + didekripsi saat benar-benar diputar. Bisa dibalas, diteruskan, diberi bintang, dan dihapus seperti pesan lain. |
| **Menu ala WhatsApp** | Rail ikon di desktop (Chat, Status, Panggilan, Pengaturan) dan **navbar bawah oval yang melayang + berkaca di hp**. Perpindahan panelnya dianimasikan halus, dan di hp percakapan dibuka sebagai halaman penuh (navbar ikut menghilang). |
| **Panggilan** | Suara, video, dan bagikan layar lewat WebRTC — **1:1 maupun grup sampai 8 orang**, dan peserta lain bisa **ditambahkan di tengah panggilan**. Nyalakan kamera di tengah panggilan suara tanpa renegosiasi. Hasilnya tercatat di **chat** dan panel Panggilan: **panggilan tidak terjawab**, **panggilan terjawab + durasinya**, atau **panggilan sedang berlangsung** dengan detik berjalan. Kalau orang yang ditelepon sedang di panggilan lain, pemanggilnya diberi tahu **ada panggilan yang sedang berlangsung**. Suara lawan bicara keluar dari elemen `<audio>` sendiri (bukan dari petak video), ada **meter mikrofon** di layar panggilan, dan kalau browser menahan suaranya muncul tombol **"Suara belum keluar — ketuk untuk menyalakan"**. |
| **Status** | Teks atau foto, hilang sendiri setelah 24 jam. Isinya tetap terenkripsi end-to-end, dan yang sudah dilihat ditandai cincin. **Status cuma bisa dilihat orang yang sudah pernah chat** — kuncinya nggak pernah dibungkus buat orang lain, dan sisi penerimanya juga menyaring. |
| **Pengaturan** | Satu panel berisi profil (foto + username), **dropdown tema Terang / Gelap / Otomatis**, sakelar notifikasi, dan tombol **Keluar** — bukan lagi modal terpisah atau tombol di header chat. |
| **Mode gelap** | Palet kedua yang lengkap, bukan inversi otomatis: permukaan berlapis, teks terang, dan aksen biru yang naik kontrasnya. Pilihannya disimpan per perangkat dan dipasang **sebelum CSS dilukis**, jadi nggak ada kilatan putih saat aplikasi dibuka. "Otomatis" ikut `prefers-color-scheme` dan langsung berubah saat perangkatnya berganti mode. |
| **Profil** | Username unik + foto profil yang bisa diganti dari Pengaturan. Foto profil **nggak** dienkripsi (memang buat dilihat orang) — lihat catatan di bawah. |
| **Kontak** | Chat cuma bisa dibuka setelah kontaknya dicari lewat email, nomor HP, atau @username. Pencocokan dikerjakan server, dan hasilnya tetap ketemu walau orangnya offline. Nomor HP **nggak** lagi disiarkan ke semua klien. |
| **Laporan** | Dari header chat: pilih alasan (spam, pelecehan, penipuan, akun palsu, lainnya) + catatan. Yang terkirim cuma yang kamu tulis — isi chat nggak ikut. |
| **Halaman admin** | `/admin.html`: baca laporan, tandai selesai/abaikan, cari pengguna, **blokir** dan **buka blokir**. Blokir ditegakkan server: sesi yang sedang jalan langsung ditendang. |
| **Login** | Google lewat Firebase Authentication. (Login nomor HP/OTP SMS dibuang: itu paket berbayar Firebase, jadi nggak pernah jalan di project free.) |
| **Verifikasi** | Safety number ala WhatsApp buat mastiin nggak ada kunci yang disisipin. |
| **Notifikasi** | Pesan baru muncul sebagai notifikasi sistem plus **balas langsung dari notifikasi** (kolom balas di notifikasi didukung Chrome Android; di desktop klik notifikasi membuka chatnya dan langsung fokus ke kolom ketik). Dinyalakan dari **Pengaturan → Notifikasi pesan**, dan cuma muncul kalau percakapannya memang nggak sedang dibaca. **Panggilan masuk juga dikirim lewat Web Push** walau tab-nya sudah ditutup, lengkap dengan tombol Terima/Tolak. |
| **Tampilan** | Mengikuti **`DESIGN.md`** (sistem desain By Chat): permukaan putih `#ffffff` di atas kanvas `#f7f8fa`, satu warna aksi By Chat Blue `#2563eb`, tombol & input 8px, kartu dan gelembung 16px, huruf Inter. Lihat bagian [Tampilan](#tampilan-mengikuti-designmd). |

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
2. **Authentication → Sign-in method**: aktifkan **Google**. Login nomor HP/OTP SMS nggak dipakai —
   itu fitur berbayar Firebase (butuh upgrade plan + reCAPTCHA), jadi jalurnya sudah dibuang dari
   UI maupun klien dan yang tersisa cuma Google (atau mode dev untuk lokal).
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

Tanpa TURN, "panggilan tersambung tapi tidak ada suara" hampir selalu berarti jalur P2P-nya
sendiri yang gagal di jaringan itu. Aplikasinya sekarang bilang terus terang — pesannya
menyebut relay TURN — dan mencoba menyusun ulang jalur ICE sekali sebelum menyerah. Suara
lawan bicara juga diputar dari elemen `<audio>` tersendiri (bukan dari petak video), dan
meter mikrofon di layar panggilan menunjukkan apakah mikrofonnya benar-benar menangkap suara.

### 4. Panggilan saat aplikasi tertutup — Web Push

Dering nggak menunggu aplikasinya dibuka. Browser yang sudah memberi izin notifikasi
mendaftarkan endpoint push-nya ke server, dan server mengirim notifikasi panggilan lewat
endpoint itu (Web Push). Kunci VAPID **dibuat sendiri sekali** lalu disimpan seperti
registry lain — `registry/push.json` di bucket Supabase, atau `data/push.json` di driver
local — jadi nggak ada env yang wajib diisi. Kalau mau memakai kunci tetap (misalnya
beberapa instance berbagi langganan yang sama), isi `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, dan `VAPID_SUBJECT`.

Ini batas jujur web: notifikasi panggilan **muncul dan berbunyi saat aplikasi tertutup**,
tapi yang berbunyi adalah nada notifikasi sistem — bukan dering berulang seperti WhatsApp,
karena browser nggak mengizinkan service worker memutar audio sendiri. Menekan **Terima**
membuka aplikasi dan langsung menjawab panggilannya.

### 6. HTTPS

**Wajib kalau diakses lewat domain atau IP LAN.** `crypto.subtle` (dipakai semua enkripsi)
dan `getUserMedia` (kamera/mikrofon) cuma jalan di *secure context*. `localhost` sudah
dianggap aman; selain itu kamu perlu TLS — taruh di belakang nginx/Caddy, atau pakai
Cloudflare Tunnel.

### 7. Deploy ke Render (gratis)

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
| `ADMIN_EMAILS` | Email kamu (akun Google buat buka `/admin.html`). Boleh beberapa, pisahkan dengan koma. `ADMIN_UIDS` tetap ada kalau mau menunjuk admin lewat uid (mis. akun mode dev). |

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

**Pesan suara** nggak punya jalur enkripsi sendiri: rekaman `MediaRecorder` dibungkus jadi
file, lalu ikut jalur di atas. Yang ditambahkan cuma penanda `voice` + durasi **di dalam**
payload terenkripsi, jadi server nggak tahu sebuah lampiran itu suara atau dokumen biasa.

**Panggilan** pakai WebRTC, jadi medianya dienkripsi **DTLS-SRTP** langsung antar
browser — di grup pun setiap pasangan punya koneksinya sendiri (mesh). Server cuma
meneruskan SDP dan ICE. Kalau pakai TURN, relay-nya juga cuma meneruskan paket yang sudah
terenkripsi — TURN lihat ciphertext, sama kayak server chat. Notifikasi panggilan (Web
Push) cuma membawa nama pemanggil dan id panggilan; tidak ada media yang lewat situ.

## Apa yang bisa dan nggak bisa dilihat server

| Bisa | Nggak bisa |
|---|---|
| uid, username, email, nomor HP, dan **public** key | private key siapa pun |
| Pesan terenkripsi selama penerima offline | isi pesan |
| Nama acak blob file dan isinya yang terenkripsi | nama file asli, tipe, kunci, atau isinya |
| Siapa menelepon siapa dan kapan | audio/video panggilan |
| Siapa memasang status dan kapan | isi status (teks maupun fotonya) |
| Laporan yang **diketik pelapornya** + siapa diblokir dan alasannya | isi percakapan yang dilaporkan |
| Siapa yang mengirim sebuah id pesan (buat "hapus untuk semua orang") | isi pesan itu sendiri |
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
public/auth-client.js  Login Google / dev.
public/files.js    Enkripsi, upload, unduh, dekripsi lampiran.
public/voice.js   Perekam pesan suara (MediaRecorder); hasilnya masuk jalur lampiran.
public/call.js     WebRTC mesh (1:1 & grup): suara, video, layar, tambah peserta.
public/app.js      UI + orkestrasi.
public/index.html  Kerangka halaman chat.
public/style.css   Seluruh tampilan; nilainya diambil dari DESIGN.md.
public/notifications.js  Izin + tampilan notifikasi, dan pengambilan balasan yang dititipkan.
public/sw.js       Service worker: notifikasi pesan, notifikasi panggilan dari Web Push, aksi balas/buka/terima/tolak.
push.js           Web Push server: kunci VAPID, langganan per akun, pengiriman notifikasi.
public/manifest.webmanifest  Identitas aplikasi (nama, ikon, warna) buat notifikasi & pemasangan.
public/admin.html  Halaman admin (laporan + blokir).
public/admin.js    Ambil data admin lewat REST dan render; nggak buka socket.
DESIGN.md          Sistem desain yang dipakai UI (warna, huruf, bentuk).
```

## Tampilan (mengikuti `DESIGN.md`)

UI-nya sengaja nggak punya bahasa desain sendiri: semua warna, bentuk, dan hurufnya diambil dari
`DESIGN.md`, dan token itu dipasang sebagai CSS custom property di `public/style.css` supaya
cuma ada satu sumber nilai.

| Token `DESIGN.md` | Nilai | Dipakai untuk |
|---|---|---|
| `{colors.primary}` | `#2563eb` | satu-satunya tombol biru, tautan, indikator aktif, baris terpilih |
| `{colors.primary-soft}` | `#e8f0ff` | gelembung pesan sendiri (biru pucat, teks tetap ink) |
| `{colors.primary-tint}` | `#eff6ff` | baris chat terpilih, latar kutipan balasan, strip balas |
| `{colors.ink}` / `{colors.text-muted}` | `#17202a` / `#687385` | teks utama, lalu jam dan label sekunder |
| `{colors.canvas}` / `{colors.paper}` | `#ffffff` | sidebar, header chat, area percakapan, kartu |
| `{colors.cloud}` / `{colors.fog}` | `#f7f8fa` / `#eef1f5` | latar aplikasi, halaman login, hover netral |
| `{colors.border}` | `#e4e8ef` | garis rambut 1px: pembatas panel, kolom isian, kolom ketik |
| `{colors.danger}` / `{colors.success}` / `{colors.warning}` | `#dc2626` / `#15803d` / `#b45309` | hapus–laporkan–tolak, online/berhasil, laporan menunggu |
| `{rounded.md}` / `{rounded.lg}` / `{rounded.xl}` | `8px` / `12px` / `16px` | tombol & input, panel & menu, kartu & gelembung pesan |

Hurufnya **Inter** dari Google Fonts. Kalau fontnya gagal dimuat, rangkaian fallback di
`style.css` tetap menampilkan halaman dengan benar; nggak ada tata letak yang bergantung pada
font itu.

Yang dipakai sebagai satu-satunya permukaan gelap cuma `{colors.ink-surface}` — layar panggilan,
penampil media, dan status selayar penuh. Sidebar, header chat, halaman admin, dan kartu login
semuanya permukaan putih dengan garis rambut, sesuai `DESIGN.md` yang bilang biru dan ink itu
warna aksi/aksen, bukan latar besar.

Satu penyimpangan yang disengaja dari `DESIGN.md`: **avatar bulat penuh**. Bentuk bulat memang yang
diminta produk, jadi itulah yang dipakai (dan itulah yang diperiksa tes browser). Sisa tokennya —
warna, huruf, ukuran sudut tombol/kartu, cincin status — tetap ikut `DESIGN.md`.

Yang **sengaja nggak ada**, karena `DESIGN.md` melarangnya: gradasi dekoratif, glow, blob latar
beranimasi, bayangan di setiap panel, dan warna saturasi kedua di layar. Chevron biru yang
sebelumnya mengapit kartu login sudah dibuang: `DESIGN.md` bilang aplikasi chat nggak butuh
grafik hero dekoratif.

### Menu & perpindahan panel

Bagian **App Shell** di `DESIGN.md` yang mengatur rail dan navbar bawah ini; nilainya tetap dari
token yang sama. Susunannya mengikuti pola aplikasi pesan yang sudah dikenal orang:

| Bagian | Desktop (>=761px) | HP (<=760px) |
|---|---|---|
| Menu utama | **rail** 76px di kolom paling kiri: logo, Chat, Status, Panggilan, Pengaturan, lalu avatar | **navbar bawah oval** yang melayang di atas isi |
| Kolom daftar | satu kolom untuk panel yang aktif, dipisahkan garis rambut 1px | panelnya penuh layar, satu panel per layar |
| Percakapan | kolom paling kanan, selalu terlihat | halaman penuh; navbar ikut menghilang dan tombol kembali mengembalikan ke daftar |
| Keluar & pengaturan | panel Pengaturan | panel Pengaturan |

Yang aktif ditandai permukaan putih (rail) atau `{colors.primary-tint}` (navbar), dan tiap
perpindahan panel memakai animasi masuk yang singkat (`view-in`, 240ms) plus transisi warna di
tombol menu. Navbar bawahnya satu-satunya tempat yang memakai efek kaca —
`backdrop-filter: blur(20px)`, latar putih transparan, sudut `{rounded.pill}`, dan bayangan
melayang: itu yang bikin kelihatan seperti navbar WhatsApp di iPhone. Kalau browsernya nggak
mendukung `backdrop-filter`, yang terlihat cuma latar putih semi-transparan — tetap terbaca,
cuma tanpa efek buram.

## Testing

```
npm test              # 104 test: kripto, file, auth, storage, username, status, kontak, moderasi, relay, signaling (termasuk grup & sibuk), aset notifikasi, tooling
npm run test:browser  # 307 cek: UI asli di Chrome, termasuk panggilan WebRTC, notifikasi, pesan suara, navbar hp, mode gelap, panah menu, dan Bersihkan/Hapus chat
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

Yang juga diuji di browser: klik kanan **dan** tahan di hp membuka menu yang sama, pesan lain
benar-benar diblur (filter CSS-nya diperiksa, bukan cuma class-nya), balasan membawa kutipan
beserta nama pengirim yang benar di tiap sisi, teruskan mengirim ulang ke chat tujuan, salin
menaruh teksnya di clipboard (termasuk saat Clipboard API ditolak), bintang, reaksi sampai ke
sisi lain, **hapus untuk saya** cuma menghilangkan di perangkat itu, **hapus untuk semua orang**
mengubah gelembung di kedua sisi jadi "Pesan ini sudah dihapus", dan foto dibuka selayar penuh
tanpa pindah tab (dimensi + byte hasil dekripsi dicek di dalam penampilnya).

Pesan suara diuji pakai mikrofon palsu Chrome yang memang menghasilkan audio: tombol kirim
berubah jadi mikrofon saat kolom kosong, timer rekaman berjalan, rekaman dikirim lewat jalur
lampiran terenkripsi, dan penerima bisa **memutarnya** — tombolnya berubah jadi jeda dan
batang gelombangnya terisi. Durasi dan jumlah batangnya harus sama di dua sisi, dan tombol
kecepatan harus berpindah ke `1,5x`. Jadi yang diperiksa bukan cuma "bubble-nya muncul".

Video ikut diuji dengan file asli: browser di jalur tes ini merekam sendiri video WebM dari
canvas, lalu memastikan penerimanya bisa membukanya di pemutar selayar penuh — dengan kontrol,
ter-dekode (`videoWidth > 0`), dan tanpa berpindah halaman atau membuka tab baru.
Rekamannya diulang sampai tiga kali kalau hasilnya cuma header WebM: `captureStream()` di Chrome
headless kadang hanya mengirim satu frame ketika mesin sedang sibuk (ukurannya lompat antara
~2.000 dan ~11.000 karakter base64). Syarat lulusnya tetap `> 2000`; yang diulang alat rekamnya,
bukan pemeriksaannya.

Soal panggilan, yang diperiksa bukan cuma "track-nya ada": energinya diukur pakai `AnalyserNode`
— mikrofon sendiri dan suara lawan bicara — plus elemen pemutarnya harus benar-benar berjalan
(bukan `paused`) dan tidak dalam keadaan mute. Keberadaan track saja pernah menyembunyikan bug
"panggilan tersambung tapi senyap": elemen audionya berhenti di keadaan paused, jadi tidak ada
suara yang keluar walau semua track hidup.

Yang juga diperiksa di jalur yang sama: jalur login nomor HP benar-benar hilang dari DOM (nggak
cuma disembunyikan) sementara tombol Google tetap ada, dan panel **Pengaturan** nggak lagi
memampangkan uid, driver penyimpanan, relay panggilan, atau peringatan private key.

Aturan status juga diuji dari dua sisi dalam satu jalur: sebelum Andi dan Budi pernah chat, daftar
penerima statusnya harus cuma berisi dirinya sendiri, sidebar Budi harus tetap kosong, dan satu
klien mentah (socket.io tanpa UI) sengaja mengirim status ke Budi dari akun asing — sisi penerima
harus tetap mengabaikannya. Sesudah mereka bertukar pesan, status yang baru harus sampai dan bisa
dibuka Budi. Jadi "status cuma buat yang sudah pernah chat" bukan cuma niat di kode.

Notifikasi diuji sebagai alur yang utuh, bukan cuma keberadaan tombolnya: tesnya menyalakan
sakelarnya dari **Pengaturan** (izinnya diberikan di level browser, karena dialog izin nggak bisa
diklik otomatis), memastikan service workernya terpasang di scope `/`, lalu membuat Andi pindah ke
percakapan lain supaya pesan Budi yang masuk benar-benar **muncul sebagai notifikasi** —
dicek langsung di daftar notifikasi Chrome (`registration.getNotifications()`), lengkap dengan
nama pengirim, isi pesan, id percakapan yang harus dibuka, pemilik notifikasinya, dan tombol balas.
Aksi balas itu lalu dipanggil pada **service worker yang sedang jalan**
(`self.bychatNotificationClick`, jalur yang sama dengan klik notifikasi di OS), dan hasilnya harus
sampai ke Budi lewat jalur enkripsi biasa — dicek dari sisi yang benar: gelembung keluar di layar
Andi, gelembung masuk di layar Budi.
Terakhir, pesan berikutnya dikirim saat Andi **sedang membaca** percakapan itu — di situ nggak
boleh ada notifikasi baru.

Menunya juga diuji sebagai perilaku, bukan cuma keberadaan tombolnya: `checkShell` menekan tiap
menu lewat jalur yang benar-benar dipakai orang (rail di desktop, navbar di hp), lalu memastikan
panelnya terbuka, cuma panel itu yang tampil, tombolnya bertanda aktif, dan animasi masuknya
benar-benar terpasang. Di layar hp, navbar bawahnya diperiksa dengan angka dari browser:
`border-radius: 9999px`, `position: fixed`, `backdrop-filter: blur(...)` dengan latar putih
transparan, masih di dalam layar, dan menyisakan jarak dari tepi bawah (jadi memang melayang,
bukan menempel). Riwayat panggilan juga diperiksa setelah panggilan sungguhan: entrinya muncul di
panel Panggilan dengan arah dan durasinya.

Tampilannya juga ikut diuji, bukan cuma dijelaskan di dokumen: `verifyDesignSystem` di
`browser-check.mjs` membaca **gaya yang benar-benar dihitung browser** di dua halaman sekaligus
(pengirim dan penerima) dan mencocokkannya dengan `DESIGN.md` — token warna, latar aplikasi
`#f7f8fa` yang permukaannya rata tanpa gradasi, huruf Inter, CTA `#2563eb` bersudut 8px dengan label huruf
biasa (bukan kapital), input 8px setinggi 44px, sidebar & kakinya permukaan putih dengan garis
rambut (bukan slab gelap), permukaan percakapan putih, baris terpilih `#eff6ff`, kartu 16px dengan
bayangan melayang, avatar bulat penuh, dan gelembung pesan sendiri yang biru pucat `#e8f0ff`
dengan teks ink sementara gelembung lawan tetap putih — dua-duanya dengan ekor 4px. Halaman login
juga ikut diperiksa: kartu putih 16px di atas kanvas `#f7f8fa`, tanpa strip gelap atau chevron, dan
label tombolnya bukan kapital lagi. Jadi kalau ada
yang mengembalikan tema gelap bergradasi atau label kapital, jalur tes ini yang gagal lebih dulu.

## Notifikasi

Notifikasi dinyalakan dari **Pengaturan → Notifikasi pesan**. Izinnya diminta ke browser saat kamu
menekan tombolnya, dan pilihannya disimpan per perangkat, jadi sehabis muat ulang halaman tinggal
jalan lagi (tanpa nanya dua kali). Tidak perlu konfigurasi server sama sekali.

Cara kerjanya:

1. Pesan yang sudah **didekripsi di halaman** dicek: kalau percakapannya sedang kamu buka dan
   jendelanya aktif, nggak ada notifikasi sama sekali.
2. Kalau nggak, halaman mengirim judul + cuplikan ke service worker (`public/sw.js`), dan service
   worker yang menampilkannya. **Kuncinya nggak pernah masuk ke service worker** — dia cuma
   memegang teks yang sudah jadi.
3. Klik notifikasi → service worker mengirim pesan ke jendela aplikasi (atau membukanya di
   `/?chat=<id>` kalau aplikasinya belum jalan), lalu chatnya terbuka.
4. Balasan: kalau browsernya mendukung kolom balas di notifikasi (Chrome Android, lewat
   `actions` bertipe `text`), teks yang kamu ketik diteruskan ke halaman, dienkripsi di sana, dan
   dikirim seperti pesan biasa. Kalau jendela aplikasinya sedang tertutup, teks itu dititipkan
   dulu di Cache Storage (maksimal 10 menit) dan dikirim begitu aplikasinya tersambung — jadi
   balasan nggak hilang. Di **Chrome desktop** kolom balas di notifikasi belum didukung browser,
   jadi klik notifikasinya yang membuka chat dan langsung memfokuskan kolom ketik.

Catatan: notifikasi butuh *secure context*, jadi jalan di `localhost` atau di domain HTTPS (lihat
bagian [HTTPS](#4-https)). Kalau izinnya pernah kamu blokir, tombol di Pengaturan berubah jadi
"Diblokir browser" — izinnya harus dibuka lagi dari pengaturan situs di browser, bukan dari
aplikasi ini.