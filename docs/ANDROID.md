# APK Android (Trusted Web Activity)

APK-nya bukan aplikasi kedua yang ditulis ulang. Isinya **aplikasi web ini
sendiri**, dibuka Chrome yang sudah terpasang di HP, tanpa address bar. Jadi
semua yang sudah jalan di web — enkripsi, Socket.IO, unggah file, panggilan
WebRTC, Web Push — ikut jalan tanpa kode terpisah. Cara ini namanya
[Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity/)
(TWA).

Kelemahannya cuma satu dan harus diingat: **APK ini butuh server yang hidup di
domain HTTPS**. Tanpa itu layarnya kosong. TWA tidak menyimpan salinan offline
aplikasi.

### Kenapa tidak dibungkus WebView sendiri (aset dibundel ke APK)?

Pernah dicoba dipertimbangkan, dan ditolak karena dua hal inti ikut hilang:

| Kebutuhan | TWA (dipakai) | WebView + aset dibundel |
|---|---|---|
| Login Google | Utuh | Ditolak Google di WebView; butuh Custom Tab + deep link + token baru di server |
| Notifikasi saat aplikasi ditutup | Utuh (Web Push) | Tidak ada; service worker tidak jalan di WebView, harus FCM |
| Unggah file & mikrofon/kamera | Utuh | Harus ditangani `onShowFileChooser` + izin runtime sendiri |
| Address bar | Hilang setelah assetlinks aktif | Selalu tidak ada |

Yang terakhir itu satu-satunya keunggulan WebView, dan bisa didapat di TWA
lewat langkah 1 di bawah. Karena itu TWA yang dipakai.

```
android/                        Project Android (dibuat Bubblewrap)
├── twa-manifest.json           Sumber kebenaran: package, domain, warna, ikon
├── app/build.gradle            Hasil generate — jangan diedit tangan sendirian
├── app/google-services.json    Konfigurasi Firebase untuk aplikasi ini
├── app/src/main/res/           Ikon, splash, strings (assetStatements)
├── android.keystore            Kunci penandatangan APK (TIDAK di-commit)
└── keystore.properties         Sandi kunci itu (TIDAK di-commit)
public/.well-known/             (tidak dipakai — assetlinks dilayani server)
```

**Satu kunci, satu APK, selamanya.** `android/app/build.gradle` membaca
`android/keystore.properties` dan menandatangani release dengan kunci itu —
tidak ada jalan lain untuk build release di project ini. Kalau ditandatangani
kunci lain (misalnya `bychat-release.jks`), dua hal langsung patah: Chrome
gagal memverifikasi domain (address bar muncul lagi) dan SHA-1-nya tidak lagi
cocok dengan yang terdaftar di Firebase. Jadi jangan mengganti kunci tanpa
memperbarui `assetlinks.json` **dan** Firebase sekaligus.

## 1. Sebelum APK-nya berguna: hubungkan domain ke APK

Chrome hanya mau membuka APK layar penuh kalau domain menyatakan bahwa APK ini
memang miliknya. Selama belum, APK tampil sebagai Custom Tab: ada address bar,
dan itu **bukan** shortcut PWA — bedanya baru terlihat setelah langkah ini
selesai, karena Chrome lalu membuka aplikasinya sebagai aplikasi Android biasa.

Route ini baru ada di kode `src/server.js`, jadi **deploy dulu** server-nya
(pull + restart di VPS) sebelum mengharapkan address bar-nya hilang.

Pernyataan itu dibaca dari
`https://<domain>/.well-known/assetlinks.json` yang dilayani `src/server.js`
(route `/.well-known/assetlinks.json`, isinya dari `assetLinks()` di
`src/config.js`).

Isi dua variabel di server (bukan di APK):

```bash
ANDROID_PACKAGE_NAME=id.web.bychat
ANDROID_SHA256_CERT_FINGERPRINTS=77:5D:AA:91:E0:76:C2:EF:C9:98:38:C4:05:79:2E:27:9B:A9:92:67:B6:C4:1E:BF:F8:CD:11:86:32:C3:DD:8A
```

Sidik jari di atas milik `android/android.keystore` yang ada di repo ini, dan
itulah kunci yang dipakai menandatangani APK (lihat bagian 4). Kunci itu punya
SHA-1 `5E:8E:84:98:2A:31:48:FB:1D:E7:02:5D:E5:07:BD:3E:C6:3B:DE:DA`, yang
harus sama dengan yang terdaftar di **Firebase → Project settings → Your apps →
Android app `id.web.bychat`** (dan dengan `certificate_hash` di
`android/app/google-services.json`). SHA-256 dipakai Chrome, SHA-1 dipakai
Firebase — dua angka dari kunci yang sama.

