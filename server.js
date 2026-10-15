/**
 * server.js — relay + key directory + attachment broker + call signaling.
 *
 * What the server can see:
 *   - verified accounts (uid, display name, phone, email) and their PUBLIC keys
 *   - an index of email/phone → uid, so an account that has never been online is
 *     still reachable (see accounts.js). The phone number stays here: it is no
 *     longer broadcast to every client the way it used to be.
 *   - bans and reports, neither of which ever contains message text (see
 *     moderation.js)
 *   - opaque encrypted chat envelopes while a recipient is offline
 *   - encrypted attachment blobs, whose paths are themselves unguessable
 *   - who called whom and when
 *
 * What it can never see: message text, attachment contents, or any private key.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';

import { config, publicConfig } from './config.js';
import { createVerifier } from './auth.js';
import { createStorage, isSafePath, newBlobPath, resolveLocalPath, sniffImageType } from './storage.js';
import { createUsernameRegistry, createUsernameStore } from './usernames.js';
import { createModeration, createModerationStore, REPORT_REASONS } from './moderation.js';
import { createAccountIndex, createAccountStore, looksLikeEmail, phoneDigits } from './accounts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

const verifier = await createVerifier(config);
const storage = await createStorage(config);

// The username namespace outlives any single connection, so it is loaded once
// here rather than built alongside the live directory.
const usernameStore = await createUsernameStore(config);
const usernames = await createUsernameRegistry({ store: usernameStore });
const savedUsernames = await usernames.load();

// Bans + laporan juga harus bertahan melewati restart, dengan alasan yang sama
// seperti namespace username: keputusan yang hilang saat restart bukan
// keputusan, cuma kebetulan.
const moderationStore = await createModerationStore(config);
const moderation = await createModeration({ store: moderationStore });
const savedModeration = await moderation.load();

// Indeks email/nomor HP: tanpa ini, satu-satunya cara menemukan orang adalah
// menunggu dia online, dan nomor HP harus disiarkan ke semua orang.
const accountStore = await createAccountStore(config);
const accounts = await createAccountIndex({ store: accountStore });
const savedAccounts = await accounts.load();

/** uid -> { profile, publicKey, socketId, socket } */
const directory = new Map();
/** uid -> [envelope] queued while offline */
const inbox = new Map();
/** callId -> { from, to, startedAt } */
const calls = new Map();
/** uid -> { version, contentType, size } for the profile photo */
const avatars = new Map();
/** statusId -> { id, from, at, members, payload } */
const statuses = new Map();

const MAX_INBOX = 500;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
/** A status is gone after a day, like the one everybody is used to. */
const STATUS_TTL = 24 * 60 * 60 * 1000;
const MAX_STATUSES_PER_USER = 30;

for (const entry of await storage.listAvatars()) avatars.set(entry.uid, entry);

/**
 * Statuses expire on their own. Pruning happens on access rather than on a
 * timer: an interval would keep the process alive for no good reason, and a
 * test that closes the server should be able to exit.
 */
function pruneStatuses() {
  const cutoff = Date.now() - STATUS_TTL;
  for (const [id, status] of statuses) if (status.at < cutoff) statuses.delete(id);
}

function statusListFor(uid) {
  pruneStatuses();
  return [...statuses.values()]
    .filter((status) => status.members.includes(uid))
    .sort((a, b) => a.at - b.at)
    .map((status) => ({ id: status.id, from: status.from, at: status.at, payload: status.payload }));
}

function avatarUrl(uid) {
  const meta = avatars.get(uid);
  // The version in the query string is what makes a new photo show up straight
  // away instead of waiting for a cache to expire.
  return meta ? `/api/avatar/${encodeURIComponent(uid)}?v=${encodeURIComponent(meta.version)}` : null;
}

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/config.json', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicConfig());
});

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    auth: verifier.mode,
    storage: storage.driver,
    users: directory.size,
    usernames: usernames.size(),
    accounts: accounts.size(),
    avatars: avatars.size,
    statuses: statuses.size(),
    calls: calls.size,
    moderation: { bans: moderation.bannedCount(), openReports: moderation.openReportCount() },
  });
});

