import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_LENGTH,
  MIN_LENGTH,
  createUsernameRegistry,
  createUsernameStore,
  normalizeUsername,
  suggestUsername,
  usernameKey,
  validateUsername,
} from '../usernames.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'securechat-names-'));

/** The registry talking to a real file, which is what runs in production here. */
async function registryIn(dir) {
  const store = await createUsernameStore({
    storage: { driver: 'local', localDir: path.join(dir, 'attachments') },
    usernames: { file: path.join(dir, 'usernames.json'), object: 'registry/usernames.json' },
  });
  const registry = await createUsernameRegistry({ store });
  await registry.load();
  return registry;
}

test('a username is normalised to lowercase and trimmed', () => {
  assert.equal(normalizeUsername('  Andi  '), 'andi');
  assert.equal(usernameKey('A.n_d-i'), 'andi');
});

test('the shape rules are enforced with a message a person can act on', () => {
  assert.equal(validateUsername('andi').ok, true);
  assert.equal(validateUsername('andi.123').ok, true);

  assert.match(validateUsername('').error, /belum diisi/);
  assert.equal(validateUsername('a'.repeat(MIN_LENGTH - 1)).ok, false);
  assert.equal(validateUsername('a'.repeat(MAX_LENGTH + 1)).ok, false);
  assert.equal(validateUsername('_andi').ok, false, 'tidak boleh mulai dari pemisah');
  assert.equal(validateUsername('andi-').ok, false, 'tidak boleh berakhir pemisah');
  assert.equal(validateUsername('andi budi').ok, false, 'spasi nggak boleh');
  assert.equal(validateUsername('andi!').ok, false);
  assert.equal(validateUsername('ADMIN').ok, false, 'nama sistem harus ditolak');
  assert.match(validateUsername('admin').error, /sistem/);

  // Length is measured before any normalisation of separators.
  assert.equal(validateUsername('ab').ok, false);
  assert.equal(validateUsername('abc').ok, true);
});

