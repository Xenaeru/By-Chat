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
import { createAccountIndex, createAccountStore } from './accounts.js';
import { createCredentialRegistry, createCredentialStore } from './credentials.js';
import { createProfileRegistry, createProfileStore, looksLikeUserId } from './profiles.js';
import { createChannelRegistry, createChannelStore, channelSummary } from './channels.js';
import { createPushService } from './push.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

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

// Akun username + kata sandi. Dimuat sebelum verifier karena kunci tanda
// tangan sesi ikut di file ini: tanpa itu token dari /api/auth/login tidak
// bisa diperiksa, dan akun yang baru dibuat langsung tidak bisa dipakai.
const credentialStore = await createCredentialStore(config);
const credentials = await createCredentialRegistry({ store: credentialStore });
const savedCredentials = await credentials.load();

// Profil publik: ID pengguna, status, tahun lahir, sakelar profil publik,
// centang biru, jabatan, dan catatan siapa yang pernah chat dengan siapa.
const profileStore = await createProfileStore(config);
const profiles = await createProfileRegistry({ store: profileStore });
const savedProfiles = await profiles.load();

// Saluran siaran. Postingannya blob terenkripsi; yang tersimpan di sini cuma
// nama, deskripsi, pengikut, admin, dan blob itu sendiri.
const channelStore = await createChannelStore(config);
const channels = await createChannelRegistry({ store: channelStore });
const savedChannels = await channels.load();

const verifier = await createVerifier(config, {
  verifySession: (token) => credentials.verifySession(token),
});

// Web Push: satu-satunya jalan memberi tahu seseorang bahwa ada telepon masuk
// saat halamannya belum terbuka. Kalau kuncinya tidak bisa dipakai, layanan ini
// mati sendiri dan panggilan tetap bisa diterima lewat socket seperti biasa.
const push = await createPushService(config);

/** uid -> { profile, publicKey, socketId, socket } */
const directory = new Map();
/** uid -> [envelope] queued while offline */
const inbox = new Map();
/**
 * callId -> call room.
 *
 * Satu panggilan bukan lagi sepasang orang: siapa pun yang sudah diterima bisa
 * mengundang anggota lain ke room yang sama, dan server hanya meneruskan
 * SDP/ICE antar anggota. Bentuknya { id, host, video, members, ever, ... },
 * dengan `members` berisi Map(uid -> { accepted, joinedAt, invitedBy }).
 */
const calls = new Map();
/** uid -> [call log] yang belum sempat dikirim (penerima sedang offline). */
const callLogs = new Map();
/** uid -> { version, contentType, size } for the profile photo */
const avatars = new Map();
/** uid -> { version, contentType, size } untuk background kartu profil. */
const covers = new Map();
/** statusId -> { id, from, at, members, payload } */
const statuses = new Map();
/**
 * messageId -> { from, members, roomId }.
 *
 * Isi pesannya tetap tidak ada di sini — yang disimpan cuma siapa yang
 * mengirim sebuah id. Itu yang membuat "hapus untuk semua orang" bisa
 * dipercaya: pengirimnya sendiri tidak bisa diaku-aku oleh orang lain.
 */
const sentMessages = new Map();

const MAX_INBOX = 500;
const MAX_SENT_MESSAGES = 4000;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_CALL_LOGS = 40;
const MAX_CALL_MEMBERS = 8;
/** Berapa lama panggilan berdering sebelum dianggap tidak terjawab. */
const CALL_RING_MS = Math.max(5000, Number(process.env.CALL_RING_MS || 45_000));
/** A status is gone after a day, like the one everybody is used to. */
const STATUS_TTL = 24 * 60 * 60 * 1000;
const MAX_STATUSES_PER_USER = 30;

for (const entry of await storage.listAvatars()) {
  // Foto saluran dan background profil memakai storage yang sama; jangan
  // dihitung sebagai foto user.
  if (entry.uid.startsWith('chv_')) continue;
  if (entry.uid.startsWith('bg_')) {
    covers.set(entry.uid.slice(3), entry);
    continue;
  }
  avatars.set(entry.uid, entry);
}

/**
 * Statuses expire on their own. Pruning happens on access rather than on a
 * timer: an interval would keep the process alive for no good reason, and a
 * test that closes the server should be able to exit.
 */
function pruneStatuses() {
  const cutoff = Date.now() - STATUS_TTL;
  for (const [id, status] of statuses) if (status.at < cutoff) statuses.delete(id);
}

/**
 * Siapa yang boleh melihat sebuah status.
 *
 * Profil publik  → isinya siaran publik, siapa pun yang login boleh lihat.
 * Profil privat  → cuma orang yang pernah bertukar pesan langsung dengan
 *                  penulisnya. Server yang memutuskan, bukan pengirimnya:
 *                  daftar `members` dari browser tidak pernah dipercaya
 *                  sepenuhnya.
 *
 * Pemilik status selalu bisa melihat miliknya sendiri.
 */
function canSeeStatus(viewerUid, status) {
  if (status.from === viewerUid) return true;
  const author = profiles.get(status.from);
  if (status.mode === 'public' && author?.publicProfile !== false) return true;
  return profiles.hasChatted(viewerUid, status.from);
}

function statusListFor(uid) {
  pruneStatuses();
  return [...statuses.values()]
    .filter((status) => status.members.includes(uid) || canSeeStatus(uid, status))
    .sort((a, b) => a.at - b.at)
    .map((status) => ({
      id: status.id,
      from: status.from,
      at: status.at,
      payload: status.payload,
      // Nama/foto penulis ikut supaya status publik dari orang yang belum
      // pernah chat tetap punya label, bukan cuma potongan uid.
      fromName: usernameFor(status.from),
      fromPhoto: avatarUrl(status.from),
    }));
}

function avatarUrl(uid) {
  const meta = avatars.get(uid);
  // The version in the query string is what makes a new photo show up straight
  // away instead of waiting for a cache to expire.
  return meta ? `/api/avatar/${encodeURIComponent(uid)}?v=${encodeURIComponent(meta.version)}` : null;
}

function coverStorageKey(uid) {
  return `bg_${uid}`;
}

function coverUrl(uid) {
  const meta = covers.get(uid);
  if (!meta) return null;
  return `/api/cover/${encodeURIComponent(uid)}?v=${encodeURIComponent(meta.version)}`;
}

/** Foto saluran disimpan lewat storage avatar yang sama, dengan awalan sendiri. */
const channelAvatarKey = (id) => `chv_${id}`;

