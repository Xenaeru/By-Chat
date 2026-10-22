import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { io as ioClient } from 'socket.io-client';

// Pin the environment before anything imports config.js, so a developer's
// local .env can never change what this suite exercises.
const TMP = path.join(os.tmpdir(), `securechat-test-${process.pid}`);
process.env.SECURECHAT_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = TMP;
process.env.LOCAL_AVATAR_DIR = path.join(TMP, 'avatars');
// Keep the username namespace inside the temp dir: a test run must not leave
// claims behind in the developer's data/ folder.
process.env.USERNAME_STORE = path.join(TMP, 'usernames.json');
// Laporan, daftar blokir, dan indeks kontak juga punya file sendiri.
process.env.MODERATION_STORE = path.join(TMP, 'moderation.json');
process.env.ACCOUNT_STORE = path.join(TMP, 'accounts.json');
// Kunci VAPID + langganan push juga tidak boleh menumpuk di data/ developer.
process.env.PUSH_STORE = path.join(TMP, 'push.json');
// Akun username+kata sandi punya file sendiri juga.
process.env.CREDENTIAL_STORE = path.join(TMP, 'credentials.json');
// Satu akun di sini yang jadi admin, supaya endpoint /api/admin/* bisa diuji.
process.env.ADMIN_UIDS = 'u-petugas';
process.env.PORT = process.env.TEST_PORT || '4399';

const {
  generateIdentity,
  importPrivateKey,
  deriveSharedKey,
  encryptMessage,
  decryptMessage,
  encryptFile,
  decryptFile,
} = await import('../public/js/crypto.js');
const { makeDevToken } = await import('../src/auth.js');
const { server, directory, inbox, calls, statuses, moderation, accounts, push } = await import('../src/server.js');
const { resolveLocalPath } = await import('../src/storage.js');

const BASE_URL = `http://127.0.0.1:${process.env.PORT}`;
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));

const sockets = [];
test.after(async () => {
  for (const socket of sockets) socket.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(TMP, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = async (blob) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())).toString('hex');

/** A stand-in for the browser: own key pair, verified token, E2EE everywhere. */
class Client {
  constructor(name, { identity = null, token = null, claimUsername = true } = {}) {
    this.name = name;
    this.uid = `u-${name}`;
    this.identity = identity;
    this.tokenOverride = token;
    this.wantsUsername = claimUsername;
    this.inbox = [];
    this.signals = [];
    this.directory = [];
    this.statusFeed = [];
    this.removedStatuses = [];
    this.bannedNotices = [];
    this.shared = new Map();
  }

  async init() {
    if (!this.identity) this.identity = await generateIdentity();
    this.privateKey = await importPrivateKey(this.identity.privateKey);
    this.token = this.tokenOverride ?? makeDevToken({ uid: this.uid, displayName: this.name });

    this.socket = ioClient(BASE_URL, {
      transports: ['websocket'],
      forceNew: true,
      auth: { token: this.token, publicKey: this.identity.publicKey },
    });
    sockets.push(this.socket);

    this.socket.on('message', (envelope) => this.inbox.push(envelope));
    this.socket.on('directory', (list) => (this.directory = list));
    this.socket.on('status:new', (status) => this.statusFeed.push(status));
    this.socket.on('status:removed', (status) => this.removedStatuses.push(status));
    this.socket.on('session:banned', (data) => this.bannedNotices.push(data));
    for (const event of [
      'call:incoming',
      'call:accepted',
      'call:joined',
      'call:member-joined',
      'call:member-left',
      'call:rejected',
      'call:ended',
      'call:signal',
      'call:log',
    ]) {
      this.socket.on(event, (data) => this.signals.push({ event, data }));
    }

    this.ready = await new Promise((resolve, reject) => {
      this.socket.once('ready', resolve);
      this.socket.once('connect_error', (err) => reject(new Error(err.message)));
      setTimeout(() => reject(new Error('timeout menunggu ready')), 5000);
    });
    this.directory = this.ready.directory;

    // The server refuses to relay anything from an account without a username,
    // so every client here claims one — the same step the browser gate performs.
    if (this.wantsUsername) {
      const claimed = await this.claim(this.name);
      if (!claimed?.ok) throw new Error(`gagal klaim username ${this.name}: ${claimed?.error}`);
    }
    return this;
  }

  claim(name) {
    return new Promise((resolve) => this.socket.emit('username:claim', name, resolve));
  }

  check(name) {
    return new Promise((resolve) => this.socket.emit('username:check', name, resolve));
  }

  rename(name) {
    return new Promise((resolve) => this.socket.emit('profile:update', { displayName: name }, resolve));
  }

  /** Cari kontak lewat email, nomor HP, atau @username. */
  lookup(query) {
    return new Promise((resolve) => this.socket.emit('contact:lookup', query, resolve));
  }

  report(data) {
    return new Promise((resolve) => this.socket.emit('report:submit', data, resolve));
  }

  /** Minta server menghapus sebuah pesan untuk semua orang. */
  remove(id) {
    return new Promise((resolve) => this.socket.emit('message:delete', { id }, resolve));
  }

  keyWith(uid, publicKey) {
    if (!this.shared.has(uid)) {
      this.shared.set(uid, deriveSharedKey(this.privateKey, publicKey, this.uid, uid));
    }
    return this.shared.get(uid);
  }

  async send({ roomId, name = '', type = 'dm', members, text, attachment = null, keys, from = null }) {
    const payload = await encryptMessage(JSON.stringify({ text, attachment }), keys);
    const meta = from || { uid: this.uid, displayName: this.name };
    return new Promise((resolve) => {
      this.socket.emit(
        'send',
        { roomId, roomName: name, type, members, payload, _from: meta },
        (ack) => resolve({ ack, payload })
      );
    });
  }

  signal(event, data) {
    return new Promise((resolve) => {
      if (event === 'call:invite' || event === 'call:accept') this.socket.emit(event, data, resolve);
      else {
        this.socket.emit(event, data);
        resolve();
      }
    });
  }

  received(event) {
    return this.signals.filter((s) => s.event === event).map((s) => s.data);
  }

  close() {
    this.socket?.close();
  }
}

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

test('1:1 message is encrypted in transit and readable by both parties', async () => {
  const alice = await new Client('alice').init();
  const bob = await new Client('bob').init();
  await sleep(50);

  const roomId = [alice.uid, bob.uid].sort().join(':');
  const key = await alice.keyWith(bob.uid, bob.identity.publicKey);
  const text = 'halo bob, ini rahasia 🔐';

  const { ack, payload } = await alice.send({
    roomId: 'dm:' + roomId,
    members: [alice.uid, bob.uid],
    text,
    keys: new Map([
      [alice.uid, key],
      [bob.uid, key],
    ]),
  });

  assert.equal(ack.ok, true);
  assert.deepEqual(ack.delivered, [bob.uid]);
  assert.ok(!JSON.stringify(payload).includes('rahasia'), 'plaintext bocor ke envelope!');

  await sleep(80);
  assert.equal(bob.inbox.length, 1);
  assert.equal(bob.inbox[0].from, alice.uid);

  const bobKey = await bob.keyWith(alice.uid, alice.identity.publicKey);
  const decoded = JSON.parse(await decryptMessage(bob.inbox[0].payload, bob.uid, bobKey));
  assert.equal(decoded.text, text);
  assert.equal(decoded.attachment, null);

  alice.close();
  bob.close();
});

test('hapus untuk semua orang: cuma pengirim aslinya, dan penerimanya dikabari', async () => {
  const alice = await new Client('alice-del').init();
  const bob = await new Client('bob-del').init();
  await sleep(50);

  const roomId = `dm:${alice.uid}:${bob.uid}`;
  const key = await alice.keyWith(bob.uid, bob.identity.publicKey);
  const keys = new Map([
    [alice.uid, key],
    [bob.uid, key],
  ]);
  const text = 'pesan yang nanti dihapus untuk semua orang';

  const { ack } = await alice.send({ roomId, members: [alice.uid, bob.uid], text, keys });
  assert.equal(ack.ok, true);

  // Penerimanya tidak boleh bisa menghapus pesan orang lain.
  const stolen = await bob.remove(ack.id);
  assert.equal(stolen.ok, false);
  assert.match(stolen.error, /pengirim aslinya/i);

  // Id yang tidak pernah dikirim lewat server ini juga ditolak, bukan diiyakan.
  const unknown = await alice.remove('id-yang-nggak-ada');
  assert.equal(unknown.ok, false);

  // Pengirim aslinya boleh, dan penerimanya dapat kabar.
  const removed = await alice.remove(ack.id);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.delivered, [bob.uid]);

  await sleep(80);
  const tombstone = bob.inbox.find((envelope) => envelope.deleted);
  assert.ok(tombstone, 'penerima tidak dikabari soal penghapusan');
  assert.equal(tombstone.id, ack.id);
  assert.equal(tombstone.roomId, roomId);
  // Yang diteruskan cuma id: tidak ada isi pesan yang ikut berpindah tempat.
  assert.ok(!JSON.stringify(tombstone).includes('nanti dihapus'), 'isi pesan ikut terkirim lagi');

  alice.close();
  bob.close();
});

