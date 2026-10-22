import test from 'node:test';
import assert from 'node:assert/strict';

// Sama seperti suite lain: .env milik developer tidak boleh mengubah apa yang
// diuji di sini.
process.env.SECURECHAT_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.STORAGE_DRIVER = 'local';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const { createCredentialRegistry, validatePassword, MIN_PASSWORD } = await import('../src/credentials.js');
const { createVerifier } = await import('../src/auth.js');
const { config } = await import('../src/config.js');

/** Store in-memory, bentuknya sama dengan file/Supabase yang dipakai server. */
function memoryStore() {
  let value = null;
  return {
    kind: 'test',
    async read() {
      return value ? structuredClone(value) : null;
    },
    async write(next) {
      value = structuredClone(next);
    },
    dump: () => value,
  };
}

async function freshRegistry() {
  const store = memoryStore();
  const registry = await createCredentialRegistry({ store });
  await registry.load();
  return { store, registry };
}

test('akun baru bisa didaftarkan lalu dipakai masuk', async () => {
  const { registry } = await freshRegistry();

  const created = await registry.register({ username: 'Budi', password: 'rahasia123' });
  assert.equal(created.ok, true, created.error);
  assert.match(created.uid, /^pw-[0-9a-f]{16}$/);
  assert.equal(registry.size(), 1);
  assert.equal(registry.has('budi'), true);

  const login = await registry.login({ username: 'Budi', password: 'rahasia123' });
  assert.equal(login.ok, true, login.error);
  assert.equal(login.profile.uid, created.uid);
  assert.equal(login.profile.displayName, 'Budi');
});

test('akun yang belum didaftarkan tidak bisa masuk', async () => {
  const { registry } = await freshRegistry();

  const login = await registry.login({ username: 'belum.ada', password: 'apa-saja' });
  assert.equal(login.ok, false);
  assert.match(login.error, /belum terdaftar/i);
});

test('sandi yang salah ditolak', async () => {
  const { registry } = await freshRegistry();
  await registry.register({ username: 'sinta', password: 'rahasia123' });

  for (const password of ['rahasia124', '', 'RAHASIA123', 'rahasia12']) {
    const login = await registry.login({ username: 'sinta', password });
    assert.equal(login.ok, false, `sandi "${password}" seharusnya ditolak`);
    assert.match(login.error, /salah/i);
  }
});

test('username sama tidak bisa didaftarkan dua kali, walau beda besar/kecil atau pemisah', async () => {
  const { registry } = await freshRegistry();
  assert.equal((await registry.register({ username: 'Budi', password: 'rahasia123' })).ok, true);

  for (const username of ['budi', 'BUDI', 'Bu.di', 'bu_di', 'bu-di']) {
    const again = await registry.register({ username, password: 'rahasia123' });
    assert.equal(again.ok, false, `"${username}" seharusnya dianggap sudah terdaftar`);
    assert.match(again.error, /sudah terdaftar/i);
  }
});

test('masuk tidak peduli besar/kecil huruf, tapi nama tampilannya tetap', async () => {
  const { registry } = await freshRegistry();
  await registry.register({ username: 'Budi', password: 'rahasia123' });

  const login = await registry.login({ username: 'bUdI', password: 'rahasia123' });
  assert.equal(login.ok, true, login.error);
  assert.equal(login.profile.displayName, 'Budi');
});

test('username yang dipakai sistem dan sandi pendek ditolak', async () => {
  const { registry } = await freshRegistry();

  const reserved = await registry.register({ username: 'admin', password: 'rahasia123' });
  assert.equal(reserved.ok, false);
  assert.match(reserved.error, /dipakai sistem/i);

  const short = await registry.register({ username: 'andi', password: '12345' });
  assert.equal(short.ok, false);
  assert.equal(short.error, `Kata sandi minimal ${MIN_PASSWORD} karakter.`);

  const spaces = await registry.register({ username: 'andi', password: '      ' });
  assert.equal(spaces.ok, false);

  assert.equal(validatePassword('123456'), null);
});

test('sandi tidak pernah tersimpan sebagai teks biasa', async () => {
  const { registry, store } = await freshRegistry();
  await registry.register({ username: 'rahasia', password: 'jangan-terbaca-ya' });

  const written = JSON.stringify(store.dump());
  assert.equal(written.includes('jangan-terbaca-ya'), false);
  assert.equal(written.includes('rahasia123'), false);
  assert.ok(store.dump().accounts.rahasia.salt);
  assert.ok(store.dump().accounts.rahasia.hash);
});

test('token sesi diterima verifier dan tidak bisa dipalsukan', async () => {
  const { registry } = await freshRegistry();
  const created = await registry.register({ username: 'dewi', password: 'rahasia123' });
  const login = await registry.login({ username: 'dewi', password: 'rahasia123' });

  const token = registry.issueSession(login.profile);
  assert.match(token, /^sess\./);

  const verifier = await createVerifier(config, {
    verifySession: (value) => registry.verifySession(value),
  });
  const profile = await verifier.verify(token);
  assert.equal(profile.uid, created.uid);
  assert.equal(profile.displayName, 'dewi');

  // Ubah satu karakter di tanda tangannya: token harus ditolak.
  const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  await assert.rejects(() => verifier.verify(tampered));

  // Token sesi tidak dikenal oleh verifier yang tidak diminta memeriksanya.
  const plainVerifier = await createVerifier(config);
  await assert.rejects(() => plainVerifier.verify(token));
});

test('sesi yang sudah kedaluwarsa ditolak', async () => {
  const { registry } = await freshRegistry();
  await registry.register({ username: 'eko', password: 'rahasia123' });
  const login = await registry.login({ username: 'eko', password: 'rahasia123' });

  const expired = registry.issueSession(login.profile, { ttlMs: -1000 });
  assert.throws(() => registry.verifySession(expired), /berakhir/);
});

test('sesi tetap sah setelah server dimuat ulang dari store yang sama', async () => {
  const store = memoryStore();
  const first = await createCredentialRegistry({ store });
  await first.load();
  await first.register({ username: 'fajar', password: 'rahasia123' });
  const login = await first.login({ username: 'fajar', password: 'rahasia123' });
  const token = first.issueSession(login.profile);

  // Boot berikutnya: kunci sesi dibaca dari file, bukan dibuat baru.
  const second = await createCredentialRegistry({ store });
  const count = await second.load();
  assert.equal(count, 1);
  assert.equal(second.verifySession(token).displayName, 'fajar');

  const again = await second.login({ username: 'fajar', password: 'rahasia123' });
  assert.equal(again.ok, true, again.error);
});

test('setelah terlalu banyak sandi salah, percobaan berikutnya ditahan', async () => {
  const { registry } = await freshRegistry();
  await registry.register({ username: 'gita', password: 'rahasia123' });

  for (let i = 0; i < 8; i++) {
    const wrong = await registry.login({ username: 'gita', password: `salah-${i}` });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /salah/i);
  }

  const blocked = await registry.login({ username: 'gita', password: 'rahasia123' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /terlalu banyak/i);
});
