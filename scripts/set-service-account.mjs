/**
 * set-service-account.mjs — turn the Firebase service-account JSON file into the
 * single-line FIREBASE_SERVICE_ACCOUNT value in .env, so nobody has to paste a
 * 2 KB blob by hand (which is where this usually goes wrong).
 *
 *   node scripts/set-service-account.mjs "C:/path/to/firebase-adminsdk-xxxx.json"
 *   node scripts/set-service-account.mjs path/to/key.json --env path/to/.env
 *
 * It never prints the secret. It only reports which key went where.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const args = process.argv.slice(2);
const flagIndex = args.indexOf('--env');
const envArgIndex = flagIndex === -1 ? -1 : flagIndex + 1;
const envPath = path.resolve(
  flagIndex === -1 ? path.join(projectRoot, '.env') : args[envArgIndex] || ''
);
const sourcePath = args.find((a, i) => !a.startsWith('--') && i !== envArgIndex);

if (!sourcePath) {
  console.error('Pakai: node scripts/set-service-account.mjs <file-service-account.json> [--env <path>]');
  process.exit(1);
}

const source = path.resolve(sourcePath);
if (!fs.existsSync(source)) {
  console.error(`File nggak ketemu: ${source}`);
  process.exit(1);
}

let account;
try {
  account = JSON.parse(fs.readFileSync(source, 'utf8'));
} catch (e) {
  console.error(`File itu bukan JSON yang valid: ${e.message}`);
  process.exit(1);
}

const looksLikeServiceAccount =
  account.type === 'service_account' && account.private_key && account.client_email;
if (!looksLikeServiceAccount) {
  console.error(
    'File itu bukan kunci service account.\n' +
      'Yang benar: Firebase Console → Project settings → Service accounts → Generate new private key.'
  );
  process.exit(1);
}

// Compact JSON is already a single line: the private key's newlines are stored
// as the two-character escape \n, which JSON.parse undoes on the server.
const oneLine = JSON.stringify(account);
if (/\r|\n/.test(oneLine)) {
  console.error('Gagal memadatkan JSON jadi satu baris.');
  process.exit(1);
}

// Start from .env.example when there is no .env yet, so the file keeps its comments.
let envText;
if (fs.existsSync(envPath)) {
  envText = fs.readFileSync(envPath, 'utf8');
} else {
  const example = path.join(projectRoot, '.env.example');
  envText = fs.existsSync(example) ? fs.readFileSync(example, 'utf8') : '';
}

const newline = envText.includes('\r\n') ? '\r\n' : '\n';
const lines = envText ? envText.split(/\r?\n/) : [];
const keyIndex = lines.findIndex((l) => /^FIREBASE_SERVICE_ACCOUNT=/.test(l));
const newLine = `FIREBASE_SERVICE_ACCOUNT=${oneLine}`;

// A pretty-printed JSON pasted by hand spills onto the following lines (that is
// the most common way this goes wrong). Those leftovers look like JSON, not like
// config, so drop them — but stop at the first line that looks like anything
// else, so real comments and keys below are preserved.
const isJsonLeftover = (l) => /^\s*("|\}|\]|\[|\/\/)/.test(l) && !/^[A-Z0-9_]+=/.test(l);
const removed = [];
if (keyIndex !== -1) {
  lines[keyIndex] = newLine;
  while (keyIndex + 1 < lines.length && isJsonLeftover(lines[keyIndex + 1])) {
    removed.push(lines.splice(keyIndex + 1, 1)[0]);
  }
} else {
  if (lines.length && lines[lines.length - 1] !== '') lines.push('');
  lines.push(newLine);
}

// Normalise a trailing newline without disturbing the rest of the file.
while (lines.length && lines[lines.length - 1] === '') lines.pop();
fs.writeFileSync(envPath, lines.join(newline) + newline);

// Fail loudly rather than leaving something the server cannot parse.
process.loadEnvFile(envPath);
const written = process.env.FIREBASE_SERVICE_ACCOUNT;
try {
  const reparsed = JSON.parse(written);
  if (reparsed.private_key !== account.private_key) {
    throw new Error('private_key berubah setelah ditulis');
  }
} catch (e) {
  console.error(`Nilai yang tertulis di .env tidak bisa dipakai: ${e.message}`);
  process.exit(1);
}

console.log(`Service account dibaca dari : ${source}`);
console.log(`Ditulis ke                  : ${envPath}`);
console.log(`Project id di file itu      : ${account.project_id || '(tidak ada)'}`);
console.log(`Client email                : ${account.client_email}`);
console.log(`Panjang nilai di .env       : ${oneLine.length} karakter (1 baris)`);
if (removed.length) {
  console.log(`Baris sisa paste yang dibuang: ${removed.length} baris (JSON-nya dulu kepotong multi-baris)`);
}
console.log('Cek ulang: nilainya sudah dimuat dan di-JSON.parse dari .env — valid.');