test('server memory only ever holds ciphertext and public keys', async () => {
  const alice = await new Client('alice2').init();
  const bob = await new Client('bob2').init();
  await sleep(50);

  const key = await alice.keyWith(bob.uid, bob.identity.publicKey);
  await alice.send({
    roomId: `dm:${alice.uid}:${bob.uid}`,
    members: [alice.uid, bob.uid],
    text: 'PIN-nya 445566 jangan bilang siapa-siapa',
    keys: new Map([
      [alice.uid, key],
      [bob.uid, key],
    ]),
  });
  await sleep(80);

  // Project only the fields a real operator could inspect; a directory entry
  // also holds a live socket object, which is not serialisable.
  const memory = JSON.stringify({
    directory: [...directory.entries()].map(([uid, entry]) => ({
      uid,
      publicKey: entry.publicKey,
      displayName: entry.profile.displayName,
    })),
    inbox: [...inbox.entries()],
  });
  assert.ok(!memory.includes('PIN-nya'));
  assert.ok(!memory.includes('445566'));
  for (const [, entry] of directory) {
    assert.equal(entry.publicKey.d, undefined, 'server nggak boleh pegang private key');
  }

  alice.close();
  bob.close();
});

test('messages queue while offline and arrive on reconnect', async () => {
  const alice = await new Client('alice3').init();
  const carol = await new Client('carol3').init();
  await sleep(50);

  const carolIdentity = carol.identity;
  carol.close();
  await sleep(120);

  const key = await alice.keyWith(carol.uid, carolIdentity.publicKey);
  const { ack } = await alice.send({
    roomId: `dm:${alice.uid}:${carol.uid}`,
    members: [alice.uid, carol.uid],
    text: 'pesan buat kamu pas online',
    keys: new Map([
      [alice.uid, key],
      [carol.uid, key],
    ]),
  });
  assert.deepEqual(ack.queued, [carol.uid]);

  // Same account, same identity, new connection.
  const carolAgain = await new Client('carol3', { identity: carolIdentity }).init();
  assert.equal(carolAgain.ready.inbox.length, 1);
  assert.equal(carolAgain.ready.directory.some((u) => u.uid === alice.uid), true);

  const carolKey = await carolAgain.keyWith(alice.uid, alice.identity.publicKey);
  const decoded = JSON.parse(await decryptMessage(carolAgain.ready.inbox[0].payload, carol.uid, carolKey));
  assert.equal(decoded.text, 'pesan buat kamu pas online');

  alice.close();
  carolAgain.close();
});

test('a connection without a valid token is rejected', async () => {
  const rogue = new Client('rogue', { token: 'not-a-real-token' });
  await assert.rejects(() => rogue.init(), /Tidak terautentikasi/);
  rogue.close();
});

test('opening the same account elsewhere replaces the older session', async () => {
  const first = await new Client('dave').init();
  const seen = [];
  first.socket.on('session:replaced', () => seen.push(true));

  const second = await new Client('dave', { identity: first.identity }).init();
  await sleep(150);

  assert.equal(seen.length, 1);
  assert.equal(directory.get('u-dave').socketId, second.socket.id);

  first.close();
  second.close();
});

/* ------------------------------------------------------------------ *
 * Usernames
 * ------------------------------------------------------------------ */

