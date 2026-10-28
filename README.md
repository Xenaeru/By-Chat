# By Chat

By Chat adalah aplikasi pesan instan dengan enkripsi ujung ke ujung (end-to-end encryption). Aplikasi ini mendukung pesan teks, pengiriman file, pesan suara, status 24 jam, serta panggilan suara dan video. Server hanya berperan sebagai perantara: server tidak menyimpan private key pengguna, tidak dapat membaca isi pesan maupun file, dan tidak melewatkan audio atau video panggilan.

## Ringkasan

- Setiap akun wajib memiliki satu username unik setelah login. Penulisan huruf besar dan kecil dipertahankan saat ditampilkan (`XenaboutYou` tetap `XenaboutYou`), tetapi keunikan dinilai setelah normalisasi: `Andi`, `andi`, dan `a.n.d.i` dianggap sama untuk mencegah peniruan identitas.
- Percakapan baru dimulai dari halaman tambah kontak (tombol **+**). Pengguna dicari melalui **ID pengguna** (6–12 angka, dibuat server dan tampil di halaman Profil). Percakapan dapat dibuka meskipun pihak yang dicari sedang offline.
- Halaman Profil punya sakelar **Profil Publik**. Saat aktif, siapa pun dapat melihat foto dan status; saat dimatikan, status hanya terlihat oleh orang yang pernah bertukar pesan. Status tetap hilang setelah 24 jam.
- Saluran (mirip Saluran WhatsApp) adalah siaran satu arah: siapa pun boleh membuatnya, hanya admin saluran yang bisa menulis, dan postingan tidak membawa nama penulis ke pengikut. Daftar pengikut hanya terbuka untuk admin saluran.
- Halaman admin (`/admin.html`) digunakan untuk meninjau laporan pengguna dan memblokir akun. **OWNER** ditentukan di sisi server melalui `ADMIN_EMAILS` atau `ADMIN_UIDS`; owner bisa mengangkat **admin** dan **moderator**, admin bisa mengangkat moderator dan memberi centang biru, dan moderator hanya bisa memberi centang biru.

## Memulai (mode pengembangan)

```bash
npm install
npm start
```

Buka `http://localhost:3000` di dua jendela browser berbeda. Tanpa berkas `.env`, aplikasi berjalan dalam mode pengembangan: login hanya memerlukan nama, file disimpan di disk lokal, dan panggilan menggunakan server STUN publik.

Mode pengembangan menolak berjalan ketika `NODE_ENV=production`.

## Fitur

