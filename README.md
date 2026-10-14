# 🔒 Secure Chat

Aplikasi chat ala WhatsApp dengan **end-to-end encryption** yang beneran — pesan, **file**, dan
**panggilan suara/video**. Server cuma perantara buta: dia nggak punya private key siapa pun,
nggak bisa baca isi pesan, nggak bisa buka isi file, dan nggak pernah menyentuh audio/video.

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

Repo ini sudah ada `render.yaml`-nya, jadi tinggal push dan klik. Butuh host yang bisa
jalanin proses Node terus-menerus **dan** mendukung WebSocket — Render masuk kriteria itu
(Vercel, Netlify, dan Cloudflare Workers **tidak**, karena servernya nggak punya proses panjang).

```bash
# 1. sekarang repo git-nya sudah siap (branch main, 1 commit)
#    bikin repo kosong di GitHub dulu, lalu:
git remote add origin https://github.com/USERNAME/secure-chat.git
git push -u origin main

# 2. di Render: New → Blueprint → pilih repo-nya → Apply
#    Render baca render.yaml dan menanyakan nilai tiap rahasia
```

Saat diminta, tempel nilai-nilai ini (semuanya dari `.env`-mu):

| Yang ditanya Render | Ambil dari |
|---|---|
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID` | Firebase Console → Project settings → Your apps |
| `FIREBASE_SERVICE_ACCOUNT` | nilai satu baris di `.env` (lihat langkah 1 di atas) |
| `SUPABASE_URL` | Supabase → Project settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret key Supabase (bukan publishable) |

`render.yaml` sengaja **tidak** menyetel `PORT` — Render yang menentukan port dan
menyuntikkannya lewat variabel `PORT`, dan `config.js` sudah membacanya. Health check
memakai `/healthz` yang sudah ada di server.

**Wajib setelah dapat domain:** tambahkan domain `*.onrender.com` kamu ke **Firebase →
Authentication → Settings → Authorized domains**. Tanpa itu login Google gagal dengan
`auth/unauthorized-domain`. HTTPS dari Render otomatis, jadi `crypto.subtle` dan kamera
langsung jalan.

**Buktikan hasil deploy-nya bekerja:**

```bash
npm run verify-token -- https://nama-app-mu.onrender.com
```

Script itu bikin ID token asli bertanda tangan Google, menyambung ke server, dan
memastikan token palsu ditolak — tanpa kamu perlu login manual di browser.

Catatan pemakaian gratis: service **tidur setelah 15 menit sepi** dan bangunnya sekitar
satu menit, disk-nya ephemeral (gak masalah, file ada di Supabase), dan semua state
(direktori user, antrian pesan offline) cuma di memori — jadi restart = orang harus
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
| uid, nama, nomor HP, dan **public** key | private key siapa pun |
| Pesan terenkripsi selama penerima offline | isi pesan |
| Nama acak blob file dan isinya yang terenkripsi | nama file asli, tipe, kunci, atau isinya |
| Siapa menelepon siapa dan kapan | audio/video panggilan |

## Struktur

```
config.js          Baca .env, pilih driver, pisah config publik vs rahasia.
auth.js            Verifikasi ID token. Driver: firebase | dev (dev diblokir di production).
storage.js         Driver blob: supabase | local. Path selalu dibuat server.
server.js          Relay + direktori kunci + endpoint lampiran + signaling panggilan.
public/crypto.js   Semua primitif E2EE. Pakai WebCrypto, jalan di browser dan Node.
public/auth-client.js  Login Google / OTP nomor HP / dev.
public/files.js    Enkripsi, upload, unduh, dekripsi lampiran.
public/call.js     WebRTC 1:1: suara, video, layar.
public/app.js      UI + orkestrasi.
```

## Testing

```
npm test              # 52 test: kripto, file, auth, storage, relay, signaling, tooling
npm run test:browser  # 47 cek: UI asli di Chrome, termasuk panggilan WebRTC beneran
CALL_DEBUG=1 npm run test:browser   # nyalain jejak negosiasi WebRTC di console
```

Alat bantu setup (semuanya nggak pernah menampilkan nilai rahasia):

```
npm run check-env            # cek .env: mana yang kosong/salah, keluar kode 1 kalau ada
npm run check-env -- --live  # plus tes kunci Supabase ke project aslinya
npm run set-service-account -- "C:/path/key.json"   # isi FIREBASE_SERVICE_ACCOUNT 1 baris
npm run verify-token -- https://app.onrender.com    # buktikan verifikasi ID token jalan
```

`test:browser` butuh Chrome. Kalau nggak di lokasi default, set `CHROME_PATH`.
Panggilan diuji pakai perangkat kamera/mikrofon palsu bawaan Chrome.

Yang diverifikasi antara lain: envelope nggak mengandung plaintext (dicek dari memori
server), blob di disk benar-benar ciphertext dan byte hasil dekripsi identik dengan
aslinya, chunk file yang diubah/dipotong/diacak urutannya kedeteksi, server nggak
pernah pegang private key, token ngawur ditolak, pihak ketiga nggak bisa nyusup ke
signaling panggilan orang lain, dan di browser: dua profil login, kirim pesan, kirim
file, lalu **panggilan suara tersambung, kamera dinyalakan di tengah panggilan terlihat
lawan bicara, dan hangup menutup di dua sisi**.

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
- **Belum ada rate limiting** di relay dan endpoint lampiran.
- **State server in-memory** (direktori kunci + antrian offline); restart = antrian hilang.