test('a fresh account has no username, and cannot send until it claims one', async () => {
  const nadia = await new Client('nadia', { claimUsername: false }).init();
  assert.equal(nadia.ready.username, null, 'akun baru seharusnya belum punya username');

  const key = await nadia.keyWith(nadia.uid, nadia.identity.publicKey);
  const attempt = (text) =>
    nadia.send({ roomId: 'dm:nadia', members: [nadia.uid], text, keys: new Map([[nadia.uid, key]]) });

  const blocked = await attempt('halo');
  assert.equal(blocked.ack.ok, false, 'relay harus nolak sebelum username ada');
  assert.match(blocked.ack.error, /username/i);

  const claimed = await nadia.claim('nadia');
  assert.equal(claimed.ok, true);
  assert.equal(claimed.username, 'nadia');

  const allowed = await attempt('halo');
  assert.equal(allowed.ack.ok, true, JSON.stringify(allowed.ack));

  nadia.close();
});

test('a taken username is refused, even with different case or with dots', async () => {
  const owner = await new Client('bagas', { claimUsername: false }).init();
  assert.equal((await owner.claim('bagas')).ok, true);

  const other = await new Client('bagas2', { claimUsername: false }).init();

  const upper = await other.claim('BAGAS');
  assert.equal(upper.ok, false);
  assert.match(upper.error, /sudah dipakai/i);
  assert.match(upper.suggestion, /^bagas/, `saran aneh: ${upper.suggestion}`);

  const dotted = await other.claim('b.a.g.a.s');
  assert.equal(dotted.ok, false, 'titik nggak boleh jadi cara nyamar');

  assert.equal((await other.claim('admin')).ok, false, 'nama sistem harus ditolak');
  assert.equal((await other.claim('ab')).ok, false, 'terlalu pendek harus ditolak');
  assert.equal((await other.claim('bagas!')).ok, false, 'karakter aneh harus ditolak');

  // A genuinely free name still works, and reaches everyone else's contact list.
  assert.equal((await other.claim('bagas2')).ok, true);
  await sleep(80);
  const seen = owner.directory.find((u) => u.uid === other.uid);
  assert.equal(seen?.displayName, 'bagas2', JSON.stringify(owner.directory));

  owner.close();
  other.close();
});

test('capitals are shown as typed, while the name stays unique and searchable', async () => {
  const owner = await new Client('owner', { claimUsername: false }).init();
  const claimed = await owner.claim('XenaboutYou');
  assert.equal(claimed.ok, true, claimed.error);
  assert.equal(claimed.username, 'XenaboutYou', 'server menyimpan ejaan yang diketik');

  const finder = await new Client('finder').init();
  await sleep(80);

  // Orang lain melihat ejaan aslinya di direktori...
  const seen = finder.directory.find((u) => u.uid === owner.uid);
  assert.equal(seen?.displayName, 'XenaboutYou', JSON.stringify(finder.directory));

  // ...dan bisa menemukannya walau mengetik besar/kecil seenaknya.
  const found = await finder.lookup('@xenABOUTyou');
  assert.equal(found.ok, true, found.error);
  assert.equal(found.results[0]?.uid, owner.uid, JSON.stringify(found.results));
  assert.equal(found.results[0]?.username, 'XenaboutYou');

  // Pemiliknya boleh membetulkan ejaannya dari Pengaturan, dan yang lain tetap
  // tidak bisa memakai nama yang sama dengan ejaan apa pun.
  const renamed = await owner.rename('Xenaboutyou');
  assert.equal(renamed.ok, true, renamed.error);
  assert.equal(renamed.username, 'Xenaboutyou');
  assert.equal((await finder.claim('xenaboutyou')).ok, false);

  await sleep(80);
  const afterRename = await finder.lookup('@XENABOUTYOU');
  assert.equal(afterRename.results[0]?.username, 'Xenaboutyou');

  owner.close();
  finder.close();
});

test('renaming runs through the same namespace, so it cannot steal a name', async () => {
  const one = await new Client('candra', { claimUsername: false }).init();
  const two = await new Client('dewi', { claimUsername: false }).init();
  assert.equal((await one.claim('candra')).ok, true);
  assert.equal((await two.claim('dewi')).ok, true);

  const clash = await two.rename('candra');
  assert.equal(clash.ok, false);
  assert.match(clash.error, /sudah dipakai/i);

  const renamed = await two.rename('dewi.lestari');
  assert.equal(renamed.ok, true);
  assert.equal(renamed.username, 'dewi.lestari');

  // The old name is free again, the new one is not.
  assert.equal((await one.check('dewi')).ok, true);
  assert.equal((await one.check('dewi.lestari')).ok, false);

  one.close();
  two.close();
});

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

const publishStatus = (client, payload, members) =>
  new Promise((resolve) => client.socket.emit('status:publish', { payload, members }, resolve));

const removeStatus = (client, id) =>
  new Promise((resolve) => client.socket.emit('status:remove', id, resolve));

test('a status reaches its audience encrypted, and only its author can delete it', async () => {
  const author = await new Client('rita').init();
  const viewer = await new Client('sari').init();
  await sleep(60);

  const secret = 'status: lagi di Jakarta, jangan bilang siapa-siapa';
  // A photo status carries the same attachment metadata a message does: the
  // ciphertext lives in storage, the key travels inside the encrypted status.
  const attachment = { path: 'att/2026/10/rita/0123456789abcdef0123456789abcdef', key: 'kunci-file', name: 'pantai.png', size: 12, mime: 'image/png', fileId: 'x', totalChunks: 1 };
  const payload = await encryptMessage(
    JSON.stringify({ text: secret, color: '#1231f0', attachment }),
    new Map([
      [author.uid, await author.keyWith(author.uid, author.identity.publicKey)],
      [viewer.uid, await author.keyWith(viewer.uid, viewer.identity.publicKey)],
    ])
  );

  const published = await publishStatus(author, payload, [viewer.uid]);
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.equal(published.reached, 1);

  await sleep(80);
  assert.equal(viewer.statusFeed.length, 1);
  const decoded = JSON.parse(
    await decryptMessage(viewer.statusFeed[0].payload, viewer.uid, await viewer.keyWith(author.uid, author.identity.publicKey))
  );
  assert.equal(decoded.text, secret);
  assert.equal(decoded.color, '#1231f0');
  assert.equal(decoded.attachment.key, 'kunci-file');
  assert.equal(decoded.attachment.name, 'pantai.png');

  // What the server holds is only the sealed blob.
  assert.equal(
    JSON.stringify([...statuses.entries()]).includes('lagi di Jakarta'),
    false,
    'isi status bocor ke memori server'
  );

  // Somebody else's status is not theirs to delete.
  const stranger = await new Client('tami').init();
  const refused = await removeStatus(stranger, published.id);
  assert.equal(refused.ok, false);
  assert.equal(statuses.has(published.id), true);

  // The author can, and the audience is told about it.
  assert.equal((await removeStatus(author, published.id)).ok, true);
  await sleep(80);
  assert.equal(statuses.has(published.id), false);
  assert.equal(viewer.removedStatuses.length, 1);
  assert.equal(viewer.removedStatuses[0].id, published.id);

  author.close();
  viewer.close();
  stranger.close();
});