function channelAvatarUrl(channel) {
  if (!channel?.avatarVersion) return null;
  return `/api/channel/${encodeURIComponent(channel.id)}/avatar?v=${encodeURIComponent(
    channel.avatarVersion
  )}`;
}

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/config.json', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicConfig(push.publicKey()));
});

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    auth: verifier.mode,
    storage: storage.driver,
    users: directory.size,
    usernames: usernames.size(),
    accounts: accounts.size(),
    credentials: credentials.size(),
    profiles: profiles.size(),
    channels: channels.size(),
    avatars: avatars.size,
    trackedMessages: sentMessages.size,
    statuses: statuses.size,
    calls: calls.size,
    push: { enabled: push.enabled, subscriptions: push.count() },
    moderation: { bans: moderation.bannedCount(), openReports: moderation.openReportCount() },
  });
});

/* ---- Web Push --------------------------------------------------- *
 * Browser mendaftarkan endpoint push-nya di sini setelah izin notifikasi
 * diberikan. Yang disimpan hanya endpoint + kunci enkripsi transport milik
 * browser; isi pesannya tetap tidak pernah lewat sini.
 */
app.post(
  '/api/push/subscribe',
  authenticateRequest,
  express.json({ limit: '32kb' }),
  async (req, res) => {
    const ok = await push.subscribe(req.profile.uid, req.body?.subscription);
    if (!ok) return res.status(400).json({ error: 'Langganan push tidak valid.' });
    res.json({ ok: true });
  }
);

app.post('/api/push/unsubscribe', authenticateRequest, express.json({ limit: '8kb' }), async (req, res) => {
  await push.unsubscribe(req.profile.uid, req.body?.endpoint);
  res.json({ ok: true });
});

/* ---- Akun username + kata sandi --------------------------------- *
 * Pendaftaran cuma membuat akun; token baru diterbitkan setelah orangnya
 * benar-benar masuk lewat /api/auth/login. Itu sebabnya halaman Daftar
 * berakhir di kotak login, bukan langsung di dalam aplikasi.
 */
app.post('/api/auth/register', express.json({ limit: '4kb' }), async (req, res) => {
  const username = String(req.body?.username ?? '');
  const password = String(req.body?.password ?? '');

  // Nama yang sudah dipakai akun lain sebagai @username tidak boleh dipakai
  // masuk: kalau boleh, dua orang akan tampil dengan nama yang sama.
  if (usernames.ownerOf(username)) {
    return res.status(409).json({ error: 'Username ini sudah dipakai akun lain.' });
  }

  const result = await credentials.register({ username, password });
  if (!result.ok) return res.status(400).json({ error: result.error });

  // Akun baru langsung punya @username, jadi tidak ada langkah "pilih nama"
  // setelah masuk dan nama yang dipakai login tidak bisa direbut orang lain.
  const claim = await usernames.claim(result.username, result.uid);
  if (!claim.ok) console.warn(`⚠️  @${result.username} gagal diklaim: ${claim.error}`);

  res.json({ ok: true, username: result.username });
});

