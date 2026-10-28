# Deploy di VPS sendiri (2 vCPU / 2 GB RAM / 4 GB disk)

Panduan ini memasang **seluruh** aplikasi — halaman statis di `public/` dan server Node/Socket.IO — di satu VPS, dengan HTTPS otomatis dari Caddy. Satu origin, satu proses. Contoh di bawah memakai domain `bychat.my.id` dan folder `/opt/bychat/app`; ganti dengan milikmu.

## Kenapa bukan Vercel

| Kebutuhan aplikasi | Vercel (serverless) |
|---|---|
| Proses Node hidup terus (`npm start`, `src/server.js`) | Fungsi dibuat dan dimatikan per request |
| WebSocket Socket.IO persis (`public/js/app.js:1015`) | Tidak ada koneksi persisten; hanya edge/streaming terbatas |
| State di memori: direktori pengguna, antrean pesan offline, signaling panggilan | Setiap request bisa mendarat di instance berbeda |
| Satu origin: klien memanggil `fetch('/config.json')`, `fetch('/api/...')`, `io()` | Butuh CORS + URL absolut + cookie lintas domain, artinya ubah kode |

Vercel tetap berguna untuk hal lain (landing page, dokumentasi), tapi aplikasi ini harus berjalan di host yang punya proses Node terus-menerus dan mendukung WebSocket. `render.yaml` di repo ini menyatakan hal yang sama untuk Render.

Penting: **jangan pecah frontend ke Vercel dan backend ke VPS tanpa mengubah kode.** Semua permintaan di `public/js` memakai path relatif, dan autentikasi Firebase terikat pada domain yang terdaftar. Memisahkannya berarti menambah CORS, URL API absolut di klien, penanganan `credentials`, dan domain Vercel di Authorized domains — perubahan yang jauh lebih besar daripada manfaatnya untuk aplikasi satu-biner seperti ini.

## Kapasitas: apakah 2 vCPU / 2 GB / 4 GB cukup?

Ya, untuk puluhan sampai ratusan pengguna aktif bersamaan. Angka nyata dari repo ini:

| Komponen | Ukuran |
|---|---|
| `node_modules` produksi (`npm ci --omit=dev`) | **96 MB** (130 MB kalau devDependencies ikut) |
| Kode aplikasi + `public/` | ± 2 MB |
| Debian/Ubuntu minimal | ± 1.2–1.8 GB |
| Swap yang dibuat skrip (`SWAP_MB=1024`) | 1 GB |
| Sisa untuk log + data | ± 400–800 MB |

Karena itu:

- Skrip memakai `npm ci --omit=dev` (devDependencies `puppeteer-core` tidak ikut) dan membersihkan cache npm setelahnya.
- Lampiran file, daftar username, laporan, dan foto profil disimpan di **Supabase** (`STORAGE_DRIVER=supabase`), bukan di disk VPS. Disk 4 GB tidak cukup untuk riwayat lampiran pengguna.
- Log Caddy diarahkan ke journald (bukan file sendiri) supaya tidak menumpuk tanpa rotasi.

Kalau disk terasa sesak:

```bash
sudo apt-get clean                                  # cache paket .deb
sudo journalctl --vacuum-size=100M                  # kecilkan log journal
sudo npm cache clean --force
df -h /
```

Batas permanen untuk journald (opsional, mesin ini khusus aplikasi):

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=150M\n' | sudo tee /etc/systemd/journald.conf.d/50-size.conf
sudo systemctl restart systemd-journald
```

RAM 2 GB cukup; Node memakai ± 80–150 MB saat idle. Yang paling menekan RAM adalah lonjakan saat `npm ci` dan saat banyak koneksi Socket.IO terbuka. Swap 1 GB mencegah OOM-killer mematikan service saat itu terjadi — bukan untuk performa.

## Prasyarat

1. VPS Debian 12 / Ubuntu 22.04 atau 24.04, akses `sudo` (atau root).
2. Domain `.my.id` yang bisa diatur DNS-nya.
3. Port **80** dan **443** bisa dijangkau dari internet (Let's Encrypt butuh 80 untuk verifikasi, atau 443 untuk TLS-ALPN).
4. Kredensial produksi sudah siap: Firebase (5 nilai publik + service account) dan Supabase URL + secret key. Lihat bagian 1–3 di `README.md`.

## 1. Arahkan domain ke VPS

Di panel DNS registrar `.my.id` (atau Cloudflare kalau domainnya dipindah ke sana), buat:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `bychat.my.id` (atau `@`) | IP publik VPS | 300 |

Jangan pakai `CNAME` ke IP. Kalau memakai Cloudflare, proxy (awan oranye) boleh aktif — WebSocket didukung — tetapi `SSL/TLS mode` harus **Full** atau **Full (strict)**, bukan *Flexible*.

Cek dari mesin lokal sebelum lanjut:

```bash
dig +short bychat.my.id
```

harus mengembalikan IP VPS. Sertifikat tidak akan terbit sebelum ini benar.

## 2. Siapkan kode di VPS

```bash
ssh user@IP_VPS
sudo mkdir -p /opt/bychat
sudo chown "$USER":"$USER" /opt/bychat
git clone https://github.com/USER/REPO.git /opt/bychat/app
cd /opt/bychat/app
```

Folder lain juga boleh (`/srv/bychat`, `/home/user/app`), skrip memakai lokasi repo apa adanya. Tapi hindari menyimpan aplikasi di dalam `/root`.

## 3. Isi `.env`

```bash
cp .env.example .env
nano .env
```

Nilai yang wajib benar untuk produksi:

```ini
PORT=3000
NODE_ENV=production          # skrip setup MENOLAK lanjut kalau bukan ini
AUTH_MODE=firebase
STORAGE_DRIVER=supabase      # jangan 'local' di disk 4 GB
MAX_UPLOAD_BYTES=47185920    # 45 MiB, di bawah batas 50 MB paket Supabase gratis

