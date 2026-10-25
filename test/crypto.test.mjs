import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateIdentity,
  importPrivateKey,
  deriveSharedKey,
  encryptMessage,
  decryptMessage,
  encryptFile,
  decryptFile,
  decryptFileChunks,
  FILE_CHUNK_SIZE,
  safetyNumber,
  dmRoomId,
  b64,
  unb64,
} from '../public/js/crypto.js';

const sha256 = async (blob) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())).toString('hex');

async function pair(a, b) {
  const idA = await generateIdentity();
  const idB = await generateIdentity();
  const keyA = await deriveSharedKey(
    await importPrivateKey(idA.privateKey),
    idB.publicKey,
    a,
    b
  );
  const keyB = await deriveSharedKey(
    await importPrivateKey(idB.privateKey),
    idA.publicKey,
    b,
    a
  );
  return { idA, idB, keyA, keyB };
}

test('base64 round-trips arbitrary bytes', () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255, 42, 7]);
  assert.deepEqual(Array.from(unb64(b64(bytes))), Array.from(bytes));
  const big = new Uint8Array(200_000).map((_, i) => i % 256);
  assert.deepEqual(Array.from(unb64(b64(big))), Array.from(big));
});

test('both sides derive the same shared key', async () => {
  const { keyA, keyB } = await pair('alice', 'bob');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(12) },
    keyA,
    new TextEncoder().encode('ping')
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(12) },
    keyB,
    ciphertext
  );
  assert.equal(new TextDecoder().decode(plain), 'ping');
});

test('a message decrypts for every recipient and for the sender', async () => {
  const idA = await generateIdentity();
  const idB = await generateIdentity();
  const idC = await generateIdentity();

  const fromA = {
    alice: await deriveSharedKey(await importPrivateKey(idA.privateKey), idA.publicKey, 'alice', 'alice'),
    bob: await deriveSharedKey(await importPrivateKey(idA.privateKey), idB.publicKey, 'alice', 'bob'),
    carol: await deriveSharedKey(await importPrivateKey(idA.privateKey), idC.publicKey, 'alice', 'carol'),
  };

  const payload = await encryptMessage('rahasia grup 🔐', new Map(Object.entries(fromA)));

  const keyForB = await deriveSharedKey(await importPrivateKey(idB.privateKey), idA.publicKey, 'alice', 'bob');
  const keyForC = await deriveSharedKey(await importPrivateKey(idC.privateKey), idA.publicKey, 'alice', 'carol');

  assert.equal(await decryptMessage(payload, 'bob', keyForB), 'rahasia grup 🔐');
  assert.equal(await decryptMessage(payload, 'carol', keyForC), 'rahasia grup 🔐');
  assert.equal(await decryptMessage(payload, 'alice', fromA.alice), 'rahasia grup 🔐');
});

test('the envelope the server sees contains no plaintext', async () => {
  const { idA, idB } = await pair('alice', 'bob');
  const key = await deriveSharedKey(await importPrivateKey(idA.privateKey), idB.publicKey, 'alice', 'bob');
  const payload = await encryptMessage('nomor rahasia 08123456789', new Map([['bob', key]]));

  const asSeenByServer = JSON.stringify(payload);
  assert.ok(!asSeenByServer.includes('nomor rahasia'));
  assert.ok(!asSeenByServer.includes('0812'));
  assert.match(payload.ct, /^[A-Za-z0-9+/=]+$/);
});

test('an outsider cannot decrypt, and cannot forge keys for themselves', async () => {
  const { idA, idB } = await pair('alice', 'bob');
  const eve = await generateIdentity();

  const keyAB = await deriveSharedKey(await importPrivateKey(idA.privateKey), idB.publicKey, 'alice', 'bob');
  const payload = await encryptMessage('pesan privat', new Map([['bob', keyAB]]));

  // Eve has no entry in keys{}, so the payload is not addressed to her at all.
  const eveKey = await deriveSharedKey(await importPrivateKey(eve.privateKey), idA.publicKey, 'eve', 'alice');
  await assert.rejects(() => decryptMessage(payload, 'eve', eveKey), /tidak ditujukan/);

  // Even if she invents a name entry, she lacks the shared secret.
  const forged = { ...payload, keys: { ...payload.keys, eve: payload.keys.bob } };
  await assert.rejects(() => decryptMessage(forged, 'eve', eveKey));
});

test('tampering with the ciphertext is detected', async () => {
  const { idA, idB } = await pair('alice', 'bob');
  const key = await deriveSharedKey(await importPrivateKey(idA.privateKey), idB.publicKey, 'alice', 'bob');
  const payload = await encryptMessage('transfer 100rb', new Map([['bob', key]]));

  const bytes = unb64(payload.ct);
  bytes[0] ^= 0x01;
  await assert.rejects(() => decryptMessage({ ...payload, ct: b64(bytes) }, 'bob', key));
});