test('a status is delivered on connect, and one older than a day is dropped', async () => {
  const author = await new Client('umar').init();
  const payload = await encryptMessage(
    'status pendek',
    new Map([[author.uid, await author.keyWith(author.uid, author.identity.publicKey)]])
  );

  const published = await publishStatus(author, payload, []);
  assert.equal(published.ok, true);

  // The author is part of the audience, so their own status comes back on the
  // next connection instead of living only in the tab that published it.
  const reopened = await new Client('umar', { identity: author.identity }).init();
  assert.equal(reopened.ready.statuses.some((status) => status.id === published.id), true);

  // Age it past the 24 hour window: it must be pruned, not merely hidden.
  statuses.get(published.id).at = Date.now() - 25 * 60 * 60 * 1000;
  const later = await new Client('umar', { identity: author.identity }).init();
  assert.equal(later.ready.statuses.some((status) => status.id === published.id), false);
  assert.equal(statuses.has(published.id), false);

  author.close();
  reopened.close();
  later.close();
});

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

const authHeader = (client) => ({ authorization: `Bearer ${client.token}` });

test('an encrypted attachment survives upload, download and decryption', async () => {
  const alice = await new Client('alice5').init();
  const bob = await new Client('bob5').init();
  await sleep(50);

  const original = new Uint8Array(300_000).map((_, i) => (i * 13 + 5) % 256);
  const source = new Blob([original]);
  const { blob: sealed, meta } = await encryptFile(source);

  const target = await fetch(`${BASE_URL}/api/attachments/request-upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader(alice) },
    body: JSON.stringify({ size: sealed.size }),
  }).then((r) => r.json());
  assert.ok(target.path, JSON.stringify(target));

  const put = await fetch(new URL(target.url, BASE_URL), {
    method: 'PUT',
    headers: { ...authHeader(alice), 'content-type': 'application/octet-stream' },
    body: sealed,
  });
  assert.equal(put.status, 204);

  // The attachment key travels inside the E2EE message, never via storage.
  const attachment = {
    path: target.path,
    fileId: meta.fileId,
    totalChunks: meta.totalChunks,
    key: meta.key,
    name: 'rahasia.bin',
    size: source.size,
    mime: 'application/octet-stream',
  };
  const key = await alice.keyWith(bob.uid, bob.identity.publicKey);
  await alice.send({
    roomId: `dm:${alice.uid}:${bob.uid}`,
    members: [alice.uid, bob.uid],
    text: '',
    attachment,
    keys: new Map([
      [alice.uid, key],
      [bob.uid, key],
    ]),
  });
  await sleep(80);

  const bobKey = await bob.keyWith(alice.uid, alice.identity.publicKey);
  const decoded = JSON.parse(await decryptMessage(bob.inbox[0].payload, bob.uid, bobKey));
  assert.equal(decoded.attachment.name, 'rahasia.bin');
  assert.equal(decoded.attachment.key, meta.key);

  const link = await fetch(`${BASE_URL}/api/attachments/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader(bob) },
    body: JSON.stringify({ path: decoded.attachment.path }),
  }).then((r) => r.json());

  const downloaded = await fetch(new URL(link.url, BASE_URL), { headers: authHeader(bob) }).then((r) => r.blob());
  assert.equal(downloaded.size, sealed.size);

  const plain = await decryptFile(downloaded, decoded.attachment);
  assert.equal(await sha256(plain), await sha256(source));

  alice.close();
  bob.close();
});

