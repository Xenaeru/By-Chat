/**
 * check-env.mjs — tell you what is still missing or wrong in .env, before you
 * waste time debugging a login that was never going to work.
 *
 *   npm run check-env            # cek .env
 *   npm run check-env -- --live  # plus tes kunci Supabase ke project aslinya
 *
 * It never prints a secret: values are only ever shown masked or as a verdict.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const envFlag = args.indexOf('--env');
const envPath = path.resolve(
  envFlag === -1 ? path.join(projectRoot, '.env') : args[envFlag + 1] || ''
);
const live = args.includes('--live');

if (!fs.existsSync(envPath)) {
  console.error(`Nggak ada ${envPath}. Salin dulu: cp .env.example .env`);
  process.exit(1);
}

process.loadEnvFile(envPath);
const env = process.env;
const val = (k) => (env[k] || '').trim();

const PLACEHOLDERS = ['namaproyek', 'xxxxxxxxxxxx', 'your-', 'example.com', 'ganti'];
const isPlaceholder = (v) => !!v && PLACEHOLDERS.some((p) => v.toLowerCase().includes(p));

const rows = [];
const check = (key, ok, note, level = 'error') => rows.push({ key, ok, note, level });

/* ---- Login: client config (yang dikirim ke browser) -------------------- */
const projectId = val('FIREBASE_PROJECT_ID');
const authDomain = val('FIREBASE_AUTH_DOMAIN');
const apiKey = val('FIREBASE_API_KEY');
const appId = val('FIREBASE_APP_ID');
const senderId = val('FIREBASE_MESSAGING_SENDER_ID');

check(
  'FIREBASE_PROJECT_ID',
  !!projectId && !isPlaceholder(projectId),
  isPlaceholder(projectId) ? 'MASIH NILAI CONTOH (namaproyek) — isi project id aslimu' : 'ok'
);
check(
  'FIREBASE_AUTH_DOMAIN',
  !!authDomain && !isPlaceholder(authDomain) && authDomain.endsWith('.firebaseapp.com'),
  isPlaceholder(authDomain) ? 'MASIH NILAI CONTOH' : authDomain.endsWith('.firebaseapp.com') ? 'ok' : 'harus <project>.firebaseapp.com'
);
check(
  'FIREBASE_API_KEY',
  !!apiKey && apiKey.startsWith('AIza'),
  !apiKey ? 'KOSONG — tombol Google/OTP nggak akan muncul' : apiKey.startsWith('AIza') ? 'ok' : 'bukan API key Firebase (biasanya mulai "AIza")'
);
check('FIREBASE_APP_ID', !!appId && appId.includes(':web:'), !appId ? 'KOSONG' : appId.includes(':web:') ? 'ok' : 'biasanya berformat "1:123:web:abc"');
check('FIREBASE_MESSAGING_SENDER_ID', !!senderId && /^\d{8,}$/.test(senderId), !senderId ? 'KOSONG' : /^\d{8,}$/.test(senderId) ? 'ok' : 'harus angka');

// Domain mismatch is a classic: the key belongs to another project, so login
// fails with auth/invalid-api-key and nothing looks wrong in the console.
if (projectId && authDomain && !authDomain.startsWith(projectId)) {
  check('project id vs auth domain', false, `nggak nyambung: project "${projectId}" tapi domain "${authDomain}"`, 'warn');
}

/* ---- Login: kredensial server ------------------------------------------ */
const saInline = val('FIREBASE_SERVICE_ACCOUNT');
const saPath = val('GOOGLE_APPLICATION_CREDENTIALS');

if (saInline) {
  if (/[\r\n]/.test(saInline)) {
    check('FIREBASE_SERVICE_ACCOUNT', false, 'nilainya kepotong beberapa baris — parser .env berhenti di baris pertama');
  } else if (saInline.startsWith('"')) {
    check('FIREBASE_SERVICE_ACCOUNT', false, 'jangan dibungkus tanda kutip');
  } else {
    try {
      const parsed = JSON.parse(saInline);
      const ok = !!parsed.private_key && !!parsed.client_email;
      check('FIREBASE_SERVICE_ACCOUNT', ok, ok ? `JSON 1 baris, project=${parsed.project_id}` : 'JSON-nya bukan kunci service account');
      if (ok && projectId && parsed.project_id !== projectId) {
        check('project id vs kunci kunci', false, `kunci ini punya project "${parsed.project_id}", .env bilang "${projectId}"`, 'warn');
      }
    } catch (e) {
      check('FIREBASE_SERVICE_ACCOUNT', false, `BUKAN JSON valid (${e.message.slice(0, 40)}) — pakai: npm run set-service-account -- <file.json>`);
    }
  }
} else if (saPath) {
  const exists = fs.existsSync(saPath);
  check('GOOGLE_APPLICATION_CREDENTIALS', exists, exists ? 'file kunci ada' : `FILE TIDAK ADA: ${saPath}`);
} else {
  check('FIREBASE_SERVICE_ACCOUNT', false, 'KOSONG dan GOOGLE_APPLICATION_CREDENTIALS juga kosong');
}

