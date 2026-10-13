/**
 * verify-firebase-token.mjs — buktikan jalur autentikasi asli jalan, tanpa perlu
 * login manual di browser.
 *
 * Caranya: minta Firebase bikin ID token yang ditandatangani Google (jenis token
 * yang persis dikirim browser setelah login Google/OTP), lalu sambung ke server
 * dengan token itu. Sekaligus memastikan token palsu ditolak.
 *
 *   npm run verify-token                     # cek server lokal (localhost:3000)
 *   npm run verify-token -- https://xxxx.onrender.com
 *
 * Script ini membuat satu user sementara di project Firebase-mu lalu MENGHAPUSNYA
 * lagi di akhir. Aman diulang. Dia butuh kredensial server dari .env.
 */

import { io as ioClient } from 'socket.io-client';

process.loadEnvFile('.env');

const baseUrl = (process.argv[2] || process.env.CHECK_URL || 'http://localhost:3000').replace(/\/$/, '');

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
if (!sa || !process.env.FIREBASE_API_KEY) {
  console.error('Butuh FIREBASE_SERVICE_ACCOUNT dan FIREBASE_API_KEY di .env');
  process.exit(1);
}

const { initializeApp, cert } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');
const admin = getAuth(initializeApp({ credential: cert(sa) }, 'verify-token'));

const uid = 'uji-otomatis-hapus';
console.log(`Server yang diuji : ${baseUrl}`);

try {
  // 1. Tukar custom token jadi ID token asli yang ditandatangani Google.
  const customToken = await admin.createCustomToken(uid);
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  const auth = await res.json();
  if (!auth.idToken) {
    console.error('Gagal dapat ID token:', JSON.stringify(auth).slice(0, 200));
    process.exit(1);
  }
  console.log(`ID token asli     : didapat, ${auth.idToken.length} karakter, ${auth.idToken.split('.').length} bagian`);

  // Public key EC palsu secukupnya; server cuma butuh bentuknya valid.
  const publicKey = {
    kty: 'EC',
    crv: 'P-256',
    x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  };

  const attempt = (label, token) =>
    new Promise((resolve) => {
      const s = ioClient(baseUrl, { auth: { token, publicKey }, reconnection: false, timeout: 8000 });
      const timer = setTimeout(() => {
        s.close();
        resolve(`${label}: TIMEOUT — nggak ada jawaban dari server`);
      }, 9000);
      s.on('ready', (payload) => {
        clearTimeout(timer);
        s.close();
        resolve(`${label}: TERHUBUNG — uid terverifikasi "${payload.profile.uid}", mode auth server "${payload.server.auth}"`);
      });
      s.on('connect_error', (err) => {
        clearTimeout(timer);
        s.close();
        resolve(`${label}: DITOLAK — "${err.message}"`);
      });
    });

  console.log('1) ' + (await attempt('token asli ', auth.idToken)));
  console.log('2) ' + (await attempt('token palsu', 'eyJhbGciOiJub25lIn0.eyJ1aWQiOiJwYWxzIn0.')));
} finally {
  await admin.deleteUser(uid).catch(() => {});
  const left = (await admin.listUsers()).users.filter((u) => u.uid === uid).length;
  console.log(`3) user uji sudah dihapus dari project (sisa: ${left})`);
}