Kalau kamu membuat kunci baru, ambil yang baru:

```bash
keytool -list -v -keystore android/android.keystore -alias android | grep SHA256
```

Lalu cek dari luar:

```bash
curl -s https://bychat.web.id/.well-known/assetlinks.json
```

Harus berisi `package_name: id.web.bychat` dan sidik jari yang sama persis
(huruf besar, dipisah titik dua). Kalau masih `[]`, env-nya belum terbaca —
restart servernya.

Sampai langkah ini selesai, APK tetap bisa dibuka, tapi tampil sebagai Custom
Tab biasa: ada address bar, dan notifikasi kadang membuka Chrome alih-alih
aplikasinya.

## 2. Memasang di HP

1. Kirim `ByChat-1.1.0.apk` ke HP (kabel, Google Drive, WhatsApp ke diri sendiri).
2. Buka filenya → Android menanyakan izin "Instal aplikasi tak dikenal" →
   izinkan untuk aplikasi yang membuka file itu (Files/Chrome).
3. Setelah terpasang, ikon **By Chat** muncul di launcher seperti WhatsApp.

**Kalau APK di HP sebelumnya ditandatangani kunci lain** (misalnya percobaan
dengan `bychat-release.jks`), Android akan menolak pemasangan dengan pesan
"aplikasi tidak terpasang" / `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Itu bukan
kerusakan: hapus dulu aplikasi **By Chat** yang lama, baru pasang yang baru.
Memang tidak ada jalan lain — Android tidak mengizinkan ganti kunci di tempat.

APK ini ditandatangani sendiri, jadi Play Protect bisa memunculkan peringatan
"aplikasi tidak dikenal". Untuk dipasang dari Play Store, unggah
`android/app/build/outputs/bundle/release/app-release.aab` dan pakai
*Play App Signing* — tapi sidik jari yang dipakai assetlinks harus sidik jari
dari Play Console, bukan dari `android.keystore` lokal.

## 3. Login Google di dalam APK

Popup tidak ada di dalam TWA, jadi `signInWithPopup` akan gagal di sana.
`public/js/auth-client.js` mendeteksi aplikasi terpasang
(`document.referrer` berawalan `android-app://`) dan memakai
`signInWithRedirect`, lalu `getRedirectResult` membaca hasilnya saat halaman
kembali dari Google.

Supaya alur itu tidak berakhir di layar login lagi, tiga hal harus benar:

1. **Domain terdaftar** di **Firebase → Authentication → Settings →
   Authorized domains**.
2. **`FIREBASE_AUTH_DOMAIN` diisi domain aplikasi ini sendiri**, bukan
   `<project>.firebaseapp.com`. Nilai itu yang dikirim server lewat
   `/config.json`, dan Firebase JS SDK memakainya untuk menyusun alamat
   halaman login: `https://<domain>/__/auth/handler`.
3. **Server meneruskan `/__/auth/*`** ke `<project>.firebaseapp.com`
   (`src/firebase-auth-proxy.js`). Jadi halaman login itu tetap berada di
   origin yang sama dengan aplikasi.

Kalau `FIREBASE_AUTH_DOMAIN` dibiarkan `firebaseapp.com`, halaman login ada di
origin lain. Chrome mempartisi penyimpanan per situs teratas, jadi hasil login
yang ditulis di sana tidak pernah terbaca oleh halaman aplikasi — dan di APK,
navigasi ke domain lain itu membawa orangnya keluar aplikasi. Gejalanya persis:
sudah memilih akun Google, lalu balik lagi ke layar login. Ini juga yang
dijelaskan dokumentasi Firebase ("Best practices for using
`signInWithRedirect` on browsers that block third-party storage access",
Option 1 + Option 3).

Satu langkah di luar repo ikut wajib: tambahkan
`https://<domain>/__/auth/handler` ke *Authorized redirect URIs* OAuth client
yang dipakai Firebase (Google Cloud Console → APIs & Services → Credentials →
"Web client (auto created by Google Service)"). Tanpa itu Google menolak
dengan `redirect_uri_mismatch`.

**Urutan deploy penting:** naikkan dulu kode server yang punya proxy `/__/auth`,
baru ubah `FIREBASE_AUTH_DOMAIN`. Kalau dibalik, alamat login menunjuk ke
`/__/auth/handler` yang belum ada dan tombol Google gagal total.

Login username + kata sandi tidak terpengaruh sama sekali.

Kalau Google menolak, aplikasi sekarang menampilkan alasannya di kotak merah
bawah tombol (misalnya "Domain ini belum didaftarkan…"). Sebelumnya kegagalan
itu hilang tanpa pesan, jadi tombolnya hanya diam.