app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const onlineCount = () => [...directory.values()].filter((e) => e.socketId).length;

/**
 * Admin = akun yang uid atau email-nya tercantum di env. Tidak ada jalur lain:
 * tidak ada "pendaftar pertama jadi admin", tidak ada tombol di UI, dan
 * halaman /admin.html sendiri hanya alat — aturan yang berlaku ada di sini.
 */
function isAdmin(profile) {
  if (!profile) return false;
  if (config.admins.uids.includes(profile.uid)) return true;
  const email = String(profile.email || '').toLowerCase();
  return Boolean(email) && config.admins.emails.includes(email);
}

/** Semua uid yang dikenal server: punya username, sedang online, atau terindeks. */
function knownUids() {
  const uids = new Set(usernames.list().map((entry) => entry.uid));
  for (const uid of directory.keys()) uids.add(uid);
  for (const account of accounts.entries()) uids.add(account.uid);
  return uids;
}

/** Nama tampilan terbaik yang server punya, atau null. */
function usernameFor(uid) {
  return usernames.get(uid) || directory.get(uid)?.profile.displayName || null;
}

function publicDirectory() {
  return [...directory.entries()].map(([uid, entry]) => ({
    uid,
    displayName: entry.profile.displayName,
    // A locally uploaded photo wins over whatever the sign-in provider had.
    photoURL: avatarUrl(uid) || entry.profile.photoURL,
    // Nomor HP sengaja TIDAK ada di sini. Dulu setiap klien menerima nomor
    // semua orang yang online; sekarang pencarian kontak dikerjakan server
    // (lihat `contact:lookup`), dan hasilnya tidak pernah memuat nomornya.
    publicKey: entry.publicKey,
    online: Boolean(entry.socketId),
  }));
}

/**
 * Bahan buat halaman admin. Email/nomor HP ikut di sini karena admin memang
 * perlu tahu siapa yang bermasalah — dan endpoint ini cuma terbuka untuk akun
 * yang didaftarkan di ADMIN_UIDS / ADMIN_EMAILS.
 */
function adminUsers() {
  return [...knownUids()]
    .map((uid) => {
      const account = accounts.get(uid);
      const live = directory.get(uid);
      const ban = moderation.banInfo(uid);
      return {
        uid,
        username: usernameFor(uid),
        email: account?.email || live?.profile.email || null,
        phone: account?.phone || live?.profile.phone || null,
        online: Boolean(live?.socketId),
        banned: Boolean(ban),
        banReason: ban?.reason || '',
        photoURL: avatarUrl(uid) || live?.profile.photoURL || null,
      };
    })
    .sort(
      (a, b) =>
        Number(b.banned) - Number(a.banned) ||
        Number(b.online) - Number(a.online) ||
        String(a.username || a.uid).localeCompare(String(b.username || b.uid))
    );
}

function broadcastDirectory() {
  io.emit('directory', publicDirectory());
}

function queueOrDeliver(uid, envelope) {
  const entry = directory.get(uid);
  if (entry?.socketId) {
    io.to(entry.socketId).emit('message', envelope);
    return 'delivered';
  }
  const queue = inbox.get(uid) || [];
  queue.push(envelope);
  if (queue.length > MAX_INBOX) queue.splice(0, queue.length - MAX_INBOX);
  inbox.set(uid, queue);
  return 'queued';
}

function sanitizeUids(uids) {
  if (!Array.isArray(uids)) return [];
  return [...new Set(uids.filter((u) => typeof u === 'string' && u.trim()))].slice(0, 256);
}

/** Pull the Firebase ID token out of an Authorization header and verify it. */
async function authenticateRequest(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Token tidak ada' });
  try {
    req.profile = await verifier.verify(token);
    // Blokir berlaku di semua jalur, bukan cuma di socket: kalau tidak, akun
    // yang diblokir masih bisa upload file atau ganti foto profil.
    const ban = moderation.banInfo(req.profile.uid);
    if (ban) {
      return res.status(403).json({ error: 'Akun ini diblokir.', banned: true, reason: ban.reason || '' });
    }
    next();
  } catch {
    res.status(401).json({ error: 'Token tidak valid' });
  }
}