| Fitur | Deskripsi |
|---|---|
| Pesan | Percakapan personal dan grup yang terenkripsi. Mendukung status online, indikator mengetik, penanda belum dibaca, status terkirim/dibaca, antrean pesan offline, dan pemisah hari. |
| Aksi pesan | Menu pada setiap gelembung pesan (panah di sudut, klik kanan, atau tekan lama di perangkat sentuh): reaksi cepat, Balas, Teruskan, Salin, Beri bintang, Laporkan, Hapus untuk saya, dan Hapus untuk semua orang. |
| Menu percakapan | Menu pada baris chat untuk menandai sudah/belum dibaca, membersihkan isi chat, atau menghapus chat dari perangkat. Dua aksi terakhir meminta konfirmasi. |
| File | Dienkripsi di browser sebelum diunggah (AES-GCM per bagian) dengan indikator progres. Foto dan video dibuka dalam penampil layar penuh di dalam aplikasi; dokumen lain diunduh. Nama file dan kuncinya hanya berada di dalam pesan terenkripsi. |
| Pesan suara | Perekaman hingga 5 menit dengan pengatur waktu dan visualisasi gelombang. Rekaman dikirim melalui jalur lampiran terenkripsi yang sama. Pemutaran mendukung kecepatan 1x, 1,5x, dan 2x. |
| Panggilan | Suara, video, dan berbagi layar melalui WebRTC. Mendukung panggilan 1:1 maupun grup hingga 8 peserta, serta penambahan peserta di tengah panggilan. Riwayat panggilan (tidak terjawab, terjawab beserta durasi, sedang berlangsung) tercatat di chat dan panel Panggilan. |
| Status | Teks, foto, atau video yang hilang otomatis setelah 24 jam. Profil publik memakai envelope dengan kunci sendiri sehingga siapa pun bisa membuka; profil privat tetap terenkripsi per kontak dan hanya sampai ke orang yang pernah bertukar pesan. |
| Profil | Kartu profil bergaya WhatsApp: banner, foto, nama, ID pengguna, status teks, tahun lahir, tombol Edit status, dan sakelar Profil Publik. |
| Saluran | Siaran satu arah yang bisa dibuat siapa pun: nama, deskripsi, foto opsional, jelajah saluran lain, ikuti/berhenti ikuti. Hanya admin saluran yang bisa mengirim; pengikut tidak melihat nama penulis, dan daftar pengikut hanya untuk admin saluran. |
| Panel info | Ketuk nama di header obrolan untuk membuka info orang, grup, atau saluran: tentang, media, anggota/pengikut, bisukan, favorit, blokir, laporkan, keluar grup, dan (untuk staf) pengaturan jabatan. |
| Jabatan & centang biru | Owner (dari env) otomatis bercentang biru dan memberi jabatan apa pun; admin otomatis bercentang biru dan memberi moderator + centang biru; moderator hanya centang biru. Badge tampil di daftar chat, header, panel info, dan halaman admin. Halaman admin juga punya tombol jabatan yang aturannya sama dengan panel info. |
| Pengaturan | Profil, tema Terang/Gelap/Otomatis, notifikasi pesan, dan tombol Keluar. |
| Mode gelap | Palet warna gelap tersendiri. Preferensi disimpan per perangkat dan diterapkan sebelum CSS dimuat sehingga tidak terjadi kilatan layar putih. Mode Otomatis mengikuti `prefers-color-scheme`. |
| Kontak | Pencarian dilakukan server berdasarkan ID pengguna. Hasilnya hanya uid, nama, ID, badge, dan status online — email dan nomor telepon tidak pernah ikut kembali. |
| Pelaporan | Pengguna dapat melaporkan akun dari header chat dengan memilih alasan dan menulis catatan. Isi percakapan tidak ikut terkirim. |
| Administrasi | Peninjauan laporan, penandaan selesai/diabaikan, pencarian pengguna, serta pemblokiran dan pembukaan blokir. Pemblokiran ditegakkan server dan langsung mengakhiri sesi yang sedang berjalan. |
| Autentikasi | Login Google melalui Firebase Authentication. |
| Verifikasi | Safety number untuk memastikan tidak ada penyisipan kunci. |
| Notifikasi | Notifikasi sistem untuk pesan baru dengan opsi balas langsung (Chrome Android), serta notifikasi panggilan masuk melalui Web Push dengan tombol Terima dan Tolak, termasuk saat aplikasi ditutup. |
| By AI | Asisten chat di dalam aplikasi untuk bertanya dan menempel tautan. Pesan di ruang ini diteruskan server ke penyedia AI yang kompatibel dengan API OpenAI (Gemini, Groq, DeepSeek, Ollama); di Gemini ia juga mencari di web (Google Search grounding + URL context). Jawabannya mengalir (streaming), jadi teks muncul sambil model menulis. Atur `AI_API_KEY`, `AI_BASE_URL`, dan `AI_MODEL` di `.env`; kuota harian lewat `AI_DAILY_LIMIT`, browsing lewat `AI_WEB`, panjang jawaban lewat `AI_MAX_TOKENS`, kedalaman berpikir Gemini 3 lewat `AI_THINKING` (default `low`), batas waktu lewat `AI_TIMEOUT_MS` (default 90 detik), dan cadangan otomatis (mis. Ollama) lewat `AI_FALLBACK_*`. |

## Versi Android (APK)

Folder `android/` berisi project yang membungkus aplikasi web ini menjadi APK
(Trusted Web Activity): ikon sendiri, layar penuh tanpa address bar, tapi tetap
dijalankan Chrome yang ada di HP. Itu yang membuat Web Push, panggilan, dan
enkripsi di browser ikut berfungsi tanpa kode terpisah. Syaratnya satu: situsnya
harus hidup di domain HTTPS, dan domain itu harus menyatakan pemilik APK-nya
lewat `/.well-known/assetlinks.json` (dilayani `src/server.js`, diisi lewat
`ANDROID_PACKAGE_NAME` + `ANDROID_SHA256_CERT_FINGERPRINTS`).

