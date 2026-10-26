import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(os.tmpdir(), `securechat-android-test-${process.pid}`);

// Sidik jari sertifikat android/android.keystore. Yang diuji bukan angka ini,
// melainkan bahwa server menyajikannya apa adanya untuk dibaca Chrome.
const FINGERPRINT = '77:5D:AA:91:E0:76:C2:EF:C9:98:38:C4:05:79:2E:27:9B:A9:92:67:B6:C4:1E:BF:F8:CD:11:86:32:C3:DD:8A';

process.env.SECURECHAT_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = TMP;
process.env.LOCAL_AVATAR_DIR = path.join(TMP, 'avatars');
process.env.USERNAME_STORE = path.join(TMP, 'usernames.json');
process.env.MODERATION_STORE = path.join(TMP, 'moderation.json');
process.env.ACCOUNT_STORE = path.join(TMP, 'accounts.json');
process.env.PUSH_STORE = path.join(TMP, 'push.json');
process.env.CREDENTIAL_STORE = path.join(TMP, 'credentials.json');
process.env.PROFILE_STORE = path.join(TMP, 'profiles.json');
process.env.CHANNEL_STORE = path.join(TMP, 'channels.json');
process.env.PORT = process.env.ANDROID_TEST_PORT || '4398';
process.env.ANDROID_PACKAGE_NAME = 'id.my.zizzy';
process.env.ANDROID_SHA256_CERT_FINGERPRINTS = FINGERPRINT;

const { assetLinks } = await import('../src/config.js');
const { server } = await import('../src/server.js');

const BASE_URL = `http://127.0.0.1:${process.env.PORT}`;
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Menjalankan config.js di proses lain, supaya env yang berbeda bisa diuji. */
async function assetLinksWith(env) {
  const script = `
    const { assetLinks } = await import('./src/config.js');
    console.log(JSON.stringify(assetLinks()));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env: { ...process.env, ANDROID_PACKAGE_NAME: '', ANDROID_SHA256_CERT_FINGERPRINTS: '', ...env },
  });
  return JSON.parse(stdout.trim().split('\n').pop());
}

test('domain menyatakan APK mana yang berhak membukanya', async () => {
  const response = await fetch(`${BASE_URL}/.well-known/assetlinks.json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/json/);

  assert.deepEqual(await response.json(), [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'id.my.zizzy',
        sha256_cert_fingerprints: [FINGERPRINT],
      },
    },
  ]);
});

test('tanpa konfigurasi APK, jawabannya daftar kosong — bukan error', async () => {
  // Chrome memperlakukan daftar kosong sebagai "domain ini bukan milik APK
  // mana pun", dan APK-nya tetap jalan sebagai Custom Tab biasa.
  assert.deepEqual(await assetLinksWith({}), []);
  assert.deepEqual(
    await assetLinksWith({ ANDROID_PACKAGE_NAME: 'id.my.zizzy', ANDROID_SHA256_CERT_FINGERPRINTS: '' }),
    []
  );
  assert.equal(assetLinks().length, 1);
});

test('sidik jari yang salah ketik dibuang, yang benar tetap dipakai', async () => {
  const links = await assetLinksWith({
    ANDROID_PACKAGE_NAME: 'id.my.zizzy',
    ANDROID_SHA256_CERT_FINGERPRINTS: `bukan-sidik-jari, ${FINGERPRINT.toLowerCase()}`,
  });

  // Huruf kecil diterima (dinaikkan dulu), sampahnya dibuang.
  assert.deepEqual(links[0].target.sha256_cert_fingerprints, [FINGERPRINT]);
});