FIREBASE_API_KEY=...
FIREBASE_AUTH_DOMAIN=bychat.web.id        # domain aplikasi, bukan <project>.firebaseapp.com
                                         # (halaman login diteruskan lewat /__/auth)
FIREBASE_PROJECT_ID=namaproyek
FIREBASE_APP_ID=...
FIREBASE_MESSAGING_SENDER_ID=...
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}   # satu baris

SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...                    # BUKAN publishable key
SUPABASE_BUCKET=attachments

ADMIN_EMAILS=email-kamu@gmail.com
```

Catatan:

- `FIREBASE_SERVICE_ACCOUNT` harus **satu baris**. Cara termudah: jalankan di mesin lokal
  `npm run set-service-account -- "C:/path/key.json"`, lalu salin nilainya ke VPS.
- `TURN_*` masih opsional, tapi tanpa TURN sekitar 10–20% panggilan gagal di CGNAT operator seluler.
- Jangan menambahkan `GOOGLE_APPLICATION_CREDENTIALS` yang menunjuk path lokal mesinmu.

Periksa sebelum deploy (tidak menampilkan nilai rahasia):

```bash
npm install --no-audit --no-fund   # dibutuhkan check-env
npm run check-env
npm run check-env -- --live        # sekalian menguji kunci Supabase
```

Kode keluar `1` berarti masih ada yang salah — perbaiki dulu.

## 4. Jalankan pemasangan

```bash
sudo bash deploy/setup-vps.sh bychat.my.id
```

Yang dikerjakan skrip ini (semuanya idempoten, boleh diulang):

1. Memasang Node.js 22 LTS (NodeSource) dan Caddy (repo resmi) bila belum ada.
2. Membuat user sistem `bychat` dan folder `data/` yang bisa ditulisi.
3. Membuat `/swapfile` 1 GB kalau belum ada swap (atur dengan `SWAP_MB=0` untuk melewati).
4. `npm ci --omit=dev`, lalu membersihkan cache npm.
5. Memasang `/etc/systemd/system/secure-chat.service` dari `deploy/secure-chat.service.in`
   dan `/etc/caddy/Caddyfile` dari `deploy/Caddyfile.in` (file Caddy lama dicadangkan).
6. Menyalakan service dan menunggu `/healthz` di `127.0.0.1:3000` menjawab.

Ingin melihat berkas hasil render tanpa menyentuh sistem:

```bash
DRY_RUN=1 bash deploy/setup-vps.sh bychat.my.id
```

Opsi lain:

```bash
sudo WITH_FIREWALL=1 bash deploy/setup-vps.sh bychat.my.id   # aktifkan ufw (22, 80, 443)
sudo SWAP_MB=512 bash deploy/setup-vps.sh bychat.my.id       # swap lebih kecil
```

> Kalau SSH-mu **bukan** port 22, tambahkan dulu `sudo ufw allow <port-ssh>` sebelum memakai `WITH_FIREWALL=1`.

### Apa yang dijalankan systemd

- `User=bychat`, `WorkingDirectory=/opt/bychat/app`, `ExecStart=/usr/bin/node src/server.js`.
- **Tidak** memakai `EnvironmentFile`, karena `FIREBASE_SERVICE_ACCOUNT` berisi JSON dan parser systemd memperlakukan tanda kutip sebagai sintaks. Aplikasi membaca `.env` sendiri lewat `process.loadEnvFile()` di `src/config.js`.
- `NODE_ENV=production` ditegakkan di unit, jadi server menolak mode dev walaupun `.env` salah diedit.
- `ProtectSystem=strict` + `ReadWritePaths=<app>/data`: kode read-only, hanya `data/` yang bisa ditulis.
- `Restart=always`, `RestartSec=3`, `LimitNOFILE=65535` untuk banyak koneksi Socket.IO.

Port `3000` hanya didengarkan di semua antarmuka mesin tapi tidak perlu dibuka ke internet — Caddy di mesin yang sama yang meneruskan trafik. Tanpa `WITH_FIREWALL=1`, pastikan firewall penyedia VPS (security group) juga menutup `3000`.

## 5. Daftarkan domain di Firebase

Firebase Console → **Authentication** → **Settings** → **Authorized domains** → tambahkan:

```
bychat.my.id
```

Tanpa langkah ini login gagal dengan `auth/unauthorized-domain` — dan karena `public/` disajikan dari origin yang sama, gejalanya muncul tepat setelah halaman berhasil dimuat.

## 6. Verifikasi

Di VPS:

```bash
systemctl status secure-chat
journalctl -u secure-chat -n 30 --no-pager
curl -s http://127.0.0.1:3000/healthz | head -c 400; echo
curl -sI https://bychat.my.id | head -5
```

`/healthz` mengembalikan `ok: true`, `auth: "firebase"`, `storage: "supabase"`.

Dari mesin lokal, uji bahwa token asli diterima dan token palsu ditolak:

```bash
npm install --no-audit --no-fund
npm run verify-token -- https://bychat.my.id
```

Lalu buka `https://bychat.my.id` di dua browser berbeda, login Google, dan kirim satu pesan. Uji juga unggah satu file (untuk memastikan kunci Supabase benar) dan satu panggilan suara.