test('a name that only differs by separators or case cannot shadow another', async () => {
  const dir = tempDir();
  const registry = await registryIn(dir);

  assert.equal((await registry.claim('andi', 'u-1')).ok, true);

  for (const sneak of ['ANDI', 'Andi', 'a.n.d.i', 'a_n_d_i', 'a-n-d-i']) {
    const result = await registry.claim(sneak, 'u-2');
    assert.equal(result.ok, false, `"${sneak}" seharusnya ditolak`);
    assert.match(result.error, /sudah dipakai/);
  }

  assert.equal(registry.get('u-1'), 'andi');
  assert.equal(registry.get('u-2'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('claiming the same name again by its owner is allowed and changes nothing', async () => {
  const dir = tempDir();
  const registry = await registryIn(dir);

  await registry.claim('sinta', 'u-1');
  const again = await registry.claim('SINTA', 'u-1');
  assert.equal(again.ok, true);
  assert.equal(again.unchanged, true, 'klaim ulang oleh pemiliknya bukan perubahan');
  assert.equal(again.username, 'sinta');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renaming frees the old name and takes the new one', async () => {
  const dir = tempDir();
  const registry = await registryIn(dir);

  await registry.claim('tono', 'u-1');
  await registry.claim('tini', 'u-2');

  const taken = await registry.claim('tono', 'u-2');
  assert.equal(taken.ok, false);

  const moved = await registry.claim('tini.besar', 'u-2');
  assert.equal(moved.ok, true);

  assert.equal(registry.takenBy('tini', 'u-1'), null, 'nama lama harus bebas lagi');
  assert.equal(registry.takenBy('tini.besar', 'u-1'), 'tini.besar');
  assert.deepEqual(registry.check('tini', 'u-1').ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('claims survive a restart', async () => {
  const dir = tempDir();
  const first = await registryIn(dir);
  await first.claim('wawan', 'u-9');
  await first.claim('wati', 'u-10');

  // A brand new registry reading the same file — the way the server boots.
  const second = await registryIn(dir);
  assert.equal(second.size(), 2);
  assert.equal(second.get('u-9'), 'wawan');
  assert.equal((await second.claim('wawan', 'u-11')).ok, false, 'sesudah restart tetap terjaga');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a damaged or hand-edited store cannot crash the boot or squat a name', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'usernames.json');

  fs.writeFileSync(file, JSON.stringify({ version: 1, uids: { 'u-1': 'ok-name', 'u-2': 'OK-NAME', 'u-3': 'x!', 'u-4': '' } }));
  const registry = await createUsernameRegistry({ store: { async read() { return JSON.parse(fs.readFileSync(file, 'utf8')); }, async write() {} } });
  await registry.load();

  // Only the first entry of a duplicated name survives, and invalid ones are dropped.
  assert.equal(registry.size(), 1);
  assert.equal(registry.get('u-1'), 'ok-name');
  assert.equal(registry.get('u-3'), null);

  const emptyFileDir = tempDir();
  fs.writeFileSync(path.join(emptyFileDir, 'usernames.json'), '   ');
  const empty = await registryIn(emptyFileDir);
  assert.equal(empty.size(), 0, 'file kosong bukan alasan gagal');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(emptyFileDir, { recursive: true, force: true });
});

test('the file backend writes a store a fresh registry can read back', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'usernames.json');
  const store = await createUsernameStore({
    storage: { driver: 'local' },
    usernames: { file, object: 'registry/usernames.json' },
  });
  assert.equal(store.kind, 'file');
  assert.equal(await store.read(), null, 'file yang belum ada bukan error');

  await store.write({ version: 1, uids: { 'u-1': 'andi' } });
  assert.deepEqual(await store.read(), { version: 1, uids: { 'u-1': 'andi' } });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('suggestions stay inside the rules and avoid what is taken', () => {
  const taken = new Set(['andi', 'andi2']);
  const suggestion = suggestUsername('ANDI', (name) => taken.has(name));
  assert.equal(suggestion, 'andi3');
  assert.equal(validateUsername(suggestion).ok, true);

  // A dotted wishlist collapses to a clean name instead of handing back a
  // lookalike of the name that was just refused.
  assert.equal(suggestUsername('a.n.d.i', (name) => name === 'andi'), 'andi2');
  assert.equal(suggestUsername('a.n.d.i', () => false).includes('.'), false);

  const nameLike = suggestUsername('Budi Santoso', () => false);
  assert.equal(nameLike, 'budisantoso');
  assert.equal(validateUsername(nameLike).ok, true);

  // Too short a stem still has to produce something usable.
  assert.ok(suggestUsername('ab', () => false).length >= MIN_LENGTH);
});

test('a claim that cannot be saved is still served, with a warning', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const registry = await createUsernameRegistry({
      store: {
        async read() {
          return null;
        },
        async write() {
          throw new Error('penyimpanan penuh');
        },
      },
    });
    await registry.load();
    const claimed = await registry.claim('rara', 'u-1');
    assert.equal(claimed.ok, true, 'klaim tetap berlaku di memori');
    assert.equal(warnings.some((w) => w.includes('penyimpanan penuh')), true);
  } finally {
    console.warn = original;
  }
});

test('the supabase backend is chosen when that is the storage driver', async () => {
  // Only the selection is asserted here; talking to Supabase needs real
  // credentials, which is exactly what the deployed server has.
  const store = await createUsernameStore({
    storage: { driver: 'supabase', bucket: 'attachments' },
    secrets: { supabaseUrl: 'https://abcdefghijklmno.supabase.co', supabaseServiceKey: 'sb_secret_dummy' },
    usernames: { file: path.join(tempDir(), 'usernames.json'), object: 'registry/usernames.json' },
  });
  assert.equal(store.kind, 'supabase');
});

test('the store path stays inside the data directory it was given', async () => {
  const dir = tempDir();
  await fsp.mkdir(path.join(dir, 'data'), { recursive: true });
  const store = await createUsernameStore({
    storage: { driver: 'local' },
    usernames: { file: path.join(dir, 'data', 'usernames.json'), object: 'registry/usernames.json' },
  });
  await store.write({ version: 1, uids: {} });
  assert.equal(fs.existsSync(path.join(dir, 'data', 'usernames.json')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