/* ------------------------------------------------------------------ *
 * Profile photos
 *
 * Unlike everything else a user uploads, a profile photo is not encrypted: it
 * is meant to be visible to anyone who can see the name next to it. It is
 * served from an unguessable-ish url, but it is not a secret — the README says
 * so plainly, and the size and type are checked here rather than trusting the
 * browser.
 * ------------------------------------------------------------------ */

app.get('/api/avatar/:uid', async (req, res) => {
  const uid = String(req.params.uid || '');
  if (!avatars.has(uid)) return res.status(404).end();

  const avatar = await storage.getAvatar(uid);
  if (!avatar) return res.status(404).end();

  res.setHeader('Content-Type', avatar.contentType);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(avatar.buffer);
});

app.post(
  '/api/profile/avatar',
  authenticateRequest,
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '3mb' }),
  async (req, res) => {
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buffer.length) return res.status(400).json({ error: 'Gambar kosong.' });
    if (buffer.length > MAX_AVATAR_BYTES) {
      return res.status(413).json({
        error: `Foto terlalu besar. Maksimal ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)} MB.`,
      });
    }

    // The bytes decide the type, not the header the client sent.
    const contentType = sniffImageType(buffer);
    if (!contentType) return res.status(415).json({ error: 'Formatnya harus PNG, JPEG, atau WebP.' });

    const uid = req.profile.uid;
    try {
      const meta = await storage.putAvatar(uid, buffer, contentType);
      avatars.set(uid, { ...meta, contentType });
      if (directory.has(uid)) broadcastDirectory();
      res.json({ ok: true, photoURL: avatarUrl(uid) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }
);

app.delete('/api/profile/avatar', authenticateRequest, async (req, res) => {
  const uid = req.profile.uid;
  try {
    await storage.removeAvatar(uid);
    avatars.delete(uid);
    if (directory.has(uid)) broadcastDirectory();
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ *
 * Admin — laporan & blokir
 *
 * Halaman /admin.html hanya tampilan; keputusan tetap di sini. Siapa yang
 * boleh masuk ditentukan oleh ADMIN_EMAILS / ADMIN_UIDS di env, bukan oleh apa
 * pun yang datang dari browser.
 *
 * Laporan tidak pernah berisi isi pesan — orang yang melapor menulisinya
 * sendiri, dan adminnya tidak bisa membuka chat.
 * ------------------------------------------------------------------ */

const requireAdmin = (req, res, next) => {
  if (!isAdmin(req.profile)) return res.status(403).json({ error: 'Akun ini bukan admin.' });
  next();
};

app.get('/api/admin/overview', authenticateRequest, requireAdmin, (req, res) => {
  res.json({
    me: {
      uid: req.profile.uid,
      username: usernames.get(req.profile.uid),
      email: req.profile.email,
      photoURL: avatarUrl(req.profile.uid) || req.profile.photoURL,
    },
    admins: { uids: config.admins.uids, emails: config.admins.emails },
    reasons: REPORT_REASONS,
    stats: {
      reports: moderation.reports().length,
      open: moderation.openReportCount(),
      bans: moderation.bannedCount(),
      users: knownUids().size,
      online: onlineCount(),
    },
    reports: moderation.reports(),
    bans: moderation.bans(),
    users: adminUsers(),
  });
});

app.post('/api/admin/ban', authenticateRequest, requireAdmin, express.json(), async (req, res) => {
  const uid = String(req.body?.uid || '');
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi.' });
  if (uid === req.profile.uid) return res.status(400).json({ error: 'Nggak bisa memblokir akun sendiri.' });
  if (isAdmin({ uid, email: accounts.get(uid)?.email })) {
    return res.status(400).json({
      error: 'Akun admin nggak bisa diblokir. Hapus dulu dari ADMIN_UIDS / ADMIN_EMAILS.',
    });
  }

  const ban = await moderation.ban(uid, {
    reason: req.body?.reason,
    username: usernameFor(uid),
    by: req.profile.email || req.profile.uid,
  });

  // Sesi yang sedang jalan harus benar-benar berhenti, bukan cuma terlihat
  // berhenti: tanpa ini orangnya masih bisa mengirim pesan sampai dia reload.
  const entry = directory.get(uid);
  if (entry) {
    if (entry.socketId) {
      io.to(entry.socketId).emit('session:banned', { reason: ban.reason });
      io.sockets.sockets.get(entry.socketId)?.disconnect(true);
    }
    entry.socketId = null;
    entry.socket = null;
    broadcastDirectory();
  }

  console.log(`⛔ ${usernameFor(uid) || uid} diblokir${ban.reason ? ` — ${ban.reason}` : ''}`);
  res.json({ ok: true, ban });
});

app.post('/api/admin/unban', authenticateRequest, requireAdmin, express.json(), async (req, res) => {
  const uid = String(req.body?.uid || '');
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi.' });
  const removed = await moderation.unban(uid);
  if (removed) console.log(`✅ ${usernameFor(uid) || uid} dibuka blokirnya`);
  res.json({ ok: true, removed });
});

app.post('/api/admin/report', authenticateRequest, requireAdmin, express.json(), async (req, res) => {
  const result = await moderation.setReportStatus(req.body?.id, String(req.body?.status || ''), {
    by: req.profile.email || req.profile.uid,
    note: req.body?.note,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, report: result.report });
});

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

app.post('/api/attachments/request-upload', authenticateRequest, express.json(), async (req, res) => {
  const size = Number(req.body?.size || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return res.status(400).json({ error: 'Ukuran file tidak valid' });
  }
  if (size > config.storage.maxBytes) {
    return res.status(413).json({
      error: `File terlalu besar. Maksimal ${Math.round(config.storage.maxBytes / 1024 / 1024)} MB.`,
    });
  }

  const blobPath = newBlobPath(req.profile.uid);
  try {
    const target = await storage.createUploadTarget(blobPath);
    res.json({ path: blobPath, url: target.url, method: target.method, headers: target.headers });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/attachments/link', authenticateRequest, express.json(), async (req, res) => {
  const blobPath = String(req.body?.path || '');
  if (!isSafePath(blobPath)) return res.status(400).json({ error: 'Path tidak valid' });
  try {
    res.json({ url: await storage.createDownloadUrl(blobPath) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* Local driver only: the browser PUTs and GETs blobs through this server. */

app.put('/api/blob/*', authenticateRequest, (req, res) => {
  if (storage.driver !== 'local') return res.status(404).end();
  const blobPath = decodeURIComponent(req.params[0] || '');
  if (!isSafePath(blobPath)) return res.status(400).json({ error: 'Path tidak valid' });

  const full = resolveLocalPath(config.storage.localDir, blobPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });

  let size = 0;
  let aborted = false;
  const out = fs.createWriteStream(full);

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > config.storage.maxBytes && !aborted) {
      aborted = true;
      out.destroy();
      fs.rm(full, { force: true }, () => {});
      res.status(413).json({ error: 'File terlalu besar' });
      req.destroy();
    }
  });
  req.on('error', () => out.destroy());
  out.on('error', () => {
    if (!aborted) res.status(500).json({ error: 'Gagal menulis file' });
  });
  out.on('close', () => {
    if (!aborted) res.status(204).end();
  });

  req.pipe(out);
});

app.get('/api/blob/*', authenticateRequest, (req, res) => {
  if (storage.driver !== 'local') return res.status(404).end();
  const blobPath = decodeURIComponent(req.params[0] || '');
  if (!isSafePath(blobPath)) return res.status(400).json({ error: 'Path tidak valid' });

  const full = resolveLocalPath(config.storage.localDir, blobPath);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(full)
    .on('error', () => res.status(404).json({ error: 'Tidak ditemukan' }))
    .pipe(res);
});

/* ------------------------------------------------------------------ *
 * Socket.IO
 * ------------------------------------------------------------------ */

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const publicKey = socket.handshake.auth?.publicKey;
    if (!publicKey?.x) return next(new Error('Public key wajib dikirim'));
    const profile = await verifier.verify(token);

    // Blokir diperiksa sebelum socket jadi hidup. Alasannya ikut dikirim
    // sebagai `data` supaya browser bisa menampilkan sebabnya, bukan cuma
    // "nggak bisa tersambung".
    const ban = moderation.banInfo(profile.uid);
    if (ban) {
      const err = new Error(ban.reason ? `Akun ini diblokir: ${ban.reason}` : 'Akun ini diblokir.');
      err.data = { banned: true, reason: ban.reason || '' };
      return next(err);
    }

    socket.data.profile = profile;
    socket.data.publicKey = publicKey;
    next();
  } catch {
    next(new Error('Tidak terautentikasi'));
  }
});

io.on('connection', (socket) => {
  const { profile, publicKey } = socket.data;
  const uid = profile.uid;

  // One live session per account. Opening the app elsewhere takes over, so a
  // stale tab can't keep receiving messages or ring for calls.
  const previous = directory.get(uid);
  if (previous?.socket) previous.socket.emit('session:replaced');
  if (previous?.socketId) io.sockets.sockets.get(previous.socketId)?.disconnect(true);

  directory.set(uid, { profile, publicKey, socketId: socket.id, socket });

  // Email dan nomor HP yang sudah diverifikasi masuk ke indeks pencarian
  // kontak. Di mode dev keduanya tidak ada, jadi yang bisa dicari cuma
  // @username. Kegagalan menyimpan di sini tidak boleh menghalangi percakapan.
  accounts
    .upsert({ uid, email: profile.email, phone: profile.phone })
    .catch((err) => console.warn(`⚠️  ${err.message}`));

  const pending = inbox.get(uid) || [];
  inbox.delete(uid);

  socket.emit('ready', {
    profile,
    // null until this account claims one — the client shows the gate for that.
    username: usernames.get(uid),
    directory: publicDirectory(),
    statuses: statusListFor(uid),
    inbox: pending,
    // Cuma dipakai buat menampilkan tautan ke /admin.html; halaman itu sendiri
    // tetap memeriksa ulang ke server.
    admin: isAdmin(profile),
    server: { auth: verifier.mode, storage: storage.driver, calls: publicConfig().calls },
  });
  broadcastDirectory();

  socket.on('publish_key', (key) => {
    if (!key?.x) return;
    const entry = directory.get(uid);
    if (entry) entry.publicKey = key;
    broadcastDirectory();
  });

  socket.on('sync', (_data, ack) => ack?.({ ok: true, directory: publicDirectory() }));

  /* ---- Usernames ------------------------------------------------- *
   * The namespace belongs to the server, so the browser can only ask. The
   * server's answer is the only thing that makes a name real.
   */

  socket.on('username:check', (name, ack) => ack?.(usernames.check(name, uid)));

  socket.on('username:claim', async (name, ack) => {
    const result = await usernames.claim(name, uid);
    if (!result.ok) return ack?.(result);

    const entry = directory.get(uid);
    if (entry) {
      entry.profile = { ...entry.profile, displayName: result.username };
      socket.data.profile = entry.profile;
      broadcastDirectory();
    }
    ack?.({ ok: true, username: result.username });
  });

  /* ---- Cari kontak ---------------------------------------------- *
   * Chat cuma bisa dikirim ke kunci publik yang sudah diketahui, dan sampai
   * sekarang satu-satunya cara tahu kunci itu adalah "sedang online". Jadi
   * pencarian dikerjakan di sini: server yang punya pemetaan email/nomor → uid,
   * dan pemetaan itu tetap berlaku saat orangnya offline.
   *
   * Balasannya tidak pernah memuat email atau nomor yang tadi dipakai mencari.
   * Kalau nilainya ikut dikirim, kolom ini berubah jadi alat menebak alamat
   * orang lain, satu percobaan demi satu percobaan.
   */
  const lookupTimes = [];

  socket.on('contact:lookup', (raw, ack) => {
    if (!usernames.get(uid)) return ack?.({ ok: false, error: 'Pilih username dulu.' });

    const now = Date.now();
    while (lookupTimes.length && now - lookupTimes[0] > 60_000) lookupTimes.shift();
    if (lookupTimes.length >= 30) {
      return ack?.({ ok: false, error: 'Kebanyakan pencarian. Tunggu sebentar ya.' });
    }
    lookupTimes.push(now);

    const query = String(raw ?? '').trim();
    if (query.length < 3) {
      return ack?.({ ok: false, error: 'Tulis minimal 3 karakter: email, nomor HP, atau @username.' });
    }
    if (query.length > 120) return ack?.({ ok: false, error: 'Pencarian kepanjangan.' });

    /** uid -> alasan dia muncul, supaya layarnya bisa bilang kenapa. */
    const found = new Map();
    const add = (targetUid, via) => {
      if (!targetUid || targetUid === uid) return;
      if (!found.has(targetUid)) found.set(targetUid, via);
    };

    // 1) @username: satu nama, satu orang.
    add(usernames.ownerOf(query.replace(/^@/, '')), 'username');
    // 2) Email: harus sama persis.
    if (looksLikeEmail(query)) for (const account of accounts.findByEmail(query)) add(account.uid, 'email');
    // 3) Nomor HP: dicocokkan pada 9 angka terakhir, jadi "+62 812…" dan "0812…"
    //    menemukan orang yang sama.
    if (phoneDigits(query).length >= 7) {
      for (const account of accounts.findByPhone(query)) add(account.uid, 'phone');
    }

    const results = [...found.entries()].slice(0, 10).map(([targetUid, via]) => {
      const live = directory.get(targetUid);
      return {
        uid: targetUid,
        username: usernameFor(targetUid),
        photoURL: avatarUrl(targetUid) || live?.profile.photoURL || null,
        online: Boolean(live?.socketId),
        foundVia: via,
        banned: moderation.isBanned(targetUid),
      };
    });

    ack?.({ ok: true, results });
  });

  /* ---- Laporan -------------------------------------------------- *
   * Pelapor cuma mengirim uid + alasan; sisanya ditentukan server. Isi chat
   * tidak ikut — laporan memuat yang diketik pelapor saja, dan admin yang
   * menerimanya tetap tidak bisa membuka percakapan.
   */
  socket.on('report:submit', async (data, ack) => {
    if (!usernames.get(uid)) return ack?.({ ok: false, error: 'Pilih username dulu.' });

    const targetUid = String(data?.uid || '');
    if (!targetUid) return ack?.({ ok: false, error: 'Orang yang dilaporkan nggak jelas.' });
    // Siapa pun yang dikenal server boleh dilaporkan — termasuk yang sedang
    // offline, karena justru itu kasus yang paling sering terjadi.
    if (!knownUids().has(targetUid)) return ack?.({ ok: false, error: 'Akun itu nggak dikenal server.' });

    const result = await moderation.report({
      from: uid,
      fromName: usernames.get(uid),
      about: targetUid,
      aboutName: usernameFor(targetUid),
      reason: data?.reason,
      detail: data?.detail,
      context: data?.roomId,
    });
    if (!result.ok) return ack?.(result);

    console.log(
      `🚩 Laporan: ${usernameFor(uid) || uid} → ${usernameFor(targetUid) || targetUid} (${result.report.reasonLabel})`
    );
    ack?.({ ok: true, id: result.report.id });
  });

  socket.on('send', (envelope, ack) => {
    if (!envelope?.payload?.ct || !envelope?.roomId) {
      return ack?.({ ok: false, error: 'Envelope tidak lengkap' });
    }
    // An account without a username has no identity to send *as*, so the whole
    // flow stops here rather than letting a client skip the gate.
    if (!usernames.get(uid)) return ack?.({ ok: false, error: 'Pilih username dulu.' });

    const members = sanitizeUids(envelope.members);
    if (!members.includes(uid)) members.push(uid);

    const record = {
      id: crypto.randomUUID(),
      roomId: String(envelope.roomId),
      roomName: String(envelope.roomName || ''),
      type: envelope.type === 'group' ? 'group' : 'dm',
      members,
      from: uid,
      payload: envelope.payload,
      at: Date.now(),
    };

    const delivered = [];
    const queued = [];
    for (const member of members) {
      if (member === uid) continue;
      (queueOrDeliver(member, record) === 'delivered' ? delivered : queued).push(member);
    }
    ack?.({ ok: true, id: record.id, at: record.at, delivered, queued });
  });

  /* ---- Statuses -------------------------------------------------- *
   * Same shape as a group message: one encrypted blob with the key wrapped
   * separately for each contact. The server can see who posted something and
   * when, never what it says.
   */

  const reachMember = (member, event, payload) => {
    const target = directory.get(member);
    if (target?.socketId) io.to(target.socketId).emit(event, payload);
  };

  socket.on('status:publish', (data, ack) => {
    if (!usernames.get(uid)) return ack?.({ ok: false, error: 'Pilih username dulu.' });
    const payload = data?.payload;
    if (!payload?.ct) return ack?.({ ok: false, error: 'Status tidak lengkap.' });

    pruneStatuses();
    // Keep the newest few; the rest are old news anyway.
    const mine = [...statuses.values()].filter((s) => s.from === uid).sort((a, b) => a.at - b.at);
    while (mine.length >= MAX_STATUSES_PER_USER) statuses.delete(mine.shift().id);

    const audience = sanitizeUids(data?.members)
      .filter((member) => member !== uid && directory.has(member))
      .slice(0, 500);
    audience.push(uid);

    const status = { id: crypto.randomUUID(), from: uid, at: Date.now(), members: audience, payload };
    statuses.set(status.id, status);

    for (const member of audience) {
      if (member === uid) continue;
      reachMember(member, 'status:new', { id: status.id, from: uid, at: status.at, payload });
    }
    ack?.({ ok: true, id: status.id, at: status.at, reached: audience.length - 1 });
  });

  socket.on('status:remove', (id, ack) => {
    const status = statuses.get(String(id || ''));
    if (!status) return ack?.({ ok: false, error: 'Status tidak ditemukan.' });
    if (status.from !== uid) return ack?.({ ok: false, error: 'Itu bukan status kamu.' });

    statuses.delete(status.id);
    for (const member of status.members) {
      if (member === uid) continue;
      reachMember(member, 'status:removed', { id: status.id, from: uid });
    }
    ack?.({ ok: true });
  });

  socket.on('typing', (data) => {
    for (const member of sanitizeUids(data?.members)) {
      if (member === uid) continue;
      const target = directory.get(member);
      if (target?.socketId) {
        io.to(target.socketId).emit('typing', { roomId: data.roomId, from: uid, typing: !!data.typing });
      }
    }
  });

  // Renaming goes through the registry too: the display name *is* the username,
  // otherwise anyone could rename themselves onto a name somebody else holds.
  socket.on('profile:update', async (data, ack) => {
    const result = await usernames.claim(data?.displayName, uid);
    if (!result.ok) return ack?.(result);

    const entry = directory.get(uid);
    if (!entry) return ack?.({ ok: false, error: 'Sesi ini sudah nggak aktif.' });
    entry.profile = { ...entry.profile, displayName: result.username };
    socket.data.profile = entry.profile;
    broadcastDirectory();
    ack?.({ ok: true, username: result.username, unchanged: result.unchanged });
  });

  /* ---- Call signaling ------------------------------------------- *
   * The server only relays SDP/ICE. Media never touches it: WebRTC
   * encrypts it with DTLS-SRTP between the two browsers, and a TURN
   * relay (if used) only forwards those already-encrypted packets.
   */

  const relayTo = (toUid, event, payload) => {
    const target = directory.get(String(toUid));
    if (!target?.socketId) return false;
    io.to(target.socketId).emit(event, payload);
    return true;
  };

  socket.on('call:invite', ({ toUid, video } = {}, ack) => {
    if (!usernames.get(uid)) return ack?.({ ok: false, error: 'Pilih username dulu.' });
    const to = String(toUid || '');
    if (!directory.has(to)) return ack?.({ ok: false, error: 'User tidak ditemukan' });
    if (to === uid) return ack?.({ ok: false, error: 'Nggak bisa nelpon diri sendiri' });

    const callId = crypto.randomUUID();
    calls.set(callId, { from: uid, to, startedAt: Date.now() });

    const reachable = relayTo(to, 'call:incoming', {
      callId,
      video: !!video,
      from: { uid, displayName: profile.displayName, photoURL: profile.photoURL },
    });
    if (!reachable) {
      calls.delete(callId);
      return ack?.({ ok: false, error: 'Dia sedang offline' });
    }
    ack?.({ ok: true, callId });
  });

  /** Only the two participants of a live call may signal on it. */
  const withCall = (data, fn) => {
    const call = calls.get(String(data?.callId || ''));
    if (!call) return false;
    if (call.from !== uid && call.to !== uid) return false;
    fn(call);
    return true;
  };

  socket.on('call:signal', (data) => {
    withCall(data, (call) => relayTo(call.from === uid ? call.to : call.from, 'call:signal', {
      callId: data.callId,
      from: uid,
      data: data.data,
    }));
  });

  socket.on('call:accept', (data, ack) => {
    const ok = withCall(data, (call) => {
      relayTo(call.from, 'call:accepted', { callId: data.callId, by: uid });
    });
    ack?.({ ok });
  });

  socket.on('call:reject', (data) => {
    withCall(data, (call) => {
      relayTo(call.from === uid ? call.to : call.from, 'call:rejected', { callId: data.callId, by: uid });
      calls.delete(data.callId);
    });
  });

  socket.on('call:end', (data) => {
    withCall(data, (call) => {
      relayTo(call.from === uid ? call.to : call.from, 'call:ended', { callId: data.callId, by: uid });
      calls.delete(data.callId);
    });
  });

  /* ---- Teardown -------------------------------------------------- */

  socket.on('disconnect', () => {
    const entry = directory.get(uid);
    if (entry && entry.socketId === socket.id) {
      entry.socketId = null;
      entry.socket = null;
      broadcastDirectory();
    }
    // Never leave the other side of a call ringing forever.
    for (const [callId, call] of calls) {
      if (call.from !== uid && call.to !== uid) continue;
      relayTo(call.from === uid ? call.to : call.from, 'call:ended', { callId, by: uid, reason: 'disconnected' });
      calls.delete(callId);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

if (!process.env.NO_LISTEN) {
  server.listen(config.port, () => {
    console.log(`🔒 Secure chat jalan di http://localhost:${config.port}`);
    console.log(`   Auth    : ${verifier.mode}${verifier.mode === 'dev' ? '  ⚠️  JANGAN dipakai di server publik' : ''}`);
    console.log(`   Storage : ${storage.driver}`);
    console.log(`   Username: ${savedUsernames} klaim tersimpan (${usernameStore.kind})`);
    console.log(`   Kontak  : ${savedAccounts} akun bisa dicari lewat email/nomor (${accountStore.kind})`);
    console.log(
      `   Moderasi: ${savedModeration.bans} diblokir, ${savedModeration.reports} laporan (${moderationStore.kind})`
    );
    if (!config.admins.uids.length && !config.admins.emails.length) {
      console.log('   Admin   : belum ada — isi ADMIN_EMAILS atau ADMIN_UIDS supaya /admin.html bisa dipakai');
    }
    console.log(`   Foto    : ${avatars.size} foto profil`);
    console.log(`   TURN    : ${config.iceServers.some((s) => String(s.urls).includes('turn:')) ? 'ada' : 'nggak ada — panggilan bisa gagal di NAT ketat'}`);
  });
}

export {
  app,
  server,
  io,
  directory,
  inbox,
  calls,
  statuses,
  avatars,
  verifier,
  storage,
  usernames,
  moderation,
  accounts,
  savedUsernames,
  savedModeration,
  savedAccounts,
  isAdmin,
  adminUsers,
  avatarUrl,
  onlineCount,
};
