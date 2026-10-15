/**
 * render-env.mjs — susun nilai-nilai yang diminta Render jadi satu file yang bisa
 * ditempel sekali ke tombol "Add from .env" di dashboard-nya.
 *
 *   npm run render-env            # tulis render-env.txt
 *   npm run render-env -- --copy  # sekalian salin ke clipboard
 *
 * Kenapa ada: render.yaml menandai 9 variabel dengan `sync: false`, jadi Render
 * menanyakannya saat setup. Mengetik 9 nilai itu manual gampang salah, dan
 * FIREBASE_SERVICE_ACCOUNT panjangnya sekitar 2 KB dalam SATU baris.
 *
 * Isi file keluarannya rahasia asli: file itu sudah masuk .gitignore, dan sebaiknya
 * dihapus setelah selesai dipakai. Script ini tidak pernah mencetak nilainya.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? '';
};

const envPath = path.resolve(flagValue('--env') || path.join(projectRoot, '.env'));
const outPath = path.resolve(flagValue('--out') || path.join(projectRoot, 'render-env.txt'));
const wantCopy = args.includes('--copy');

/* ------------------------------------------------------------------ *
 * Yang ditanyakan Render
 * ------------------------------------------------------------------ */

// Urutannya mengikuti render.yaml, supaya sama dengan form di sana.
const RENDER_KEYS = [
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_APP_ID',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_SERVICE_ACCOUNT',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ADMIN_EMAILS',
];

// Boleh kosong: aplikasinya jalan tanpa admin, cuma halaman /admin.html-nya
// yang nggak bisa dibuka siapa pun. Ini satu-satunya nilai yang begitu.
const OPTIONAL_KEYS = new Set(['ADMIN_EMAILS']);

// Setelan lain (NODE_ENV, AUTH_MODE, STORAGE_DRIVER, SUPABASE_BUCKET,
// MAX_UPLOAD_BYTES, CALLS_ENABLED) sudah ditulis di render.yaml, jadi sengaja
// tidak ikut di sini — supaya tidak ada yang menimpanya dengan nilai dev.

if (!fs.existsSync(envPath)) {
  console.error(`Nggak ada ${envPath}. Salin dulu: cp .env.example .env`);
  process.exit(1);
}

process.loadEnvFile(envPath);
const value = (key) => String(process.env[key] ?? '').trim();

const rows = [];
const problems = [];
const warnings = [];

for (const key of RENDER_KEYS) {
  const v = value(key);
  if (!v) {
    if (OPTIONAL_KEYS.has(key)) {
      warnings.push(
        `${key} masih kosong — tanpa itu halaman admin nggak bisa dibuka siapa pun (bisa diisi kapan saja di dashboard Render)`
      );
      rows.push({ key, value: '', note: 'kosong (opsional)' });
      continue;
    }
    problems.push(`${key} masih KOSONG di ${envPath}`);
    rows.push({ key, value: '', note: 'KOSONG' });
    continue;
  }
  rows.push({ key, value: v, note: `${v.length} karakter` });
}

/* Pemeriksaan khusus service account: satu baris, JSON valid, ada private key. */
const serviceAccountRow = rows.find((r) => r.key === 'FIREBASE_SERVICE_ACCOUNT');
if (serviceAccountRow?.value) {
  if (/[\r\n]/.test(serviceAccountRow.value)) {
    problems.push('FIREBASE_SERVICE_ACCOUNT kepotong beberapa baris — JSON-nya harus SATU baris');
    serviceAccountRow.note = 'MULTI-BARIS';
  } else {
    try {
      const parsed = JSON.parse(serviceAccountRow.value);
      if (!parsed.private_key || !parsed.client_email) {
        problems.push('FIREBASE_SERVICE_ACCOUNT bukan isi kunci service account');
        serviceAccountRow.note = 'BUKAN SERVICE ACCOUNT';
      } else {
        serviceAccountRow.note = `JSON 1 baris, project=${parsed.project_id}`;
        const envProject = value('FIREBASE_PROJECT_ID');
        if (envProject && parsed.project_id !== envProject) {
          warnings.push(
            `kunci ini milik project "${parsed.project_id}" tapi FIREBASE_PROJECT_ID bilang "${envProject}"`
          );
        }
      }
    } catch (e) {
      problems.push(
        `FIREBASE_SERVICE_ACCOUNT bukan JSON valid (${e.message.slice(0, 40)}) — perbaiki dengan: npm run set-service-account -- "C:/path/key.json"`
      );
      serviceAccountRow.note = 'BUKAN JSON';
    }
  }
}

/* ------------------------------------------------------------------ *
 * Laporan
 * ------------------------------------------------------------------ */

const pad = (s, n) => String(s).padEnd(n);
console.log(`Sumber      : ${envPath}`);
console.log(`Tujuan      : ${outPath}\n`);
console.log(pad('KUNCI', 34) + 'STATUS (nilai tidak pernah dicetak di sini)');
console.log('-'.repeat(86));
for (const r of rows) console.log(pad(r.key, 34) + r.note);

if (warnings.length) {
  console.log('');
  for (const w of warnings) console.error(`PERHATIAN: ${w}`);
}

if (problems.length) {
  console.log('');
  for (const p of problems) console.error(`BELUM BISA: ${p}`);
  console.error('\nPerbaiki dulu, lalu jalankan ulang. Nggak ada file yang ditulis.');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Tulis + salin
 * ------------------------------------------------------------------ */

// Tanpa komentar dan tanpa kutip: satu baris per variabel, format yang dibaca
// kotak "Add from .env" milik Render (pemisahnya `=`, sisanya nilai apa adanya).
const text = rows.map((r) => `${r.key}=${r.value}`).join('\n') + '\n';
fs.writeFileSync(outPath, text);

// Jaring pengaman: file ini berisi rahasia asli, jadi pastikan git mengabaikannya.
if (outPath.startsWith(projectRoot + path.sep)) {
  const ignored = spawnSync('git', ['check-ignore', '-q', '--', outPath], { cwd: projectRoot });
  if (ignored.status !== 0) {
    console.error(
      `\nPERHATIAN: ${outPath} TIDAK diabaikan git — tambahkan namanya ke .gitignore sebelum commit apa pun.`
    );
  }
}

console.log('');
console.log(`${rows.length} variabel ditulis ke ${outPath}.`);

if (wantCopy) {
  const commands =
    process.platform === 'win32'
      ? [['clip']]
      : process.platform === 'darwin'
        ? [['pbcopy']]
        : [['wl-copy'], ['xclip', '-selection', 'clipboard']];
  const worked = commands.some(([cmd, ...rest]) => {
    const result = spawnSync(cmd, rest, { input: text, windowsHide: true });
    return !result.error && result.status === 0;
  });
  console.log(
    worked
      ? 'Sudah disalin ke clipboard — tinggal tempel ke kotak "Add from .env" di Render.'
      : 'Clipboard nggak bisa diisi otomatis. Buka file itu dan salin isinya manual.'
  );
} else {
  console.log(
    process.platform === 'win32'
      ? 'Salin ke clipboard: cat render-env.txt | clip'
      : 'Salin ke clipboard: cat render-env.txt | pbcopy'
  );
}

console.log('');
console.log('Langkah berikutnya di Render:');
console.log('  1. New → Blueprint → pilih repo ini (repo privat: izinkan akses dulu).');
console.log('  2. Tekan "Add from .env", tempel isinya, lalu Deploy.');
console.log('  3. JANGAN menambah PORT, dan jangan ubah NODE_ENV jadi development.');
console.log('  4. Hapus file ini setelah selesai: rm render-env.txt');