Langkah pasang dan build ulang: [`docs/ANDROID.md`](docs/ANDROID.md).

## Konfigurasi untuk lingkungan produksi

```bash
cp .env.example .env
npm run check-env
npm run check-env -- --live
```

`check-env` memeriksa kelengkapan dan validitas konfigurasi tanpa menampilkan nilai rahasia. Perintah ini keluar dengan kode 1 selama masih ada variabel wajib yang belum benar. Opsi `--live` menambahkan pengujian kunci Supabase terhadap project yang sebenarnya.

### 1. Autentikasi (Firebase)

1. Buat project di [Firebase Console](https://console.firebase.google.com).
2. Pada **Authentication > Sign-in method**, aktifkan **Google**. Login nomor telepon (OTP SMS) tidak didukung karena memerlukan paket berbayar Firebase.
3. Pada **Project settings > Your apps**, daftarkan aplikasi web, lalu salin konfigurasinya ke `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, dan `FIREBASE_MESSAGING_SENDER_ID`.
4. Pada **Project settings > Service accounts**, buat private key baru (berkas `.json`). Pilih salah satu cara berikut:
   - Isi `GOOGLE_APPLICATION_CREDENTIALS` dengan path berkas tersebut.
   - Jalankan skrip bantu: `node scripts/set-service-account.mjs "C:/path/ke/firebase-adminsdk-xxxx.json"`.
   - Isi `FIREBASE_SERVICE_ACCOUNT` secara manual dengan JSON satu baris, misalnya dari keluaran `node -e "console.log(JSON.stringify(require('C:/path/ke/key.json')))"`. Nilai harus berada dalam satu baris, tanpa tanda kutip dan tanpa spasi tambahan, karena parser `.env` berhenti di akhir baris.
5. Pada **Authentication > Settings > Authorized domains**, tambahkan domain aplikasi. Tanpa langkah ini, login gagal dengan galat `auth/unauthorized-domain`.

`FIREBASE_SERVICE_ACCOUNT` hanya digunakan server untuk memverifikasi ID token dan tidak boleh ditempatkan pada kode sisi klien.

### 2. Penyimpanan file (Supabase Storage)

1. Buat project di [Supabase](https://supabase.com/dashboard).
2. Pada **Storage**, buat bucket bernama `attachments` dan biarkan bersifat private.
3. Pada **Project settings > API keys**, salin Project URL ke `SUPABASE_URL` dan kunci rahasia ke `SUPABASE_SERVICE_ROLE_KEY`.

| Kunci di dashboard | Dapat digunakan |
|---|---|
| `sb_secret_...` (Secret key, format baru) | Ya |
| `service_role` JWT (diawali `eyJ...`) | Ya (format lama) |
| `sb_publishable_...` (Publishable key) | Tidak, unggahan akan ditolak |
| `anon` JWT | Tidak, unggahan akan ditolak |

Penggunaan kunci yang salah menghasilkan galat `new row violates row-level security policy` saat mengunggah.

Service role key bersifat rahasia dan hanya digunakan server untuk membuat signed URL. Kunci ini tidak pernah dikirim ke browser. Klien mengunggah dan mengunduh langsung ke Supabase melalui signed URL, sehingga data file tidak melewati server aplikasi.

**Batas ukuran file.** Supabase membatasi ukuran per objek, dan setiap file disimpan sebagai satu objek. Paket gratis dibatasi 50 MB (unggahan 51 MiB ditolak dengan `413 EntityTooLarge`). Oleh karena itu `.env.example` menetapkan `MAX_UPLOAD_BYTES=47185920` (45 MiB) agar penolakan terjadi di aplikasi dengan pesan yang jelas. Naikkan nilai ini hanya jika paket Supabase yang digunakan memiliki batas objek lebih besar.

### 3. Panggilan (TURN)

Server STUN publik digunakan secara otomatis, tetapi STUN saja tidak memadai pada NAT yang ketat maupun CGNAT operator seluler (sekitar 10-20% panggilan). Untuk penggunaan oleh banyak pengguna, konfigurasikan TURN:

```
TURN_URLS=turn:global.turn.twilio.com:3478?transport=udp,turn:global.turn.twilio.com:3478?transport=tcp
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

Layanan TURN dapat berasal dari [Twilio Network Traversal](https://console.twilio.com), Vonage, atau [coturn](https://github.com/coturn/coturn) yang dikelola sendiri.

Tanpa TURN, kondisi "panggilan tersambung tetapi tidak ada suara" umumnya disebabkan kegagalan jalur P2P pada jaringan tersebut. Aplikasi menampilkan pesan yang merujuk pada kebutuhan relay TURN dan mencoba menyusun ulang jalur ICE satu kali sebelum menyerah. Audio lawan bicara diputar melalui elemen `<audio>` tersendiri, dan layar panggilan menampilkan meter mikrofon. Jika browser menahan pemutaran suara, tombol untuk mengaktifkannya akan muncul.

### 4. Panggilan saat aplikasi tertutup (Web Push)

Browser yang telah memberi izin notifikasi mendaftarkan endpoint push ke server, dan server mengirim notifikasi panggilan melalui endpoint tersebut. Kunci VAPID dibuat otomatis satu kali dan disimpan pada `registry/push.json` di bucket Supabase atau `data/push.json` pada driver `local`, sehingga tidak ada variabel lingkungan yang wajib diisi. Untuk menggunakan kunci tetap (misalnya ketika beberapa instance berbagi langganan yang sama), isi `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, dan `VAPID_SUBJECT`.

Keterbatasan: notifikasi panggilan muncul dan berbunyi ketika aplikasi tertutup, tetapi menggunakan nada notifikasi sistem, bukan dering berulang, karena browser tidak mengizinkan service worker memutar audio sendiri. Menekan **Terima** membuka aplikasi dan langsung menjawab panggilan.

### 5. HTTPS

HTTPS wajib jika aplikasi diakses melalui domain atau alamat IP jaringan lokal. `crypto.subtle` (digunakan untuk seluruh enkripsi) dan `getUserMedia` (kamera dan mikrofon) hanya tersedia pada secure context. `localhost` dianggap aman; untuk akses lain diperlukan TLS, misalnya melalui reverse proxy nginx atau Caddy, atau Cloudflare Tunnel.

## Deploy di VPS sendiri

VPS kecil (2 vCPU / 2 GB RAM / 4 GB disk) sudah cukup: satu proses Node di belakang Caddy dengan HTTPS otomatis, semuanya di satu origin. `deploy/setup-vps.sh` memasang Node 22, user sistem, unit systemd, dan Caddyfile; `deploy/update.sh` menarik kode baru lalu restart.

```bash
sudo bash deploy/setup-vps.sh bychat.my.id
```

Panduan lengkap (DNS `.my.id`, `.env` produksi, Firebase Authorized domains, kapasitas disk, pemecahan masalah): [`docs/DEPLOY-VPS.md`](docs/DEPLOY-VPS.md).

## Deploy ke Render

Aplikasi memerlukan host yang menjalankan proses Node secara terus-menerus dan mendukung WebSocket. Render memenuhi syarat ini, sedangkan Vercel, Netlify, dan Cloudflare Workers tidak. Berkas `render.yaml` sudah menetapkan region `singapore`, health check `/healthz`, `NODE_ENV=production`, `AUTH_MODE=firebase`, dan `STORAGE_DRIVER=supabase`. Yang perlu diisi hanya sembilan nilai rahasia.

**a. Push kode ke repositori.**

```bash
git push -u origin main
```

**b. Siapkan nilai variabel lingkungan.**

```bash
npm run check-env
npm run render-env -- --copy
```

Perintah kedua menulis `render-env.txt` dan menyalinnya ke clipboard. Berkas ini berisi rahasia sebenarnya; berkas sudah tercantum di `.gitignore` dan sebaiknya dihapus setelah digunakan. Isinya sengaja tidak memuat `NODE_ENV`, `PORT`, dan `STORAGE_DRIVER` agar setelan dari `render.yaml` tidak tertimpa.

**c. Buat service di Render.** Pilih **New > Blueprint**, pilih repositori (untuk repositori privat, berikan akses terlebih dahulu kepada GitHub App Render), lalu pada form variabel pilih **Add from .env**, tempel isi clipboard, dan jalankan **Deploy web service**.

Jika variabel diisi satu per satu:

| Variabel | Sumber |
|---|---|
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID` | Firebase Console > Project settings > Your apps |
| `FIREBASE_SERVICE_ACCOUNT` | Nilai satu baris di `.env` (lihat bagian Autentikasi) |
| `SUPABASE_URL` | Supabase > Project settings > API |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret key Supabase (bukan publishable key) |
| `ADMIN_EMAILS` | Email akun Google yang berhak membuka `/admin.html`; beberapa alamat dipisahkan koma. `ADMIN_UIDS` dapat digunakan untuk menunjuk admin berdasarkan uid. |

Dengan `STORAGE_DRIVER=supabase`, data berikut disimpan pada bucket yang sama sehingga tetap ada saat service tidur atau di-deploy ulang: blob lampiran terenkripsi, `registry/usernames.json` (daftar username), `registry/moderation.json` (laporan dan blokir), `registry/accounts.json` (indeks kontak), dan folder `avatars/` (foto profil). Pada driver `local` di host dengan disk ephemeral, seluruh data ini hilang setiap restart.

`render.yaml` tidak menetapkan `PORT`; Render menyuntikkannya sendiri dan `src/config.js` membacanya.

Dua kesalahan yang sering terjadi saat mengisi form secara manual:

- Menambahkan variabel `PORT`, sehingga service mendengarkan port yang salah.
- Mengubah `NODE_ENV` menjadi `development`. Pada mode pengembangan, server mempercayai uid apa pun yang diklaim browser, sehingga siapa pun dapat mengaku sebagai akun lain.

**d. Daftarkan domain.** Salin URL service (`https://<nama-service>.onrender.com`) dan tambahkan domain tersebut (tanpa `https://`) ke **Firebase > Authentication > Settings > Authorized domains**. HTTPS disediakan otomatis oleh Render.

**e. Verifikasi deployment.**

```bash
npm run verify-token -- https://nama-app.onrender.com
```

Skrip ini membuat ID token asli yang ditandatangani Google, menyambung ke server, dan memastikan token palsu ditolak.

**f. Mencegah service tidur (opsional).** Service gratis Render tidur setelah 15 menit tanpa trafik, termasuk trafik WebSocket, dan memerlukan sekitar satu menit untuk aktif kembali. Melakukan ping ke `/healthz` setiap 10-14 menit melalui cron-job.org atau UptimeRobot menjaga service tetap aktif dan masih berada dalam kuota 750 jam instance per bulan. Jika service dibiarkan tidur, file tetap aman di Supabase, tetapi state yang hanya ada di memori (direktori pengguna dan antrean pesan offline) hilang sehingga pengguna perlu login ulang.

## Arsitektur enkripsi

| Langkah | Proses |
|---|---|
| 1 | Setiap akun memiliki key pair ECDH P-256 yang dibuat di browser. Private key disimpan di `localStorage` dan tidak pernah dikirim ke server. |
| 2 | Hanya public key yang dikirim ke server dan dipakai sebagai daftar kontak. |
| 3 | Dua pengguna menurunkan shared secret melalui ECDH, kemudian HKDF-SHA256, menghasilkan kunci AES-256-GCM. |
| 4 | Setiap pesan menggunakan kunci acak sekali pakai. Teks dienkripsi satu kali, lalu kunci tersebut dibungkus terpisah untuk setiap anggota grup. |
| 5 | Server hanya menerima ciphertext dan bungkusan kunci. |

**File.** File dienkripsi per bagian 4 MiB dengan kunci tersendiri. Kunci dan nama file ditempatkan di dalam pesan terenkripsi sehingga server maupun penyimpanan tidak pernah mengetahuinya. Nomor bagian dan jumlah total disertakan sebagai additional authenticated data (AAD), sehingga blob yang urutannya diubah atau yang dipotong akan terdeteksi.

**Pesan suara.** Rekaman `MediaRecorder` dikemas menjadi file dan menggunakan jalur enkripsi file. Penanda `voice` dan durasi disimpan di dalam payload terenkripsi sehingga server tidak dapat membedakan pesan suara dari dokumen biasa.

**Panggilan.** Media dienkripsi dengan DTLS-SRTP langsung antar browser. Pada panggilan grup, setiap pasangan peserta memiliki koneksi sendiri (topologi mesh). Server hanya meneruskan SDP dan ICE. Bila TURN digunakan, relay hanya meneruskan paket yang sudah terenkripsi. Notifikasi panggilan melalui Web Push hanya memuat nama pemanggil dan id panggilan.

## Data yang dapat dan tidak dapat diakses server

| Dapat diakses | Tidak dapat diakses |
|---|---|
| uid, username, email, nomor telepon, dan public key | Private key pengguna |
| Pesan terenkripsi selama penerima offline | Isi pesan |
| Nama acak blob file dan isi terenkripsinya | Nama file asli, tipe, kunci, dan isi file |
| Informasi siapa menelepon siapa dan waktunya | Audio dan video panggilan |
| Informasi siapa memasang status dan waktunya | Isi status (teks, foto, maupun video) |
| Laporan yang ditulis pelapor serta daftar akun terblokir beserta alasannya | Isi percakapan yang dilaporkan |
| Pengirim sebuah id pesan (untuk fitur "hapus untuk semua orang") | Isi pesan tersebut |
| Foto profil dan foto saluran (tidak dienkripsi) | - |
| ID pengguna, status teks, tahun lahir, jabatan, dan centang biru | Private key pengguna |
| Nama/deskripsi saluran, pengikut, dan daftar anggota grup | Isi pesan pribadi dan grup |

**Catatan tentang status publik dan saluran.** Keduanya memang siaran, jadi envelope-nya membawa kunci sendiri (`mode: "public"`) agar pengikut baru dan orang yang bukan kontak tetap bisa membacanya. Konsekuensinya, server yang menyimpan envelope itu secara teknis bisa membuka isinya. Jangan menaruh hal rahasia di status publik atau saluran; untuk percakapan tetap pakai pesan biasa yang terenkripsi per penerima.

Email dan nomor telepon disimpan di server (diperoleh dari penyedia login yang telah memverifikasinya), tetapi tidak disiarkan ke klien. Klien hanya menerima nama, foto, dan public key. Kedua data tersebut hanya muncul melalui dua jalur: hasil pencarian kontak (yang tidak mengembalikan nilainya) dan halaman admin.

Foto profil adalah satu-satunya unggahan yang tidak dienkripsi, karena memang ditujukan untuk dilihat oleh siapa pun yang melihat nama pengguna. Server memeriksa ukuran (maksimal 2 MB) dan jenis gambar dari byte aslinya, bukan dari header yang dikirim browser. Pengguna dapat menghapus foto profil tanpa mengganggu fungsi aplikasi.

## Struktur proyek

```
src/
  server.js          Entry point: relay, direktori kunci, lampiran, signaling, admin
  config.js          Pembacaan .env, pemilihan driver, pemisahan konfigurasi publik dan rahasia
  auth.js            Verifikasi ID token (driver: firebase | dev; dev diblokir di production)
  storage.js         Driver blob (supabase | local); path selalu dibuat server
  usernames.js       Namespace username (normalisasi, nama sistem, penyimpanan permanen)
  moderation.js      Laporan pengguna dan daftar blokir
  accounts.js        Indeks email dan nomor telepon (tidak lagi dipakai mencari kontak)
  profiles.js        ID pengguna, status, tahun lahir, profil publik, jabatan, riwayat chat
  channels.js        Saluran: pengikut, admin, postingan, foto
  push.js            Web Push: kunci VAPID, langganan per akun, pengiriman notifikasi

public/
  index.html         Kerangka halaman chat
  admin.html         Halaman admin (laporan dan pemblokiran)
  manifest.webmanifest
  sw.js              Service worker: notifikasi pesan/panggilan dan aksi balas/buka/terima/tolak
  js/
    app.js           Antarmuka dan orkestrasi
    admin.js         Pengambilan data admin melalui REST dan rendering
    auth-client.js   Login Google / dev
    crypto.js        Seluruh primitif E2EE (WebCrypto; berjalan di browser dan Node)
    files.js         Enkripsi, unggah, unduh, dan dekripsi lampiran
    voice.js         Perekam pesan suara
    call.js          WebRTC mesh (1:1 dan grup): suara, video, layar, tambah peserta
    notifications.js Izin dan tampilan notifikasi, pengambilan balasan yang dititipkan
  css/
    style.css        Seluruh tampilan, mengacu pada token di DESIGN.md
  assets/            Logo dan ikon aplikasi

docs/
  STRUCTURE.md       Peta folder, alur HTTP, dan alur event Socket.IO
scripts/             Alat bantu: cek env, deploy, screenshot, tes browser
test/                Pengujian otomatis (node --test)
DESIGN.md            Sistem desain (warna, tipografi, bentuk)
```

Alur request HTTP dan event Socket.IO dijelaskan lebih lengkap di [`docs/STRUCTURE.md`](docs/STRUCTURE.md).

## Desain antarmuka

Antarmuka mengikuti `DESIGN.md`. Seluruh token warna, bentuk, dan tipografi dipasang sebagai CSS custom property di `public/css/style.css` sehingga hanya ada satu sumber nilai.

| Token | Nilai | Penggunaan |
|---|---|---|
| `primary` | `#2563eb` | Tombol utama, tautan, indikator aktif |
| `primary-soft` | `#e8f0ff` | Gelembung pesan sendiri |
| `primary-tint` | `#eff6ff` | Baris chat terpilih, kutipan balasan |
| `ink` / `text-muted` | `#17202a` / `#687385` | Teks utama / teks sekunder |
| `canvas` / `paper` | `#ffffff` | Sidebar, header, area percakapan, kartu |
| `cloud` / `fog` | `#f7f8fa` / `#eef1f5` | Latar aplikasi dan halaman login / hover netral |
| `border` | `#e4e8ef` | Garis pemisah 1px |
| `danger` / `success` / `warning` | `#dc2626` / `#15803d` / `#b45309` | Aksi destruktif / berhasil / menunggu |
| `rounded.md` / `lg` / `xl` | `8px` / `12px` / `16px` | Tombol dan input / panel dan menu / kartu dan gelembung |

Tipografi menggunakan Inter (Google Fonts) dengan rangkaian fallback sehingga tata letak tidak bergantung pada pemuatan font. Permukaan gelap hanya digunakan pada layar panggilan, penampil media, dan status layar penuh. Gradasi dekoratif, efek glow, dan bayangan berlebihan sengaja tidak digunakan. Satu penyimpangan yang disengaja dari `DESIGN.md` adalah avatar berbentuk lingkaran penuh.

### Navigasi

| Komponen | Desktop (lebar 761 px ke atas) | Ponsel (lebar 760 px ke bawah) |
|---|---|---|
| Menu utama | Rail 76 px di sisi kiri: logo, Chat, Status, Panggilan, Pengaturan, avatar | Navbar bawah berbentuk oval yang melayang |
| Daftar | Satu kolom untuk panel aktif | Satu panel per layar |
| Percakapan | Kolom kanan, selalu terlihat | Halaman penuh; navbar disembunyikan, tombol kembali menuju daftar |

Menu aktif ditandai dengan permukaan putih (rail) atau `primary-tint` (navbar). Perpindahan panel menggunakan animasi masuk 240 ms. Navbar bawah menggunakan `backdrop-filter: blur(20px)` dengan latar putih transparan; pada browser yang tidak mendukungnya, navbar tampil sebagai latar putih semi-transparan.

## Pengujian

```bash
npm test                              # Pengujian unit dan integrasi (node --test)
npm run test:browser                  # Pengujian UI end-to-end di Chrome
CALL_DEBUG=1 npm run test:browser     # Dengan log negosiasi WebRTC
```

`test:browser` memerlukan Chrome. Jika Chrome tidak berada di lokasi default, atur variabel `CHROME_PATH`. Pengujian panggilan menggunakan perangkat kamera dan mikrofon virtual bawaan Chrome.

**Cakupan `npm test`:** kriptografi, file, autentikasi, penyimpanan, username, status, kontak, moderasi, relay, signaling (termasuk panggilan grup dan kondisi sibuk), aset notifikasi, dan alat bantu.

**Cakupan `npm run test:browser`:**

- Pesan dan file: login dua profil, pencarian kontak, pengiriman pesan dan file, pembukaan foto dan video pada penampil layar penuh (dimensi dan byte hasil dekripsi diverifikasi).
- Aksi pesan: menu klik kanan dan tekan lama, efek blur pada pesan lain, balas dengan kutipan, teruskan, salin, bintang, reaksi, hapus untuk saya, dan hapus untuk semua orang.
- Pesan suara: perekaman, pengiriman terenkripsi, pemutaran di sisi penerima, kesesuaian durasi dan jumlah batang gelombang, serta pengubahan kecepatan.
- Panggilan: koneksi suara, pengaktifan kamera di tengah panggilan, penutupan di kedua sisi, pengukuran energi audio melalui `AnalyserNode`, dan pemeriksaan bahwa elemen audio benar-benar berjalan dan tidak dibisukan. Riwayat panggilan diperiksa setelah panggilan sungguhan.
- Moderasi: pelaporan dari header chat, pembacaan laporan di halaman admin, pemblokiran (sesi korban langsung berhenti dan menampilkan alasan), dan pembukaan blokir.
- Status: penerima status hanya mencakup pengguna yang pernah bertukar pesan, dan klien mentah yang mengirim status dari akun asing diabaikan oleh sisi penerima.
- Notifikasi: pengaktifan dari Pengaturan, pemasangan service worker, kemunculan notifikasi (nama pengirim, isi, id percakapan, tombol balas), aksi balas pada service worker yang berjalan, dan tidak adanya notifikasi saat percakapan sedang dibaca.
- Navigasi dan desain: `checkShell` menguji rail dan navbar melalui interaksi nyata, dan `verifyDesignSystem` membandingkan gaya hasil komputasi browser dengan `DESIGN.md` pada halaman pengirim dan penerima, termasuk halaman login.
- Keamanan: server tidak memegang private key, token tidak valid ditolak, dan pihak ketiga tidak dapat menyusup ke signaling panggilan pengguna lain.

Perekaman video pada pengujian diulang hingga tiga kali jika hasilnya hanya berisi header WebM, karena `captureStream()` pada Chrome headless kadang hanya mengirim satu frame saat mesin sibuk. Kriteria lulus tetap sama (ukuran lebih dari 2000 karakter base64).

### Alat bantu

```bash
npm run check-env                                  # Periksa .env (kode keluar 1 jika ada yang salah)
npm run check-env -- --live                        # Termasuk uji kunci Supabase
npm run render-env -- --copy                       # Sembilan nilai variabel untuk Render
npm run set-service-account -- "C:/path/key.json"  # Isi FIREBASE_SERVICE_ACCOUNT satu baris
npm run verify-token -- https://app.onrender.com   # Verifikasi pemeriksaan ID token pada deployment
npm run screenshots                                # Ambil tangkapan layar UI ke screenshots/ (butuh Chrome)
```

Seluruh alat bantu tidak menampilkan nilai rahasia.

## Notifikasi

Notifikasi diaktifkan dari **Pengaturan > Notifikasi pesan**. Izin diminta ke browser saat tombol ditekan, dan pilihan disimpan per perangkat. Tidak diperlukan konfigurasi server.

1. Pesan yang sudah didekripsi di halaman diperiksa terlebih dahulu: jika percakapannya sedang dibuka dan jendela aktif, notifikasi tidak ditampilkan.
2. Jika tidak, halaman mengirim judul dan cuplikan teks ke service worker (`public/sw.js`) untuk ditampilkan. Kunci enkripsi tidak pernah diberikan kepada service worker; service worker hanya menerima teks yang sudah jadi.
3. Mengklik notifikasi membuka percakapan terkait, baik melalui jendela aplikasi yang sudah berjalan maupun dengan membuka `/?chat=<id>`.
4. Balasan langsung dari notifikasi didukung pada browser yang mengizinkan aksi bertipe `text` (Chrome Android). Teks balasan dienkripsi di halaman dan dikirim seperti pesan biasa. Jika jendela aplikasi tertutup, teks disimpan sementara di Cache Storage (maksimal 10 menit) dan dikirim setelah aplikasi tersambung. Pada Chrome desktop, kolom balas pada notifikasi belum didukung; mengklik notifikasi akan membuka chat dan memfokuskan kolom ketik.

Notifikasi memerlukan secure context (`localhost` atau domain HTTPS; lihat bagian [HTTPS](#5-https)). Jika izin sebelumnya diblokir, tombol di Pengaturan menampilkan "Diblokir browser", dan izin harus dibuka kembali melalui pengaturan situs pada browser.
