/**
 * crypto.js — End-to-end encryption primitives.
 *
 * Design (Signal-style "sealed envelope" for a small app):
 *
 *   1. Every user owns an ECDH P-256 identity key pair. The private key never
 *      leaves the device; only the public key is published to the server.
 *   2. Two users turn their key pair + each other's public key into a shared
 *      AES-256-GCM key using ECDH -> HKDF-SHA256. The names are sorted before
 *      they go into the HKDF `info`, so both sides derive the *same* key.
 *   3. To send a message the client picks a random one-time "message key",
 *      encrypts the text once with it, then wraps that message key separately
 *      for every recipient. The server therefore only ever sees an opaque blob.
 *
 * This module is deliberately dependency-free and uses the standard WebCrypto
 * API, so the identical code runs in the browser and in Node for the tests.
 */

const te = new TextEncoder();
const td = new TextDecoder();

const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' };
const AES_PARAMS = { name: 'AES-GCM', length: 256 };
const HKDF_SALT = new Uint8Array(32);
const PROTOCOL_LABEL = 'secure-chat/v1';

export const toBytes = (s) => te.encode(s);
export const fromBytes = (b) => td.decode(b);

/* ------------------------------------------------------------------ *
 * Base64 + randomness helpers
 * ------------------------------------------------------------------ */

export function b64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  const CHUNK = 0x8000; // avoid blowing the argument limit on big buffers
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

export function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/* ------------------------------------------------------------------ *
 * Identity keys
 * ------------------------------------------------------------------ */

/** Create a fresh identity. Returns serialisable JWKs, never the CryptoKey. */
export async function generateIdentity() {
  const keyPair = await crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveBits']);
  return {
    publicKey: await crypto.subtle.exportKey('jwk', keyPair.publicKey),
    privateKey: await crypto.subtle.exportKey('jwk', keyPair.privateKey),
  };
}

export function importPrivateKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, ECDH_PARAMS, false, ['deriveBits']);
}

export function importPublicKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, ECDH_PARAMS, false, []);
}

/* ------------------------------------------------------------------ *
 * Shared secret derivation
 * ------------------------------------------------------------------ */

/**
 * Derive the pairwise AES key for `me` <-> `peer`.
 * Symmetric: deriveSharedKey(myPriv, peerPub, 'a', 'b') === deriveSharedKey(peerPriv, myPub, 'a', 'b')
 */
export async function deriveSharedKey(myPrivateKey, peerPublicJwk, me, peer) {
  const peerKey = await importPublicKey(peerPublicJwk);
  const secret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerKey },
    myPrivateKey,
    256
  );
  const hkdfKey = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const info = toBytes([PROTOCOL_LABEL, ...[me, peer].sort()].join('|'));
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info },
    hkdfKey,
    AES_PARAMS,
    false,
    ['encrypt', 'decrypt']
  );
}

/* ------------------------------------------------------------------ *
 * Message encryption
 * ------------------------------------------------------------------ */

/**
 * Encrypt `plaintext` for every recipient in `sharedKeys`.
 * @param {string} plaintext
 * @param {Map<string, CryptoKey>} sharedKeys username -> pairwise AES key
 * @returns {Promise<{v:number, iv:string, ct:string, keys:Record<string,{iv:string,k:string}>}>}
 */
export async function encryptMessage(plaintext, sharedKeys) {
  const messageKeyRaw = randomBytes(32);
  const messageKey = await crypto.subtle.importKey('raw', messageKeyRaw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, messageKey, toBytes(plaintext));

  const keys = {};
  for (const [username, shared] of sharedKeys) {
    const wrapIv = randomBytes(12);
    const wrapped = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: wrapIv },
      shared,
      messageKeyRaw
    );
    keys[username] = { iv: b64(wrapIv), k: b64(wrapped) };
  }

  return { v: 1, iv: b64(iv), ct: b64(ct), keys };
}

/**
 * Decrypt an envelope addressed to `me`, using the pairwise key we share with
 * the sender. Throws if we are not a recipient or the ciphertext was tampered with.
 */
export async function decryptMessage(payload, me, sharedKey) {
  const entry = payload?.keys?.[me];
  if (!entry) throw new Error('Pesan ini tidak ditujukan untuk kamu');

  const messageKeyRaw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(entry.iv) },
    sharedKey,
    unb64(entry.k)
  );
  const messageKey = await crypto.subtle.importKey('raw', messageKeyRaw, 'AES-GCM', false, [
    'decrypt',
  ]);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(payload.iv) },
    messageKey,
    unb64(payload.ct)
  );
  return fromBytes(plain);
}

/* ------------------------------------------------------------------ *
 * Safety number (WhatsApp-style key verification)
 * ------------------------------------------------------------------ */

/**
 * A short fingerprint of both identities. If two users read the same number on
 * their own devices, nobody swapped their public keys in transit.
 */
export async function safetyNumber(a, b) {
  const [first, second] = [a, b].sort((x, y) => (x.username < y.username ? -1 : 1));
  const material = [first, second]
    .map((p) => `${p.username}:${p.publicKey.x}.${p.publicKey.y}`)
    .join('|');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toBytes(material)));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 60).toUpperCase().match(/.{5}/g).join(' ');
}

