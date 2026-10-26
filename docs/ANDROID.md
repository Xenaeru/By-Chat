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
├── app/src/main/res/           Ikon, splash, strings (assetStatements)
├── android.keystore            Kunci penandatangan APK (TIDAK di-commit)
└── keystore.properties         Sandi kunci itu (TIDAK di-commit)
public/.well-known/             (tidak dipakai — assetlinks dilayani server)
```

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
ANDROID_PACKAGE_NAME=id.my.zizzy
ANDROID_SHA256_CERT_FINGERPRINTS=77:5D:AA:91:E0:76:C2:EF:C9:98:38:C4:05:79:2E:27:9B:A9:92:67:B6:C4:1E:BF:F8:CD:11:86:32:C3:DD:8A
```

Sidik jari di atas milik `android/android.keystore` yang ada di repo ini. Kalau
kamu membuat kunci baru, ambil yang baru:

```bash
keytool -list -v -keystore android/android.keystore -alias android | grep SHA256
```

Lalu cek dari luar:

```bash
curl -s https://zizzy.my.id/.well-known/assetlinks.json
```

Harus berisi `package_name: id.my.zizzy` dan sidik jari yang sama persis
(huruf besar, dipisah titik dua). Kalau masih `[]`, env-nya belum terbaca —
restart servernya.

Sampai langkah ini selesai, APK tetap bisa dibuka, tapi tampil sebagai Custom
Tab biasa: ada address bar, dan notifikasi kadang membuka Chrome alih-alih
aplikasinya.

## 2. Memasang di HP

1. Kirim `ByChat-1.0.0.apk` ke HP (kabel, Google Drive, WhatsApp ke diri sendiri).
2. Buka filenya → Android menanyakan izin "Instal aplikasi tak dikenal" →
   izinkan untuk aplikasi yang membuka file itu (Files/Chrome).
3. Setelah terpasang, ikon **By Chat** muncul di launcher seperti WhatsApp.

APK ini ditandatangani sendiri, jadi Play Protect bisa memunculkan peringatan
"aplikasi tidak dikenal". Untuk dipasang dari Play Store, unggah
`android/app/build/outputs/bundle/release/app-release.aab` dan pakai
*Play App Signing* — tapi sidik jari yang dipakai assetlinks harus sidik jari
dari Play Console, bukan dari `android.keystore` lokal.

## 3. Login Google di dalam APK

Popup tidak ada di dalam TWA, jadi `signInWithPopup` akan gagal di sana.
`public/js/auth-client.js` mendeteksi aplikasi terpasang
(`document.referrer` berawalan `android-app://`) dan memakai
`signInWithRedirect`. Karena Chrome-nya sama, halaman Google tetap terbuka di
dalam aplikasi dan kembali sendiri.

Syaratnya domain sudah terdaftar di **Firebase → Authentication → Settings →
Authorized domains**. Login username + kata sandi tidak terpengaruh sama sekali.

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

`bubblewrap update` mengambil ikon dan manifest dari `https://zizzy.my.id`,
jadi **situsnya harus hidup** saat menjalankannya. Kalau sedang offline, edit
angkanya langsung di `app/build.gradle` (bagian `twaManifest`) lalu build
dengan Gradle:

```bash
cd android
./gradlew assembleRelease \
  -Pandroid.injected.signing.store.file="$PWD/android.keystore" \
  -Pandroid.injected.signing.store.password="$(grep storePassword keystore.properties | cut -d= -f2)" \
  -Pandroid.injected.signing.key.alias=android \
  -Pandroid.injected.signing.key.password="$(grep keyPassword keystore.properties | cut -d= -f2)"
```

Hasilnya di `android/app/build/outputs/apk/release/app-release-signed.apk`.

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
| Address bar muncul di atas layar | Assetlinks belum cocok. Cek `https://<domain>/.well-known/assetlinks.json`, pastikan package name + sidik jari sama dengan APK-nya, lalu pasang ulang APK-nya (Chrome menyimpan hasil verifikasi). |
| Layar putih / "Can't open page" | Server mati atau domain belum mengarah ke server. Buka dulu alamatnya di Chrome HP. |
| Tombol Google tidak melakukan apa-apa | Domain belum ada di Firebase Authorized domains, atau Chrome di HP terlalu tua (TWA butuh Chrome 72+). |
| Notifikasi tidak muncul | Izin notifikasi belum diberikan. Buka Setelan → Notifikasi di aplikasi. Pada APK yang dipasang manual, notifikasi web dikirim oleh Chrome; kalau diabaikan, buka Chrome → Setelan situs → domain ini → Notifikasi. |
| Panggilan gagal di jaringan seluler | Itu bukan soal APK. Isi `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` di server (lihat `README.md`). |
| Ingin ganti domain | Ubah `host`, `webManifestUrl`, `fullScopeUrl` di `android/twa-manifest.json`, jalankan `bubblewrap update`, build ulang, lalu sesuaikan env domain di server. |