`android/app/google-services.json` ikut dibaca saat build (plugin
`com.google.gms.google-services`), dan di dalam APK ini dia menjadi resource
`google_app_id`, `project_id`, `default_web_client_id`. Untuk TWA sendiri
konfigurasi itu **belum dipakai kode mana pun** — login Google di dalam APK
berjalan lewat halaman web (Firebase JS SDK), bukan lewat SDK Android. File itu
baru berguna kalau nanti ditambah login Google native (Credential Manager).
Yang membuat login berhasil sekarang adalah kunci penandatangan yang cocok
dengan assetlinks, sehingga Chrome membuka APK sebagai TWA dan
`signInWithRedirect` bisa jalan.

Isi `certificate_hash` di file itu harus SHA-1 dari `android.keystore`
(`5e8e8498…deda`). Kalau kamu suatu saat mengunduh ulang file itu dari Firebase
setelah menambahkan sidik jari kunci lain, periksa angka itu lagi.

## 4. Membangun ulang APK

Butuh **JDK 17** dan **Android SDK** (Bubblewrap meminta `build-tools;36.1.0`
dan `platforms;android-36`). Android Studio sudah membawa keduanya.

```bash
# sekali saja
npm install -g @bubblewrap/cli
bubblewrap doctor          # memastikan JDK + SDK terdeteksi

# tiap kali ada perubahan manifest / ikon / domain
cd android
bubblewrap update          # generate ulang project dari twa-manifest.json
bubblewrap build           # APK + AAB bertanda tangan
```

`bubblewrap update` mengambil ikon dan manifest dari `https://bychat.web.id`,
jadi **situsnya harus hidup** saat menjalankannya. Kalau sedang offline, edit
angkanya langsung di `app/build.gradle` (bagian `twaManifest`) lalu build
dengan Gradle:

```bash
cd android
./gradlew assembleRelease
```

Tanda tangannya diambil otomatis dari `keystore.properties` oleh
`app/build.gradle`, jadi tidak perlu `-Pandroid.injected.signing.*` lagi. Kalau
`keystore.properties` atau `app/google-services.json` tidak ada, build berhenti
dengan pesan jelas — itu disengaja, supaya tidak pernah diam-diam menghasilkan
APK berkunci lain.

Hasilnya di `android/app/build/outputs/apk/release/app-release.apk`. Periksa
sebelum dibagikan:

```bash
keytool -list -v -keystore android/android.keystore -alias android | grep -E 'SHA1|SHA256'
apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
curl -s https://bychat.web.id/.well-known/assetlinks.json
```

SHA-256 APK, SHA-256 di assetlinks, dan SHA-1 di Firebase harus berasal dari
kunci yang sama. Itu satu-satunya cara address bar benar-benar hilang.

Kalau `keystore.properties` belum ada, buat kuncinya sekali:

```bash
cd android
keytool -genkeypair -keystore android.keystore -alias android \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass 'SANDI-PILIHANMU' -keypass 'SANDI-PILIHANMU' \
  -dname "CN=By Chat, O=By Chat, C=ID"
printf 'storePassword=SANDI-PILIHANMU\nkeyPassword=SANDI-PILIHANMU\nkeyAlias=android\nstoreFile=android.keystore\n' > keystore.properties
```

**Jangan kehilangan `android.keystore` dan sandinya.** Android menolak
pemasangan APK baru kalau tanda tangannya berbeda dari yang lama, dan sidik jari
di assetlinks ikut berubah.

## 5. Kalau ada yang tidak berjalan

| Gejala | Sebab dan jalan keluarnya |
|---|---|
| Address bar muncul di atas layar | Assetlinks belum cocok. Cek `https://<domain>/.well-known/assetlinks.json`, pastikan package name + sidik jari sama dengan APK-nya, lalu pasang ulang APK-nya (Chrome menyimpan hasil verifikasi). Bandingkan dulu `apksigner verify --print-certs` dari APK yang terpasang dengan isi assetlinks — kalau berbeda, APK-nya dibangun dengan kunci lain. |
| Login Google gagal padahal domain sudah di Authorized domains | Sama akarnya: APK tidak lolos verifikasi. Di Custom Tab tidak ada popup dan `document.referrer` bukan `android-app://`, jadi alurnya salah. Pastikan APK bertanda tangan `android.keystore` (SHA-256 `775DAA91…DD8A`). |
| Layar putih / "Can't open page" | Server mati atau domain belum mengarah ke server. Buka dulu alamatnya di Chrome HP. |
| Sudah memilih akun Google, lalu balik ke layar login | `FIREBASE_AUTH_DOMAIN` masih `firebaseapp.com`, atau redirect URI `https://<domain>/__/auth/handler` belum didaftarkan. Lihat bagian 3. |
| Tombol Google tidak melakukan apa-apa | Domain belum ada di Firebase Authorized domains, atau Chrome di HP terlalu tua (TWA butuh Chrome 72+). |
| Notifikasi tidak muncul | Izin notifikasi belum diberikan. Buka Setelan → Notifikasi di aplikasi. Pada APK yang dipasang manual, notifikasi web dikirim oleh Chrome; kalau diabaikan, buka Chrome → Setelan situs → domain ini → Notifikasi. |
| Panggilan gagal di jaringan seluler | Itu bukan soal APK. Isi `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` di server (lihat `README.md`). |
| Ingin ganti domain | Lihat bagian 6 di bawah. |

