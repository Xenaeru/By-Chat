/**
 * usernames.js — the @name namespace.
 *
 * Signing in proves *that* an account exists; it says nothing about what other
 * people call that account. So right after signing in, a new account claims a
 * username. The server owns that namespace and is the only authority on it:
 * it normalises the input, rejects reserved words, and refuses a name that is
 * already taken.
 *
 * Two rules matter more than they look:
 *
 *   - Comparison is case-insensitive, so "Andi" cannot shadow "andi". Casing
 *     itself is kept, though: someone who writes "Andi" is shown as "Andi".
 *   - Names that differ only by separators are the same name, so "a.n.d.i"
 *     cannot shadow "andi". Without this, impersonation is trivial.
 *
 * Claims are persisted (a JSON file, or an object in the Supabase bucket when
 * that driver is in use) because a namespace that resets on every restart is
 * not a namespace, it is a race.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const MIN_LENGTH = 3;
export const MAX_LENGTH = 20;

/** Names the server keeps for itself, plus a few that invite impersonation. */
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'sysadmin', 'system', 'support', 'help',
  'official', 'staff', 'moderator', 'mod', 'owner', 'securechat', 'secure',
  'chat', 'server', 'api', 'www', 'mail', 'bot', 'null', 'undefined', 'me',
  'you', 'all', 'everyone', 'here', 'everyone', 'anonymous', 'anon', 'guest',
  'security', 'verify', 'verified', 'announcement', 'broadcast',
]);

/** Trimmed, still with the casing the person typed — that is what others see. */
export const normalizeUsername = (raw) => String(raw ?? '').trim();

/**
 * The comparison key. Case-folded, and only characters that carry meaning in a
 * name are kept, so neither capitals nor separators can smuggle a lookalike
 * name in next to a real one.
 */
export const usernameKey = (raw) =>
  normalizeUsername(raw).toLowerCase().replace(/[._-]/g, '');

// Uppercase is allowed *and kept*; only the comparison folds it away.
const PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])$/;

/**
 * Returns { ok: true, name } or { ok: false, error }. The error is written to
 * be shown to a person as-is.
 */
export function validateUsername(raw) {
  const name = normalizeUsername(raw);
  if (!name) return { ok: false, error: 'Username belum diisi.' };
  if (name.length < MIN_LENGTH) return { ok: false, error: `Minimal ${MIN_LENGTH} karakter.` };
  if (name.length > MAX_LENGTH) return { ok: false, error: `Maksimal ${MAX_LENGTH} karakter.` };
  if (!PATTERN.test(name)) {
    return {
      ok: false,
      error: 'Pakai huruf besar/kecil, angka, titik, garis bawah, atau strip. Harus mulai dan berakhir dengan huruf/angka.',
    };
  }
  if (RESERVED.has(usernameKey(name))) return { ok: false, error: 'Username ini dipakai sistem.' };
  return { ok: true, name };
}

/**
 * A usable name close to the one that was refused. Separators are dropped on
 * purpose: when "andi" is taken, handing back "a.n.d.i2" would be suggesting a
 * lookalike of a name somebody else holds.
 */
