/**
 * server.js — relay + key directory + attachment broker + call signaling.
 *
 * What the server can see:
 *   - verified accounts (uid, display name, phone) and their PUBLIC keys
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
import { createStorage, isSafePath, newBlobPath, resolveLocalPath } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

const verifier = await createVerifier(config);
const storage = await createStorage(config);

/** uid -> { profile, publicKey, socketId, socket } */
const directory = new Map();
/** uid -> [envelope] queued while offline */
const inbox = new Map();
/** callId -> { from, to, startedAt } */
const calls = new Map();

const MAX_INBOX = 500;

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
  res.json({ ok: true, auth: verifier.mode, storage: storage.driver, users: directory.size, calls: calls.size });
});

app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const onlineCount = () => [...directory.values()].filter((e) => e.socketId).length;

function publicDirectory() {
  return [...directory.entries()].map(([uid, entry]) => ({
    uid,
    displayName: entry.profile.displayName,
    photoURL: entry.profile.photoURL,
    phone: entry.profile.phone,
    publicKey: entry.publicKey,
    online: Boolean(entry.socketId),
  }));
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
    next();
  } catch {
    res.status(401).json({ error: 'Token tidak valid' });
  }
}

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
    socket.data.profile = await verifier.verify(token);
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

  const pending = inbox.get(uid) || [];
  inbox.delete(uid);

  socket.emit('ready', {
    profile,
    directory: publicDirectory(),
    inbox: pending,
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

  socket.on('send', (envelope, ack) => {
    if (!envelope?.payload?.ct || !envelope?.roomId) {
      return ack?.({ ok: false, error: 'Envelope tidak lengkap' });
    }
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

  socket.on('typing', (data) => {
    for (const member of sanitizeUids(data?.members)) {
      if (member === uid) continue;
      const target = directory.get(member);
      if (target?.socketId) {
        io.to(target.socketId).emit('typing', { roomId: data.roomId, from: uid, typing: !!data.typing });
      }
    }
  });

  socket.on('profile:update', (data) => {
    const name = String(data?.displayName || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
    if (!name) return;
    const entry = directory.get(uid);
    if (!entry) return;
    entry.profile = { ...entry.profile, displayName: name };
    socket.data.profile = entry.profile;
    broadcastDirectory();
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
    console.log(`   TURN    : ${config.iceServers.some((s) => String(s.urls).includes('turn:')) ? 'ada' : 'nggak ada — panggilan bisa gagal di NAT ketat'}`);
  });
}

export { app, server, io, directory, inbox, calls, verifier, storage, onlineCount };