test('the stored blob is ciphertext, and its path is unguessable', async () => {
  const alice = await new Client('alice6').init();

  const source = new Blob([new TextEncoder().encode('ISI_DOKUMEN_SANGAT_RAHASIA '.repeat(50))]);
  const { blob: sealed, meta } = await encryptFile(source);

  const target = await fetch(`${BASE_URL}/api/attachments/request-upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader(alice) },
    body: JSON.stringify({ size: sealed.size }),
  }).then((r) => r.json());

  await fetch(new URL(target.url, BASE_URL), {
    method: 'PUT',
    headers: { ...authHeader(alice), 'content-type': 'application/octet-stream' },
    body: sealed,
  });

  // Read it back through the same mapping the server used, so a divergence
  // between writer and reader would show up here as a failure.
  const onDisk = await fs.readFile(resolveLocalPath(TMP, target.path));
  assert.equal(onDisk.includes('ISI_DOKUMEN'), false);
  assert.match(target.path, /^att\/\d{4}\/\d{2}\/[A-Za-z0-9_-]+\/[a-f0-9]{32}$/);
  assert.ok(meta.key, 'kunci file harus ada, tapi cuma dikirim lewat pesan terenkripsi');

  alice.close();
});

test('attachments require a valid token', async () => {
  const anon = await fetch(`${BASE_URL}/api/attachments/request-upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size: 10 }),
  });
  assert.equal(anon.status, 401);

  const badToken = await fetch(`${BASE_URL}/api/attachments/request-upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
    body: JSON.stringify({ size: 10 }),
  });
  assert.equal(badToken.status, 401);
});

test('oversized uploads and hostile paths are refused', async () => {
  const alice = await new Client('alice7').init();

  const tooBig = await fetch(`${BASE_URL}/api/attachments/request-upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader(alice) },
    body: JSON.stringify({ size: 5_000_000_000 }),
  });
  assert.equal(tooBig.status, 413);

  const traversal = await fetch(`${BASE_URL}/api/attachments/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader(alice) },
    body: JSON.stringify({ path: '../../etc/passwd' }),
  });
  assert.equal(traversal.status, 400);

  alice.close();
});

/* ------------------------------------------------------------------ *
 * Foto profil
 * ------------------------------------------------------------------ */

const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARAAH/wAB/9p9AAAAAElFTkSuQmCC',
  'base64'
);

test('a profile photo is stored, served back to anybody, and can be deleted', async () => {
  const alice = await new Client('alice11').init();

  const upload = await fetch(`${BASE_URL}/api/profile/avatar`, {
    method: 'POST',
    headers: { ...authHeader(alice), 'content-type': 'image/png' },
    body: png1x1,
  });
  // Read the body once: the assertion message would consume it otherwise.
  const body = await upload.text();
  assert.equal(upload.status, 200, body);
  const { photoURL } = JSON.parse(body);
  assert.match(photoURL, /^\/api\/avatar\//);

  // Anyone can load it — that is the point of a profile photo.
  const served = await fetch(new URL(photoURL, BASE_URL));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await served.arrayBuffer()).equals(png1x1), true);

  // Contacts pick it up from the directory without asking for anything extra.
  const viewer = await new Client('bob11').init();
  const seen = viewer.ready.directory.find((entry) => entry.uid === alice.uid);
  assert.match(seen.photoURL, /^\/api\/avatar\//);

  const removed = await fetch(`${BASE_URL}/api/profile/avatar`, {
    method: 'DELETE',
    headers: authHeader(alice),
  });
  assert.equal(removed.status, 200);
  assert.equal(await fetch(new URL(photoURL, BASE_URL)).then((r) => r.status), 404);

  alice.close();
  viewer.close();
});

test('a profile photo must be a real image of a sane size, and come from a real account', async () => {
  const alice = await new Client('alice12').init();

  const anonymous = await fetch(`${BASE_URL}/api/profile/avatar`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: png1x1,
  });
  assert.equal(anonymous.status, 401);

  // A png content-type header is not enough: the bytes are what count.
  const liar = await fetch(`${BASE_URL}/api/profile/avatar`, {
    method: 'POST',
    headers: { ...authHeader(alice), 'content-type': 'image/png' },
    body: Buffer.from('sebenarnya cuma teks biasa, bukan gambar sama sekali'),
  });
  assert.equal(liar.status, 415);

  const huge = await fetch(`${BASE_URL}/api/profile/avatar`, {
    method: 'POST',
    headers: { ...authHeader(alice), 'content-type': 'image/jpeg' },
    body: Buffer.alloc(2_500_000, 7),
  });
  assert.equal(huge.status, 413);

  alice.close();
});

/* ------------------------------------------------------------------ *
 * Calls
 * ------------------------------------------------------------------ */

test('call signaling relays between the two parties only', async () => {
  const alice = await new Client('alice8').init();
  const bob = await new Client('bob8').init();
  const eve = await new Client('eve8').init();
  await sleep(50);

  const invite = await alice.signal('call:invite', { toUid: bob.uid, video: true });
  assert.equal(invite.ok, true);

  await sleep(60);
  const incoming = bob.received('call:incoming');
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].from.uid, alice.uid);
  assert.equal(incoming[0].video, true);
  const callId = invite.callId;

  // A third party who learns the call id still cannot inject signaling.
  await eve.signal('call:signal', { callId, toUid: alice.uid, data: { type: 'ice', candidate: { fake: true } } });
  await sleep(60);
  assert.equal(alice.received('call:signal').length, 0);
  assert.equal(bob.received('call:signal').length, 0);

  await bob.signal('call:accept', { callId, toUid: alice.uid });
  await sleep(60);
  assert.equal(alice.received('call:accepted').length, 1);

  await alice.signal('call:signal', { callId, toUid: bob.uid, data: { type: 'description', sdp: 'v=0' } });
  await sleep(60);
  const relayed = bob.received('call:signal');
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].from, alice.uid);
  assert.equal(relayed[0].data.sdp, 'v=0');

  await alice.signal('call:end', { callId, toUid: bob.uid });
  await sleep(60);
  assert.equal(bob.received('call:ended').length, 1);
  assert.equal(calls.size, 0, 'panggilan harus dibersihkan');

  alice.close();
  bob.close();
  eve.close();
});

test('an account the server has never seen cannot be called', async () => {
  const alice = await new Client('alice9').init();
  const invite = await alice.signal('call:invite', { toUid: 'u-ghost', video: false });
  assert.equal(invite.ok, false);
  assert.match(invite.error, /tidak ditemukan/i);
  alice.close();
});

test('a call to someone offline still rings, and reaches them when they reconnect', async () => {
  const alice = await new Client('alice11').init();
  // Bob pernah masuk, jadi server mengenal akunnya walau sekarang offline.
  const bob = await new Client('bob11').init();
  bob.close();
  await sleep(120);

  const invite = await alice.signal('call:invite', { toUid: bob.uid, video: false });
  assert.equal(invite.ok, true, 'offline bukan alasan untuk menolak panggilan');

  const back = await new Client('bob11').init();
  await sleep(150);
  const incoming = back.received('call:incoming');
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].callId, invite.callId);
  assert.equal(incoming[0].from.uid, alice.uid);

  await back.signal('call:accept', { callId: invite.callId });
  await sleep(80);
  assert.equal(alice.received('call:member-joined').length, 1);

  await alice.signal('call:end', { callId: invite.callId });
  await sleep(80);
  back.close();
  alice.close();
});

test('a third person can be added to a running call', async () => {
  const alice = await new Client('alice12').init();
  const bob = await new Client('bob12').init();
  const carol = await new Client('carol12').init();
  await sleep(50);

  const invite = await alice.signal('call:invite', { toUid: bob.uid, video: false });
  await bob.signal('call:accept', { callId: invite.callId });
  await sleep(80);

  const added = await alice.signal('call:invite', {
    callId: invite.callId,
    toUid: carol.uid,
    video: false,
  });
  assert.equal(added.ok, true);
  await sleep(80);
  assert.equal(carol.received('call:incoming').length, 1);

  await carol.signal('call:accept', { callId: invite.callId });
  await sleep(100);

  assert.equal(alice.received('call:member-joined').at(-1).member.uid, carol.uid);
  assert.equal(bob.received('call:member-joined').at(-1).member.uid, carol.uid);
  const roster = carol.received('call:joined')[0];
  assert.equal(roster.members.length, 3, 'yang baru masuk harus melihat semua anggota');

  // Carol keluar, panggilan Alice–Bob tetap berjalan.
  await carol.signal('call:leave', { callId: invite.callId });
  await sleep(80);
  assert.equal(alice.received('call:member-left').length, 1);
  assert.equal(calls.size, 1, 'sisa anggota masih di panggilan');

  await alice.signal('call:end', { callId: invite.callId });
  await sleep(80);
  carol.close();
  bob.close();
  alice.close();
});

test('a second call to someone already on a call is refused as busy', async () => {
  const alice = await new Client('alice13').init();
  const bob = await new Client('bob13').init();
  const carol = await new Client('carol13').init();
  await sleep(50);

  const invite = await alice.signal('call:invite', { toUid: bob.uid, video: false });
  await bob.signal('call:accept', { callId: invite.callId });
  await sleep(80);

  const busy = await carol.signal('call:invite', { toUid: bob.uid, video: false });
  assert.equal(busy.ok, false);
  assert.equal(busy.busy, true);
  assert.match(busy.error, /panggilan yang sedang berlangsung/i);

  const logs = carol.received('call:log');
  assert.equal(logs.at(-1).kind, 'busy', 'pemanggil dapat catatan chat bahwa lawannya sedang menelepon');

  await alice.signal('call:end', { callId: invite.callId });
  await sleep(80);
  carol.close();
  bob.close();
  alice.close();
});

test('a rejected call leaves a missed-call log for both sides', async () => {
  const alice = await new Client('alice14').init();
  const bob = await new Client('bob14').init();
  await sleep(50);

  const invite = await alice.signal('call:invite', { toUid: bob.uid, video: true });
  await bob.signal('call:reject', { callId: invite.callId });
  await sleep(100);

  const aliceLog = alice.received('call:log').at(-1);
  const bobLog = bob.received('call:log').at(-1);
  assert.equal(aliceLog.kind, 'missed');
  assert.equal(aliceLog.video, true);
  assert.equal(bobLog.kind, 'missed');
  assert.equal(bobLog.from.uid, bob.uid, 'arah masuk/keluar dihitung dari pengirim catatan');
  assert.equal(calls.size, 0);

  bob.close();
  alice.close();
});

test('a browser can register and drop its call push subscription', async () => {
  const alice = await new Client('alice16').init();
  const token = makeDevToken({ uid: alice.uid, displayName: alice.name });
  const subscription = {
    endpoint: 'https://push.example.com/call/alice16',
    keys: { p256dh: 'p'.repeat(64), auth: 'a'.repeat(16) },
  };

  const config = await fetch(`${BASE_URL}/config.json`).then((res) => res.json());
  assert.equal(typeof config.calls.pushPublicKey, 'string', 'kunci publik VAPID harus dibagikan');

  const subscribe = await fetch(`${BASE_URL}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ subscription }),
  });
  assert.equal(subscribe.status, 200);
  assert.equal(push.has(alice.uid), true, 'langganan harus tersimpan per akun');

  const invalid = await fetch(`${BASE_URL}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ subscription: { endpoint: 'http://bukan-https', keys: {} } }),
  });
  assert.equal(invalid.status, 400, 'endpoint yang tidak masuk akal ditolak');

  const drop = await fetch(`${BASE_URL}/api/push/unsubscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  assert.equal(drop.status, 200);
  assert.equal(push.has(alice.uid), false);

  alice.close();
});

