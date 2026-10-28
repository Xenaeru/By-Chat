/**
 * profiles.js — profil publik, ID pengguna, dan jabatan.
 *
 * Kenapa terpisah dari usernames.js: username adalah nama yang dipakai login
 * dan disebut orang lain, sedangkan berkas ini menyimpan hal-hal yang boleh
 * diketahui siapa saja (ID, status, tahun lahir) plus dua keputusan yang
 * cuma boleh diubah pemiliknya atau staf: `publicProfile` dan jabatan.
 *
 * Aturan yang dijaga di sini, bukan di browser:
 *   - ID pengguna dibuat server, unik, dan tidak pernah dipilih sendiri.
 *   - `publicProfile` menentukan siapa yang boleh melihat status (lihat
 *     canSeeStatus di server.js).
 *   - `chats` mencatat pasangan yang pernah bertukar pesan langsung. Catatan
 *     ini yang membuat status tetap bisa dilihat kontak walau profilnya
 *     privat.
 *   - Jabatan (`role`) dan centang biru cuma bisa diberikan lewat role:set,
 *     yang memeriksa peringkat pemberinya lebih dulu.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Jabatan yang bisa diberikan. OWNER bukan jabatan tersimpan: dia dari env. */
export const GRANTABLE_ROLES = ['admin', 'moderator'];

const MAX_CHATS = 500;

/** Status teks singkat — sama panjangnya dengan batas "about" WhatsApp. */
export const cleanAbout = (value) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 139);

export function cleanBirthYear(value) {
  if (value === null || value === '' || value === undefined) return null;
  const year = Number(value);
  const now = new Date().getFullYear();
  if (!Number.isInteger(year) || year < 1900 || year > now) return null;
  return year;
}

/** Kunci publik ECDH P-256; cukup x/y karena kurvanya sudah ditentukan. */
export function cleanPublicKey(value) {
  if (!value || typeof value !== 'object') return null;
  const x = typeof value.x === 'string' ? value.x : '';
  const y = typeof value.y === 'string' ? value.y : '';
  const coordinate = /^[A-Za-z0-9_-]{40,64}$/;
  if (!coordinate.test(x) || !coordinate.test(y)) return null;
  return { kty: 'EC', crv: 'P-256', x, y };
}

const isUid = (uid) => typeof uid === 'string' && uid.length > 0 && uid.length <= 128;

/** ID yang diketik orang: 6–12 angka. Spasi/titik dibuang sebelum dicek. */
export const normalizeUserId = (value) => String(value ?? '').replace(/\D+/g, '');
export const looksLikeUserId = (value) => /^\d{6,12}$/.test(normalizeUserId(value));

/* ------------------------------------------------------------------
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * Bentuk penyimpanan sama dengan accounts.js: file JSON untuk driver local,
 * objek di bucket Supabase kalau driver itu dipakai.
 */
