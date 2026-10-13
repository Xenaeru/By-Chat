import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// scripts/set-service-account.mjs exists because pasting the service-account blob
// by hand is where people get it wrong: the JSON must end up on ONE line, or the
// .env parser stops at the first newline and the server gets "{".
const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(projectRoot, 'scripts', 'set-service-account.mjs');

const ACCOUNT = {
  type: 'service_account',
  project_id: 'demo-proj',
  private_key_id: 'abc123',
  // Real keys carry literal \n escapes. "$&" is here on purpose: a naive
  // regex-replace would expand it and corrupt the key.
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq$&hkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n-----END PRIVATE KEY-----\n',
  client_email: 'x@demo-proj.iam.gserviceaccount.com',
  client_id: '100268424326337707235',
  token_uri: 'https://oauth2.googleapis.com/token',
};

function makeKeyFile(dir, account = ACCOUNT) {
  const p = path.join(dir, 'key.json');
  fs.writeFileSync(p, JSON.stringify(account, null, 2)); // pretty, like the real download
  return p;
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'securechat-sa-'));

const run = (args, { expectFail = false } = {}) => {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    if (!expectFail) throw new Error(`script gagal: ${e.stderr || e.message}`);
    return { status: e.status, stderr: String(e.stderr || '') };
  }
};

/** Read .env back exactly like config.js does, then parse the value like auth.js does. */
function loadBack(envPath) {
  process.loadEnvFile(envPath);
  return {
    parsed: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT),
    raw: new RegExp('^FIREBASE_SERVICE_ACCOUNT=(.*)$', 'm').exec(fs.readFileSync(envPath, 'utf8'))[1],
  };
}

test('the helper writes the service account as one usable line', () => {
  const dir = tempDir();
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'PORT=3000\nFIREBASE_PROJECT_ID=demo-proj\nFIREBASE_SERVICE_ACCOUNT=\n');

  run([makeKeyFile(dir), '--env', envPath]);

  const { parsed, raw } = loadBack(envPath);
  assert.equal(/[\r\n]/.test(raw), false, 'nilai harus satu baris');
  assert.deepEqual(parsed, ACCOUNT, 'harus identik dengan file aslinya');
  assert.equal(parsed.private_key, ACCOUNT.private_key, 'private_key tidak boleh berubah satu karakter pun');
  assert.equal(parsed.private_key.includes('$&'), true, 'karakter $& tidak boleh dimakan regex replace');

  const text = fs.readFileSync(envPath, 'utf8');
  assert.match(text, /^PORT=3000$/m, 'kunci lain harus utuh');
  assert.match(text, /^FIREBASE_PROJECT_ID=demo-proj$/m);
});

test('a JSON blob pasted across many lines is replaced, not left behind', () => {
  const dir = tempDir();
  const envPath = path.join(dir, '.env');
  // Exactly the broken shape: "FIREBASE_SERVICE_ACCOUNT={" followed by the raw
  // pretty-printed JSON lines.
  const pretty = JSON.stringify(ACCOUNT, null, 2).split('\n');
  fs.writeFileSync(
    envPath,
    ['PORT=3000', 'FIREBASE_SERVICE_ACCOUNT=' + pretty[0], ...pretty.slice(1), '# komentar di bawah', 'SUPABASE_BUCKET=attachments', ''].join('\n')
  );

  const out = run([makeKeyFile(dir), '--env', envPath]);

  // Every leftover line of the pretty JSON (all but the first) must be gone.
  assert.match(out.stdout, new RegExp(`dibuang: ${pretty.length - 1} baris`));
  const text = fs.readFileSync(envPath, 'utf8');
  const { parsed } = loadBack(envPath);
  assert.deepEqual(parsed, ACCOUNT);
  assert.equal(/"type": "service_account"/.test(text), false, 'sisa JSON harus hilang');
  assert.match(text, /^# komentar di bawah$/m, 'komentar di bawahnya harus selamat');
  assert.match(text, /^SUPABASE_BUCKET=attachments$/m, 'kunci di bawahnya harus selamat');
  assert.equal(text.split('\n').filter((l) => l.trim()).length, 4, 'cuma 4 baris berisi yang tersisa');
});

test('running it twice does not duplicate the entry', () => {
  const dir = tempDir();
  const envPath = path.join(dir, '.env');
  const key = makeKeyFile(dir);
  run([key, '--env', envPath]);
  run([key, '--env', envPath]);

  const text = fs.readFileSync(envPath, 'utf8');
  assert.equal(text.split('FIREBASE_SERVICE_ACCOUNT=').length - 1, 1, 'harus tetap satu baris');
  assert.deepEqual(loadBack(envPath).parsed, ACCOUNT);
});

test('a file that is not a service account is refused', () => {
  const dir = tempDir();
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'PORT=3000\n');

  const notAKey = path.join(dir, 'something-else.json');
  fs.writeFileSync(notAKey, JSON.stringify({ hello: 'world' }));
  const result = run([notAKey, '--env', envPath], { expectFail: true });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /bukan kunci service account/);
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'PORT=3000\n', '.env tidak boleh berubah');
});

test('CRLF .env keeps its line endings', () => {
  const dir = tempDir();
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'PORT=3000\r\nFIREBASE_SERVICE_ACCOUNT=\r\n');

  run([makeKeyFile(dir), '--env', envPath]);

  const text = fs.readFileSync(envPath, 'utf8');
  assert.equal(/\n/.test(text) && !/\r\n/.test(text), false, 'jangan mengubah CRLF jadi LF');
  assert.equal(text.split('\r\n').length, 3, 'tiga baris dengan CRLF');
});