test('a finished call records how long it lasted', async () => {
  const alice = await new Client('alice15').init();
  const bob = await new Client('bob15').init();
  await sleep(50);

  const invite = await alice.signal('call:invite', { toUid: bob.uid, video: false });
  await bob.signal('call:accept', { callId: invite.callId });
  await sleep(1100);
  await alice.signal('call:end', { callId: invite.callId });
  await sleep(100);

  for (const client of [alice, bob]) {
    const log = client.received('call:log').at(-1);
    assert.equal(log.kind, 'answered');
    assert.ok(log.duration >= 1, `durasi harus tercatat, dapat ${log.duration}`);
  }

  bob.close();
  alice.close();
});

test('hanging up or disconnecting ends the call for the other side', async () => {
  const alice = await new Client('alice10').init();
  const bob = await new Client('bob10').init();
  await sleep(50);

  const invite = await alice.signal('call:invite', { toUid: bob.uid, video: false });
  await bob.signal('call:accept', { callId: invite.callId, toUid: alice.uid });
  await sleep(60);

  bob.close();
  await sleep(200);

  const ended = alice.received('call:ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, 'disconnected');
  assert.equal(calls.size, 0);

  alice.close();
});

/* ------------------------------------------------------------------ *
 * Cari kontak
 * ------------------------------------------------------------------ */

test('a contact is found by username, email, or phone — and while offline', async () => {
  const seeker = await new Client('seeker').init();
  const target = await new Client('target', {
    // Email dan nomor HP datang dari penyedia login, jadi di sini dibuat lewat
    // token dev yang sudah diverifikasi server.
    token: makeDevToken({
      uid: 'u-target',
      displayName: 'target',
      email: 'Target.One@Example.com',
      phone: '+62 812-3456-789',
    }),
  }).init();
  await sleep(60);

  // Empat ejaan berbeda, satu orang yang sama — dan alasannya ikut dilaporkan.
  const queries = [
    ['target', 'username'],
    ['@target', 'username'],
    ['target.one@example.com', 'email'],
    ['08123456789', 'phone'],
  ];
  for (const [query, via] of queries) {
    const result = await seeker.lookup(query);
    assert.equal(result.ok, true, `${query}: ${result.error}`);
    assert.equal(result.results.length, 1, `${query} → ${JSON.stringify(result.results)}`);
    assert.equal(result.results[0].uid, 'u-target', query);
    assert.equal(result.results[0].username, 'target', query);
    assert.equal(result.results[0].foundVia, via, query);

    // Yang dipakai buat mencari tidak pernah ikut kembali: kalau nilainya
    // dikirim, kolom ini berubah jadi alat menebak alamat orang lain.
    const raw = JSON.stringify(result.results[0]);
    assert.equal(raw.includes('example.com'), false, `email bocor: ${raw}`);
    assert.equal(raw.includes('628123456789'), false, `nomor bocor: ${raw}`);
    assert.equal(raw.includes('publicKey'), false, 'kunci publik bukan urusan pencarian');
  }

  // Kueri yang terlalu pendek atau tidak jelas tidak memanggil apa pun.
  assert.equal((await seeker.lookup('ab')).ok, false, 'kueri 2 karakter harus ditolak');
  const nothing = await seeker.lookup('tidak.pernah.ada@contoh.id');
  assert.equal(nothing.ok, true);
  assert.deepEqual(nothing.results, []);

  // Orang yang sedang offline tetap bisa ditemukan, dan tetap tanpa kunci publik.
  target.close();
  await sleep(200);
  const offline = await seeker.lookup('target.one@example.com');
  assert.equal(offline.ok, true);
  assert.equal(offline.results.length, 1);
  assert.equal(offline.results[0].online, false);

  seeker.close();
});

test('the directory no longer broadcasts phone numbers to every client', async () => {
  const watcher = await new Client('watcher').init();
  const withPhone = await new Client('withphone', {
    token: makeDevToken({ uid: 'u-withphone', displayName: 'withphone', phone: '+628990001112' }),
  }).init();
  await sleep(80);

  const seen = watcher.directory.find((entry) => entry.uid === 'u-withphone');
  assert.ok(seen, 'akun itu harus muncul di direktori');
  assert.equal(seen.phone, undefined, 'nomor HP tidak boleh disiarkan lagi');
  assert.equal(JSON.stringify(watcher.directory).includes('8990001112'), false);

  // Server tetap menyimpannya — itu yang membuat pencarian bisa bekerja.
  assert.equal(accounts.get('u-withphone')?.phone, '+628990001112');

  watcher.close();
  withPhone.close();
});

/* ------------------------------------------------------------------ *
 * Laporan + halaman admin
 * ------------------------------------------------------------------ */

const adminPost = (client, route, body) =>
  fetch(`${BASE_URL}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader(client) },
    body: JSON.stringify(body),
  });

test('anyone can file a report, and a report blocks nobody by itself', async () => {
  const petugas = await new Client('petugas').init();
  const pelapor = await new Client('pelapor').init();
  const nakal = await new Client('nakal').init();
  await sleep(60);

  const filed = await pelapor.report({
    uid: nakal.uid,
    reason: 'spam',
    detail: 'kirim link iklan terus-terusan',
    roomId: 'dm:uji',
  });
  assert.equal(filed.ok, true, filed.error);

  // Alasan tidak dikenal, laporan ke diri sendiri, dan akun asing ditolak.
  assert.equal((await pelapor.report({ uid: nakal.uid, reason: 'ngawur' })).ok, false);
  assert.equal((await pelapor.report({ uid: pelapor.uid, reason: 'spam' })).ok, false, 'lapor diri sendiri');
  assert.equal((await pelapor.report({ uid: 'u-hantu', reason: 'spam' })).ok, false, 'akun asing');
  // Laporan yang masih terbuka untuk orang yang sama tidak perlu ditumpuk.
  const duplicate = await pelapor.report({ uid: nakal.uid, reason: 'kasar' });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /masih diproses/i);

  // Laporan tidak memblokir siapa pun: itu keputusan terpisah.
  assert.equal(moderation.isBanned(nakal.uid), false);
  const key = await nakal.keyWith(nakal.uid, nakal.identity.publicKey);
  const stillFine = await nakal.send({
    roomId: 'dm:nakal',
    members: [nakal.uid],
    text: 'masih bisa kirim',
    keys: new Map([[nakal.uid, key]]),
  });
  assert.equal(stillFine.ack.ok, true);

  // Halaman admin cuma untuk admin — periksa keduanya, bukan cuma yang berhasil.
  const asPelapor = await fetch(`${BASE_URL}/api/admin/overview`, { headers: authHeader(pelapor) });
  assert.equal(asPelapor.status, 403);

  const overview = await fetch(`${BASE_URL}/api/admin/overview`, { headers: authHeader(petugas) }).then((r) =>
    r.json()
  );
  assert.equal(overview.stats.open, 1, JSON.stringify(overview.stats));

  const report = overview.reports[0];
  assert.equal(report.reason, 'spam');
  assert.equal(report.reasonLabel, 'Spam atau iklan');
  assert.equal(report.detail, 'kirim link iklan terus-terusan');
  assert.equal(report.from, pelapor.uid);
  assert.equal(report.fromName, 'pelapor');
  assert.equal(report.about, nakal.uid);
  assert.equal(report.aboutName, 'nakal');
  assert.equal(report.status, 'open');

  // Daftar pengguna di halaman admin memuat akun yang dilaporkan.
  const listed = overview.users.find((user) => user.uid === nakal.uid);
  assert.ok(listed, 'akun yang dilaporkan harus ada di daftar pengguna');
  assert.equal(listed.banned, false);

  // Menandai selesai: siapa yang menangani dan kapan, dicatat.
  const handled = await adminPost(petugas, '/api/admin/report', { id: report.id, status: 'resolved' }).then((r) =>
    r.json()
  );
  assert.equal(handled.ok, true);
  assert.equal(handled.report.status, 'resolved');
  assert.equal(handled.report.handledBy, 'u-petugas');
  assert.ok(handled.report.handledAt);
  assert.equal(moderation.openReportCount(), 0);

  const badStatus = await adminPost(petugas, '/api/admin/report', { id: report.id, status: 'entah' });
  assert.equal(badStatus.status, 400);

  petugas.close();
  pelapor.close();
  nakal.close();
});

test('a banned account is cut off everywhere, and unbanning gives it back', async () => {
  const petugas = await new Client('petugas').init();
  const korban = await new Client('korban').init();
  await sleep(60);

  const banned = await adminPost(petugas, '/api/admin/ban', { uid: korban.uid, reason: 'nyebar link' }).then((r) =>
    r.json()
  );
  assert.equal(banned.ok, true, JSON.stringify(banned));
  assert.equal(banned.ban.reason, 'nyebar link');
  assert.equal(moderation.isBanned(korban.uid), true);

  // Sesi yang sedang jalan diberi tahu alasannya, bukan cuma diputus diam-diam.
  await sleep(250);
  assert.equal(korban.bannedNotices.length, 1, JSON.stringify(korban.bannedNotices));
  assert.equal(korban.bannedNotices[0].reason, 'nyebar link');
  assert.equal(directory.get(korban.uid)?.socketId, null, 'socket-nya harus dilepas');
  korban.close();

  // Endpoint REST ikut tertutup, bukan cuma socket-nya.
  const avatarAttempt = await fetch(`${BASE_URL}/api/profile/avatar`, {
    method: 'POST',
    headers: { ...authHeader(korban), 'content-type': 'image/png' },
    body: png1x1,
  });
  assert.equal(avatarAttempt.status, 403);
  const body = await avatarAttempt.json();
  assert.equal(body.banned, true);
  assert.equal(body.reason, 'nyebar link');

  // Dan dia tidak bisa masuk lagi selama blokirnya berlaku.
  const again = new Client('korban', { identity: korban.identity });
  await assert.rejects(() => again.init(), /diblokir/);
  again.close();

  // Admin sendiri tidak bisa diblokir dari halaman admin.
  const selfBan = await adminPost(petugas, '/api/admin/ban', { uid: 'u-petugas' });
  assert.equal(selfBan.status, 400);
  const selfUnban = await adminPost(petugas, '/api/admin/unban', { uid: 'u-petugas' }).then((r) => r.json());
  assert.equal(selfUnban.removed, false);

  // Membuka blokir mengembalikan akunnya, lengkap dengan username lamanya.
  const unbanned = await adminPost(petugas, '/api/admin/unban', { uid: korban.uid }).then((r) => r.json());
  assert.equal(unbanned.removed, true);

  const back = await new Client('korban', { identity: korban.identity }).init();
  assert.equal(back.ready.username, 'korban');

  petugas.close();
  back.close();
});

/* ------------------------------------------------------------------ *
 * Notifikasi: aset yang harus bisa diambil browser
 * ------------------------------------------------------------------ */

test('aset notifikasi disajikan apa adanya: manifest, service worker, modulnya', async () => {
  const manifest = await fetch(`${BASE_URL}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  const parsed = JSON.parse(await manifest.text());
  assert.equal(parsed.name, 'By Chat');
  assert.equal(parsed.start_url, '/');
  assert.equal(parsed.scope, '/');
  assert.ok(parsed.icons.some((icon) => icon.src === '/assets/logo.svg'), JSON.stringify(parsed.icons));

  // Service worker harus dilayani dari akar situs: dari subfolder scope-nya
  // tidak akan mencakup aplikasinya.
  const sw = await fetch(`${BASE_URL}/sw.js`);
  assert.equal(sw.status, 200);
  const swSource = await sw.text();
  assert.match(swSource, /notificationclick/);
  assert.match(swSource, /bychat:notification/);

  const module = await fetch(`${BASE_URL}/js/notifications.js`);
  assert.equal(module.status, 200);
  const moduleSource = await module.text();
  assert.match(moduleSource, /requestPermission/);

  const html = await fetch(`${BASE_URL}/`).then((res) => res.text());
  assert.match(html, /rel="manifest"/);
});

