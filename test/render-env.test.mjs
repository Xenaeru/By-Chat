import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(projectRoot, 'scripts', 'render-env.mjs');

// Must match the `sync: false` entries in render.yaml — those are exactly the
// values Render asks for when it creates the service from the blueprint.
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
  ADMIN_EMAILS: 'admin@contoh.id',
};

function writeEnv(dir, values) {
  const p = path.join(dir, '.env');
  const text = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  fs.writeFileSync(p, text + '\n');
  return p;
}

// spawnSync rather than execFileSync: the script reports warnings on stderr, and
// execFileSync forwards a successful child's stderr to the terminal instead of
// handing it back, which would hide precisely what these tests check.
function run(envPath, outPath) {
  const result = spawnSync(process.execPath, [script, '--env', envPath, '--out', outPath], {
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'securechat-render-'));

test('the Render list holds exactly the nine blueprint values, in order', () => {
  const dir = tempDir();
  const outPath = path.join(dir, 'render-env.txt');

  // The developer's .env also has settings that render.yaml already fixes; those
  // must not leak into the paste block or they would override the blueprint.
  const envPath = writeEnv(dir, {
    ...GOOD,
    NODE_ENV: 'development',
    PORT: '3000',
    STORAGE_DRIVER: 'local',
    AUTH_MODE: 'dev',
    SUPABASE_BUCKET: 'attachments',
    TURN_URLS: 'turn:example.org:3478',
  });

  const result = run(envPath, outPath);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const lines = fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(
    lines.map((l) => l.slice(0, l.indexOf('='))),
    RENDER_KEYS
  );
  for (const key of ['NODE_ENV', 'PORT', 'STORAGE_DRIVER', 'AUTH_MODE', 'SUPABASE_BUCKET', 'TURN_URLS']) {
    assert.equal(`${lines.join('\n')}\n`.includes(`\n${key}=`), false, `${key} ikut tertulis`);
  }
  // Comments would confuse a paste-and-parse dialog, so there must be none.
  assert.equal(lines.some((l) => l.startsWith('#')), false);

  // The service account has to survive as ONE line: its private key stores newlines
  // as the two-character escape \n, and a raw break would truncate the value there.
  const saLine = lines.find((l) => l.startsWith('FIREBASE_SERVICE_ACCOUNT='));
  assert.equal(saLine, `FIREBASE_SERVICE_ACCOUNT=${SERVICE_ACCOUNT}`);
  assert.equal(JSON.parse(saLine.slice(saLine.indexOf('=') + 1)).private_key.includes('-----BEGIN'), true);
});

test('no secret value is ever printed to the terminal', () => {
  const dir = tempDir();
  const result = run(writeEnv(dir, GOOD), path.join(dir, 'render-env.txt'));

  assert.equal(result.status, 0, result.stderr);
  const printed = result.stdout + result.stderr;
  for (const secret of [
    GOOD.FIREBASE_API_KEY,
    GOOD.SUPABASE_SERVICE_ROLE_KEY,
    'BEGIN PRIVATE KEY',
    'MIIEvQIBADANBgkq',
  ]) {
    assert.equal(printed.includes(secret), false, `nilai rahasia tercetak: ${secret}`);
  }
  // It still has to be useful: every key is listed with a verdict.
  for (const key of RENDER_KEYS) assert.match(printed, new RegExp(key));
});

test('a service account spread over several lines stops the run before anything is written', () => {
  const dir = tempDir();
  const outPath = path.join(dir, 'render-env.txt');
  const envPath = writeEnv(dir, { ...GOOD, FIREBASE_SERVICE_ACCOUNT: '{' });
  fs.appendFileSync(envPath, '  "type": "service_account",\n  "project_id": "demo-proj"\n}\n');

  const result = run(envPath, outPath);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bukan JSON valid|kepotong beberapa baris/);
  assert.equal(fs.existsSync(outPath), false);
});

test('an unset secret is named, and nothing is written', () => {
  const dir = tempDir();
  const outPath = path.join(dir, 'render-env.txt');
  const { SUPABASE_SERVICE_ROLE_KEY, ...rest } = GOOD;

  const result = run(writeEnv(dir, rest), outPath);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SUPABASE_SERVICE_ROLE_KEY masih KOSONG/);
  assert.equal(fs.existsSync(outPath), false);
});

test('a service account from another project is a warning, not a stop', () => {
  const dir = tempDir();
  const outPath = path.join(dir, 'render-env.txt');
  const other = JSON.stringify({
    type: 'service_account',
    project_id: 'proyek-lain',
    private_key: 'x',
    client_email: 'y@z',
  });

  const result = run(writeEnv(dir, { ...GOOD, FIREBASE_SERVICE_ACCOUNT: other }), outPath);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /proyek-lain/);
  assert.equal(fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean).length, RENDER_KEYS.length);
});

test('an empty admin list only warns — the app still deploys, just without /admin.html', () => {
  const dir = tempDir();
  const outPath = path.join(dir, 'render-env.txt');
  const { ADMIN_EMAILS, ...rest } = GOOD;

  const result = run(writeEnv(dir, rest), outPath);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /ADMIN_EMAILS masih kosong/);

  // Nilainya tetap ikut tertulis (kosong), supaya jumlah barisnya cocok dengan
  // kotak tempel di Render dan nggak ada yang tertinggal tanpa disadari.
  const lines = fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(
    lines.map((l) => l.slice(0, l.indexOf('='))),
    RENDER_KEYS
  );
});

test('the written file is ignored by git', () => {
  // The block holds real secrets, so the default output name has to be ignored.
  let ignored = false;
  try {
    execFileSync('git', ['check-ignore', '-q', '--', 'render-env.txt'], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    ignored = true;
  } catch (e) {
    // No git binary on this machine: nothing to assert, the check simply can't run.
    if (e.status === null || e.status === undefined) return;
  }
  assert.equal(ignored, true, 'render-env.txt harus diabaikan git');
});
