/**
 * credentials.js — akun yang masuk pakai username + kata sandi.
 *
 * Login Google membuktikan identitas lewat Google. Akun di sini membuktikannya
 * sendiri: kata sandinya disimpan sebagai hash scrypt bergaram, tidak pernah
 * sebagai teks biasa, dan tidak pernah dikirim balik ke browser.
 *
 * Tiga hal yang membuat modul ini ada:
 *
 *   - Akun harus dibuat dulu di halaman Daftar. Username yang tidak pernah
 *     didaftarkan tidak punya hash, jadi tidak ada yang bisa dicocokkan dan
 *     login-nya ditolak — bukan dibiarkan masuk dengan sandi apa pun.
 *   - Setelah cocok, server menerbitkan token sesi bertanda tangan HMAC
 *     (`sess.<payload>.<tanda tangan>`). Token itu yang dipakai klien seperti
 *     token login lain (lihat auth.js), jadi seluruh jalur yang sudah ada —
 *     socket, upload, admin — tetap bekerja tanpa jalur khusus.
 *   - Username di sini memakai aturan yang sama dengan @username (usernames.js):
 *     beda besar/kecil dan beda tanda pemisah dianggap nama yang sama, supaya
 *     tidak ada dua orang yang tampak identik.
 *
 * Bentuk penyimpanannya sama dengan registry lain: file JSON saat driver local,
 * objek di bucket Supabase saat driver itu aktif.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { usernameKey, validateUsername } from './usernames.js';

/** Awalan token sesi. Dipakai juga oleh auth.js untuk mengenali token ini. */
export const SESSION_PREFIX = 'sess.';

export const MIN_PASSWORD = 6;
export const MAX_PASSWORD = 128;

/** Sesi berlaku 30 hari; habis berarti masuk lagi, bukan diam-diam diperpanjang. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Parameter scrypt. Disimpan per akun supaya hash lama tetap bisa dibaca. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** Batas percobaan sandi salah per username, supaya sandi tidak bisa ditebak. */
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

const UID_RE = /^pw-[0-9a-f]{16}$/;

/**
 * Aturan sandi. Panjang minimum lebih penting daripada campuran karakter: yang
 * menentukan tebakan brute-force adalah panjangnya, dan aturan campuran bikin
 * orang menulis "Password1!" di mana-mana.
 */
export function validatePassword(raw) {
  const password = String(raw ?? '');
  if (!password) return 'Kata sandi belum diisi.';
  if (password.length < MIN_PASSWORD) return `Kata sandi minimal ${MIN_PASSWORD} karakter.`;
  if (password.length > MAX_PASSWORD) return `Kata sandi maksimal ${MAX_PASSWORD} karakter.`;
  if (!password.trim()) return 'Kata sandi tidak boleh cuma spasi.';
  return null;
}

const profileOf = (record) => ({
  uid: record.uid,
  displayName: record.username,
  phone: null,
  email: null,
  photoURL: null,
});

function hashPassword(password, salt, cost = SCRYPT) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      String(password),
      salt,
      cost.keylen,
      { N: cost.N, r: cost.r, p: cost.p },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

const sameBytes = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

