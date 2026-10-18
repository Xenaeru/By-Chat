import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(projectRoot, 'scripts', 'check-env.mjs');

const SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'demo-proj',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----\n',
  client_email: 'x@demo-proj.iam.gserviceaccount.com',
});

const GOOD = {
  FIREBASE_PROJECT_ID: 'demo-proj',
  FIREBASE_AUTH_DOMAIN: 'demo-proj.firebaseapp.com',
  FIREBASE_API_KEY: 'AIzaSyDUMMYKEYFORTESTS',
  FIREBASE_APP_ID: '1:483463782266:web:abc123',
  FIREBASE_MESSAGING_SENDER_ID: '483463782266',
  FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
  SUPABASE_URL: 'https://abcdefghijklmno.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummyvaluefortests',
  SUPABASE_BUCKET: 'attachments',
};

function writeEnv(dir, values) {
  const p = path.join(dir, '.env');
  const text = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  fs.writeFileSync(p, text + '\n');
  return p;
}

function run(envPath) {
  try {
    const stdout = execFileSync(process.execPath, [script, '--env', envPath], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status, stdout: String(e.stdout || '') };
  }
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'securechat-env-'));

test('a fully-filled .env passes', () => {
  const dir = tempDir();
  const result = run(writeEnv(dir, GOOD));

  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /Login Google : SIAP/);
  assert.match(result.stdout, /Kirim file              : SIAP/);
  assert.match(result.stdout, /Semua kunci wajib sudah benar/);
});

test('the .env.example placeholders are reported as not ready', () => {
  const dir = tempDir();
  const envPath = path.join(dir, '.env');
  fs.copyFileSync(path.join(projectRoot, '.env.example'), envPath);
  const result = run(envPath);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FIREBASE_PROJECT_ID.*MASIH NILAI CONTOH/s);
  assert.match(result.stdout, /Login Google : BELUM SIAP/);
  // Nothing in the template may be mistaken for a working secret.
  assert.equal(/Login Google : SIAP/.test(result.stdout), false);
});

test('a publishable Supabase key is flagged with the reason it fails', () => {
  const dir = tempDir();
  const result = run(writeEnv(dir, { ...GOOD, SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_abc123' }));

  assert.equal(result.status, 1);
  assert.match(result.stdout, /KUNCI PUBLIK/);
  assert.match(result.stdout, /row-level security policy/);
  assert.match(result.stdout, /Kirim file\s+: BELUM SIAP/);
});

test('the legacy anon JWT is rejected, the service_role JWT is accepted', () => {
  const jwt = (role) => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, iss: 'supabase' })}.signature`;
  };

  const anonDir = tempDir();
  const anon = run(writeEnv(anonDir, { ...GOOD, SUPABASE_SERVICE_ROLE_KEY: jwt('anon') }));
  assert.equal(anon.status, 1);
  assert.match(anon.stdout, /KUNCI ANON/);

  const serviceDir = tempDir();
  const service = run(writeEnv(serviceDir, { ...GOOD, SUPABASE_SERVICE_ROLE_KEY: jwt('service_role') }));
  assert.equal(service.status, 0, service.stdout);
  assert.match(service.stdout, /ok \(JWT service_role\)/);
});

test('a service account pasted across several lines is caught', () => {
  const dir = tempDir();
  const envPath = writeEnv(dir, { ...GOOD, FIREBASE_SERVICE_ACCOUNT: '{' });
  fs.appendFileSync(envPath, '  "type": "service_account",\n  "project_id": "demo-proj"\n}\n');
  const result = run(envPath);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /BUKAN JSON valid|kepotong beberapa baris/);
  assert.match(result.stdout, /Login Google : BELUM SIAP/);
});

test('a service account from another project is warned about', () => {
  const dir = tempDir();
  const other = JSON.stringify({ type: 'service_account', project_id: 'proyek-lain', private_key: 'x', client_email: 'y@z' });
  const result = run(writeEnv(dir, { ...GOOD, FIREBASE_SERVICE_ACCOUNT: other }));

  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /PERHATIAN/);
  assert.match(result.stdout, /proyek-lain/);
});