export function suggestUsername(raw, isTaken) {
  // Saran ditulis huruf kecil biar rapi; keunikan tetap dicek tanpa peduli
  // besar/kecil lewat pemanggil `isTaken`.
  const base = normalizeUsername(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, MAX_LENGTH);

  const candidates = [];
  if (base && validateUsername(base).ok) candidates.push(base);
  const stem = (base || 'user').replace(/[._-]+$/g, '').slice(0, MAX_LENGTH - 1) || 'user';
  for (let i = 2; i <= 40; i++) {
    const candidate = `${stem}${i}`.slice(0, MAX_LENGTH);
    if (validateUsername(candidate).ok) candidates.push(candidate);
  }
  for (const candidate of candidates) if (!isTaken(candidate)) return candidate;
  return null;
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * Where claims live between restarts. The Supabase driver keeps them next to the
 * blobs (the bucket is private and only this process holds the service key); the
 * local driver keeps them in a JSON file under data/.
 */
export async function createUsernameStore(config) {
  if (config.storage.driver === 'supabase') {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(config.secrets.supabaseUrl, config.secrets.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const bucket = config.storage.bucket;
    const object = config.usernames.object;

    return {
      kind: 'supabase',
      async read() {
        const { data, error } = await client.storage.from(bucket).download(object);
        if (error) {
          // First run: the object does not exist yet. That is not a failure.
          if (/not found|does not exist|no such/i.test(error.message || '')) return null;
          throw new Error(`Gagal baca daftar username: ${error.message}`);
        }
        return JSON.parse(await data.text());
      },
      async write(value) {
        const { error } = await client.storage.from(bucket).upload(object, JSON.stringify(value), {
          upsert: true,
          contentType: 'application/json',
        });
        if (error) throw new Error(`Gagal simpan daftar username: ${error.message}`);
      },
    };
  }

  const file = config.usernames.file;
  return {
    kind: 'file',
    file,
    async read() {
      try {
        const text = await fs.readFile(file, 'utf8');
        return text.trim() ? JSON.parse(text) : null;
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        // A damaged file must not stop the server from booting; the claims it
        // holds are re-claimable, and the warning says what happened.
        console.warn(`⚠️  Daftar username nggak bisa dibaca (${err.message}) — mulai dari kosong.`);
        return null;
      }
    },
    async write(value) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

const isUid = (uid) => typeof uid === 'string' && uid.length > 0 && uid.length <= 128;

export async function createUsernameRegistry({ store = null } = {}) {
  /** usernameKey -> username as claimed */
  const byKey = new Map();
  /** uid -> username */
  const byUid = new Map();

  async function load() {
    let saved = null;
    try {
      saved = await store?.read();
    } catch (err) {
      console.warn(`⚠️  ${err.message}`);
    }
    const uids = saved?.uids && typeof saved.uids === 'object' ? saved.uids : {};
    for (const [uid, name] of Object.entries(uids)) {
      const check = validateUsername(name);
      if (!check.ok || !isUid(uid)) continue;
      const key = usernameKey(check.name);
      // A file written by hand could list one name twice; the first claim wins.
      if (byKey.has(key)) continue;
      byKey.set(key, check.name);
      byUid.set(uid, check.name);
    }
    return byUid.size;
  }

  async function persist() {
    if (!store) return;
    try {
      await store.write({ version: 1, uids: Object.fromEntries(byUid) });
    } catch (err) {
      // The claim stands in memory; only surviving a restart is at risk, and
      // pretending it was saved would be worse than saying so.
      console.warn(`⚠️  ${err.message} — username ini bisa hilang kalau server restart.`);
    }
  }

  return {
    load,
    size: () => byUid.size,
    get: (uid) => byUid.get(uid) || null,

    /** Is this name already someone else's? */
    takenBy: (raw, uid) => {
      const owner = byKey.get(usernameKey(raw));
      if (!owner) return null;
      const current = byUid.get(uid);
      if (current && usernameKey(current) === usernameKey(owner)) return null;
      return owner;
    },

    /**
     * uid yang memakai sebuah nama, atau null. Dipakai untuk mencari kontak
     * lewat @username, dan tetap berlaku walau orangnya sedang offline.
     */
    ownerOf(raw) {
      const key = usernameKey(raw);
      if (!key) return null;
      for (const [uid, name] of byUid) if (usernameKey(name) === key) return uid;
      return null;
    },

    /** Semua pasangan uid → username, buat daftar pengguna di halaman admin. */
    list: () => [...byUid.entries()].map(([uid, username]) => ({ uid, username })),

    /** Everything the UI needs to render a live availability hint. */
    check(raw, uid) {
      const check = validateUsername(raw);
      if (!check.ok) return { ok: false, error: check.error, suggestion: null };
      const owner = this.takenBy(check.name, uid);
      if (owner) {
        return {
          ok: false,
          error: `"${owner}" sudah dipakai orang lain.`,
          suggestion: suggestUsername(check.name, (candidate) => Boolean(this.takenBy(candidate, uid))),
        };
      }
      return { ok: true, username: check.name, suggestion: null };
    },

    /**
     * Claim or rename. The maps are updated before the first await, so two
     * claims arriving in the same tick cannot both win.
     */
    async claim(raw, uid) {
      if (!isUid(uid)) return { ok: false, error: 'Akun tidak dikenal.' };
      const check = validateUsername(raw);
      if (!check.ok) return check;

      const current = byUid.get(uid);
      if (current && usernameKey(current) === usernameKey(check.name)) {
        // Nama yang sama, cuma beda ejaan besar/kecil: pemiliknya boleh
        // membetulkan tampilannya tanpa kehilangan klaimnya.
        if (current === check.name) return { ok: true, username: current, unchanged: true };
        byKey.set(usernameKey(check.name), check.name);
        byUid.set(uid, check.name);
        await persist();
        return { ok: true, username: check.name };
      }
      if (this.takenBy(check.name, uid)) {
        return {
          ok: false,
          error: `Username "${check.name}" sudah dipakai.`,
          suggestion: suggestUsername(check.name, (candidate) => Boolean(this.takenBy(candidate, uid))),
        };
      }

      const key = usernameKey(check.name);
      if (current) byKey.delete(usernameKey(current));
      byKey.set(key, check.name);
      byUid.set(uid, check.name);
      await persist();
      return { ok: true, username: check.name };
    },

    /** Free a name (used when an account is removed, and by the tests). */
    async release(uid) {
      const current = byUid.get(uid);
      if (!current) return false;
      byUid.delete(uid);
      // Only drop the key if this account still owns it.
      if (byKey.get(usernameKey(current)) === current) byKey.delete(usernameKey(current));
      await persist();
      return true;
    },
  };
}