export async function createCredentialStore(config) {
  if (config.storage.driver === 'supabase') {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(config.secrets.supabaseUrl, config.secrets.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const bucket = config.storage.bucket;
    const object = config.credentials.object;

    return {
      kind: 'supabase',
      async read() {
        const { data, error } = await client.storage.from(bucket).download(object);
        if (error) {
          if (/not found|does not exist|no such/i.test(error.message || '')) return null;
          throw new Error(`Gagal baca daftar akun: ${error.message}`);
        }
        return JSON.parse(await data.text());
      },
      async write(value) {
        const { error } = await client.storage.from(bucket).upload(object, JSON.stringify(value), {
          upsert: true,
          contentType: 'application/json',
        });
        if (error) throw new Error(`Gagal simpan daftar akun: ${error.message}`);
      },
    };
  }

  const file = config.credentials.file;
  return {
    kind: 'file',
    file,
    async read() {
      try {
        const text = await fs.readFile(file, 'utf8');
        return text.trim() ? JSON.parse(text) : null;
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        console.warn(`⚠️  Daftar akun nggak bisa dibaca (${err.message}) — mulai dari kosong.`);
        return null;
      }
    },
    async write(value) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Hash sandi tidak boleh ikut terbaca proses lain di mesin yang sama.
      await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    },
  };
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

export async function createCredentialRegistry({ store = null } = {}) {
  /** usernameKey -> { uid, username, salt, hash, cost, createdAt } */
  const byKey = new Map();
  /** uid -> record yang sama, supaya token sesi bisa dicabut dengan menghapus akun. */
  const byUid = new Map();
  /** usernameKey -> { count, resetAt } */
  const failures = new Map();

  /** Kunci tanda tangan token sesi. Dibuat sekali, lalu ikut tersimpan. */
  let secret = null;

  async function writeAll() {
    if (!store) return false;
    try {
      await store.write({
        version: 1,
        secret: secret.toString('base64'),
        accounts: Object.fromEntries(byKey),
      });
      return true;
    } catch (err) {
      console.warn(`⚠️  ${err.message} — akun baru ini bisa hilang kalau server restart.`);
      return false;
    }
  }

  async function load() {
    let saved = null;
    try {
      saved = await store?.read();
    } catch (err) {
      console.warn(`⚠️  ${err.message}`);
    }

    // Kunci sesi harus sama setiap boot, kalau tidak semua sesi hangus saat
    // restart. Disimpan bersama akun karena keduanya satu paket.
    const savedSecret =
      typeof saved?.secret === 'string' ? Buffer.from(saved.secret, 'base64') : null;
    secret = savedSecret && savedSecret.length >= 32 ? savedSecret : crypto.randomBytes(32);

    const accounts = saved?.accounts && typeof saved.accounts === 'object' ? saved.accounts : {};
    for (const [key, record] of Object.entries(accounts)) {
      const check = validateUsername(record?.username);
      if (!check.ok) continue;
      if (usernameKey(check.name) !== key) continue;
      if (!UID_RE.test(String(record?.uid || ''))) continue;
      if (typeof record?.salt !== 'string' || typeof record?.hash !== 'string') continue;
      if (byKey.has(key) || byUid.has(record.uid)) continue;
      const cost = {
        N: Number(record.cost?.N) || SCRYPT.N,
        r: Number(record.cost?.r) || SCRYPT.r,
        p: Number(record.cost?.p) || SCRYPT.p,
        keylen: Number(record.cost?.keylen) || SCRYPT.keylen,
      };
      const entry = { ...record, cost };
      byKey.set(key, entry);
      byUid.set(record.uid, entry);
    }

    // Daftar kosong tanpa kunci sesi: file ini baru, dan kuncinya juga perlu
    // disimpan supaya sesi besok masih sah.
    if (!savedSecret) await writeAll();

    return byKey.size;
  }

  function noteFailure(key) {
    const now = Date.now();
    const entry = failures.get(key);
    if (!entry || entry.resetAt <= now) failures.set(key, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
    else entry.count += 1;
    // Penjaga ukuran: nama yang salah ketik terus-menerus tidak boleh membuat
    // peta ini tumbuh tanpa batas.
    if (failures.size > 1000) {
      for (const [candidate, value] of failures) if (value.resetAt <= now) failures.delete(candidate);
    }
  }

  function sign(payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  }

  return {
    load,
    size: () => byKey.size,
    secretReady: () => Boolean(secret),

    /** Apakah username ini sudah punya akun? */
    has: (raw) => byKey.has(usernameKey(raw)),

    /**
     * Buat akun baru. Username yang sudah terdaftar ditolak; username yang
     * belum pernah didaftarkan tidak punya hash, jadi tidak bisa dipakai masuk.
     */
    async register({ username, password }) {
      const check = validateUsername(username);
      if (!check.ok) return { ok: false, error: check.error };
      const passwordError = validatePassword(password);
      if (passwordError) return { ok: false, error: passwordError };

      const key = usernameKey(check.name);
      const taken = 'Username ini sudah terdaftar. Langsung masuk saja.';
      if (byKey.has(key)) return { ok: false, error: taken };

      // Hashing butuh waktu: dua pendaftaran bersamaan sama-sama lolos
      // pemeriksaan di atas. Yang kalah harus ditolak, bukan menimpa akun orang.
      const salt = crypto.randomBytes(16);
      const hash = await hashPassword(password, salt);
      if (byKey.has(key)) return { ok: false, error: taken };

      const record = {
        uid: `pw-${crypto.randomBytes(8).toString('hex')}`,
        username: check.name,
        salt: salt.toString('hex'),
        hash: hash.toString('hex'),
        cost: { ...SCRYPT },
        createdAt: Date.now(),
      };
      byKey.set(key, record);
      byUid.set(record.uid, record);
      await writeAll();
      return { ok: true, uid: record.uid, username: record.username };
    },

    /** Cocokkan sandi. Akun yang belum pernah didaftarkan selalu ditolak. */
    async login({ username, password }) {
      const key = usernameKey(username);
      if (!key) return { ok: false, error: 'Username belum diisi.' };

      const throttle = failures.get(key);
      if (throttle && throttle.count >= MAX_FAILURES && throttle.resetAt > Date.now()) {
        return { ok: false, error: 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.' };
      }

      const record = byKey.get(key);
      if (!record) {
        return { ok: false, error: 'Akun ini belum terdaftar. Buat akun dulu lewat tombol Daftar.' };
      }

      const raw = String(password ?? '');
      if (!raw || raw.length > MAX_PASSWORD) {
        noteFailure(key);
        return { ok: false, error: 'Kata sandi salah.' };
      }

      const derived = await hashPassword(raw, Buffer.from(record.salt, 'hex'), record.cost);
      const expected = Buffer.from(record.hash, 'hex');
      if (!sameBytes(derived, expected)) {
        noteFailure(key);
        return { ok: false, error: 'Kata sandi salah.' };
      }

      failures.delete(key);
      return { ok: true, profile: profileOf(record) };
    },

    /**
     * Token sesi untuk akun yang sudah lolos login. Isinya cuma uid + waktu
     * habis; nama tampilan selalu dibaca ulang dari catatan akun, jadi sesi
     * tidak bisa dipakai mengaku-aku nama lain.
     */
    issueSession(profile, { ttlMs = SESSION_TTL_MS } = {}) {
      if (!secret) throw new Error('Kunci sesi belum siap');
      const payload = Buffer.from(
        JSON.stringify({ uid: String(profile.uid), exp: Date.now() + ttlMs })
      ).toString('base64url');
      return `${SESSION_PREFIX}${payload}.${sign(payload)}`;
    },

    /** Dipakai auth.js saat sebuah permintaan membawa token sesi. */
    verifySession(token) {
      if (!secret) throw new Error('Kunci sesi belum siap');
      const raw = String(token ?? '');
      if (!raw.startsWith(SESSION_PREFIX)) throw new Error('Token sesi tidak valid');

      const rest = raw.slice(SESSION_PREFIX.length);
      const split = rest.lastIndexOf('.');
      if (split <= 0) throw new Error('Token sesi tidak lengkap');
      const payload = rest.slice(0, split);
      const signature = rest.slice(split + 1);

      let given;
      try {
        given = Buffer.from(signature, 'base64url');
      } catch {
        throw new Error('Token sesi tidak sah');
      }
      if (!sameBytes(given, Buffer.from(sign(payload), 'base64url'))) {
        throw new Error('Token sesi tidak sah');
      }

      let data;
      try {
        data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      } catch {
        throw new Error('Token sesi tidak bisa dibaca');
      }
      if (!(Number(data?.exp) > Date.now())) throw new Error('Sesi sudah berakhir, masuk lagi ya.');

      const record = byUid.get(String(data?.uid || ''));
      if (!record) throw new Error('Akun ini sudah tidak ada');
      return profileOf(record);
    },
  };
}