/* ---- Kirim file -------------------------------------------------------- */
const sbUrl = val('SUPABASE_URL');
const sbKey = val('SUPABASE_SERVICE_ROLE_KEY');
const sbBucket = val('SUPABASE_BUCKET') || 'attachments';

check(
  'SUPABASE_URL',
  !!sbUrl && !isPlaceholder(sbUrl) && /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(sbUrl),
  !sbUrl ? 'KOSONG' : isPlaceholder(sbUrl) ? 'MASIH NILAI CONTOH' : /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(sbUrl) ? 'ok' : 'format harus https://<ref>.supabase.co'
);

// Supabase now offers three keys. Only the secret one may leave the server.
const keyVerdict = (() => {
  if (!sbKey) return 'KOSONG — file akan disimpan lokal';
  if (sbKey.startsWith('sb_publishable_')) return 'INI KUNCI PUBLIK (sb_publishable_), bukan kunci rahasia — upload bakal ditolak "row-level security policy"';
  if (sbKey.startsWith('sb_secret_')) return 'ok (format baru sb_secret_)';
  if (sbKey.startsWith('eyJ') && sbKey.split('.').length === 3) {
    const payload = JSON.parse(Buffer.from(sbKey.split('.')[1], 'base64url').toString('utf8'));
    if (payload.role === 'service_role') return 'ok (JWT service_role)';
    if (payload.role === 'anon') return 'INI KUNCI ANON, bukan service_role — upload bakal ditolak';
    return `JWT dengan role "${payload.role}" — harusnya service_role`;
  }
  return 'bentuknya nggak dikenal (bukan sb_secret_ dan bukan JWT)';
})();
check('SUPABASE_SERVICE_ROLE_KEY', keyVerdict.startsWith('ok'), keyVerdict);
check('SUPABASE_BUCKET', sbBucket === 'attachments', sbBucket === 'attachments' ? 'ok' : `".env" bilang "${sbBucket}" — pastikan bucket dengan nama itu memang ada`);

/* ---- Lain-lain --------------------------------------------------------- */
if (val('NODE_ENV') === 'production' && !sbKey) {
  check('NODE_ENV', false, 'production tapi Supabase belum diisi — file bakal ditulis ke disk server', 'warn');
}
if (!val('TURN_URLS')) {
  check('TURN_URLS', true, 'kosong — panggilan lewat STUN saja, bisa gagal di NAT ketat/CGNAT seluler', 'warn');
}

/* ---- Laporan ----------------------------------------------------------- */
const pad = (s, n) => String(s).padEnd(n);
console.log(`Memeriksa: ${envPath}\n`);
console.log(pad('KUNCI', 34) + pad('STATUS', 8) + 'CATATAN');
console.log('-'.repeat(120));
for (const r of rows) {
  const status = r.ok ? 'OK' : r.level === 'warn' ? 'PERHATIAN' : 'BELUM';
  console.log(pad(r.key, 34) + pad(status, 8) + r.note);
}

const blocking = rows.filter((r) => !r.ok && r.level === 'error');
const firebaseReady = !blocking.some((r) => r.key.startsWith('FIREBASE') || r.key.startsWith('GOOGLE_APPLICATION'));
const storageReady = !blocking.some((r) => r.key.startsWith('SUPABASE'));

console.log('');
console.log('Login Google / nomor HP :', firebaseReady ? 'SIAP' : 'BELUM SIAP (jalan di mode dev)');
console.log('Kirim file              :', storageReady ? 'SIAP (driver supabase)' : 'BELUM SIAP (masih driver local)');

if (live && storageReady) {
  console.log('\nTes kunci Supabase ke project aslinya...');
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } });
  const { error } = await sb.storage.from(sbBucket).createSignedUploadUrl('probe/check.txt');
  if (error) console.log(`  createSignedUploadUrl() -> GAGAL: ${error.message}`);
  else console.log('  createSignedUploadUrl() -> OK, kunci bisa bikin tanda tangan upload');
  const listed = await sb.storage.listBuckets();
  if (listed.error) console.log(`  listBuckets() -> GAGAL: ${listed.error.message}`);
  else console.log(`  bucket yang terlihat: ${listed.data.map((b) => b.name).join(', ') || '(kosong)'}`);
}

console.log('');
if (blocking.length) {
  console.log(`${blocking.length} hal yang belum benar — lihat baris "BELUM" di atas.`);
  process.exit(1);
}
console.log('Semua kunci wajib sudah benar.');