## 7. Update

```bash
cd /opt/bychat/app
sudo bash deploy/update.sh
```

Skrip menarik `git pull --ff-only`, menjalankan `npm ci --omit=dev`, memperbaiki permission `.env`/`data/`, restart service, lalu menunggu `/healthz`. Kalau service tidak sehat, skrip keluar dengan kode 1 dan menyuruhmu melihat `journalctl`.

Kalau `.env` berubah (misalnya menambah TURN), cukup:

```bash
sudo systemctl restart secure-chat
```

## 8. Backup

Dengan `STORAGE_DRIVER=supabase`, data yang perlu diselamatkan ada di dua tempat:

| Data | Lokasi | Cara backup |
|---|---|---|
| `registry/usernames.json`, `registry/moderation.json`, `registry/accounts.json`, `registry/credentials.json`, `registry/push.json`, `attachments/*`, `avatars/*` | bucket Supabase `attachments` | unduh dari dashboard Supabase, atau salin bucket secara berkala |
| `.env` (kunci Firebase service account, Supabase secret, VAPID) | `/opt/bychat/app/.env` | simpan di password manager — **jangan** di git |

`registry/credentials.json` berisi hash scrypt dan kunci tanda tangan sesi; memperlakukannya setara private key. Menghapusnya membuat semua sesi tidak sah dan pengguna harus login ulang.

Kunci VAPID untuk Web Push: kalau `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` tidak diisi di `.env`, server membuatnya sekali dan menyimpannya di `registry/push.json` (Supabase) atau `data/push.json` (driver local). Ganti kunci = semua langganan push lama tidak berlaku.

## 9. By AI tanpa biaya token (Ollama di VPS)

