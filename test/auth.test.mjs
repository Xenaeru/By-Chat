import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.SECURECHAT_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.STORAGE_DRIVER = 'local';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const { createVerifier, makeDevToken } = await import('../auth.js');
const { config, publicConfig } = await import('../config.js');

test('the dev verifier round-trips a profile', async () => {
  const verifier = await createVerifier(config);
  assert.equal(verifier.mode, 'dev');

  const token = makeDevToken({ uid: 'u-123', displayName: 'Budi', phone: '+628123', photoURL: null });
  const profile = await verifier.verify(token);

  assert.equal(profile.uid, 'u-123');
  assert.equal(profile.displayName, 'Budi');
  assert.equal(profile.phone, '+628123');
});

test('the dev verifier rejects anything that is not a dev token', async () => {
  const verifier = await createVerifier(config);
  for (const bad of ['', 'Bearer x', 'dev.', 'dev.not-base64!!', null, undefined]) {
    await assert.rejects(() => verifier.verify(bad));
  }
});

test('a token cannot smuggle control characters or a giant uid', async () => {
  const verifier = await createVerifier(config);

  await assert.rejects(() =>
    verifier.verify(makeDevToken({ uid: '../../etc/passwd', displayName: 'x' }))
  );
  await assert.rejects(() =>
    verifier.verify(makeDevToken({ uid: 'a'.repeat(200), displayName: 'x' }))
  );

  const profile = await verifier.verify(
    makeDevToken({ uid: 'ok_uid-1', displayName: 'Budi\u0000\nNyolong', phone: null })
  );
  assert.equal(profile.displayName, 'BudiNyolong');
});

test('a profile with no name still gets a usable label', async () => {
  const verifier = await createVerifier(config);
  const profile = await verifier.verify(makeDevToken({ uid: 'abcdef123456', displayName: '' }));
  assert.equal(profile.displayName, 'user-abcdef');
});

test('the browser config never carries a secret', () => {
  const exposed = JSON.stringify(publicConfig());

  assert.equal(config.secrets.supabaseServiceKey, '');
  assert.ok(!exposed.includes('SERVICE_ROLE'));
  assert.ok(!exposed.includes('serviceAccount'));
  assert.equal(publicConfig().auth.firebase, null);
  assert.equal(publicConfig().auth.mode, 'dev');
});

test('NODE_ENV=production refuses to boot with dev auth', async () => {
  const script = `
    process.env.SECURECHAT_SKIP_DOTENV = '1';
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'dev';
    await import('./config.js');
    console.log('SHOULD_NOT_REACH_HERE');
  `;

  await assert.rejects(
    () => execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT }),
    (err) => {
      assert.match(String(err.stderr), /AUTH_MODE=dev nggak boleh dipakai di NODE_ENV=production/);
      assert.equal(String(err.stdout).includes('SHOULD_NOT_REACH_HERE'), false);
      return true;
    }
  );
});

test('asking for firebase auth without credentials fails loudly', async () => {
  const script = `
    process.env.SECURECHAT_SKIP_DOTENV = '1';
    process.env.AUTH_MODE = 'firebase';
    await import('./config.js');
    console.log('SHOULD_NOT_REACH_HERE');
  `;

  await assert.rejects(
    () => execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT }),
    (err) => {
      assert.match(String(err.stderr), /FIREBASE_API_KEY/);
      return true;
    }
  );
});

test('picking supabase storage without credentials fails loudly', async () => {
  const script = `
    process.env.SECURECHAT_SKIP_DOTENV = '1';
    process.env.STORAGE_DRIVER = 'supabase';
    await import('./config.js');
    console.log('SHOULD_NOT_REACH_HERE');
  `;

  await assert.rejects(
    () => execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT }),
    (err) => {
      assert.match(String(err.stderr), /SUPABASE_URL/);
      return true;
    }
  );
});

test('TURN settings are surfaced to the client without the credentials being hidden', () => {
  // ICE servers are the one secret-ish thing the browser legitimately needs:
  // it is the client that has to authenticate to TURN.
  const calls = publicConfig().calls;
  assert.ok(Array.isArray(calls.iceServers));
  assert.ok(calls.iceServers.some((s) => String(s.urls).includes('stun:')));
  assert.equal(calls.hasTurn, false); // no TURN configured in this test env
});