export async function createProfileStore(config) {
  if (config.storage.driver === 'supabase') {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(config.secrets.supabaseUrl, config.secrets.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const bucket = config.storage.bucket;
    const object = config.profiles.object;

    return {
      kind: 'supabase',
      async read() {
        const { data, error } = await client.storage.from(bucket).download(object);
        if (error) {
          if (/not found|does not exist|no such/i.test(error.message || '')) return null;
          throw new Error(`Gagal baca profil: ${error.message}`);
        }
        return JSON.parse(await data.text());
      },
      async write(value) {
        const { error } = await client.storage.from(bucket).upload(object, JSON.stringify(value), {
          upsert: true,
          contentType: 'application/json',
        });
        if (error) throw new Error(`Gagal simpan profil: ${error.message}`);
      },
    };
  }

  const file = config.profiles.file;
  return {
    kind: 'file',
    file,
    async read() {
      try {
        const raw = await fs.readFile(file, 'utf8');
        return raw.trim() ? JSON.parse(raw) : null;
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        console.warn(`⚠️  Profil nggak bisa dibaca (${err.message}) — mulai dari kosong.`);
        return null;
      }
    },
    async write(value) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

/* ------------------------------------------------------------------
 * Registry
 * ------------------------------------------------------------------ */

export async function createProfileRegistry({ store = null } = {}) {
  /** uid -> record */
  const byUid = new Map();
  /** ID pengguna -> uid */
  const byId = new Map();

  const blank = (uid) => ({
    uid,
    id: '',
    about: '',
    birthYear: null,
    publicProfile: true,
    verified: false,
    role: null,
    chats: [],
    // Disimpan supaya orang yang sedang offline tetap bisa dikirimi pesan
    // terenkripsi tanpa menunggu dia membuka aplikasinya lebih dulu.
    publicKey: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  /** ID acak 8 digit yang belum dipakai. */
  function newUserId() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = String(crypto.randomInt(10_000_000, 99_999_999));
      if (!byId.has(id)) return id;
    }
    // Praktis tidak tercapai, tapi tetap harus menghasilkan sesuatu yang unik.
    return String(Date.now()).slice(-9);
  }

  async function load() {
    let saved = null;
    try {
      saved = await store?.read();
    } catch (err) {
      console.warn(`⚠️  ${err.message}`);
    }

    const entries = saved?.profiles && typeof saved.profiles === 'object' ? saved.profiles : {};
    for (const [uid, entry] of Object.entries(entries)) {
      if (!isUid(uid)) continue;

      const id = normalizeUserId(entry?.id);
      const record = {
        uid,
        id: id.length >= 6 && id.length <= 12 && !byId.has(id) ? id : '',
        about: cleanAbout(entry?.about),
        birthYear: cleanBirthYear(entry?.birthYear),
        // Profil baru sengaja publik: itu yang paling tidak mengejutkan, dan
        // orang yang ingin privat tinggal mematikan sakelarnya.
        publicProfile: entry?.publicProfile !== false,
        verified: entry?.verified === true,
        role: GRANTABLE_ROLES.includes(entry?.role) ? entry.role : null,
        chats: Array.isArray(entry?.chats)
          ? [...new Set(entry.chats.filter((candidate) => isUid(candidate) && candidate !== uid))].slice(
              -MAX_CHATS
            )
          : [],
        publicKey: cleanPublicKey(entry?.publicKey),
        createdAt: Number(entry?.createdAt) || Date.now(),
        updatedAt: Number(entry?.updatedAt) || Date.now(),
      };
      if (record.id) byId.set(record.id, uid);
      byUid.set(uid, record);
    }
    return byUid.size;
  }

  async function persist() {
    if (!store) return;
    try {
      await store.write({ version: 1, profiles: Object.fromEntries(byUid) });
    } catch (err) {
      console.warn(`⚠️  ${err.message} — ID/jabatan terakhir mungkin hilang setelah restart.`);
    }
  }

  /** Pastikan uid punya record + ID. Ada record baru = satu tulisan. */
  async function ensure(uid) {
    if (!isUid(uid)) return null;
    const existing = byUid.get(uid);
    if (existing?.id) return existing;

    const record = existing || blank(uid);
    if (!record.id) {
      record.id = newUserId();
      byId.set(record.id, uid);
    }
    record.updatedAt = Date.now();
    byUid.set(uid, record);
    await persist();
    return record;
  }

  const get = (uid) => byUid.get(String(uid || '')) || null;
  const byUserId = (value) => {
    const uid = byId.get(normalizeUserId(value));
    return uid ? byUid.get(uid) : null;
  };

  /**
   * Potret profil yang boleh dilihat orang lain. `role` ikut karena badge staf
   * ditampilkan di samping nama; tidak ada email/nomor HP di sini.
   */
  const view = (uid) => {
    const record = get(uid);
    if (!record) return null;
    return {
      uid: record.uid,
      id: record.id,
      about: record.about,
      birthYear: record.birthYear,
      publicProfile: record.publicProfile,
      verified: record.verified,
      role: record.role,
    };
  };

  return {
    load,
    size: () => byUid.size,
    all: () => [...byUid.values()],
    get,
    view,
    byUserId,
    ensure,

    /**
     * Simpan kunci publik terbaru. Kunci privat tidak pernah menyentuh server;
     * yang bertahan cuma bagian publiknya, supaya pengirim tidak perlu
     * menunggu penerima online untuk mengenkripsi pesan.
     */
    async setPublicKey(uid, value) {
      const record = await ensure(uid);
      const key = cleanPublicKey(value);
      if (!record || !key) return null;
      if (record.publicKey?.x === key.x && record.publicKey?.y === key.y) return record.publicKey;
      record.publicKey = key;
      record.updatedAt = Date.now();
      await persist();
      return record.publicKey;
    },

    /** Ubah pengaturan yang hanya boleh disentuh pemiliknya. */
    async updateSettings(uid, patch = {}) {
      const record = await ensure(uid);
      if (!record) return null;

      if (patch.about !== undefined) record.about = cleanAbout(patch.about);
      if (patch.birthYear !== undefined) record.birthYear = cleanBirthYear(patch.birthYear);
      if (patch.publicProfile !== undefined) record.publicProfile = patch.publicProfile !== false;

      record.updatedAt = Date.now();
      await persist();
      return view(uid);
    },

    /** Catat bahwa dua orang pernah bertukar pesan langsung. */
    async markChat(a, b) {
      if (!isUid(a) || !isUid(b) || a === b) return false;

      let changed = false;
      for (const [owner, other] of [
        [a, b],
        [b, a],
      ]) {
        const record = await ensure(owner);
        if (!record) continue;
        if (record.chats.includes(other)) continue;
        record.chats.push(other);
        if (record.chats.length > MAX_CHATS) record.chats.splice(0, record.chats.length - MAX_CHATS);
        changed = true;
      }
      if (changed) await persist();
      return changed;
    },

    hasChatted: (a, b) => Boolean(get(a)?.chats.includes(String(b))),

    /** Jabatan/centang biru; pemanggil sudah memeriksa izin pemberinya. */
    async setRole(uid, role) {
      const record = await ensure(uid);
      if (!record) return null;
      record.role = GRANTABLE_ROLES.includes(role) ? role : null;
      record.updatedAt = Date.now();
      await persist();
      return view(uid);
    },

    async setVerified(uid, value) {
      const record = await ensure(uid);
      if (!record) return null;
      record.verified = value === true;
      record.updatedAt = Date.now();
      await persist();
      return view(uid);
    },
  };
}
