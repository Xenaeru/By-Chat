/**
 * moderation.js — laporan pengguna dan daftar blokir.
 *
 * Dua hal yang mirip tapi beda, dan servernya memperlakukan keduanya beda:
 *
 *   laporan : siapa saja boleh melaporkan siapa saja. Laporan cuma disimpan
 *             buat halaman admin dan tidak mengubah apa pun sendiri — laporan
 *             itu tuduhan, bukan keputusan.
 *   blokir  : cuma admin yang bisa. Ini ditegakkan di server, bukan di tampilan:
 *             akun yang diblokir nggak bisa buka socket, nggak bisa pakai
 *             endpoint REST, dan langsung ditendang dari sesi yang sedang jalan.
 *
 * Seperti namespace username, keduanya bertahan melewati restart: file JSON di
 * data/ untuk driver local, objek di bucket Supabase kalau driver itu dipakai.
 *
 * Yang *tidak* pernah ada di sini: isi pesan. Laporan cuma memuat yang ditulis
 * pelapor sendiri, dan isi chat tetap terenkripsi end-to-end — admin pun nggak
 * bisa membacanya.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const REPORT_REASONS = [
  { id: 'spam', label: 'Spam atau iklan' },
  { id: 'kasar', label: 'Kata kasar / pelecehan' },
  { id: 'penipuan', label: 'Penipuan atau minta uang' },
  { id: 'palsu', label: 'Akun palsu (mengaku orang lain)' },
  { id: 'anak', label: 'Konten di bawah umur' },
  { id: 'lain', label: 'Lainnya' },
];

const REASON_IDS = new Set(REPORT_REASONS.map((r) => r.id));

/** Label yang aman ditampilkan, walau id-nya datang dari data lama. */
export const reasonLabel = (id) => REPORT_REASONS.find((r) => r.id === id)?.label || 'Lainnya';

export const MAX_DETAIL = 400;
export const MAX_REASON = 200;

/** Laporan lama rontok kalau sudah sebanyak ini, biar file-nya nggak tumbuh terus. */
const MAX_REPORTS = 500;
/** Satu akun nggak boleh membanjiri halaman admin. */
const MAX_REPORTS_PER_HOUR = 10;
const HOUR = 60 * 60 * 1000;

export const REPORT_STATUSES = ['open', 'resolved', 'dismissed'];

const text = (value, max) =>
  String(value ?? '')
    // Karakter kontrol dibuang di sini: laporan ditampilkan di halaman admin,
    // jadi tidak ada alasan menerima baris baru yang bisa menyamarkan isinya.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * Tempat bans + laporan disimpan di antara restart. Bentuknya sengaja sama
 * dengan penyimpanan username (lihat usernames.js) supaya tidak ada dua cara
 * berbeda untuk hal yang sama.
 */