## 6. Pindah domain (mis. `bychat.web.id`)

Tiga hal berbeda ikut berubah, dan tidak semuanya bisa dikerjakan dari repo:

1. **Domainnya** — DNS, TLS, dan env server. Server sendiri tidak menyimpan
domain, jadi tidak ada kode yang perlu diubah: begitu `bychat.web.id` menunjuk
ke VPS ini dan Caddy menerbitkan sertifikatnya, situs langsung jalan.
2. **Package APK** — `id.web.bychat`, karena package lama memakai nama domain
lama. Package adalah identitas aplikasi di Android: yang baru adalah aplikasi
lain, jadi pengguna memasangnya sebagai aplikasi tambahan, bukan pembaruan.
3. **Firebase** — Android app baru, karena Firebase memisahkan aplikasi per
package.

### Yang harus dikerjakan di luar repo

```text
DNS      A  bychat.web.id      → IP VPS
         A  www.bychat.web.id  → IP VPS   (opsional)
TLS      Caddy menerbitkan sertifikat sendiri setelah DNS aktif
```

1. Tambahkan `bychat.web.id` di **Firebase → Authentication → Settings →
   Authorized domains** (wajib, kalau tidak login Google ditolak).
2. Tambahkan **Android app** baru di **Firebase → Project settings → Your apps**:
   package `id.web.bychat`, lalu daftarkan SHA-1
   `5E:8E:84:98:2A:31:48:FB:1D:E7:02:5D:E5:07:BD:3E:C6:3B:DE:DA`.
3. Unduh `google-services.json` yang baru dan timpa `android/app/google-services.json`.
   File yang ada di repo sekarang masih milik package lama; isinya sudah
   disesuaikan supaya build jalan, tapi versi resminya harus dari Firebase.
4. Di VPS, ubah `.env`:

   ```bash
   ANDROID_PACKAGE_NAME=id.web.bychat
   ANDROID_SHA256_CERT_FINGERPRINTS=77:5D:AA:91:E0:76:C2:EF:C9:98:38:C4:05:79:2E:27:9B:A9:92:67:B6:C4:1E:BF:F8:CD:11:86:32:C3:DD:8A
   FIREBASE_AUTH_DOMAIN=bychat.web.id
   ```

   Sidik jari SHA-256 **tidak berubah**: kuncinya tetap `android.keystore` yang sama.
5. `curl -s https://bychat.web.id/.well-known/assetlinks.json` sampai berisi
   `package_name: id.web.bychat`. Route ini otomatis mengikuti env di atas.

### Yang sudah dikerjakan di repo

`android/twa-manifest.json`, `app/build.gradle` (applicationId, namespace,
hostName, versionCode 2 / 1.1.0), source Java (`id/web/bychat/`),
`AndroidManifest.xml`, `strings.xml` (assetStatements), dan
`app/google-services.json` sudah pindah ke `bychat.web.id` + `id.web.bychat`.
APK-nya: **`ByChat-1.1.0.apk`**.

### Yang hilang saat pindah domain (tidak bisa dihindari)

Kunci enkripsi dan semua data lokal disimpan **per origin** di browser
(`localStorage`). Di `bychat.web.id` setiap orang mendapat kunci baru, jadi:

- riwayat chat lama tidak bisa didekripsi di alamat baru (masih terbaca kalau
  membuka `zizzy.my.id` di Chrome yang sama);
- daftar kontak terverifikasi, obrolan yang di-pin, daftar blokir, dan
  langganan notifikasi ikut kosong — notifikasi perlu diaktifkan ulang;
- akun Firebase tetap sama (uid di server tetap sama), jadi kontak dan pesan
  baru langsung tersambung lagi setelah masuk.

APK lama (`id.my.zizzy`) dan APK baru bisa terpasang bersamaan. Setelah pindah
total, hapus yang lama supaya tidak tertukar.
