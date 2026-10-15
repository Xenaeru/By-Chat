/**
 * accounts.js — indeks email + nomor HP.
 *
 * Kenapa ada: pesan cuma bisa dikirim ke kunci publik yang sudah diketahui, dan
 * sampai sekarang satu-satunya cara tahu kunci itu adalah melihat direktori
 * "siapa yang sedang online". Artinya orang yang belum pernah online sama
 * sekali tidak bisa dihubungi, dan nomor HP tiap orang disiarkan ke semua
 * klien.
 *
 * Jadi: direktori berhenti menyiarkan nomor HP (lihat publicDirectory di
 * server.js), dan pencarian kontak pindah ke sini. Yang disimpan cuma
 * uid + email + nomor HP yang sudah diverifikasi penyedia login — tidak ada
 * bagian lain dari profil, dan tidak ada isi pesan.
 *
 * Cakupannya sengaja sesempit mungkin: yang bisa ditemukan hanyalah orang yang
 * pernah masuk setidaknya sekali, karena server tidak pernah mengenal akun yang
 * belum pernah menyapa. Pencocokan email harus sama persis, sedangkan nomor HP
 * dicocokkan pada 9 angka terakhir supaya "+62 812…" dan "0812…" menemukan
 * orang yang sama.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Angka saja — spasi, tanda hubung, dan tanda plus bukan bagian dari nomor. */
export const phoneDigits = (value) => String(value ?? '').replace(/\D+/g, '');

const TAIL = 9;

/**
 * Apakah dua nomor ini kemungkinan besar orang yang sama? Dipakai buat
 * pencarian kontak, bukan buat autentikasi: yang cocok cuma 9 angka terakhir,
 * jadi nomor yang belum pernah terdaftar tidak bisa dipastikan ada.
 */
export function phoneMatches(stored, query) {
  const a = phoneDigits(stored);
  const b = phoneDigits(query);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= TAIL && b.length >= 7 && a.slice(-TAIL) === b.slice(-TAIL);
}

export const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();

/** Cukup ketat buat memisahkan "bukan email" dari email; validasi asli milik penyedia login. */
export const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(value));

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * Bentuk penyimpanan mengikuti username + moderasi: file JSON di data/ untuk
 * driver local, objek di bucket Supabase kalau driver itu dipakai.
 */
export async function createAccountStore(config) {
  if (config.storage.driver === 'supabase') {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(config.secrets.supabaseUrl, config.secrets.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const bucket = config.storage.bucket;
    const object = config.accounts.object;

    return {
      kind: 'supabase',
      async read() {
        const { data, error } = await client.storage.from(bucket).download(object);
        if (error) {
          if (/not found|does not exist|no such/i.test(error.message || '')) return null;
          throw new Error(`Gagal baca indeks akun: ${error.message}`);
        }
        return JSON.parse(await data.text());
      },
      async write(value) {
        const { error } = await client.storage.from(bucket).upload(object, JSON.stringify(value), {
          upsert: true,
          contentType: 'application/json',
        });
        if (error) throw new Error(`Gagal simpan indeks akun: ${error.message}`);
      },
    };
  }

  const file = config.accounts.file;
  return {
    kind: 'file',
    file,
    async read() {
      try {
        const raw = await fs.readFile(file, 'utf8');
        return raw.trim() ? JSON.parse(raw) : null;
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        console.warn(`⚠️  Indeks akun nggak bisa dibaca (${err.message}) — mulai dari kosong.`);
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
 * Index
 * ------------------------------------------------------------------ */

const isUid = (uid) => typeof uid === 'string' && uid.length > 0 && uid.length <= 128;
const cleanPhone = (value) => {
  const digits = phoneDigits(value);
  return digits.length >= 6 && digits.length <= 20 ? String(value).trim().slice(0, 24) : null;
};

export async function createAccountIndex({ store = null } = {}) {
  /** uid -> { uid, email, phone } */
  const byUid = new Map();

  async function load() {
    let saved = null;
    try {
      saved = await store?.read();
    } catch (err) {
      console.warn(`⚠️  ${err.message}`);
    }
    const entries = saved?.accounts && typeof saved.accounts === 'object' ? saved.accounts : {};
    for (const [uid, entry] of Object.entries(entries)) {
      if (!isUid(uid)) continue;
      const email = normalizeEmail(entry?.email) || null;
      const phone = cleanPhone(entry?.phone);
      if (!email && !phone) continue;
      byUid.set(uid, { uid, email, phone });
    }
    return byUid.size;
  }

  async function persist() {
    if (!store) return;
    try {
      await store.write({ version: 1, accounts: Object.fromEntries(byUid) });
    } catch (err) {
      console.warn(`⚠️  ${err.message} — orang ini mungkin nggak ketemu saat dicari setelah restart.`);
    }
  }

  return {
    load,
    size: () => byUid.size,
    get: (uid) => byUid.get(uid) || null,
    entries: () => [...byUid.values()],
    list: () => [...byUid.values()],

    /**
     * Catat email/nomor dari profil yang sudah diverifikasi server.
     *
     * Hanya menambah, tidak pernah menghapus: kalau seseorang masuk lagi tanpa
     * email (misal login pakai nomor), email lamanya tetap bisa dipakai buat
     * menemukannya. Mengembalikan true kalau ada yang benar-benar berubah,
     * supaya pemanggilnya tidak menulis file tiap kali ada yang connect.
     */
    async upsert({ uid, email = null, phone = null }) {
      if (!isUid(uid)) return false;
      const nextEmail = normalizeEmail(email) || null;
      const nextPhone = cleanPhone(phone);
      if (!nextEmail && !nextPhone) return false;

      const current = byUid.get(uid) || { uid, email: null, phone: null };
      const merged = {
        uid,
        email: nextEmail || current.email || null,
        phone: nextPhone || current.phone || null,
      };
      if (merged.email === current.email && merged.phone === current.phone) return false;

      byUid.set(uid, merged);
      await persist();
      return true;
    },

    /** Semua uid yang emailnya sama persis. */
    findByEmail(email) {
      const needle = normalizeEmail(email);
      if (!needle) return [];
      return [...byUid.values()].filter((entry) => entry.email === needle);
    },

    /** Semua uid yang nomor HP-nya cocok (lihat phoneMatches). */
    findByPhone(phone) {
      return [...byUid.values()].filter((entry) => phoneMatches(entry.phone, phone));
    },
  };
}