/** Deterministic room id for a 1:1 conversation. */
export function dmRoomId(a, b) {
  return `dm:${[a, b].sort().join(':')}`;
}

/* ------------------------------------------------------------------ *
 * Attachment encryption
 *
 * Files are chunked so a huge upload never has to sit in memory whole and
 * decryption can start before the download finishes. Each chunk is sealed
 * with AES-GCM using the file's own random key. The IV is the chunk index,
 * which is safe because the key is used for exactly one file, and the chunk
 * index plus the total count go in as additional authenticated data so a
 * blob cannot be reordered or truncated undetected.
 * ------------------------------------------------------------------ */

export const FILE_CHUNK_SIZE = 4 * 1024 * 1024;
const GCM_TAG_BYTES = 16;

function chunkIv(index) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, index);
  return iv;
}

const chunkAad = (fileId, index, total) => toBytes(`${fileId}|${index}|${total}`);

/**
 * Encrypt a File/Blob. Returns the ciphertext blob plus the metadata that has
 * to travel inside the encrypted message (never through the storage server).
 */
export async function encryptFile(file, onProgress) {
  const rawKey = randomBytes(32);
  const fileKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const fileId = b64(randomBytes(16));
  const total = Math.max(1, Math.ceil(file.size / FILE_CHUNK_SIZE));

  const parts = [];
  for (let index = 0; index < total; index++) {
    const slice = file.slice(index * FILE_CHUNK_SIZE, (index + 1) * FILE_CHUNK_SIZE);
    const plain = await slice.arrayBuffer();
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: chunkIv(index), additionalData: chunkAad(fileId, index, total) },
      fileKey,
      plain
    );
    parts.push(new Uint8Array(sealed));
    onProgress?.((index + 1) / total);
  }

  return {
    blob: new Blob(parts),
    meta: { fileId, totalChunks: total, key: b64(rawKey) },
  };
}

/** Decrypt bytes produced by encryptFile back into a blob. */
export async function decryptFile(ciphertext, meta) {
  const fileKey = await crypto.subtle.importKey('raw', unb64(meta.key), 'AES-GCM', false, ['decrypt']);
  const sealedChunk = FILE_CHUNK_SIZE + GCM_TAG_BYTES;
  const parts = [];

  for (let index = 0; index < meta.totalChunks; index++) {
    const slice = ciphertext.slice(index * sealedChunk, (index + 1) * sealedChunk);
    const bytes = await slice.arrayBuffer();
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: chunkIv(index),
        additionalData: chunkAad(meta.fileId, index, meta.totalChunks),
      },
      fileKey,
      bytes
    );
    parts.push(new Uint8Array(plain));
  }

  return new Blob(parts);
}

/**
 * Decrypt a ReadableStream of ciphertext as it arrives. Each yielded value is
 * one decrypted chunk, so callers can start playing a video or showing an
 * image before the whole download has finished.
 */
export async function* decryptFileChunks(stream, meta) {
  const fileKey = await crypto.subtle.importKey('raw', unb64(meta.key), 'AES-GCM', false, ['decrypt']);
  const sealedChunk = FILE_CHUNK_SIZE + GCM_TAG_BYTES;
  const reader = stream.getReader();
  const parts = [];
  let pendingLength = 0;
  let index = 0;

  // Ambil tepat `size` byte dari antrean tanpa menyalin seluruh sisa unduhan
  // setiap kali potongan jaringan datang. Satu chunk yang utuh bisa langsung
  // dipakai sebagai subarray; potongan kecil baru digabung saat perlu.
  const take = (size) => {
    if (parts[0].length >= size) {
      const bytes = parts[0].subarray(0, size);
      parts[0] = parts[0].subarray(size);
      if (!parts[0].length) parts.shift();
      pendingLength -= size;
      return bytes;
    }

    const bytes = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const part = parts[0];
      const needed = size - filled;
      if (part.length <= needed) {
        bytes.set(part, filled);
        filled += part.length;
        parts.shift();
      } else {
        bytes.set(part.subarray(0, needed), filled);
        parts[0] = part.subarray(needed);
        filled += needed;
      }
    }
    pendingLength -= size;
    return bytes;
  };

  try {
    while (index < meta.totalChunks) {
      const { done, value } = await reader.read();
      if (value?.length) {
        parts.push(value);
        pendingLength += value.length;
      }

      while (index < meta.totalChunks && (pendingLength >= sealedChunk || done)) {
        const size = Math.min(pendingLength, sealedChunk);
        if (!size) throw new Error('Lampiran terpotong.');
        const bytes = take(size);
        const plain = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: chunkIv(index),
            additionalData: chunkAad(meta.fileId, index, meta.totalChunks),
          },
          fileKey,
          bytes
        );
        index++;
        yield new Uint8Array(plain);
      }

      if (done) {
        if (index < meta.totalChunks) throw new Error('Lampiran terpotong.');
        break;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}
