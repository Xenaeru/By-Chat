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
process.env.PORT = process.env.TEST_PORT || '4399';

const {
  generateIdentity,
  importPrivateKey,
  deriveSharedKey,
  encryptMessage,
  decryptMessage,
  encryptFile,
  decryptFile,
} = await import('../public/crypto.js');
const { makeDevToken } = await import('../auth.js');
const { server, directory, inbox, calls } = await import('../server.js');
const { resolveLocalPath } = await import('../storage.js');

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
  constructor(name, { identity = null, token = null } = {}) {
    this.name = name;
    this.uid = `u-${name}`;
    this.identity = identity;
    this.tokenOverride = token;
    this.inbox = [];
    this.signals = [];
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
    for (const event of ['call:incoming', 'call:accepted', 'call:rejected', 'call:ended', 'call:signal']) {
      this.socket.on(event, (data) => this.signals.push({ event, data }));
    }

    this.ready = await new Promise((resolve, reject) => {
      this.socket.once('ready', resolve);
      this.socket.once('connect_error', (err) => reject(new Error(err.message)));
      setTimeout(() => reject(new Error('timeout menunggu ready')), 5000);
    });
    return this;
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
 * Attachments
 * ------------------------------------------------------------------ */

const authHeader = (client) => ({ authorization: `Bearer ${client.token}` });

test('an encrypted attachment survives upload, download and decryption', async () => {
  const alice = await new Client('a5').init();
  const bob = await new Client('b5').init();
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
  const alice = await new Client('a6').init();

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
  const alice = await new Client('a7').init();

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
 * Calls
 * ------------------------------------------------------------------ */

test('call signaling relays between the two parties only', async () => {
  const alice = await new Client('a8').init();
  const bob = await new Client('b8').init();
  const eve = await new Client('e8').init();
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

test('inviting someone offline fails instead of ringing forever', async () => {
  const alice = await new Client('a9').init();
  const invite = await alice.signal('call:invite', { toUid: 'u-ghost', video: false });
  assert.equal(invite.ok, false);
  assert.match(invite.error, /offline|tidak ditemukan/i);
  alice.close();
});

test('hanging up or disconnecting ends the call for the other side', async () => {
  const alice = await new Client('a10').init();
  const bob = await new Client('b10').init();
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