/* ------------------------------------------------------------------ *
 * Akun username + kata sandi
 * ------------------------------------------------------------------ */

test('daftar lalu masuk dengan kata sandi: tokennya diterima socket', async () => {
  const post = async (path, body) => {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  // Belum didaftarkan berarti tidak bisa masuk, dengan alasan yang jelas.
  const unknown = await post('/api/auth/login', { username: 'belum.ada', password: 'rahasia123' });
  assert.equal(unknown.status, 401);
  assert.match(unknown.body.error, /belum terdaftar/i);

  const created = await post('/api/auth/register', { username: 'sandi.budi', password: 'rahasia123' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.username, 'sandi.budi');

  // Nama yang sama tidak bisa didaftarkan dua kali (besar/kecil diabaikan).
  const duplicate = await post('/api/auth/register', { username: 'SandiBudi', password: 'rahasia123' });
  // 409 kalau namanya sudah dipakai sebagai @username, 400 kalau sudah ada
  // akunnya tapi klaim @-nya belum sempat tersimpan. Dua-duanya penolakan.
  assert.ok([400, 409].includes(duplicate.status), String(duplicate.status));
  assert.match(duplicate.body.error, /sudah terdaftar|sudah dipakai/i);

  const wrong = await post('/api/auth/login', { username: 'sandi.budi', password: 'salah-banget' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body.error, /salah/i);

  const login = await post('/api/auth/login', { username: 'sandi.budi', password: 'rahasia123' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.match(login.body.token, /^sess\./);
  assert.match(login.body.profile.uid, /^pw-/);

  // Token itu benar-benar dipakai seperti token login lain: socket tersambung
  // dan username-nya sudah diklaim saat pendaftaran.
  const identity = await generateIdentity();
  const socket = ioClient(BASE_URL, {
    transports: ['websocket'],
    forceNew: true,
    auth: { token: login.body.token, publicKey: identity.publicKey },
  });
  sockets.push(socket);
  const ready = await new Promise((resolve, reject) => {
    socket.once('ready', resolve);
    socket.once('connect_error', (err) => reject(new Error(err.message)));
    setTimeout(() => reject(new Error('timeout menunggu ready')), 5000);
  });
  assert.equal(ready.profile.uid, login.body.profile.uid);
  assert.equal(ready.username, 'sandi.budi');
  socket.close();

  // Token yang diubah satu karakter tidak boleh diterima.
  const forged = ioClient(BASE_URL, {
    transports: ['websocket'],
    forceNew: true,
    auth: { token: `${login.body.token}x`, publicKey: identity.publicKey },
  });
  sockets.push(forged);
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        forged.once('ready', resolve);
        forged.once('connect_error', (err) => reject(new Error(err.message)));
        setTimeout(() => reject(new Error('timeout: token palsu diterima')), 5000);
      }),
    /Tidak terautentikasi/
  );
  forged.close();
});