app.post('/api/auth/login', express.json({ limit: '4kb' }), async (req, res) => {
  const result = await credentials.login({
    username: req.body?.username,
    password: req.body?.password,
  });
  if (!result.ok) return res.status(401).json({ error: result.error });

  // Blokir berlaku di sini juga, sebelum token diterbitkan.
  const ban = moderation.banInfo(result.profile.uid);
  if (ban) {
    return res.status(403).json({
      error: ban.reason ? `Akun ini diblokir: ${ban.reason}` : 'Akun ini diblokir.',
      banned: true,
      reason: ban.reason || '',
    });
  }

  res.json({ token: credentials.issueSession(result.profile), profile: result.profile });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const onlineCount = () => [...directory.values()].filter((e) => e.socketId).length;

/**
 * OWNER = akun yang uid atau email-nya tercantum di env. Tidak ada jalur lain
 * untuk menjadi owner: tidak ada "pendaftar pertama jadi admin", tidak ada
 * tombol di UI, dan halaman /admin.html sendiri hanya alat — aturan yang
 * berlaku ada di sini.
 *
 * Di bawah owner ada dua jabatan yang bisa diberikan: `admin` (boleh memberi
 * moderator dan centang biru) dan `moderator` (cuma centang biru). Pemegang
 * jabatan disimpan di profiles.js, bukan di env, supaya bisa diberikan tanpa
 * restart.
 */
function isOwner(profile) {
  if (!profile) return false;
  if (config.admins.uids.includes(profile.uid)) return true;
  const email = String(profile.email || '').toLowerCase();
  return Boolean(email) && config.admins.emails.includes(email);
}

/** Nama lama tetap dipakai di beberapa tempat: admin dari env = owner. */
const isAdmin = isOwner;

/** 'owner' | 'admin' | 'moderator' | null untuk satu uid. */
function staffRank(uid) {
  const id = String(uid || '');
  if (!id) return null;
  if (isOwner({ uid: id, email: accounts.get(id)?.email })) return 'owner';
  const role = profiles.get(id)?.role || null;
  return role === 'admin' || role === 'moderator' ? role : null;
}

/** Panel admin (blokir, laporan) terbuka untuk owner dan admin, bukan moderator. */
function canUseAdminPanel(profile) {
  const rank = staffRank(profile?.uid);
  return rank === 'owner' || rank === 'admin';
}

/**
 * Centang biru yang ditampilkan. Owner dan admin selalu memakainya supaya
 * akun staf gampang dikenali; moderator hanya kalau memang diberi. `verified`
 * tetap berarti "diberikan lewat role:set", jadi mencabutnya tidak menghapus
 * centang bawaan jabatan.
 */
function isVerified(uid) {
  if (profiles.get(uid)?.verified === true) return true;
  const rank = staffRank(uid);
  return rank === 'owner' || rank === 'admin';
}

/**
 * Siapa boleh memberi apa. Aturannya sengaja satu arah: owner memberi jabatan
 * apa pun, admin memberi moderator + centang biru, moderator cuma centang
 * biru. Tidak ada jalur untuk menaikkan diri sendiri.
 */
const GRANT_RULES = {
  owner: ['admin', 'moderator', 'verified'],
  admin: ['moderator', 'verified'],
  moderator: ['verified'],
};

function canGrant(actorUid, key) {
  const rank = staffRank(actorUid);
  return Boolean(rank) && GRANT_RULES[rank].includes(key);
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
  return [...directory.entries()].map(([uid, entry]) => {
    const profile = profiles.view(uid) || {};
    return {
      uid,
      displayName: entry.profile.displayName,
      // A locally uploaded photo wins over whatever the sign-in provider had.
      photoURL: avatarUrl(uid) || entry.profile.photoURL,
      coverURL: coverUrl(uid),
      // Nomor HP sengaja TIDAK ada di sini. Dulu setiap klien menerima nomor
      // semua orang yang online; sekarang pencarian kontak dikerjakan server
      // (lihat `contact:lookup`), dan hasilnya tidak pernah memuat nomornya.
      publicKey: entry.publicKey,
      online: Boolean(entry.socketId),
      // ID publik dipakai untuk menambah kontak; badge staf ikut supaya
      // centang biru muncul di samping nama tanpa permintaan tambahan.
      id: profile.id || null,
      about: profile.about || '',
      verified: Boolean(profile.verified),
      checked: isVerified(uid),
      staff: staffRank(uid),
      publicProfile: profile.publicProfile !== false,
    };
  });
}

/** Potret profil untuk panel info — berlaku juga untuk orang yang offline. */
function profileCard(uid) {
  const profile = profiles.view(uid) || {};
  const live = directory.get(uid);
  return {
    uid: String(uid),
    username: usernameFor(uid),
    photoURL: avatarUrl(uid) || live?.profile.photoURL || null,
    coverURL: coverUrl(String(uid)),
    online: Boolean(live?.socketId),
    id: profile.id || null,
    about: profile.about || '',
    birthYear: profile.birthYear ?? null,
    publicProfile: profile.publicProfile !== false,
    verified: Boolean(profile.verified),
    checked: isVerified(uid),
    role: profile.role || null,
    staff: staffRank(uid),
    banned: moderation.isBanned(uid),
  };
}

/**
 * Satu jalur untuk mengubah jabatan/centang biru, dipakai socket dan halaman
 * admin. Semua izin diperiksa di sini supaya dua pintu itu tidak bisa berbeda
 * aturan.
 */
async function changeRole(actorUid, targetUid, key, value) {
  if (!['admin', 'moderator', 'verified'].includes(key)) {
    return { ok: false, error: 'Jabatan itu nggak dikenal.' };
  }
  if (!knownUids().has(targetUid)) return { ok: false, error: 'Akun itu nggak dikenal server.' };
  if (targetUid === actorUid) return { ok: false, error: 'Nggak bisa mengubah jabatan sendiri.' };
  if (isOwner({ uid: targetUid, email: accounts.get(targetUid)?.email })) {
    return { ok: false, error: 'Akun owner cuma diatur lewat ADMIN_EMAILS / ADMIN_UIDS.' };
  }
  if (!canGrant(actorUid, key)) {
    return { ok: false, error: 'Jabatanmu nggak cukup buat memberikan ini.' };
  }

  let me = null;
  if (key === 'verified') {
    me = await profiles.setVerified(targetUid, value === true);
  } else {
    const current = profiles.get(targetUid)?.role || null;
    let next = current;
    if (key === 'admin') next = value ? 'admin' : current === 'admin' ? null : current;
    if (key === 'moderator') {
      next = value ? (current === 'admin' ? 'admin' : 'moderator') : current === 'moderator' ? null : current;
    }
    me = await profiles.setRole(targetUid, next);
  }

  broadcastDirectory();
  const card = profileCard(targetUid);
  sendTo(targetUid, 'profile:roles', {
    me: { ...(me || {}), checked: isVerified(targetUid), username: usernameFor(targetUid) },
  });
  console.log(
    `🛡️  ${usernameFor(actorUid) || actorUid} mengubah ${key} ${usernameFor(targetUid) || targetUid} → ${
      value ? 'ya' : 'tidak'
    }`
  );
  return { ok: true, profile: card };
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
        id: profiles.get(uid)?.id || null,
        username: usernameFor(uid),
        email: account?.email || live?.profile.email || null,
        phone: account?.phone || live?.profile.phone || null,
        online: Boolean(live?.socketId),
        banned: Boolean(ban),
        banReason: ban?.reason || '',
        photoURL: avatarUrl(uid) || live?.profile.photoURL || null,
        verified: Boolean(profiles.get(uid)?.verified),
        checked: isVerified(uid),
        role: staffRank(uid),
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

/** Ingat pemilik sebuah id pesan, dengan batas jumlah supaya tidak tumbuh terus. */
function rememberSentMessage(id, info) {
  sentMessages.set(id, info);
  while (sentMessages.size > MAX_SENT_MESSAGES) sentMessages.delete(sentMessages.keys().next().value);
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

/* ------------------------------------------------------------------ *
 * Panggilan: room, roster, dan catatan panggilan
 *
 * Server tidak menyentuh media. Yang diurusnya cuma siapa ada di room mana,
 * siapa sudah menjawab, dan kapan panggilan berakhir — cukup untuk menolak
 * sinyal dari orang luar dan untuk menulis "tidak terjawab" di chat kedua
 * pihak walau salah satunya sedang offline.
 * ------------------------------------------------------------------ */

function memberInfo(uid) {
  const id = String(uid);
  const entry = directory.get(id);
  return {
    uid: id,
    displayName: usernameFor(id) || entry?.profile.displayName || id.slice(0, 8),
    photoURL: avatarUrl(id) || entry?.profile.photoURL || null,
    verified: Boolean(profiles.get(id)?.verified),
    checked: isVerified(id),
    staff: staffRank(id),
  };
}

/** Anggota yang sudah menjawab — yang boleh dipakai sebagai tujuan sinyal. */
function callRoster(call) {
  return [...call.members.entries()]
    .filter(([, member]) => member.accepted)
    .map(([uid, member]) => ({ ...memberInfo(uid), joinedAt: member.joinedAt }));
}

/** Panggilan yang sedang berjalan (termasuk yang masih berdering) untuk uid. */
function activeCallFor(uid) {
  for (const call of calls.values()) {
    if (!call.ended && call.members.has(uid)) return call;
  }
  return null;
}

function incomingPayload(call, uid) {
  const member = call.members.get(uid);
  const inviter = member?.invitedBy || call.host;
  return {
    callId: call.id,
    video: call.video,
    from: memberInfo(inviter),
    members: callRoster(call),
    startedAt: call.createdAt,
    answeredAt: call.answeredAt,
  };
}

/** Relay ke satu uid. false = orangnya sedang tidak tersambung. */
function sendTo(uid, event, payload) {
  const target = directory.get(String(uid));
  if (!target?.socketId) return false;
  io.to(target.socketId).emit(event, payload);
  return true;
}

/**
 * Undang satu orang ke room. Kalau dia tidak tersambung, notifikasinya tetap
 * dikirim lewat Web Push — itu satu-satunya cara dering tanpa halaman terbuka.
 */
function deliverCallInvite(call, uid, invitedBy) {
  const payload = incomingPayload(call, uid);
  payload.from = memberInfo(invitedBy);
  const delivered = sendTo(uid, 'call:incoming', payload);
  if (!delivered) {
    push
      .notify(uid, {
        type: 'call',
        callId: call.id,
        video: call.video,
        from: payload.from,
        members: payload.members,
        at: Date.now(),
      })
      .catch(() => {});
  }
  return delivered;
}

function takeCallLogs(uid) {
  const list = callLogs.get(String(uid));
  callLogs.delete(String(uid));
  return list || [];
}

function deliverCallLog(uid, entry) {
  if (sendTo(uid, 'call:log', entry)) return;
  const list = callLogs.get(String(uid)) || [];
  list.push(entry);
  if (list.length > MAX_CALL_LOGS) list.splice(0, list.length - MAX_CALL_LOGS);
  callLogs.set(String(uid), list);
}

/**
 * Tutup satu panggilan: beri tahu semua yang pernah terlibat, lalu catat
 * hasilnya di chat masing-masing. Durasi dihitung dari saat panggilan dijawab.
 */
function finishCall(call, reason) {
  if (!call || call.ended) return;
  call.ended = true;
  clearTimeout(call.timer);
  call.timer = null;

  const duration = call.answeredAt ? Math.max(1, Math.round((Date.now() - call.answeredAt) / 1000)) : 0;
  const answered = Boolean(call.answeredAt);
  const ever = [...call.ever];

  for (const uid of ever) {
    sendTo(uid, 'call:ended', { callId: call.id, reason, duration, answered });
    const other = ever.find((candidate) => candidate !== uid) || uid;
    deliverCallLog(uid, {
      id: crypto.randomUUID(),
      kind: answered ? 'answered' : 'missed',
      callId: call.id,
      video: call.video,
      at: Date.now(),
      duration,
      reason: reason || '',
      group: ever.length > 2,
      from: memberInfo(uid),
      to: memberInfo(other),
      participants: ever.map(memberInfo),
    });
  }

  calls.delete(call.id);
}

function leaveCall(call, uid, reason) {
  if (!call || call.ended) return;
  const member = call.members.get(uid);
  if (!member) return;
  call.members.delete(uid);

  const remaining = [...call.members.entries()].filter(([, entry]) => entry.accepted);
  // Satu orang tersisa = tidak ada lagi yang bisa diajak bicara.
  if (remaining.length < 2) return finishCall(call, reason || 'selesai');
  if (member.accepted) {
    for (const [otherUid] of remaining) {
      sendTo(otherUid, 'call:member-left', { callId: call.id, uid });
    }
  }
}

function armRingTimer(call) {
  call.timer = setTimeout(() => {
    if (call.ended || call.answeredAt) return;
    finishCall(call, 'tidak dijawab');
  }, CALL_RING_MS);
  // Timer panggilan tidak boleh menahan proses tetap hidup saat server ditutup.
  call.timer.unref?.();
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

/* ---- Background kartu profil ------------------------------------ *
 * Sama seperti foto profil: publik dan tidak dienkripsi. Bedanya cuma
 * dipotong ke rasio banner oleh browser sebelum dikirim ke sini.
 * ------------------------------------------------------------------ */

app.get('/api/cover/:uid', async (req, res) => {
  const uid = String(req.params.uid || '');
  if (!covers.has(uid)) return res.status(404).end();

  const cover = await storage.getAvatar(coverStorageKey(uid));
  if (!cover) return res.status(404).end();

  res.setHeader('Content-Type', cover.contentType);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(cover.buffer);
});

app.post(
  '/api/profile/cover',
  authenticateRequest,
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '3mb' }),
  async (req, res) => {
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buffer.length) return res.status(400).json({ error: 'Gambar kosong.' });
    if (buffer.length > MAX_AVATAR_BYTES) {
      return res.status(413).json({
        error: `Background terlalu besar. Maksimal ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)} MB.`,
      });
    }

    const contentType = sniffImageType(buffer);
    if (!contentType) return res.status(415).json({ error: 'Formatnya harus PNG, JPEG, atau WebP.' });

    const uid = req.profile.uid;
    try {
      const meta = await storage.putAvatar(coverStorageKey(uid), buffer, contentType);
      covers.set(uid, { ...meta, contentType });
      broadcastDirectory();
      res.json({ ok: true, coverURL: coverUrl(uid) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }
);

app.delete('/api/profile/cover', authenticateRequest, async (req, res) => {
  const uid = req.profile.uid;
  try {
    await storage.removeAvatar(coverStorageKey(uid));
    covers.delete(uid);
    broadcastDirectory();
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ---- Foto saluran ------------------------------------------------ *
 * Sama seperti foto profil: tidak dienkripsi, karena memang untuk dilihat
 * pengikut. Yang berbeda cuma siapa yang boleh menggantinya — admin saluran.
 */

app.get('/api/channel/:id/avatar', async (req, res) => {
  const channel = channels.get(req.params.id);
  if (!channel) return res.status(404).end();

  const avatar = await storage.getAvatar(channelAvatarKey(channel.id));
  if (!avatar) return res.status(404).end();

  res.setHeader('Content-Type', avatar.contentType);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(avatar.buffer);
});

app.post(
  '/api/channel/:id/avatar',
  authenticateRequest,
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '3mb' }),
  async (req, res) => {
    const channel = channels.get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Saluran tidak ditemukan.' });
    if (!channel.admins.includes(req.profile.uid)) {
      return res.status(403).json({ error: 'Cuma admin saluran yang bisa mengganti foto ini.' });
    }

    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buffer.length) return res.status(400).json({ error: 'Gambar kosong.' });
    if (buffer.length > MAX_AVATAR_BYTES) {
      return res.status(413).json({
        error: `Foto terlalu besar. Maksimal ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)} MB.`,
      });
    }

    const contentType = sniffImageType(buffer);
    if (!contentType) return res.status(415).json({ error: 'Formatnya harus PNG, JPEG, atau WebP.' });

    try {
      const meta = await storage.putAvatar(channelAvatarKey(channel.id), buffer, contentType);
      await channels.setAvatar(channel.id, meta.version);
      const photoURL = channelAvatarUrl({ id: channel.id, avatarVersion: meta.version });
      for (const memberUid of new Set([...channel.followers, ...channel.admins])) {
        sendTo(memberUid, 'channel:update', { channel: { ...channelSummary(channel, memberUid), avatarUrl: photoURL } });
      }
      res.json({ ok: true, photoURL });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }
);

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
  if (!canUseAdminPanel(req.profile)) return res.status(403).json({ error: 'Akun ini bukan admin.' });
  next();
};

app.get('/api/admin/overview', authenticateRequest, requireAdmin, (req, res) => {
  res.json({
    me: {
      uid: req.profile.uid,
      username: usernames.get(req.profile.uid),
      email: req.profile.email,
      photoURL: avatarUrl(req.profile.uid) || req.profile.photoURL,
      rank: staffRank(req.profile.uid),
      checked: isVerified(req.profile.uid),
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
  if (isOwner({ uid, email: accounts.get(uid)?.email })) {
    return res.status(400).json({
      error: 'Akun owner nggak bisa diblokir. Hapus dulu dari ADMIN_UIDS / ADMIN_EMAILS.',
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

/**
 * Jabatan dari halaman admin. Aturan izinnya sama persis dengan `role:set`
 * karena dua-duanya lewat changeRole: owner memberi apa pun, admin memberi
 * moderator + centang biru, dan akun owner dari env tidak bisa disentuh.
 */
app.post('/api/admin/role', authenticateRequest, requireAdmin, express.json(), async (req, res) => {
  const uid = String(req.body?.uid || '');
  if (!uid) return res.status(400).json({ error: 'uid wajib diisi.' });

  const result = await changeRole(
    req.profile.uid,
    uid,
    String(req.body?.key || ''),
    req.body?.value === true
  );
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
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

  // ID pengguna dipastikan di latar belakang, bukan dengan `await` di sini:
  // menunggu di titik ini menunda pemasangan seluruh listener, sehingga event
  // yang dikirim klien tepat setelah 'connect' (sebelum 'ready') hilang tanpa
  // jejak. Yang menunggu cuma pengiriman 'ready'.
  const profileReady = profiles
    .ensure(uid)
    .catch((err) => console.warn(`⚠️  Profil ${uid}: ${err.message}`));

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

  profileReady.then(() => socket.emit('ready', {
    profile,
    // null until this account claims one — the client shows the gate for that.
    username: usernames.get(uid),
    // Profil publik milik sendiri: ID, status, tahun lahir, sakelar publik,
    // centang biru, dan jabatan.
    me: {
      ...(profiles.view(uid) || {}),
      coverURL: coverUrl(uid),
      checked: isVerified(uid),
      username: usernames.get(uid),
    },
    roles: { rank: staffRank(uid), panel: canUseAdminPanel(profile) },
    channels: channels
      .summaries(uid)
      .filter((channel) => channel.isFollowing)
      .map((channel) => ({ ...channel, avatarUrl: channelAvatarUrl(channels.get(channel.id)) })),
    directory: publicDirectory(),
    statuses: statusListFor(uid),
    inbox: pending,
    // Catatan panggilan yang terjadi saat perangkat ini tertutup: tanpa ini,
    // "panggilan tidak terjawab" cuma terlihat oleh orang yang menelpon.
    callLogs: takeCallLogs(uid),
    // Cuma dipakai buat menampilkan tautan ke /admin.html; halaman itu sendiri
    // tetap memeriksa ulang ke server.
    admin: canUseAdminPanel(profile),
    server: { auth: verifier.mode, storage: storage.driver, calls: publicConfig().calls },
  }));
  broadcastDirectory();

  // Undangan panggilan yang masih berdering dikirim ulang setelah tersambung,
  // supaya orang yang membuka aplikasi di tengah deringan tetap bisa menjawab.
  for (const call of calls.values()) {
    const member = call.members.get(uid);
    if (member && !member.accepted && !call.ended) socket.emit('call:incoming', incomingPayload(call, uid));
  }

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
    // Sejak ID pengguna ada, menambah kontak tidak lagi memakai email/nomor HP
    // atau @username: ID itu satu-satunya alamat yang dibagikan orang. Bentuk
    // pencarian lama sengaja tidak dipertahankan — kalau dipertahankan, kolom
    // ini tetap bisa dipakai menebak alamat email orang lain.
    if (!looksLikeUserId(query)) {
      return ack?.({ ok: false, error: 'Tulis ID pengguna (6–12 angka), misalnya 17217387.' });
    }

    const found = profiles.byUserId(query);
    if (!found || found.uid === uid) return ack?.({ ok: true, results: [] });

    const live = directory.get(found.uid);
    ack?.({
      ok: true,
      results: [
        {
          uid: found.uid,
          id: found.id,
          username: usernameFor(found.uid),
          photoURL: avatarUrl(found.uid) || live?.profile.photoURL || null,
          online: Boolean(live?.socketId),
          about: found.about,
          verified: Boolean(found.verified),
          checked: isVerified(found.uid),
          staff: staffRank(found.uid),
          foundVia: 'id',
          banned: moderation.isBanned(found.uid),
        },
      ],
    });
  });

  /* ---- Kartu profil ---------------------------------------------- *
   * Panel info orang butuh data yang juga berlaku saat dia offline. Yang
   * dikirim cuma bagian publik; email dan nomor HP tidak pernah ikut.
   */
  socket.on('profile:get', (raw, ack) => {
    const target = String(raw?.uid || raw || '');
    if (!target) return ack?.({ ok: false, error: 'uid kosong.' });
    if (!knownUids().has(target)) return ack?.({ ok: false, error: 'Akun itu nggak dikenal server.' });
    ack?.({ ok: true, profile: profileCard(target) });
  });

  /* ---- Pengaturan profil ----------------------------------------- *
   * Status, tahun lahir, dan sakelar profil publik cuma boleh diubah
   * pemiliknya. Namanya tetap lewat username:claim supaya tidak ada dua orang
   * dengan nama yang sama.
   */
  socket.on('profile:settings', async (data, ack) => {
    const settings = await profiles.updateSettings(uid, {
      about: data?.about,
      birthYear: data?.birthYear,
      publicProfile: data?.publicProfile,
    });
    if (!settings) return ack?.({ ok: false, error: 'Profil nggak tersimpan.' });

    broadcastDirectory();
    ack?.({
      ok: true,
      me: {
        ...settings,
        coverURL: coverUrl(uid),
        checked: isVerified(uid),
        username: usernames.get(uid),
      },
    });
  });

  /* ---- Jabatan & centang biru ------------------------------------ *
   * Aturannya satu arah: owner memberi apa pun, admin memberi moderator dan
   * centang biru, moderator cuma centang biru. Mencabut jabatan mengikuti
   * aturan yang sama, dan akun owner dari env tidak bisa disentuh dari sini.
   */
  socket.on('role:set', async (data, ack) => {
    const result = await changeRole(
      uid,
      String(data?.uid || ''),
      String(data?.key || ''),
      data?.value === true
    );
    ack?.(result);
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

    rememberSentMessage(record.id, { from: uid, members, roomId: record.roomId });

    // Catat pasangan DM. Inilah yang membuat status orang dengan profil privat
    // tetap bisa dilihat oleh orang yang pernah mengobrol dengannya.
    if (record.type === 'dm') {
      for (const member of members) {
        if (member === uid) continue;
        profiles.markChat(uid, member).catch(() => {});
      }
    }

    const delivered = [];
    const queued = [];
    for (const member of members) {
      if (member === uid) continue;
      (queueOrDeliver(member, record) === 'delivered' ? delivered : queued).push(member);
    }
    ack?.({ ok: true, id: record.id, at: record.at, delivered, queued });
  });

  /* ---- Hapus untuk semua orang ----------------------------------- *
   * Siapa pemilik sebuah id ditentukan server, bukan klien: permintaan hapus
   * diperiksa terhadap catatan pengiriman di atas. Yang diteruskan ke anggota
   * ruangan cuma id-nya ("pesan ini sudah dihapus"), tanpa isi apa pun — server
   * memang tidak pernah menyimpan isinya.
   */
  socket.on('message:delete', (data, ack) => {
    if (!usernames.get(uid)) return ack?.({ ok: false, error: 'Pilih username dulu.' });

    const id = String(data?.id || '');
    const sent = sentMessages.get(id);
    if (!sent) return ack?.({ ok: false, error: 'Pesan itu nggak dikenal server ini.' });
    if (sent.from !== uid) {
      return ack?.({ ok: false, error: 'Cuma pengirim aslinya yang bisa menghapus untuk semua orang.' });
    }

    const gone = { deleted: true, id, roomId: sent.roomId, from: uid, at: Date.now() };
    const delivered = [];
    const queued = [];
    for (const member of sent.members) {
      if (member === uid) continue;
      (queueOrDeliver(member, gone) === 'delivered' ? delivered : queued).push(member);
    }
    ack?.({ ok: true, delivered, queued });
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

    // Status publik membawa kuncinya sendiri di dalam envelope (`payload.key`),
    // jadi siapa pun bisa membukanya. Tanpa kunci itu, isinya hanya bisa dibaca
    // orang yang kuncinya dibungkus satu per satu: mode kontak.
    //
    // Sakelar Profil Publik yang menentukan, bukan mode yang dikirim klien:
    // profil privat tidak boleh menyiarkan status ke orang asing walau
    // kliennya meminta `mode: 'public'`.
    pruneStatuses();
    const requestsPublic = data?.mode === 'public' && typeof payload.key === 'string';
    // Keep the newest few; the rest are old news anyway.
    const mine = [...statuses.values()].filter((s) => s.from === uid).sort((a, b) => a.at - b.at);
    while (mine.length >= MAX_STATUSES_PER_USER) statuses.delete(mine.shift().id);

    // Untuk profil privat, server menyaring sendiri: hanya orang yang benar-
    // benar pernah chat yang boleh menerima kunci status ini. Profil publik
    // boleh memilih lingkaran yang lebih kecil (mode kontak) tanpa disaring,
    // karena isinya memang bisa dia siarkan ke semua orang kalau mau.
    const isPrivate = profiles.get(uid)?.publicProfile === false;
    const mode = requestsPublic && !isPrivate ? 'public' : 'contacts';
    const audience =
      mode === 'public'
        ? [uid]
        : sanitizeUids(data?.members).filter(
            (member) =>
              member !== uid && (!isPrivate || profiles.hasChatted(uid, member))
          );
    if (mode === 'contacts') audience.push(uid);

    const status = {
      id: crypto.randomUUID(),
      from: uid,
      at: Date.now(),
      mode,
      members: audience,
      payload,
    };
    statuses.set(status.id, status);

    if (mode === 'public') {
      // Status publik: siapa pun yang sedang tersambung boleh menerimanya.
      socket.broadcast.emit('status:new', {
        id: status.id,
        from: uid,
        at: status.at,
        payload,
        fromName: usernameFor(uid),
        fromPhoto: avatarUrl(uid),
      });
    } else {
      for (const member of audience) {
        if (member === uid) continue;
        reachMember(member, 'status:new', {
          id: status.id,
          from: uid,
          at: status.at,
          payload,
          fromName: usernameFor(uid),
          fromPhoto: avatarUrl(uid),
        });
      }
    }

    ack?.({
      ok: true,
      id: status.id,
      at: status.at,
      mode,
      reached: mode === 'public' ? Math.max(0, onlineCount() - 1) : audience.length - 1,
    });
  });

  socket.on('status:remove', (id, ack) => {
    const status = statuses.get(String(id || ''));
    if (!status) return ack?.({ ok: false, error: 'Status tidak ditemukan.' });
    if (status.from !== uid) return ack?.({ ok: false, error: 'Itu bukan status kamu.' });

    statuses.delete(status.id);
    if (status.mode === 'public') {
      io.emit('status:removed', { id: status.id, from: uid });
    } else {
      for (const member of status.members) {
        if (member === uid) continue;
        reachMember(member, 'status:removed', { id: status.id, from: uid });
      }
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

  /* ---- Saluran --------------------------------------------------- *
   * Saluran itu satu arah: pengikut membaca, admin saluran menulis. Postingan
   * yang sampai ke pengikut tidak membawa uid penulisnya — dari sisi mereka
   * semuanya datang "dari saluran".
   */

  const channelAudience = (channel) => [...new Set([...channel.followers, ...channel.admins])];

  const channelPayload = (channel) => ({
    ...channelSummary(channel, uid),
    avatarUrl: channelAvatarUrl(channel),
    posts: channel.posts.slice(-100).map((post) => ({ id: post.id, at: post.at, payload: post.payload })),
  });

  const broadcastChannel = (channel, event = 'channel:update') => {
    for (const member of channelAudience(channel)) {
      if (member === uid) continue;
      sendTo(member, event, {
        channel: { ...channelSummary(channel, member), avatarUrl: channelAvatarUrl(channel) },
      });
    }
  };

  socket.on('channel:list', (_data, ack) => {
    if (!usernames.get(uid)) return ack?.({ ok: false, error: 'Pilih username dulu.' });
    ack?.({
      ok: true,
      channels: channels.summaries(uid).map((channel) => ({
        ...channel,
        avatarUrl: channelAvatarUrl(channels.get(channel.id)),
      })),
    });
  });

  socket.on('channel:create', async (data, ack) => {
    if (!usernames.get(uid)) return ack?.({ ok: false, error: 'Pilih username dulu.' });
    const result = await channels.create({
      name: data?.name,
      description: data?.description,
      owner: uid,
    });
    if (!result.ok) return ack?.(result);

    console.log(`📣 Saluran baru: ${result.channel.name} (${usernameFor(uid) || uid})`);
    ack?.({ ok: true, channel: channelPayload(result.channel) });
  });

  socket.on('channel:open', (data, ack) => {
    const channel = channels.get(data?.channelId);
    if (!channel) return ack?.({ ok: false, error: 'Saluran tidak ditemukan.' });

    // Daftar pengikut cuma untuk admin saluran. Pengikut biasa dapat jumlahnya
    // saja — itu yang membuat saluran terasa satu arah.
    const isChannelAdmin = channel.admins.includes(uid);
    ack?.({
      ok: true,
      channel: channelPayload(channel),
      members: isChannelAdmin ? channel.followers.map((member) => memberInfo(member)) : null,
      memberCount: channel.followers.length,
    });
  });

  socket.on('channel:update', async (data, ack) => {
    const channel = channels.get(data?.channelId);
    if (!channel) return ack?.({ ok: false, error: 'Saluran tidak ditemukan.' });
    if (!channel.admins.includes(uid)) {
      return ack?.({ ok: false, error: 'Cuma admin saluran yang bisa mengubah ini.' });
    }

    const result = await channels.update(channel.id, {
      name: data?.name,
      description: data?.description,
    });
    if (!result.ok) return ack?.(result);

    broadcastChannel(result.channel);
    ack?.({ ok: true, channel: channelPayload(result.channel) });
  });

  socket.on('channel:follow', async (data, ack) => {
    const channel = channels.get(data?.channelId);
    if (!channel) return ack?.({ ok: false, error: 'Saluran tidak ditemukan.' });

    const result = await channels.follow(channel.id, uid);
    if (!result.ok) return ack?.(result);
    ack?.({ ok: true, channel: channelPayload(result.channel) });
  });

  socket.on('channel:unfollow', async (data, ack) => {
    const channel = channels.get(data?.channelId);
    if (!channel) return ack?.({ ok: false, error: 'Saluran tidak ditemukan.' });

    const result = await channels.unfollow(channel.id, uid);
    if (!result.ok) return ack?.(result);
    ack?.({ ok: true, channel: channelPayload(result.channel) });
  });

  socket.on('channel:members', (data, ack) => {
    const channel = channels.get(data?.channelId);
    if (!channel) return ack?.({ ok: false, error: 'Saluran tidak ditemukan.' });
    if (!channel.admins.includes(uid)) {
      return ack?.({ ok: false, error: 'Daftar anggota cuma bisa dilihat admin saluran.' });
    }
    ack?.({ ok: true, members: channel.followers.map((member) => memberInfo(member)) });
  });

  socket.on('channel:admin', async (data, ack) => {
    const channel = channels.get(data?.channelId);
    if (!channel) return ack?.({ ok: false, error: 'Saluran tidak ditemukan.' });
    if (channel.owner !== uid) {
      return ack?.({ ok: false, error: 'Cuma pemilik saluran yang bisa mengangkat admin.' });
    }

    const targetUid = String(data?.uid || '');
    const result = await channels.setAdmin(channel.id, targetUid, data?.value === true);
    if (!result.ok) return ack?.(result);

    sendTo(targetUid, 'channel:update', {
      channel: { ...channelSummary(result.channel, targetUid), avatarUrl: channelAvatarUrl(result.channel) },
    });
    ack?.({ ok: true, channel: channelPayload(result.channel) });
  });

  socket.on('channel:post', async (data, ack) => {
    if (!usernames.get(uid)) return ack?.({ ok: false, error: 'Pilih username dulu.' });
    const channel = channels.get(data?.channelId);
    if (!channel) return ack?.({ ok: false, error: 'Saluran tidak ditemukan.' });
    if (!channel.admins.includes(uid)) {
      return ack?.({ ok: false, error: 'Cuma admin saluran yang bisa mengirim pesan.' });
    }

    const result = await channels.addPost(channel.id, { payload: data?.payload, from: uid });
    if (!result.ok) return ack?.(result);

    const post = { id: result.post.id, at: result.post.at, payload: result.post.payload };
    for (const member of channelAudience(channel)) {
      if (member === uid) continue;
      sendTo(member, 'channel:post', { channelId: channel.id, ...post });
    }
    ack?.({ ok: true, post });
  });

  /* ---- Call signaling ------------------------------------------- *
   * The server only relays SDP/ICE. Media never touches it: WebRTC
   * encrypts it with DTLS-SRTP between the two browsers, and a TURN
   * relay (if used) only forwards those already-encrypted packets.
   */

  /**
   * Mulai panggilan baru, atau tambah satu orang ke panggilan yang sudah jalan
   * (kalau `callId` ikut dikirim). Penerima yang sedang offline tetap boleh
   * dipanggil: panggilannya berdering sampai batas waktu, dan dia dapat
   * notifikasi push. Yang ditolak cuma yang sedang sibuk di panggilan lain.
   */
  socket.on('call:invite', ({ toUid, video, callId: joinId } = {}, ack) => {
    if (!usernames.get(uid)) return ack?.({ ok: false, error: 'Pilih username dulu.' });
    const to = String(toUid || '');
    if (to === uid) return ack?.({ ok: false, error: 'Nggak bisa nelpon diri sendiri' });
    if (!knownUids().has(to)) return ack?.({ ok: false, error: 'User tidak ditemukan' });
    if (moderation.isBanned(to)) return ack?.({ ok: false, error: 'Akun itu sedang diblokir.' });

    // Sibuk: orang yang sudah di panggilan lain (termasuk yang masih berdering)
    // tidak boleh dideringi dua kali. Pemanggilnya yang diberi tahu.
    const busy = activeCallFor(to);
    if (busy) {
      deliverCallLog(uid, {
        id: crypto.randomUUID(),
        kind: 'busy',
        callId: busy.id,
        video: Boolean(video),
        at: Date.now(),
        duration: 0,
        group: false,
        from: memberInfo(uid),
        to: memberInfo(to),
        participants: [memberInfo(uid), memberInfo(to)],
      });
      return ack?.({ ok: false, busy: true, error: 'Ada panggilan yang sedang berlangsung' });
    }

    let call = null;
    if (joinId) {
      call = calls.get(String(joinId));
      const mine = call?.members.get(uid);
      if (!call || call.ended || !mine?.accepted) {
        return ack?.({ ok: false, error: 'Panggilan itu sudah selesai.' });
      }
      if (call.members.has(to)) return ack?.({ ok: false, error: 'Dia sudah ada di panggilan ini.' });
      const accepted = [...call.members.values()].filter((member) => member.accepted).length;
      if (accepted >= MAX_CALL_MEMBERS) {
        return ack?.({ ok: false, error: `Maksimal ${MAX_CALL_MEMBERS} orang dalam satu panggilan.` });
      }
      call.members.set(to, { accepted: false, joinedAt: Date.now(), invitedBy: uid });
      call.ever.add(to);
    } else {
      if (activeCallFor(uid)) return ack?.({ ok: false, error: 'Kamu sedang dalam panggilan.' });
      call = {
        id: crypto.randomUUID(),
        host: uid,
        video: Boolean(video),
        createdAt: Date.now(),
        answeredAt: null,
        members: new Map([[uid, { accepted: true, joinedAt: Date.now(), invitedBy: uid }]]),
        ever: new Set([uid]),
        timer: null,
        ended: false,
      };
      call.members.set(to, { accepted: false, joinedAt: Date.now(), invitedBy: uid });
      call.ever.add(to);
      calls.set(call.id, call);
      armRingTimer(call);
    }

    deliverCallInvite(call, to, uid);
    ack?.({
      ok: true,
      callId: call.id,
      video: call.video,
      startedAt: call.createdAt,
      answeredAt: call.answeredAt,
      members: callRoster(call),
    });
  });

  socket.on('call:signal', (data) => {
    const call = calls.get(String(data?.callId || ''));
    if (!call || call.ended || !call.members.has(uid)) return;
    const to = String(data.toUid || '');
    const target = call.members.get(to);
    // Hanya antar anggota yang sudah menjawab; orang luar yang tahu callId
    // tetap tidak bisa menyuntikkan SDP/ICE.
    if (!target?.accepted) return;
    sendTo(to, 'call:signal', { callId: call.id, from: uid, data: data.data });
  });

  socket.on('call:accept', (data, ack) => {
    const call = calls.get(String(data?.callId || ''));
    const member = call?.members.get(uid);
    if (!call || call.ended || !member) return ack?.({ ok: false, error: 'Panggilan sudah selesai.' });

    member.accepted = true;
    if (!call.answeredAt) {
      call.answeredAt = Date.now();
      clearTimeout(call.timer);
      call.timer = null;
    }

    const members = callRoster(call);
    for (const [memberUid, entry] of call.members) {
      if (!entry.accepted) continue;
      // Yang baru masuk butuh roster lengkap; yang lain cuma perlu tahu ada
      // anggota baru supaya bisa membuka koneksi peer-to-peer ke dia.
      const event = memberUid === uid ? 'call:joined' : 'call:member-joined';
      sendTo(memberUid, event, {
        callId: call.id,
        member: memberInfo(uid),
        members,
        video: call.video,
        startedAt: call.createdAt,
        answeredAt: call.answeredAt,
      });
      // Nama event lama tetap dikirim supaya klien versi sebelumnya tidak diam
      // saja saat dipanggil dari aplikasi versi baru.
      if (memberUid !== uid) sendTo(memberUid, 'call:accepted', { callId: call.id, by: uid });
    }

    ack?.({ ok: true, members, answeredAt: call.answeredAt });
  });

  socket.on('call:reject', (data, ack) => {
    const call = calls.get(String(data?.callId || ''));
    const member = call?.members.get(uid);
    if (!call || call.ended || !member) return ack?.({ ok: false });

    call.members.delete(uid);
    // Tinggal satu orang (atau nol) = tidak ada lagi yang bisa diajak bicara.
    const left = [...call.members.values()].filter((entry) => entry.accepted).length;
    if (left < 2) return finishCall(call, 'ditolak');

    for (const [memberUid, entry] of call.members) {
      if (!entry.accepted) continue;
      sendTo(memberUid, 'call:rejected', { callId: call.id, by: uid });
    }
    ack?.({ ok: true });
  });

  // "Keluar dari panggilan" dan "akhiri panggilan" sama saja dari sisi server:
  // 1:1 otomatis selesai, grup tetap jalan untuk anggota yang tersisa.
  const hangUp = (data, ack) => {
    const call = calls.get(String(data?.callId || ''));
    if (!call || call.ended || !call.members.has(uid)) return ack?.({ ok: false });
    leaveCall(call, uid, 'selesai');
    ack?.({ ok: true });
  };

  socket.on('call:end', hangUp);
  socket.on('call:leave', hangUp);

  /* ---- Teardown -------------------------------------------------- */

  socket.on('disconnect', () => {
    const entry = directory.get(uid);
    if (entry && entry.socketId === socket.id) {
      entry.socketId = null;
      entry.socket = null;
      broadcastDirectory();
    }
    // Never leave the other side of a call ringing forever.
    for (const call of [...calls.values()]) {
      if (!call.members.has(uid)) continue;
      leaveCall(call, uid, 'disconnected');
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
    console.log(`   Akun    : ${savedCredentials} akun username+kata sandi (${credentialStore.kind})`);
    console.log(`   Profil  : ${savedProfiles} ID pengguna tersimpan (${profileStore.kind})`);
    console.log(`   Saluran : ${savedChannels} saluran (${channelStore.kind})`);
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
  credentials,
  profiles,
  channels,
  push,
  callLogs,
  savedUsernames,
  savedModeration,
  savedAccounts,
  savedCredentials,
  savedProfiles,
  savedChannels,
  isAdmin,
  isOwner,
  staffRank,
  adminUsers,
  avatarUrl,
  onlineCount,
};