test('safety number is identical on both devices', async () => {
  const idA = await generateIdentity();
  const idB = await generateIdentity();
  const a = { username: 'alice', publicKey: idA.publicKey };
  const b = { username: 'bob', publicKey: idB.publicKey };

  assert.equal(await safetyNumber(a, b), await safetyNumber(b, a));

  const other = await generateIdentity();
  assert.notEqual(
    await safetyNumber(a, { username: 'bob', publicKey: other.publicKey }),
    await safetyNumber(a, b)
  );
});

test('dm room ids are stable regardless of who opens the chat', () => {
  assert.equal(dmRoomId('alice', 'bob'), dmRoomId('bob', 'alice'));
  assert.notEqual(dmRoomId('alice', 'bob'), dmRoomId('alice', 'carol'));
});

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

const bytesOf = (size) => new Uint8Array(size).map((_, i) => (i * 7 + 11) % 251);

for (const [label, size] of [
  ['a tiny file', 37],
  ['exactly one chunk', FILE_CHUNK_SIZE],
  ['two chunks and a bit', FILE_CHUNK_SIZE * 2 + 1234],
]) {
  test(`file encryption round-trips ${label}`, async () => {
    const data = bytesOf(size);
    const { blob, meta } = await encryptFile(new Blob([data]));
    assert.equal(meta.totalChunks, Math.ceil(size / FILE_CHUNK_SIZE));
    assert.equal(blob.size, size + meta.totalChunks * 16); // one GCM tag per chunk

    const plain = await decryptFile(blob, meta);
    assert.equal(await sha256(plain), await sha256(new Blob([data])));
  });
}

test('streaming decryption yields the same bytes before the whole file arrives', async () => {
  const size = FILE_CHUNK_SIZE * 2 + 1234;
  const data = bytesOf(size);
  const { blob, meta } = await encryptFile(new Blob([data]));
  const raw = new Uint8Array(await blob.arrayBuffer());

  // Potongan jaringan jarang pas satu chunk: pakai 777 byte supaya batas
  // chunk harus disatukan lagi oleh dekriptor.
  const stream = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < raw.length; offset += 777) {
        controller.enqueue(raw.subarray(offset, Math.min(raw.length, offset + 777)));
      }
      controller.close();
    },
  });

  const parts = [];
  for await (const part of decryptFileChunks(stream, meta)) parts.push(part);
  assert.equal(parts.length, meta.totalChunks);
  assert.equal(await sha256(new Blob(parts)), await sha256(new Blob([data])));
});

test('streaming decryption rejects a truncated stream', async () => {
  const { blob, meta } = await encryptFile(new Blob([bytesOf(FILE_CHUNK_SIZE * 2)]));
  const raw = new Uint8Array(await blob.arrayBuffer());
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(raw.slice(0, FILE_CHUNK_SIZE + 16));
      controller.close();
    },
  });

  await assert.rejects(async () => {
    for await (const _ of decryptFileChunks(stream, meta)) {
      /* drain */
    }
  });
});

test('the uploaded blob never contains the file bytes', async () => {
  const data = new TextEncoder().encode('RAHASIA_PERUSAHAAN_2026 '.repeat(500));
  const { blob } = await encryptFile(new Blob([data]));
  const ciphertext = Buffer.from(await blob.arrayBuffer());
  assert.equal(ciphertext.includes('RAHASIA_PERUSAHAAN'), false);
});

test('a flipped byte in a file chunk is detected', async () => {
  const { blob, meta } = await encryptFile(new Blob([bytesOf(1000)]));
  const raw = new Uint8Array(await blob.arrayBuffer());
  raw[100] ^= 0x01;
  await assert.rejects(() => decryptFile(new Blob([raw]), meta));
});

test('truncating a file is detected, not silently accepted', async () => {
  const size = FILE_CHUNK_SIZE * 2 + 10;
  const { blob, meta } = await encryptFile(new Blob([bytesOf(size)]));
  const raw = new Uint8Array(await blob.arrayBuffer());
  const withoutLastChunk = raw.slice(0, FILE_CHUNK_SIZE + 16);
  await assert.rejects(() => decryptFile(new Blob([withoutLastChunk]), meta));
});

test('reordering file chunks is detected', async () => {
  const chunk = FILE_CHUNK_SIZE;
  const { blob, meta } = await encryptFile(new Blob([bytesOf(chunk * 2)]));
  const raw = new Uint8Array(await blob.arrayBuffer());
  const sealed = chunk + 16;
  const swapped = new Uint8Array(raw.length);
  swapped.set(raw.subarray(sealed, sealed * 2), 0);
  swapped.set(raw.subarray(0, sealed), sealed);
  await assert.rejects(() => decryptFile(new Blob([swapped]), meta));
});

test('each file gets its own key, so the same bytes encrypt differently', async () => {
  const data = new Blob([bytesOf(2048)]);
  const a = await encryptFile(data);
  const b = await encryptFile(data);
  assert.notEqual(a.meta.key, b.meta.key);
  assert.notEqual(a.meta.fileId, b.meta.fileId);
  assert.notEqual(await sha256(a.blob), await sha256(b.blob));
});