export async function createModerationStore(config) {
  if (config.storage.driver === 'supabase') {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(config.secrets.supabaseUrl, config.secrets.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const bucket = config.storage.bucket;
    const object = config.moderation.object;

    return {
      kind: 'supabase',
      async read() {
        const { data, error } = await client.storage.from(bucket).download(object);
        if (error) {
          // Belum pernah ada: bukan kegagalan, cuma hari pertama.
          if (/not found|does not exist|no such/i.test(error.message || '')) return null;
          throw new Error(`Gagal baca data moderasi: ${error.message}`);
        }
        return JSON.parse(await data.text());
      },
      async write(value) {
        const { error } = await client.storage.from(bucket).upload(object, JSON.stringify(value), {
          upsert: true,
          contentType: 'application/json',
        });
        if (error) throw new Error(`Gagal simpan data moderasi: ${error.message}`);
      },
    };
  }

  const file = config.moderation.file;
  return {
    kind: 'file',
    file,
    async read() {
      try {
        const raw = await fs.readFile(file, 'utf8');
        return raw.trim() ? JSON.parse(raw) : null;
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        // File rusak jangan sampai menghalangi server jalan; blokirnya bisa
        // dibuat ulang lewat halaman admin, dan pesan ini bilang apa yang terjadi.
        console.warn(`⚠️  Data moderasi nggak bisa dibaca (${err.message}) — mulai dari kosong.`);
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

export async function createModeration({ store = null } = {}) {
  /** uid -> { uid, username, reason, at, by } */
  const bans = new Map();
  /** Terbaru di depan. */
  let reports = [];
  /** uid -> [timestamp] buat membatasi jumlah laporan per jam. */
  const filings = new Map();

  async function load() {
    let saved = null;
    try {
      saved = await store?.read();
    } catch (err) {
      console.warn(`⚠️  ${err.message}`);
    }
    if (saved && typeof saved === 'object') {
      const savedBans = saved.bans && typeof saved.bans === 'object' ? saved.bans : {};
      for (const [uid, ban] of Object.entries(savedBans)) {
        if (!isUid(uid)) continue;
        bans.set(uid, {
          uid,
          username: text(ban?.username, 40) || null,
          reason: text(ban?.reason, MAX_REASON),
          at: Number(ban?.at) || Date.now(),
          by: text(ban?.by, 128) || null,
        });
      }

      const savedReports = Array.isArray(saved.reports) ? saved.reports : [];
      reports = savedReports
        .filter((r) => isUid(r?.from) && isUid(r?.about))
        .map((r) => ({
          id: String(r.id || `r-${r.at}`),
          at: Number(r.at) || Date.now(),
          status: REPORT_STATUSES.includes(r.status) ? r.status : 'open',
          reason: REASON_IDS.has(r.reason) ? r.reason : 'lain',
          detail: text(r.detail, MAX_DETAIL),
          from: r.from,
          fromName: text(r.fromName, 40) || null,
          about: r.about,
          aboutName: text(r.aboutName, 40) || null,
          context: text(r.context, 80) || null,
          handledBy: text(r.handledBy, 128) || null,
          handledAt: Number(r.handledAt) || null,
          handledNote: text(r.handledNote, 200) || '',
        }))
        .slice(0, MAX_REPORTS);
    }
    return { bans: bans.size, reports: reports.length };
  }

  async function persist() {
    if (!store) return;
    try {
      await store.write({
        version: 1,
        bans: Object.fromEntries(bans),
        reports,
      });
    } catch (err) {
      // Perubahan tetap berlaku di memori; yang berisiko cuma bertahan setelah
      // restart, dan berpura-pura sudah tersimpan jauh lebih buruk.
      console.warn(`⚠️  ${err.message} — perubahan moderasi bisa hilang kalau server restart.`);
    }
  }

  /** Buang laporan paling tua; yang sudah selesai lebih dulu, baru yang belum. */
  function trimReports() {
    while (reports.length > MAX_REPORTS) {
      const index = reports.map((r) => r.status !== 'open').lastIndexOf(true);
      reports.splice(index === -1 ? reports.length - 1 : index, 1);
    }
  }

  return {
    load,
    reasonLabel,

    /* ---- Blokir -------------------------------------------------- */

    isBanned: (uid) => bans.has(uid),
    banInfo: (uid) => bans.get(uid) || null,
    bans: () => [...bans.values()].sort((a, b) => b.at - a.at),
    bannedCount: () => bans.size,

    async ban(uid, { reason = '', by = null, username = null } = {}) {
      if (!isUid(uid)) return null;
      const ban = {
        uid,
        username: text(username, 40) || bans.get(uid)?.username || null,
        reason: text(reason, MAX_REASON),
        at: Date.now(),
        by: text(by, 128) || null,
      };
      bans.set(uid, ban);
      await persist();
      return ban;
    },

    async unban(uid) {
      if (!bans.delete(uid)) return false;
      await persist();
      return true;
    },

    /* ---- Laporan ------------------------------------------------- */

    reports: () => reports.map((r) => ({ ...r, reasonLabel: reasonLabel(r.reason) })),
    openReportCount: () => reports.filter((r) => r.status === 'open').length,

    /**
     * Simpan satu laporan. Semua penolakan di sini ditulis untuk dibaca
     * pelapor apa adanya, karena itulah yang muncul di layarnya.
     */
    async report({ from, fromName, about, aboutName, reason, detail = '', context = null }) {
      if (!isUid(from) || !isUid(about)) return { ok: false, error: 'Laporan nggak lengkap.' };
      if (from === about) return { ok: false, error: 'Nggak bisa melaporkan diri sendiri.' };
      if (!REASON_IDS.has(reason)) return { ok: false, error: 'Pilih dulu alasan laporannya.' };

      const now = Date.now();
      const mine = (filings.get(from) || []).filter((at) => now - at < HOUR);
      if (mine.length >= MAX_REPORTS_PER_HOUR) {
        return { ok: false, error: 'Kamu sudah kirim banyak laporan. Tunggu sebentar ya.' };
      }
      // Laporan yang belum ditangani untuk orang yang sama tidak perlu ditumpuk;
      // admin cuma perlu satu.
      if (reports.some((r) => r.status === 'open' && r.from === from && r.about === about)) {
        return { ok: false, error: 'Laporan kamu soal orang ini masih diproses admin.' };
      }

      const entry = {
        id: `rep-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        at: now,
        status: 'open',
        reason,
        detail: text(detail, MAX_DETAIL),
        from,
        fromName: text(fromName, 40) || null,
        about,
        aboutName: text(aboutName, 40) || null,
        context: text(context, 80) || null,
        handledBy: null,
        handledAt: null,
        handledNote: '',
      };

      mine.push(now);
      filings.set(from, mine);
      reports.unshift(entry);
      trimReports();
      await persist();
      return { ok: true, report: { ...entry, reasonLabel: reasonLabel(entry.reason) } };
    },

    /** Admin menandai sebuah laporan selesai atau diabaikan. */
    async setReportStatus(id, status, { by = null, note = '' } = {}) {
      if (!REPORT_STATUSES.includes(status)) return { ok: false, error: 'Status laporan tidak dikenal.' };
      const entry = reports.find((r) => r.id === String(id || ''));
      if (!entry) return { ok: false, error: 'Laporan itu nggak ada.' };

      entry.status = status;
      entry.handledBy = status === 'open' ? null : text(by, 128) || null;
      entry.handledAt = status === 'open' ? null : Date.now();
      entry.handledNote = text(note, 200);
      await persist();
      return { ok: true, report: { ...entry, reasonLabel: reasonLabel(entry.reason) } };
    },
  };
}