Kalau kuota penyedia cloud (Gemini dan sejenisnya) habis, By AI bisa dijalankan
sepenuhnya di mesin ini lewat [Ollama](https://ollama.com). Server hanya butuh
endpoint yang kompatibel dengan API OpenAI, dan Ollama punya `/v1/chat/completions`.

```bash
# 1. Pasang Ollama (sekali saja, ikut systemd sendiri)
curl -fsSL https://ollama.com/install.sh | sh

# 2. Unduh model. Di VPS 2 vCPU / 2 GB RAM pakai yang 1B.
#    llama3.2 (3B) butuh ± 2,5 GB RAM dan akan berebut dengan Node + Caddy.
ollama pull llama3.2:1b

# 3. Pastikan cuma mendengarkan di localhost, jangan pernah dibuka ke internet
ss -ltnp | grep 11434
curl -s http://127.0.0.1:11434/api/tags | head -c 200
```

Lalu `.env` (ganti blok `AI_*` yang lama, dan **kosongkan** `AI_FALLBACK_*`
supaya tidak ada percobaan ke Gemini yang kuotanya sudah habis):

```ini
AI_ENABLED=true
AI_BASE_URL=http://127.0.0.1:11434/v1
AI_MODEL=llama3.2:1b
AI_API_KEY=
AI_MAX_TOKENS=512
AI_DAILY_LIMIT=50
#AI_FALLBACK_BASE_URL=
#AI_FALLBACK_MODEL=
```

```bash
sudo systemctl restart secure-chat
sudo journalctl -u secure-chat -n 5 --no-pager | grep -i "by ai"
```

Verifikasi dari luar:

```bash
curl -s https://DOMAIN/config.json | grep -A3 '"ai"'     # "enabled": true
```

Setelah itu kirim satu pesan di ruang By AI. Kalau gagal, baris
`⚠️  By AI gagal: …` di `journalctl -u secure-chat -f` menyebut penyebabnya.

Jawaban dikirim **bertahap** lewat SSE (`/api/ai/stream`), jadi kata pertama
muncul dalam hitungan detik walau jawaban utuhnya butuh 30 detik di CPU. Yang
perlu dijaga: `Cache-Control: no-transform` di respons itu tidak boleh diganti
proxy mana pun — kalau isinya dikompres atau ditampung dulu, streaming-nya mati
dan teksnya baru muncul setelah semuanya selesai. Caddy dan Cloudflare meneruskan
SSE apa adanya dengan setelan bawaan repo ini.

Yang berubah dibanding memakai Gemini:

| Kemampuan | Gemini | Ollama lokal |
|---|---|---|
| Teks | ya | ya |
| Cari di web / baca tautan | ya | **tidak** |
| Kirim foto / PDF | ya | **tidak** — server menolak dengan pesan yang jelas |
| Biaya per pesan | per token | listrik + CPU |
| Kecepatan di 2 vCPU | 2–10 detik | 2–15 detik tergantung panjang jawaban |

Catatan kapasitas: model tetap harus muat di RAM bersama Node (± 150 MB) dan
Caddy. `llama3.2:1b` ± 1,3 GB, jadi dengan swap 1 GB masih aman; model 3B ke atas
sebaiknya tidak dipasang di VPS 2 GB.

## Tanpa domain (sementara)

Untuk mencoba dulu sebelum DNS selesai, pakai domain gratis berbasis IP:

```bash
IP="$(curl -s https://api.ipify.org)"
sudo bash deploy/setup-vps.sh "${IP}.sslip.io"
```

Tetap butuh port 80/443 terbuka. Jangan lupa menambahkan `${IP}.sslip.io` ke Authorized domains Firebase, dan ganti HSTS/domain begitu domain asli siap.

## Pemecahan masalah

| Gejala | Penyebab umum | Tindakan |
|---|---|---|
| `curl: (7) Failed to connect` ke domain | Record A belum ada / propagasi | `dig +short bychat.my.id`, tunggu TTL |
| Caddy log `challenge failed` / sertifikat gagal | Port 80 (atau 443) tertutup, atau Cloudflare mode *Flexible* | Buka port di ufw **dan** security group penyedia; ubah mode SSL ke Full |
| `502 Bad Gateway` | Service mati atau crash saat boot | `journalctl -u secure-chat -n 50 --no-pager` |
| Service langsung berhenti dengan pesan `AUTH_MODE=dev nggak boleh...` | `.env` belum berisi kredensial Firebase | Isi 5 nilai Firebase + service account, `npm run check-env` |
| `auth/unauthorized-domain` | Domain belum terdaftar di Firebase | Langkah 5 |
| Login Google: sudah memilih akun, lalu balik ke layar login lagi | `FIREBASE_AUTH_DOMAIN` masih `namaproyek.firebaseapp.com`, jadi halaman login berjalan di origin lain dan hasilnya tidak sampai ke aplikasi (Chrome mempartisi penyimpanan; di APK malah keluar aplikasi) | Set `FIREBASE_AUTH_DOMAIN=<domain sendiri>`, tambahkan `https://<domain>/__/auth/handler` ke *Authorized redirect URIs* OAuth client di Google Cloud Console, lalu restart service |
| Unggah file gagal `new row violates row-level security policy` | Memakai publishable/anon key | Pakai `sb_secret_...` atau `service_role` JWT |
| Login berhasil tapi pesan tidak terkirim | WebSocket diblokir proxy/firewall | Cek `wss://bychat.my.id/socket.io/` di DevTools → Network; pastikan tidak ada proxy yang memutus upgrade |
| Panggilan tersambung tapi tanpa suara | Tidak ada TURN | Isi `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL`, restart |
| Disk penuh | cache apt/npm, log journal | Lihat bagian [Kapasitas](#kapasitas-apakah-2-vcpu--2-gb--4-gb-cukup) |
| Service terbunuh (OOM) | RAM 2 GB tanpa swap | `dmesg -T \| grep -i oom`; pastikan swap aktif (`swapon --show`) |

Perintah harian:

```bash
systemctl status secure-chat
journalctl -u secure-chat -f
journalctl -u caddy -f
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```
