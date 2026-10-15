import {
  generateIdentity,
  importPrivateKey,
  deriveSharedKey,
  encryptMessage,
  decryptMessage,
  safetyNumber,
  dmRoomId,
} from './crypto.js';
import { createAuthClient } from './auth-client.js';
import { uploadAttachment, fetchAttachment, formatBytes } from './files.js';
import { createCallManager } from './call.js';

/* ------------------------------------------------------------------ *
 * Local storage — everything here stays on this device.
 * ------------------------------------------------------------------ */
const identityKey = (uid) => `securechat.identity.v3.${uid}`;
const roomsKey = (uid) => `securechat.rooms.v3.${uid}`;
const verifiedKey = (uid) => `securechat.verified.v3.${uid}`;
const statusSeenKey = (uid) => `securechat.status.v1.${uid}`;

const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false; // quota full / storage disabled
    }
  },
  drop(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
const state = {
  config: null,
  auth: null,
  profile: null,
  me: null,
  username: null,
  directory: [],
  rooms: new Map(),
  activeRoomId: null,
  sharedKeys: new Map(),
  verified: new Set(),
  unread: new Map(),
  typingPeers: new Map(),
  calls: null,
  incoming: null,
  blobUrls: new Map(),
  uploadToken: 0,
  statuses: [],
  statusSeen: new Set(),
  statusDecoded: new Map(),
  statusView: null,
  isAdmin: false,
  replyTo: null,
};

const $ = (sel) => document.querySelector(sel);
const el = {
  boot: $('#boot'),
  login: $('#login'),
  loginFirebase: $('#login-firebase'),
  loginDev: $('#login-dev'),
  loginDevNote: $('#login-dev-note'),
  loginUsername: $('#login-username'),
  loginSubmit: $('#login-submit'),
  loginError: $('#login-error'),
  btnGoogle: $('#btn-google'),
  phoneStep1: $('#phone-step-1'),
  phoneStep2: $('#phone-step-2'),
  phoneNumber: $('#phone-number'),
  phoneShown: $('#phone-shown'),
  btnSendCode: $('#btn-send-code'),
  btnVerifyCode: $('#btn-verify-code'),
  btnChangePhone: $('#btn-change-phone'),
  otpCode: $('#otp-code'),
  recaptcha: $('#recaptcha-container'),

  onboarding: $('#onboarding'),
  usernameField: $('#username-field'),
  usernameInput: $('#username-input'),
  usernameMark: $('#username-mark'),
  usernameStatus: $('#username-status'),
  usernameSubmit: $('#username-submit'),
  usernameLogout: $('#username-logout'),

  app: $('#app'),
  meAvatar: $('#me-avatar'),
  meName: $('#me-name'),
  meStatus: $('#me-status'),
  btnAdmin: $('#btn-admin'),
  btnSettings: $('#btn-settings'),
  btnLogout: $('#btn-logout'),
  search: $('#search'),
  btnNewChat: $('#btn-new-chat'),
  btnNewGroup: $('#btn-new-group'),
  chatList: $('#chat-list'),
  chatListEmpty: $('#chat-list-empty'),
  emptyState: $('#empty-state'),
  chatView: $('#chat-view'),
  peerAvatar: $('#peer-avatar'),
  peerName: $('#peer-name'),
  peerSub: $('#peer-sub'),
  btnCallAudio: $('#btn-call-audio'),
  btnCallVideo: $('#btn-call-video'),
  btnVerify: $('#btn-verify'),
  btnBack: $('#btn-back'),
  messages: $('#messages'),
  typing: $('#typing'),
  composer: $('#composer'),
  input: $('#composer-input'),
  replyBar: $('#reply-bar'),
  replyText: $('#reply-text'),
  btnAttach: $('#btn-attach'),
  fileInput: $('#file-input'),
  uploadBar: $('#upload-bar'),
  uploadLabel: $('#upload-label'),
  uploadFill: $('#upload-fill'),
  uploadCancel: $('#upload-cancel'),

  callOverlay: $('#call-overlay'),
  remoteVideo: $('#remote-video'),
  remoteAudio: $('#remote-audio'),
  localVideo: $('#local-video'),
  callPlaceholder: $('#call-placeholder'),
  callAvatar: $('#call-avatar'),
  callName: $('#call-name'),
  callStatus: $('#call-status'),
  ctlMic: $('#ctl-mic'),
  ctlCamera: $('#ctl-camera'),
  ctlScreen: $('#ctl-screen'),
  ctlHangup: $('#ctl-hangup'),

  incoming: $('#incoming'),
  incomingAvatar: $('#incoming-avatar'),
  incomingName: $('#incoming-name'),
  incomingKind: $('#incoming-kind'),
  btnAccept: $('#btn-accept'),
  btnDecline: $('#btn-decline'),

  statusMe: $('#status-me'),
  statusMeOpen: $('#status-me-open'),
  statusMeAdd: $('#status-me-add'),
  statusMeAvatar: $('#status-me-avatar'),
  statusMeSub: $('#status-me-sub'),
  statusList: $('#status-list'),
  statusViewer: $('#status-viewer'),
  statusProgress: $('#status-progress'),
  statusStage: $('#status-stage'),
  statusViewerAvatar: $('#status-viewer-avatar'),
  statusViewerName: $('#status-viewer-name'),
  statusViewerTime: $('#status-viewer-time'),
  statusViewerCount: $('#status-viewer-count'),
  statusViewerMenu: $('#status-viewer-menu'),
  statusViewerClose: $('#status-viewer-close'),
  statusPrev: $('#status-prev'),
  statusNext: $('#status-next'),

  btnReport: $('#btn-report'),

  contactPage: $('#contact-page'),
  contactBack: $('#contact-back'),
  contactForm: $('#contact-form'),
  contactQuery: $('#contact-query'),
  contactSubmit: $('#contact-submit'),
  contactNote: $('#contact-note'),
  contactResults: $('#contact-results'),

  banned: $('#banned'),
  bannedReason: $('#banned-reason'),
  bannedLogout: $('#banned-logout'),

  modal: $('#modal'),
  modalCard: $('#modal-card'),
  toast: $('#toast'),
};

let socket = null;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
const initials = (name) => (name ? String(name).trim().charAt(0).toUpperCase() : '?');

const formatTime = (ts) => new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

function formatListTime(ts) {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? formatTime(ts) : `${d.getDate()}/${d.getMonth() + 1}`;
}

const esc = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function showToast(message, ms = 4000) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (el.toast.hidden = true), ms);
}

const peerByUid = (uid) => state.directory.find((u) => u.uid === uid);

/*
 * Avatar colour is derived from the name, so the same person is always the same
 * colour — you recognise a contact before you finish reading the name.
 */
function nameHue(name) {
  let hue = 0;
  for (const char of String(name)) hue = (hue * 31 + char.codePointAt(0)) % 360;
  return hue;
}

const photoFor = (uid) => (uid ? peerByUid(uid)?.photoURL || null : null);

function paintAvatars(root = document) {
  for (const node of root.querySelectorAll('.avatar')) {
    const seed = node.dataset.hueFor || node.textContent.trim();
    if (seed) node.style.setProperty('--hue', nameHue(seed));

    const photo = photoFor(node.dataset.uid);
    const url = photo ? new URL(photo, location.origin).href : '';
    // Only touch the style when the url really changed, otherwise every re-render
    // would make the browser fetch the same picture again.
    if ((node.dataset.photoUrl || '') === url) continue;
    node.dataset.photoUrl = url;
    if (url) {
      node.style.backgroundImage = `url("${url}")`;
      node.classList.add('has-photo');
    } else {
      node.style.removeProperty('background-image');
      node.classList.remove('has-photo');
    }
  }
}

const packMessage = (text, attachment, extra = {}) => JSON.stringify({ text: text || '', attachment: attachment || null, ...extra });

function unpackMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.text === 'string') return parsed;
  } catch {
    /* older or plain-text payload */
  }
  return { text: raw, attachment: null };
}

/* ------------------------------------------------------------------ *
 * Identity + keys
 * ------------------------------------------------------------------ */
async function loadOrCreateIdentity(uid) {
  const existing = store.get(identityKey(uid));
  if (existing?.privateKey && existing?.publicKey) return existing;
  const fresh = await generateIdentity();
  store.set(identityKey(uid), fresh);
  return fresh;
}

async function sharedKeyWith(uid) {
  const peer = peerByUid(uid);
  if (!peer?.publicKey) throw new Error(`Kunci publik ${uid.slice(0, 8)} belum tersedia`);

  const cached = state.sharedKeys.get(uid);
  if (cached && cached.pubX === peer.publicKey.x) return cached.key;

  const key = await deriveSharedKey(state.me.privateKey, peer.publicKey, state.me.uid, uid);
  state.sharedKeys.set(uid, { pubX: peer.publicKey.x, key });
  return key;
}

function referenceName(uid) {
  if (uid === state.me.uid) return { uid, displayName: state.profile.displayName, publicKey: state.me.publicJwk };
  const peer = peerByUid(uid);
  return { uid, displayName: peer?.displayName || uid.slice(0, 8), publicKey: peer?.publicKey };
}

/* ------------------------------------------------------------------ *
 * Rooms
 * ------------------------------------------------------------------ */
function ensureRoom({ id, name, type, members }) {
  let room = state.rooms.get(id);
  if (room) {
    room.members = members;
    // Nama yang datang belakangan tetap disimpan: percakapan yang dimulai dari
    // hasil pencarian kontak belum punya entri direktori saat itu.
    if (name && (type === 'group' || !room.name)) room.name = name;
    return room;
  }
  room = { id, name: name || null, type, members, messages: [] };
  state.rooms.set(id, room);
  return room;
}

const otherUid = (room) => room.members.find((m) => m !== state.me.uid);

// Nama milik direktori kalau orangnya dikenal; kalau belum (misalnya baru
// ditemukan lewat pencarian kontak dan dia masih offline), nama yang tersimpan
// di ruangannya yang dipakai.
const displayName = (room) =>
  room.type === 'group' ? room.name : peerByUid(otherUid(room))?.displayName || room.name || 'Tidak dikenal';

function saveRooms() {
  if (!state.me) return;
  const data = [...state.rooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    members: r.members,
    messages: r.messages.map((m) => ({ ...m, pending: false })),
  }));
  if (!store.set(roomsKey(state.me.uid), data)) {
    showToast('⚠️ Penyimpanan browser penuh — riwayat baru nggak kesimpan.');
  }
}

function loadRooms(uid) {
  for (const room of store.get(roomsKey(uid), [])) {
    state.rooms.set(room.id, { ...room, messages: room.messages || [] });
  }
}

/* ------------------------------------------------------------------ *
 * Auth / boot
 * ------------------------------------------------------------------ */
async function boot() {
  try {
    state.config = await fetch('/config.json', { cache: 'no-store' }).then((r) => r.json());
  } catch {
    el.boot.hidden = true;
    el.login.hidden = false;
    el.loginError.textContent = 'Gagal ambil konfigurasi server.';
    el.loginError.hidden = false;
    return;
  }

  el.boot.hidden = true;
  el.login.hidden = false;

  const firebaseMode = state.config.auth.mode === 'firebase';
  el.loginFirebase.hidden = !firebaseMode;
  el.loginDev.hidden = firebaseMode;
  el.loginDevNote.hidden = firebaseMode;

  state.auth = await createAuthClient(state.config);

  state.auth.onUserChange((profile) => {
    if (profile) enterApp(profile);
    else showLogin();
  });

  // The dev driver has no remote session to restore, so nudge it manually.
  state.auth.resume?.();
}

function showLogin() {
  socket?.disconnect();
  socket = null;
  state.me = null;
  state.profile = null;
  state.username = null;
  state.isAdmin = false;
  state.rooms.clear();
  closeOnboarding();
  closeContactPage();
  el.btnAdmin.hidden = true;
  el.banned.hidden = true;
  el.app.hidden = true;
  el.login.hidden = false;
}

async function enterApp(profile) {
  if (state.me?.uid === profile.uid && socket) return;

  closeStatusViewer();
  const identity = await loadOrCreateIdentity(profile.uid);
  state.me = {
    uid: profile.uid,
    displayName: profile.displayName,
    privateKey: await importPrivateKey(identity.privateKey),
    publicJwk: identity.publicKey,
  };
  state.profile = profile;

  state.sharedKeys.clear();
  state.verified = new Set(store.get(verifiedKey(profile.uid), []));
  state.statuses = [];
  state.statusSeen = new Set(store.get(statusSeenKey(profile.uid), []));
  state.statusDecoded.clear();
  state.statusView = null;
  state.rooms.clear();
  state.unread.clear();
  loadRooms(profile.uid);

  el.login.hidden = true;
  el.app.hidden = false;
  el.meName.textContent = profile.displayName;
  el.meAvatar.textContent = initials(profile.displayName);
  setStatus('menyambung…');

  const token = await state.auth.getIdToken();
  connect(token);
}

function setStatus(text, online = false) {
  el.meStatus.textContent = text;
  el.meStatus.classList.toggle('online', online);
}

/* ------------------------------------------------------------------ *
 * Username — the one thing a new account has to settle before it can chat
 * ------------------------------------------------------------------ */
function applyUsername(username) {
  state.username = username;
  state.profile = { ...state.profile, displayName: username };
  if (state.me) state.me.displayName = username;
  el.meName.textContent = username;
  el.meAvatar.textContent = initials(username);
  el.meAvatar.dataset.hueFor = username;
  el.meAvatar.dataset.uid = state.me?.uid || '';
  paintAvatars();
}

function setUsernameNote(text, kind = '') {
  el.usernameStatus.textContent = text;
  el.usernameStatus.hidden = !text;
  el.usernameStatus.classList.toggle('good', kind === 'good');
  el.usernameStatus.classList.toggle('bad', kind === 'bad');
  el.usernameField.classList.toggle('good', kind === 'good');
  el.usernameField.classList.toggle('bad', kind === 'bad');
  el.usernameMark.textContent = kind === 'good' ? '✓' : kind === 'bad' ? '✕' : '';
}

/** "Azhari Pratama" -> "azhari.pratama": only a starting point for the user. */
function usernameFromProfile(name) {
  return String(name || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 20);
}

function openOnboarding() {
  el.onboarding.hidden = false;
  if (!el.usernameInput.value) el.usernameInput.value = usernameFromProfile(state.profile?.displayName);
  el.usernameSubmit.disabled = true;
  setUsernameNote('Memeriksa ketersediaan…');
  checkUsername();
  el.usernameInput.focus();
}

function closeOnboarding() {
  el.onboarding.hidden = true;
}

// The server owns the namespace, so the only honest availability answer comes
// from it — the browser just asks and reports.
let usernameCheckToken = 0;

async function checkUsername() {
  const value = el.usernameInput.value.trim();
  if (!value) {
    el.usernameSubmit.disabled = true;
    return setUsernameNote('Username belum diisi.', 'bad');
  }

  const token = ++usernameCheckToken;
  const result = await new Promise((resolve) => {
    if (!socket?.connected) return resolve(null);
    const timer = setTimeout(() => resolve(null), 3000);
    socket.emit('username:check', value, (answer) => {
      clearTimeout(timer);
      resolve(answer || null);
    });
  });

  if (token !== usernameCheckToken) return; // a newer keystroke already asked

  if (!result) {
    el.usernameSubmit.disabled = true;
    return setUsernameNote('Server belum menjawab. Tunggu sebentar lalu coba lagi.', 'bad');
  }
  if (result.ok) {
    el.usernameSubmit.disabled = false;
    setUsernameNote(`@${result.username} masih kosong — siap dipakai.`, 'good');
  } else {
    el.usernameSubmit.disabled = true;
    setUsernameNote(result.suggestion ? `${result.error} Coba "${result.suggestion}".` : result.error, 'bad');
  }
}

async function claimUsername() {
  const value = el.usernameInput.value.trim();
  if (!value) return;

  el.usernameSubmit.disabled = true;
  el.usernameSubmit.textContent = 'Menyimpan…';

  const result = await new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, error: 'Belum tersambung ke server.' });
    const timer = setTimeout(() => resolve({ ok: false, error: 'Server nggak menjawab. Coba lagi.' }), 8000);
    socket.emit('username:claim', value, (answer) => {
      clearTimeout(timer);
      resolve(answer || { ok: false, error: 'Jawaban server tidak terbaca.' });
    });
  });

  el.usernameSubmit.textContent = 'Pakai username ini';

  if (!result.ok) {
    el.usernameSubmit.disabled = false;
    setUsernameNote(result.error || 'Gagal menyimpan username.', 'bad');
    // The server knows what is free; take its suggestion rather than guess.
    if (result.suggestion) el.usernameInput.value = result.suggestion;
    return;
  }

  applyUsername(result.username);
  await state.auth.setDisplayName(result.username).catch(() => {});
  closeOnboarding();
  showToast(`Username @${result.username} siap dipakai.`);
}

/* ------------------------------------------------------------------ *
 * Socket
 * ------------------------------------------------------------------ */
function connect(token) {
  socket?.disconnect();

  socket = io({
    auth: { token, publicKey: state.me.publicJwk },
    reconnectionDelayMax: 4000,
  });

  // ID tokens expire after an hour, so refresh before every reconnect.
  socket.on('reconnect_attempt', async () => {
    socket.auth = { token: await state.auth.getIdToken(), publicKey: state.me.publicJwk };
  });

  socket.on('connect', () => setStatus('online — terenkripsi end-to-end', true));

  socket.on('connect_error', (err) => {
    // Server menyertakan alasan penolakan di `data`, jadi layar yang muncul
    // bisa menjelaskan sebabnya, bukan cuma "nggak bisa tersambung".
    if (err?.data?.banned) return showBanned(err.data.reason);
    setStatus('gagal tersambung');
    showToast(`Koneksi ditolak: ${err.message}`);
  });

  // Diblokir saat sesi ini sedang jalan: servernya menutup koneksi, tapi kabar
  // ini yang membuat layarnya langsung berubah.
  socket.on('session:banned', ({ reason } = {}) => showBanned(reason));

  socket.on('disconnect', () => setStatus('terputus — mencoba lagi…'));

  socket.on('session:replaced', () => {
    showToast('Akun ini dibuka di jendela lain. Sesi di sini dihentikan.', 8000);
  });

  socket.on('ready', (payload) => {
    state.directory = payload.directory || [];
    state.statuses = payload.statuses || [];
    state.statusDecoded.clear();
    // Penanda ini cuma buat menampilkan tautan ke /admin.html; halaman itu
    // sendiri memeriksa ulang ke server siapa yang boleh masuk.
    state.isAdmin = Boolean(payload.admin);
    el.btnAdmin.hidden = !state.isAdmin;
    renderStatuses();
    // A fresh account has no username yet, and the server refuses to relay
    // messages until it has one — so this gate comes before anything else.
    if (payload.username) {
      applyUsername(payload.username);
      closeOnboarding();
    } else {
      openOnboarding();
    }
    renderChatList();
    for (const envelope of payload.inbox || []) receiveMessage(envelope);
    if (!state.activeRoomId) renderEmptyState();
    if (!payload.server?.calls?.hasTurn) {
      console.info('TURN belum dikonfigurasi — panggilan bisa gagal di NAT ketat/CGNAT.');
    }
  });

  socket.on('directory', (list) => {
    state.directory = list;
    renderChatList();
    renderPeerHeader();
    renderStatuses();
  });

  socket.on('message', (envelope) => receiveMessage(envelope));
  socket.on('message:deleted', ({ id, roomId }) => { const room = state.rooms.get(roomId); if (room) { room.messages = room.messages.filter((m) => m.id !== id); saveRooms(); if (state.activeRoomId === roomId) renderMessages(); } });

  socket.on('status:new', (status) => {
    state.statuses.push(status);
    renderStatuses();
    renderChatList();
    const name = peerByUid(status.from)?.displayName || 'seseorang';
    showToast(`Status baru dari ${name}.`, 3500);
  });

  socket.on('status:removed', ({ id }) => {
    state.statuses = state.statuses.filter((status) => status.id !== id);
    state.statusDecoded.delete(id);
    renderStatuses();
  });

  socket.on('typing', ({ roomId, from, typing }) => {
    const set = state.typingPeers.get(roomId) || new Set();
    if (typing) set.add(peerByUid(from)?.displayName || from.slice(0, 8));
    else set.delete(peerByUid(from)?.displayName || from.slice(0, 8));
    state.typingPeers.set(roomId, set);
    renderTyping();
  });

  setupCalls();
}

function setupCalls() {
  socket.on('call:incoming', (data) => {
    state.incoming = data;
    el.incomingName.textContent = data.from.displayName;
    el.incomingAvatar.textContent = initials(data.from.displayName);
    el.incomingAvatar.dataset.uid = data.from.uid;
    el.incomingKind.textContent = data.video ? 'Panggilan video masuk' : 'Panggilan suara masuk';
    el.incoming.hidden = false;
    paintAvatars();
    state.calls?.handleIncoming(data);
    renderCall(state.calls ? {} : {});
    showToast(`${data.from.displayName} menelepon…`, 5000);
  });

  state.calls = createCallManager({
    socket,
    iceServers: state.config.calls.iceServers,
    onState: (call) => renderCall(call),
    onError: (err) => showToast(`Panggilan: ${err.message}`),
  });
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */
async function sendMessage(text, attachment, extra = {}) {
  const room = state.rooms.get(state.activeRoomId);
  if (!room) return;
  if (!text.trim() && !attachment && !extra.sticker) return;
  const replyTo = extra.replyTo || state.replyTo;
  const meta = { ...extra, replyTo: replyTo ? { id: replyTo.id, from: replyTo.from, text: String(replyTo.text || '').slice(0, 240) } : null };
  delete meta.clearReply;

  const sharedKeys = new Map();
  try {
    for (const member of room.members) sharedKeys.set(member, await sharedKeyWith(member));
  } catch (err) {
    pushSystemNote(room, `⚠️ ${err.message}. Minta dia buka aplikasinya dulu.`);
    renderMessages();
    return;
  }

  const payload = await encryptMessage(packMessage(text, attachment, meta), sharedKeys);
  const local = {
    id: `local:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    from: state.me.uid,
    text,
    attachment: attachment || null,
    at: Date.now(),
    status: 'sending',
    ...meta,
  };
  room.messages.push(local);
  renderMessages();
  saveRooms();

  socket.emit('send', { roomId: room.id, roomName: room.name, type: room.type, members: room.members, payload }, (ack) => {
    if (ack?.id) local.id = ack.id;
    local.status = ack?.ok ? (ack.queued?.length ? 'sent' : 'delivered') : 'failed';
    renderMessages();
    saveRooms();
  });
  if (state.replyTo) { state.replyTo = null; if (el.replyBar) el.replyBar.hidden = true; }
}

async function receiveMessage(envelope) {
  const room = ensureRoom({
    id: envelope.roomId,
    name: envelope.roomName,
    type: envelope.type,
    members: envelope.members,
  });

  let parsed = { text: '', attachment: null };
  let error = null;
  try {
    if (!peerByUid(envelope.from)) await new Promise((r) => socket.emit('sync', {}, r));
    const key = await sharedKeyWith(envelope.from);
    parsed = unpackMessage(await decryptMessage(envelope.payload, state.me.uid, key));
  } catch (err) {
    error = err.message;
  }

  room.messages.push({
    id: envelope.id,
    from: envelope.from,
    at: envelope.at,
    text: parsed.text,
    attachment: parsed.attachment,
    replyTo: parsed.replyTo || null,
    forwardedFrom: parsed.forwardedFrom || null,
    sticker: parsed.sticker || null,
    error,
  });

  if (state.activeRoomId === room.id) renderMessages();
  else state.unread.set(room.id, (state.unread.get(room.id) || 0) + 1);

  saveRooms();
  renderChatList();
}

function pushSystemNote(room, text) {
  room.messages.push({ id: `sys:${Date.now()}:${Math.random()}`, system: true, at: Date.now(), text });
}

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */
async function sendFiles(files) {
  const room = state.rooms.get(state.activeRoomId);
  if (!room || !files?.length) return;

  const token = ++state.uploadToken;
  el.uploadBar.hidden = false;

  const stages = { encrypt: 'Mengenkripsi', upload: 'Mengunggah' };
  for (const file of files) {
    if (token !== state.uploadToken) break;
    try {
      const attachment = await uploadAttachment({
        file,
        getIdToken: () => state.auth.getIdToken(),
        maxBytes: state.config.files.maxBytes,
        onStage: (stage, fraction) => {
          if (token !== state.uploadToken) return;
          el.uploadLabel.textContent = `${stages[stage] || stage} ${file.name}`;
          el.uploadFill.style.width = `${Math.round(fraction * 100)}%`;
        },
      });
      if (token !== state.uploadToken) break;
      el.uploadFill.style.width = '0%';
      await sendMessage(file.name ? '' : '', attachment);
    } catch (err) {
      showToast(`Gagal kirim ${file.name}: ${err.message}`, 6000);
    }
  }

  if (token === state.uploadToken) el.uploadBar.hidden = true;
}

async function downloadAttachment(message, container) {
  if (message.attachment?.localUrl) {
    window.open(message.attachment.localUrl, '_blank');
    return;
  }

  const token = ++state.uploadToken;
  el.uploadBar.hidden = false;
  el.uploadLabel.textContent = `Mengunduh ${message.attachment.name}`;

  try {
    const url = await fetchAttachment({
      attachment: message.attachment,
      getIdToken: () => state.auth.getIdToken(),
      onStage: (stage, fraction) => {
        if (token !== state.uploadToken) return;
        el.uploadLabel.textContent = `${stage === 'decrypt' ? 'Mendekripsi' : 'Mengunduh'} ${message.attachment.name}`;
        el.uploadFill.style.width = `${Math.round(fraction * 100)}%`;
      },
    });
    if (token !== state.uploadToken) return;
    state.blobUrls.set(message.id, url);

    if (message.attachment.mime?.startsWith('image/') || message.attachment.mime?.startsWith('video/')) {
      renderMessages();
    } else {
      const link = document.createElement('a');
      link.href = url;
      link.download = message.attachment.name || 'file';
      link.click();
    }
  } catch (err) {
    showToast(`Gagal ambil file: ${err.message}`, 6000);
  } finally {
    if (token === state.uploadToken) el.uploadBar.hidden = true;
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */
function renderEmptyState() {
  el.emptyState.hidden = false;
  el.chatView.hidden = true;
}

function selectRoom(roomId) {
  state.activeRoomId = roomId;
  state.unread.set(roomId, 0);
  const room = state.rooms.get(roomId);
  if (!room) return renderEmptyState();

  el.emptyState.hidden = true;
  el.chatView.hidden = false;
  el.app.classList.add('show-chat');
  renderPeerHeader();
  renderMessages();
  renderChatList();
  el.input.focus();
}

function renderPeerHeader() {
  const room = state.rooms.get(state.activeRoomId);
  if (!room) return;
  const name = displayName(room);
  el.peerName.textContent = room.type === 'group' ? room.name : name;
  el.peerAvatar.textContent = initials(room.type === 'group' ? room.name : name);
  el.peerAvatar.dataset.uid = room.type === 'dm' ? otherUid(room) : '';

  const isDm = room.type === 'dm';
  const canCall = isDm && state.config.calls.enabled;
  el.btnCallAudio.hidden = !canCall;
  el.btnCallVideo.hidden = !canCall;
  el.btnVerify.hidden = !isDm;

  if (!isDm) {
    const names = room.members.filter((m) => m !== state.me.uid).map((m) => peerByUid(m)?.displayName || '?');
    el.peerSub.textContent = `${room.members.length} anggota · ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`;
    return;
  }

  el.btnReport.hidden = !isDm;

  const peer = peerByUid(otherUid(room));
  const shield = state.verified.has(otherUid(room)) ? '🛡️ ' : '';
  el.peerSub.textContent = !peer
    ? room.name
      ? 'offline — dia harus buka aplikasinya dulu'
      : 'tidak dikenal'
    : shield + (peer.online ? 'online' : 'terakhir dilihat baru-baru ini');
  paintAvatars();
}

function renderChatList() {
  const filter = el.search.value.trim().toLowerCase();
  const rooms = [...state.rooms.values()].sort((a, b) => {
    const at = a.messages[a.messages.length - 1]?.at || 0;
    const bt = b.messages[b.messages.length - 1]?.at || 0;
    return bt - at;
  });

  el.chatList.innerHTML = '';
  let shown = 0;

  for (const room of rooms) {
    const name = displayName(room);
    if (filter && !name.toLowerCase().includes(filter)) continue;
    shown++;

    const last = room.messages[room.messages.length - 1];
    const unread = state.unread.get(room.id) || 0;
    const peerOnline = room.type === 'dm' && peerByUid(otherUid(room))?.online;

    const peerUid = room.type === 'dm' ? otherUid(room) : null;
    const peerStatuses = peerUid ? statusesFrom(peerUid).length : 0;
    const ring = peerStatuses ? (unseenStatusCount(peerUid) ? ' ring' : ' ring-seen') : '';

    const li = document.createElement('li');
    li.className = 'chat-item' + (room.id === state.activeRoomId ? ' active' : '');
    li.innerHTML = `
      <div class="avatar${ring}"${peerUid ? ` data-uid="${esc(peerUid)}"` : ''}>${esc(initials(name))}</div>
      <div class="chat-item-main">
        <div class="chat-item-top">
          <span class="chat-item-name">${esc(name)}${room.type === 'group' ? ' 👥' : ''}</span>
          <span class="chat-item-time">${last ? formatListTime(last.at) : ''}</span>
        </div>
        <div class="chat-item-sub">${esc(preview(last))}</div>
      </div>
      ${peerOnline ? '<span class="dot"></span>' : ''}
      ${unread ? `<span class="badge">${unread}</span>` : ''}
    `;
    li.addEventListener('click', () => selectRoom(room.id));
    // Tapping the picture opens the status, the way the ring suggests it should.
    if (peerStatuses) {
      li.querySelector('.avatar').addEventListener('click', (event) => {
        event.stopPropagation();
        openStatusViewer(peerUid);
      });
    }
    el.chatList.appendChild(li);
  }

  el.chatListEmpty.hidden = shown > 0;
  el.chatListEmpty.textContent = filter ? 'Nggak ada chat yang cocok.' : 'Belum ada chat. Tekan ＋ buat mulai.';
  paintAvatars(el.chatList);
}

function preview(message) {
  if (!message) return '🔒 Belum ada pesan';
  if (message.system) return message.text;
  const body = message.attachment ? `📎 ${message.attachment.name}` : message.text ?? '⚠️ nggak bisa didekripsi';
  return message.from === state.me?.uid ? `Kamu: ${body}` : body;
}

function attachmentNode(message) {
  const wrap = document.createElement('div');
  wrap.className = 'attach';
  const cached = state.blobUrls.get(message.id);
  const a = message.attachment;
  if (cached && a.mime?.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = cached;
    img.alt = a.name || 'Foto';
    img.addEventListener('click', (event) => { event.stopPropagation(); openMediaViewer(cached, 'image', a.name); });
    wrap.appendChild(img);
    return wrap;
  }
  if (cached && a.mime?.startsWith('video/')) {
    const video = document.createElement('video');
    video.className = 'chat-video'; video.src = cached; video.controls = true; video.playsInline = true; video.preload = 'metadata';
    video.addEventListener('click', (event) => event.stopPropagation());
    wrap.appendChild(video);
    const name = document.createElement('div'); name.className = 'attach-size'; name.textContent = `${a.name || 'Video'} · ${formatBytes(a.size)}`; wrap.appendChild(name);
    return wrap;
  }
  wrap.innerHTML = `
    <span class="attach-icon">${a.mime?.startsWith('image/') ? '🖼️' : a.mime?.startsWith('video/') ? '🎬' : a.mime?.startsWith('audio/') ? '🎵' : '📄'}</span>
    <span class="attach-info"><span class="attach-name">${esc(a.name)}</span><span class="attach-size">${esc(formatBytes(a.size))} · terenkripsi</span></span>
  `;
  wrap.addEventListener('click', () => downloadAttachment(message, wrap));
  return wrap;
}

function openMediaViewer(url, type, name = '') {
  let viewer = document.getElementById('media-viewer');
  if (!viewer) {
    viewer = document.createElement('div'); viewer.id = 'media-viewer'; viewer.className = 'media-viewer';
    viewer.innerHTML = '<button type="button" class="media-viewer-close" aria-label="Tutup">×</button><div class="media-viewer-content"></div>';
    viewer.addEventListener('click', (event) => { if (event.target === viewer || event.target.closest('.media-viewer-close')) { viewer.hidden = true; viewer.querySelector('.media-viewer-content').innerHTML = ''; } });
    document.body.appendChild(viewer);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { viewer.hidden = true; viewer.querySelector('.media-viewer-content').innerHTML = ''; } });
  }
  const content = viewer.querySelector('.media-viewer-content'); content.innerHTML = '';
  const media = document.createElement(type === 'video' ? 'video' : 'img'); media.src = url; media.alt = name || 'Media';
  if (type === 'video') { media.controls = true; media.autoplay = true; media.playsInline = true; }
  content.appendChild(media); viewer.hidden = false;
}

function messageActions(message, room) {
  const actions = document.createElement('div'); actions.className = 'msg-actions';
  const add = (label, title, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); actions.appendChild(b); };
  add('↩', 'Balas', () => { state.replyTo = message; if (el.replyBar) { el.replyBar.hidden = false; el.replyText.textContent = (message.text || message.attachment?.name || message.sticker || 'Pesan').slice(0, 120); } el.input.focus(); });
  add('↗', 'Teruskan', async () => {
    const targets = [...state.rooms.values()].filter((r) => r.id !== room.id && r.type === 'dm');
    if (!targets.length) return showToast('Belum ada chat lain untuk tujuan penerusan.');
    const labels = targets.map((r, i) => `${i + 1}. ${r.name || r.members.filter((u) => u !== state.me.uid).map((u) => peerByUid(u)?.displayName || u.slice(0, 8)).join(', ')}`).join('\n');
    const choice = Number(prompt(`Teruskan ke chat mana?\n${labels}\nMasukkan nomor:`));
    const target = targets[choice - 1]; if (!target) return;
    const previous = state.activeRoomId; selectRoom(target.id);
    await sendMessage(message.text || '', message.attachment || null, { forwardedFrom: { from: message.from, text: (message.text || message.attachment?.name || message.sticker || '').slice(0, 240) }, sticker: message.sticker || null });
    if (previous && previous !== target.id) selectRoom(previous);
  });
  add('🗑', 'Hapus', () => {
    const isOwnMessage = message.from === state.me.uid;
    if (isOwnMessage) {
      const deleteForEveryone = confirm('Hapus pesan ini untuk semua orang?\n\nOK = Hapus untuk semua orang\nBatal = Hapus untuk diri sendiri saja');
      if (deleteForEveryone) {
        // Only the original sender may request global deletion. Remove the local
        // copy only after the server confirms that authorization and deletion succeeded.
        socket.emit('message:delete-everyone', { id: message.id, roomId: room.id }, (ack) => {
          if (!ack?.ok) {
            showToast(ack?.error || 'Gagal menghapus untuk semua orang.');
            return;
          }
          room.messages = room.messages.filter((m) => m.id !== message.id);
          saveRooms();
          if (state.activeRoomId === room.id) renderMessages();
        });
        return;
      }
    }

    // Delete-for-me is local to this account. A message sent by another person
    // can never be globally deleted by this client.
    room.messages = room.messages.filter((m) => m.id !== message.id);
    saveRooms();
    if (state.activeRoomId === room.id) renderMessages();
  });
  return actions;
}

function renderMessages() {
  const room = state.rooms.get(state.activeRoomId);
  el.messages.innerHTML = '';
  if (!room) return;

  for (const message of room.messages) {
    if (message.system) {
      const note = document.createElement('div');
      note.className = 'system-note';
      note.textContent = message.text;
      el.messages.appendChild(note);
      continue;
    }

    const mine = message.from === state.me.uid;
    const div = document.createElement('div');
    div.className = 'msg' + (mine ? ' out' : '') + (message.error ? ' undecryptable' : '');

    if (room.type === 'group' && !mine) {
      const sender = document.createElement('span');
      sender.className = 'msg-sender';
      sender.textContent = peerByUid(message.from)?.displayName || 'Tidak dikenal';
      div.appendChild(sender);
    }

    if (message.error) {
      div.appendChild(document.createTextNode(`⚠️ pesan ini nggak bisa dibuka (${message.error})`));
    } else {
      if (message.forwardedFrom) { const f = document.createElement('div'); f.className = 'msg-forwarded'; f.textContent = '↗ Diteruskan'; div.appendChild(f); }
      if (message.replyTo) { const r = document.createElement('div'); r.className = 'msg-reply'; r.textContent = `↩ ${message.replyTo.text || 'Pesan'}`; div.appendChild(r); }
      if (message.sticker) { const st = document.createElement('div'); st.className = 'msg-sticker'; st.textContent = message.sticker; div.appendChild(st); }
      if (message.attachment) div.appendChild(attachmentNode(message));
      if (message.text) div.appendChild(document.createTextNode(message.text));
    }

    const meta = document.createElement('span');
    meta.className = 'msg-meta';
    meta.innerHTML = `${formatTime(message.at)} ${mine ? statusIcon(message.status) : ''}`;
    div.appendChild(meta);

    div.appendChild(messageActions(message, room));
    el.messages.appendChild(div);
  }

  el.messages.scrollTop = el.messages.scrollHeight;
  renderTyping();
}

function statusIcon(status) {
  if (status === 'sending') return '🕓';
  if (status === 'failed') return '⚠️';
  if (status === 'delivered') return '<span style="color:#53bdeb">✓✓</span>';
  return '✓';
}

function renderTyping() {
  const peers = [...(state.typingPeers.get(state.activeRoomId) || [])];
  if (!peers.length) {
    el.typing.hidden = true;
    return;
  }
  el.typing.hidden = false;
  el.typing.textContent = peers.length === 1 ? `${peers[0]} sedang menulis…` : 'beberapa orang sedang menulis…';
}

/* ------------------------------------------------------------------ *
 * Call UI
 * ------------------------------------------------------------------ */
function renderCall(call = {}) {
  const active = state.calls?.active;
  el.callOverlay.hidden = !active;

  if (!active) {
    el.incoming.hidden = true;
    state.incoming = null;
    el.remoteVideo.srcObject = null;
    if (el.remoteAudio) el.remoteAudio.srcObject = null;
    el.localVideo.srcObject = null;
    if (call.endedPeer) {
      showToast(
        call.endedReason
          ? `Panggilan dengan ${call.endedPeer} berakhir: ${call.endedReason}.`
          : `Panggilan dengan ${call.endedPeer} berakhir.`
      );
    }
    return;
  }

  if (call.localStream) el.localVideo.srcObject = call.localStream;

  if (call.remoteStream && call.remoteStream.getTracks().length) {
    // Separate audio playback avoids a browser/video-element quirk where remote
    // audio tracks are connected but inaudible on audio-only calls.
    el.remoteVideo.muted = true;
    el.remoteVideo.srcObject = call.remoteStream;
    if (el.remoteAudio) { el.remoteAudio.srcObject = call.remoteStream; el.remoteAudio.volume = 1; el.remoteAudio.play().catch(() => showToast('Browser memblokir audio otomatis. Ketuk layar lalu aktifkan suara.')); }
    el.callPlaceholder.hidden = true;
  } else {
    el.callPlaceholder.hidden = false;
  }

  const peerName = call.peer?.displayName || '—';
  el.callName.textContent = peerName;
  el.callAvatar.textContent = initials(peerName);
  el.callAvatar.dataset.uid = call.peer?.uid || '';
  el.callStatus.textContent =
    call.status === 'outgoing' ? 'memanggil…' : call.status === 'incoming' ? 'panggilan masuk' : 'menyambungkan…';

  el.ctlMic.classList.toggle('off', call.micOn === false);
  el.ctlCamera.classList.toggle('off', call.cameraOn === false);
  el.ctlScreen.classList.toggle('off', call.screenSharing === true);
  paintAvatars();
}

function startCall(video) {
  const room = state.rooms.get(state.activeRoomId);
  if (!room || room.type !== 'dm') return;
  const uid = otherUid(room);
  const peer = peerByUid(uid);
  if (!peer) return showToast('Kontak nggak dikenal.');
  if (!peer.online) return showToast(`${peer.displayName} sedang offline.`);

  state.calls
    .startCall(uid, { displayName: peer.displayName, photoURL: peer.photoURL }, { video })
    .catch((err) => showToast(err.message));
}

/* ------------------------------------------------------------------ *
 * Modals
 * ------------------------------------------------------------------ */
function openModal(html) {
  el.modalCard.innerHTML = html;
  el.modal.hidden = false;
  paintAvatars(el.modalCard);
}

function closeModal() {
  el.modal.hidden = true;
  el.modalCard.innerHTML = '';
}

/* ------------------------------------------------------------------ *
 * Tambah kontak
 *
 * Chat selalu lahir dari halaman ini. Alasannya bukan tampilan: server hanya
 * bisa merelai pesan ke kunci publik yang sudah dikenal, dan satu-satunya cara
 * mengenal orang adalah mencarinya lewat email, nomor HP, atau @username.
 * `+` jadi membuka halaman ini, bukan daftar orang yang kebetulan online.
 * ------------------------------------------------------------------ */
const VIA_LABEL = { username: 'username', email: 'email', phone: 'nomor HP' };

function setContactNote(text, kind = '') {
  el.contactNote.textContent = text;
  el.contactNote.hidden = !text;
  el.contactNote.classList.toggle('good', kind === 'good');
  el.contactNote.classList.toggle('bad', kind === 'bad');
}

function openContactPage() {
  closeModal();
  el.contactPage.hidden = false;
  el.contactQuery.value = '';
  el.contactResults.innerHTML = '';
  el.contactResults.hidden = true;
  setContactNote(
    'Orang yang belum pernah kamu chat nggak muncul sendiri. Cari pakai email, nomor HP, atau @username — hasilnya tetap ada walau dia sedang offline.'
  );
  el.contactQuery.focus();
}

function closeContactPage() {
  el.contactPage.hidden = true;
}

function renderContactResults(results) {
  el.contactResults.innerHTML = '';
  el.contactResults.hidden = results.length === 0;

  for (const person of results) {
    const name = person.username || person.uid.slice(0, 8);
    const status = person.banned
      ? 'diblokir admin — nggak bisa di-chat'
      : `${person.online ? 'online' : 'offline'} · ditemukan lewat ${VIA_LABEL[person.foundVia] || 'pencarian'}`;

    const li = document.createElement('li');
    li.className = 'contact-result';
    li.dataset.uid = person.uid;
    li.innerHTML = `
      <span class="avatar" data-uid="${esc(person.uid)}">${esc(initials(name))}</span>
      <span class="contact-result-main">
        <strong>${esc(name)}</strong>
        <span class="muted">${esc(status)}</span>
      </span>
      <span class="contact-go">${person.banned ? '—' : 'Chat'}</span>
    `;
    li.addEventListener('click', () => {
      if (person.banned) return showToast('Akun itu diblokir admin, jadi nggak bisa di-chat.');
      openContactRoom(person.uid, person.username);
    });
    el.contactResults.appendChild(li);
  }

  paintAvatars(el.contactResults);
}

async function lookupContact() {
  const query = el.contactQuery.value.trim();
  if (query.length < 3) {
    return setContactNote('Tulis minimal 3 karakter: email, nomor HP, atau @username.', 'bad');
  }

  el.contactSubmit.disabled = true;
  el.contactSubmit.textContent = 'Mencari…';
  setContactNote('Mencari…');

  const result = await new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, error: 'Belum tersambung ke server.' });
    const timer = setTimeout(() => resolve({ ok: false, error: 'Server nggak menjawab. Coba lagi.' }), 8000);
    socket.emit('contact:lookup', query, (answer) => {
      clearTimeout(timer);
      resolve(answer || { ok: false, error: 'Jawaban server tidak terbaca.' });
    });
  });

  el.contactSubmit.disabled = false;
  el.contactSubmit.textContent = 'Cari';

  if (!result.ok) return setContactNote(result.error || 'Pencarian gagal.', 'bad');

  const results = result.results || [];
  renderContactResults(results);
  if (!results.length) {
    return setContactNote(
      `Tidak ada yang cocok dengan "${query}". Cek lagi ejaannya, atau minta dia masuk dulu supaya akunnya terdaftar.`,
      'bad'
    );
  }
  setContactNote(`${results.length} kontak ditemukan. Ketuk barisnya buat mulai chat.`, 'good');
}

function openContactRoom(uid, name) {
  const id = dmRoomId(state.me.uid, uid);
  ensureRoom({ id, name, type: 'dm', members: [state.me.uid, uid] });
  saveRooms();
  closeContactPage();
  selectRoom(id);

  // Kunci publik orang yang sedang offline belum tentu ada di perangkat ini,
  // jadi direktori disegarkan: kalau dia online, chat-nya langsung bisa jalan.
  socket?.emit('sync', {}, (answer) => {
    if (!answer?.directory) return;
    state.directory = answer.directory;
    renderChatList();
    renderPeerHeader();
    renderStatuses();
  });
}

/** Orang yang sudah kamu tambahkan sebagai kontak — sumber daftar anggota grup. */
function contactList() {
  const uids = new Set();
  for (const room of state.rooms.values()) {
    if (room.type !== 'dm') continue;
    const uid = otherUid(room);
    if (uid && uid !== state.me.uid) uids.add(uid);
  }
  return [...uids].map((uid) => ({
    uid,
    name: peerByUid(uid)?.displayName || state.rooms.get(dmRoomId(state.me.uid, uid))?.name || uid.slice(0, 8),
    online: Boolean(peerByUid(uid)?.online),
  }));
}

/* ------------------------------------------------------------------ *
 * Laporan
 * ------------------------------------------------------------------ */
function openReportModal() {
  const room = state.rooms.get(state.activeRoomId);
  if (!room || room.type !== 'dm') return;

  const target = otherUid(room);
  const label = displayName(room);
  const reasons = state.config.reports?.reasons || [];
  const maxDetail = Number(state.config.reports?.maxDetail) || 400;

  openModal(`
    <h3>Laporkan ${esc(label)}</h3>
    <p class="sub">
      Laporan masuk ke admin aplikasi ini. Isi chat kamu nggak ikut terkirim — yang
      dikirim cuma alasan dan catatan yang kamu tulis di bawah.
    </p>

    <label for="report-reason">Alasan</label>
    <select id="report-reason">
      ${reasons
        .map((reason, index) => `<option value="${esc(reason.id)}"${index === 0 ? ' selected' : ''}>${esc(reason.label)}</option>`)
        .join('')}
    </select>

    <label for="report-detail">Cerita singkat (opsional)</label>
    <textarea id="report-detail" maxlength="${maxDetail}" placeholder="misal: dia kirim link penipuan dan minta uang"></textarea>

    <div class="modal-actions">
      <button data-close>Batal</button>
      <button class="primary" data-send>Kirim laporan</button>
    </div>
  `);

  el.modalCard.querySelector('[data-close]').addEventListener('click', closeModal);
  el.modalCard.querySelector('[data-send]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Mengirim…';

    const reason = el.modalCard.querySelector('#report-reason').value;
    const detail = el.modalCard.querySelector('#report-detail').value.trim();

    const result = await new Promise((resolve) => {
      if (!socket?.connected) return resolve({ ok: false, error: 'Belum tersambung ke server.' });
      const timer = setTimeout(() => resolve({ ok: false, error: 'Server nggak menjawab. Coba lagi.' }), 8000);
      socket.emit('report:submit', { uid: target, reason, detail, roomId: room.id }, (answer) => {
        clearTimeout(timer);
        resolve(answer || { ok: false, error: 'Jawaban server tidak terbaca.' });
      });
    });

    if (!result.ok) {
      button.disabled = false;
      button.textContent = 'Kirim laporan';
      return showToast(result.error || 'Laporan gagal dikirim.');
    }

    closeModal();
    showToast('Laporan terkirim ke admin. Terima kasih sudah bilang.');
  });
}

/* ------------------------------------------------------------------ *
 * Akun diblokir
 * ------------------------------------------------------------------ */
function showBanned(reason) {
  socket?.disconnect();
  socket = null;
  el.bannedReason.textContent = reason
    ? `Alasan dari admin: ${reason}`
    : 'Admin nggak menulis alasan. Coba tanya langsung ke pengelola aplikasi ini.';
  el.banned.hidden = false;
  el.app.hidden = true;
  el.login.hidden = true;
  el.onboarding.hidden = true;
}

function openNewGroup() {
  // Anggota grup diambil dari kontak yang sudah ditambahkan, bukan dari daftar
  // "siapa yang kebetulan online": kalau tidak, halaman tambah kontak cuma jadi
  // formalitas yang bisa dilewati lewat grup.
  const people = contactList();
  openModal(`
    <h3>Grup baru</h3>
    <p class="sub">Grup tetap end-to-end encrypted — kunci pesan dibungkus terpisah buat tiap anggota.</p>
    <label for="group-name">Nama grup</label>
    <input id="group-name" type="text" maxlength="40" placeholder="misal: Tim Kantor" />
    <label>Anggota</label>
    <ul class="picker">
      ${people
        .map(
          (u) => `<li><input type="checkbox" value="${esc(u.uid)}" id="m-${esc(u.uid)}" />
            <label for="m-${esc(u.uid)}" style="margin:0;color:var(--text);font-size:14px">${esc(u.name)}</label></li>`
        )
        .join('')}
    </ul>
    <div class="modal-actions">
      <button data-close>Batal</button>
      <button class="primary" data-create>Buat grup</button>
    </div>
  `);
  el.modalCard.querySelector('[data-close]').addEventListener('click', closeModal);
  el.modalCard.querySelector('[data-create]').addEventListener('click', () => {
    const name = el.modalCard.querySelector('#group-name').value.trim();
    const members = [...el.modalCard.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
    if (!name) return showToast('Nama grup belum diisi.');
    if (!members.length) return showToast('Pilih minimal satu anggota.');
    const id = `group:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    ensureRoom({ id, name, type: 'group', members: [state.me.uid, ...members] });
    saveRooms();
    closeModal();
    selectRoom(id);
  });
}

function openSettings() {
  const { maxBytes } = state.config.files;
  openModal(`
    <h3>Pengaturan</h3>
    <p class="sub">${state.config.auth.mode === 'firebase' ? 'Login lewat Firebase' : 'Mode dev — identitas nggak diverifikasi'}</p>

    <div class="photo-row">
      <div class="avatar big" id="settings-avatar" data-uid="${esc(state.me.uid)}">${esc(initials(state.username || state.profile.displayName))}</div>
      <div class="photo-actions">
        <button data-pick-photo class="ghost">Ganti foto</button>
        <button data-remove-photo class="ghost">Hapus</button>
        <span class="sub">PNG, JPEG, atau WebP — maksimal 2 MB. Foto profil <strong>tidak</strong> terenkripsi, jadi jangan pakai foto yang kamu nggak mau orang lihat.</span>
      </div>
      <input type="file" id="avatar-input" accept="image/png,image/jpeg,image/webp" hidden />
    </div>

    <label for="display-name">Username</label>
    <input id="display-name" type="text" maxlength="20" value="${esc(state.username || state.profile.displayName)}" />
    <p class="sub" style="margin:8px 0 0">
      Orang lain lihat kamu sebagai <strong>@${esc(state.username || '—')}</strong>. Nama ini unik —
      kalau sudah dipakai orang, ganti yang lain.
    </p>
    <p class="sub" style="margin-top:16px">
      Akun: <code>${esc(state.me.uid.slice(0, 16))}…</code><br />
      ${state.profile.phone ? `Nomor: ${esc(state.profile.phone)}<br />` : ''}
      Penyimpanan file: <strong>${esc(state.config.files.driver)}</strong> (maks ${Math.round(maxBytes / 1024 / 1024)} MB)<br />
      Relay panggilan: <strong>${state.config.calls.hasTurn ? 'STUN + TURN' : 'STUN saja'}</strong>
    </p>
    <p class="sub">Private key kamu cuma ada di browser ini. Ganti akun atau hapus data browser = riwayat lama nggak bisa dibuka lagi.</p>
    <div class="modal-actions">
      <button data-close>Tutup</button>
      <button class="primary" data-save>Simpan</button>
    </div>
  `);
  el.modalCard.querySelector('[data-close]').addEventListener('click', closeModal);
  el.modalCard.querySelector('[data-save]').addEventListener('click', async () => {
    const name = el.modalCard.querySelector('#display-name').value.trim();
    if (!name) return;

    // Renaming goes through the same namespace as the first claim, so a name
    // somebody else already holds is refused here too.
    const result = await new Promise((resolve) => {
      if (!socket) return resolve({ ok: false, error: 'Belum tersambung ke server.' });
      socket.emit('profile:update', { displayName: name }, (answer) => resolve(answer || {}));
    });
    if (!result.ok) return showToast(result.error || 'Gagal simpan username.', 5000);

    await state.auth.setDisplayName(result.username).catch(() => {});
    applyUsername(result.username);
    closeModal();
    showToast(`Username disimpan: @${result.username}`);
  });

  // The photo saves on its own, the way people expect from a profile picture.
  el.modalCard.querySelector('[data-pick-photo]')?.addEventListener('click', () => {
    el.modalCard.querySelector('#avatar-input')?.click();
  });
  el.modalCard.querySelector('#avatar-input')?.addEventListener('change', async (event) => {
    const [file] = event.target.files || [];
    event.target.value = '';
    try {
      await uploadAvatar(file);
    } catch (err) {
      showToast(`Foto profil: ${err.message}`, 6000);
    }
  });
  el.modalCard.querySelector('[data-remove-photo]')?.addEventListener('click', async () => {
    try {
      await removeAvatar();
      showToast('Foto profil dihapus.');
    } catch (err) {
      showToast(`Foto profil: ${err.message}`, 6000);
    }
  });
}

function openSafetyNumber() {
  const room = state.rooms.get(state.activeRoomId);
  if (!room || room.type !== 'dm') return;
  const uid = otherUid(room);
  const peer = peerByUid(uid);
  if (!peer?.publicKey) return showToast('Kunci publik dia belum ada.');

  safetyNumber(referenceName(state.me.uid), peer).then((code) => {
    const verified = state.verified.has(uid);
    openModal(`
      <h3>Safety number</h3>
      <p class="sub">
        Cocokkan angka ini dengan ${esc(peer.displayName)} lewat jalur lain (tatap muka, telepon).
        Kalau sama, berarti nggak ada yang nyisipin kunci palsu di tengah.
      </p>
      <div class="safety">${esc(code)}</div>
      ${verified ? '<p class="verified-tag">🛡️ Ditandai terverifikasi</p>' : ''}
      <p class="sub" style="margin-top:16px">
        Login cuma buktiin akun ke server — enkripsinya tetap dari kunci di perangkat kamu.
      </p>
      <div class="modal-actions">
        <button data-close>Tutup</button>
        <button class="primary" data-verify>${verified ? 'Hapus tanda' : 'Tandai terverifikasi'}</button>
      </div>
    `);
    el.modalCard.querySelector('[data-close]').addEventListener('click', closeModal);
    el.modalCard.querySelector('[data-verify]').addEventListener('click', () => {
      verified ? state.verified.delete(uid) : state.verified.add(uid);
      store.set(verifiedKey(state.me.uid), [...state.verified]);
      closeModal();
      renderPeerHeader();
    });
  });
}

/* ------------------------------------------------------------------ *
 * Status — hilang sendiri setelah 24 jam
 *
 * Isinya lewat jalur yang persis sama dengan pesan grup: satu blob terenkripsi
 * dengan kunci yang dibungkus terpisah untuk tiap kontak. Server cuma tahu
 * siapa yang memasang sesuatu dan kapan.
 * ------------------------------------------------------------------ */
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const STATUS_BACKGROUNDS = ['#1231f0', '#0369a1', '#0f766e', '#7c3aed', '#b91c1c', '#0f172a', '#a16207'];

const liveStatuses = () => state.statuses.filter((status) => status.at > Date.now() - STATUS_TTL_MS);

const statusesFrom = (uid) =>
  liveStatuses()
    .filter((status) => status.from === uid)
    .sort((a, b) => a.at - b.at);

const unseenStatusCount = (uid) =>
  uid === state.me?.uid ? 0 : statusesFrom(uid).filter((status) => !state.statusSeen.has(status.id)).length;

/** Siapa yang punya status aktif; yang belum dilihat ditaruh di depan. */
function statusOwnerList() {
  const owners = [];
  for (const status of liveStatuses()) if (!owners.includes(status.from)) owners.push(status.from);

  return owners.sort((a, b) => {
    const unseen = (unseenStatusCount(b) > 0 ? 1 : 0) - (unseenStatusCount(a) > 0 ? 1 : 0);
    if (unseen) return unseen;
    return (statusesFrom(b).at(-1)?.at || 0) - (statusesFrom(a).at(-1)?.at || 0);
  });
}

function markStatusSeen(id) {
  if (state.statusSeen.has(id)) return;
  state.statusSeen.add(id);
  store.set(statusSeenKey(state.me.uid), [...state.statusSeen].slice(-500));
  renderStatuses();
  renderChatList();
}

function renderStatuses() {
  if (!state.me) return;

  const mine = statusesFrom(state.me.uid);
  el.statusMeAvatar.textContent = initials(state.username || state.profile.displayName);
  el.statusMeAvatar.dataset.uid = state.me.uid;
  el.statusMeAvatar.classList.toggle('ring', mine.length > 0);
  el.statusMeSub.textContent = mine.length
    ? `${mine.length} status · terakhir ${formatListTime(mine.at(-1).at)}`
    : 'Ketuk buat tambah status';

  const chattedUids = new Set([...state.rooms.values()].filter((room) => room.type === 'dm' && room.messages.some((m) => !m.system)).flatMap((room) => room.members.filter((uid) => uid !== state.me.uid)));
  const owners = statusOwnerList().filter((uid) => uid !== state.me.uid && chattedUids.has(uid));
  el.statusList.innerHTML = '';
  el.statusList.hidden = owners.length === 0;

  for (const uid of owners) {
    const name = peerByUid(uid)?.displayName || uid.slice(0, 8);
    const unseen = unseenStatusCount(uid) > 0;
    const last = statusesFrom(uid).at(-1);

    const li = document.createElement('li');
    li.className = 'status-item';
    li.dataset.uid = uid;
    li.innerHTML = `
      <span class="avatar ${unseen ? 'ring' : 'ring-seen'}" data-uid="${esc(uid)}">${esc(initials(name))}</span>
      <span class="status-item-text">
        <strong>${esc(name)}</strong>
        <span class="muted">${unseen ? 'Belum dilihat' : 'Sudah dilihat'} · ${formatListTime(last.at)}</span>
      </span>
    `;
    li.addEventListener('click', () => openStatusViewer(uid));
    el.statusList.appendChild(li);
  }

  paintAvatars();
}

/** Status baru: { text, color, attachment }. Teks lama tetap terbaca. */
function unpackStatus(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.text === 'string') {
      return { text: parsed.text, color: parsed.color || null, attachment: parsed.attachment || null };
    }
  } catch {
    /* payload teks biasa */
  }
  return { text: String(raw ?? ''), color: null, attachment: null };
}

async function decodeStatus(status) {
  const cached = state.statusDecoded.get(status.id);
  if (cached) return cached;

  let decoded;
  try {
    // A status can arrive from somebody this device has not met yet.
    if (!peerByUid(status.from)) await new Promise((resolve) => socket.emit('sync', {}, resolve));
    const key = await sharedKeyWith(status.from);
    decoded = unpackStatus(await decryptMessage(status.payload, state.me.uid, key));
    decoded.error = null;
  } catch (err) {
    decoded = { text: '', color: null, attachment: null, error: err.message };
  }

  state.statusDecoded.set(status.id, decoded);
  return decoded;
}

/* ------------------------------------------------------------------ *
 * Foto profil
 *
 * Satu-satunya unggahan yang sengaja TIDAK dienkripsi: foto profil memang
 * untuk dilihat orang yang melihat namamu. Server tetap memeriksa ukuran dan
 * jenis gambar dari byte aslinya, bukan dari header yang dikirim browser.
 * ------------------------------------------------------------------ */

/** Perkecil foto besar supaya unggahannya kecil; PNG/WebP kecil dibiarkan utuh. */
async function prepareAvatarFile(file) {
  if (file.size <= 512 * 1024 && ['image/png', 'image/webp'].includes(file.type)) return file;

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  if (!blob) throw new Error('Gagal memproses gambar.');
  return blob;
}

async function uploadAvatar(file) {
  if (!file) return;
  const token = await state.auth.getIdToken();
  if (!token) throw new Error('Belum login.');

  const body = await prepareAvatarFile(file);
  const response = await fetch('/api/profile/avatar', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': body.type || 'image/jpeg' },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Gagal unggah (${response.status}).`);

  applyOwnPhoto(data.photoURL);
  showToast('Foto profil diperbarui.');
}

async function removeAvatar() {
  const token = await state.auth.getIdToken();
  const response = await fetch('/api/profile/avatar', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Gagal menghapus (${response.status}).`);
  }
  applyOwnPhoto(null);
}

function applyOwnPhoto(photoURL) {
  const entry = peerByUid(state.me.uid);
  if (entry) entry.photoURL = photoURL || null;
  state.profile = { ...state.profile, photoURL: photoURL || null };
  paintAvatars();
}

/* ------------------------------------------------------------------ *
 * Status: penampil + pembuat
 * ------------------------------------------------------------------ */
const STATUS_SHOW_MS = 7000;
let statusToken = 0;
let statusAdvance = null;

async function openStatusViewer(uid, at = null) {
  const list = statusesFrom(uid);
  if (!list.length) return;

  const firstUnseen = list.findIndex((status) => !state.statusSeen.has(status.id));
  state.statusView = { uid, index: at ?? (firstUnseen === -1 ? 0 : firstUnseen), token: ++statusToken };
  el.statusViewer.hidden = false;
  renderStatusView();
}

function closeStatusViewer() {
  state.statusView = null;
  statusToken++;
  clearTimeout(statusAdvance);
  if (el.statusViewer) el.statusViewer.hidden = true;
  if (el.statusStage) el.statusStage.innerHTML = '';
  if (state.me) renderStatuses();
}

function nextStatus(step) {
  const view = state.statusView;
  if (!view) return;

  const list = statusesFrom(view.uid);
  const next = view.index + step;
  if (next < 0) return;
  if (next >= list.length) return closeStatusViewer();

  view.index = next;
  view.token = ++statusToken;
  renderStatusView();
}

function scheduleStatusAdvance() {
  clearTimeout(statusAdvance);
  if (!state.statusView) return;
  statusAdvance = setTimeout(() => nextStatus(1), STATUS_SHOW_MS);
}

async function renderStatusView() {
  const view = state.statusView;
  if (!view) return;

  const list = statusesFrom(view.uid);
  if (!list.length || view.index >= list.length) return closeStatusViewer();

  const status = list[view.index];
  const mine = view.uid === state.me.uid;
  const name = mine ? `@${state.username || 'aku'}` : peerByUid(view.uid)?.displayName || 'Tidak dikenal';

  el.statusViewerName.textContent = name;
  el.statusViewerAvatar.textContent = initials(name);
  el.statusViewerAvatar.dataset.uid = view.uid;
  el.statusViewerTime.textContent = formatListTime(status.at);
  el.statusViewerCount.textContent = `${view.index + 1} dari ${list.length}`;
  el.statusViewerMenu.hidden = !mine;
  el.statusProgress.innerHTML = list
    .map((_, i) => `<i class="${i < view.index ? 'done' : i === view.index ? 'now' : ''}"></i>`)
    .join('');

  el.statusStage.innerHTML = '<div class="status-note">Membuka…</div>';
  const decoded = await decodeStatus(status);
  // Kabur kalau pembukanya sudah pindah atau ditutup selagi menunggu.
  if (!state.statusView || state.statusView.token !== view.token) return;

  markStatusSeen(status.id);
  await paintStatusStage(decoded, mine ? 'Ketuk ikon tempat sampah buat menghapus ini' : '');
  if (!decoded.attachment?.mime?.startsWith('video/')) scheduleStatusAdvance();
}

async function paintStatusStage(decoded, hint = '') {
  if (decoded.error) {
    el.statusStage.innerHTML = `<div class="status-text" style="--status-bg:#7f1d1d">⚠️ ${esc(decoded.error)}</div>`;
    return;
  }

  if (decoded.attachment) {
    el.statusStage.innerHTML = '<div class="status-note">Membuka media…</div>';
    try {
      const url = await fetchAttachment({
        attachment: decoded.attachment,
        getIdToken: () => state.auth.getIdToken(),
      });
      const isVideo = decoded.attachment.mime?.startsWith('video/');
      el.statusStage.innerHTML = `
        ${isVideo ? '<video class="status-video" controls autoplay playsinline></video>' : '<img class="status-image" alt="Status" />'}
        ${decoded.text ? `<span class="status-caption">${esc(decoded.text)}</span>` : ''}
        ${hint ? `<span class="status-hint">${esc(hint)}</span>` : ''}
      `;
      const media = el.statusStage.querySelector(isVideo ? 'video' : 'img');
      media.src = url;
      if (isVideo) { media.onended = () => nextStatus(1); media.play().catch(() => {}); }
    } catch (err) {
      el.statusStage.innerHTML = `<div class="status-text" style="--status-bg:#7f1d1d">⚠️ ${esc(err.message)}</div>`;
    }
    return;
  }

  el.statusStage.innerHTML = `
    <div class="status-text" style="--status-bg:${decoded.color || STATUS_BACKGROUNDS[0]}">${esc(decoded.text)}</div>
    ${hint ? `<span class="status-hint">${esc(hint)}</span>` : ''}
  `;
}

async function publishStatus({ text, color, attachment }) {
  // Everybody who can see the name gets a wrapped copy of the status key.
  const chattedUids = new Set([...state.rooms.values()].filter((room) => room.type === 'dm' && room.messages.some((m) => !m.system)).flatMap((room) => room.members.filter((uid) => uid !== state.me.uid)));
  const audience = [...new Set([...state.directory.filter((user) => user.uid !== state.me.uid && user.publicKey && chattedUids.has(user.uid)).map((user) => user.uid), state.me.uid])];

  const keys = new Map();
  for (const uid of audience) {
    try {
      keys.set(uid, await sharedKeyWith(uid));
    } catch {
      /* tanpa kunci publiknya dia memang nggak bisa baca */
    }
  }

  const payload = await encryptMessage(
    JSON.stringify({ text, color, attachment: attachment || null }),
    keys
  );

  const result = await new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, error: 'Belum tersambung ke server.' });
    const timer = setTimeout(() => resolve({ ok: false, error: 'Server nggak menjawab.' }), 20000);
    socket.emit('status:publish', { payload, members: [...keys.keys()] }, (answer) => {
      clearTimeout(timer);
      resolve(answer || {});
    });
  });

  if (!result.ok) throw new Error(result.error || 'Gagal membagikan status.');

  // The publisher is not sent its own status back, so keep it locally.
  state.statuses.push({ id: result.id, from: state.me.uid, at: result.at, payload });
  renderStatuses();
  return result;
}

async function deleteStatus(id) {
  const result = await new Promise((resolve) => {
    if (!socket) return resolve({ ok: false, error: 'Belum tersambung ke server.' });
    socket.emit('status:remove', id, resolve);
  });
  if (!result?.ok) throw new Error(result?.error || 'Gagal menghapus status.');
  state.statuses = state.statuses.filter((status) => status.id !== id);
  state.statusDecoded.delete(id);
  renderStatuses();
}

function openStatusComposer() {
  openModal(`
    <h3>Buat status</h3>
    <p class="sub">Hilang sendiri setelah 24 jam. Isinya terenkripsi end-to-end — server cuma lihat blob.</p>
    <textarea id="status-text" maxlength="280" placeholder="Tulis sesuatu…"></textarea>
    <div class="swatch-row" id="status-colors">
      ${STATUS_BACKGROUNDS.map(
        (color, index) =>
          `<button type="button" class="swatch${index === 0 ? ' active' : ''}" data-color="${color}" style="--swatch:${color}" aria-label="Warna ${index + 1}"></button>`
      ).join('')}
    </div>
    <p class="sub" id="status-note">Pilih warna latar, atau lampirkan foto/video.</p>
    <input type="file" id="status-photo" accept="image/*,video/mp4,video/webm,video/quicktime" hidden />
    <div class="modal-actions">
      <button data-close>Batal</button>
      <button data-photo>Lampirkan foto</button>
      <button class="primary" data-publish>Bagikan</button>
    </div>
  `);

  let chosenFile = null;
  let color = STATUS_BACKGROUNDS[0];
  const note = () => el.modalCard.querySelector('#status-note');

  el.modalCard.querySelector('#status-colors').addEventListener('click', (event) => {
    const button = event.target.closest('[data-color]');
    if (!button) return;
    color = button.dataset.color;
    for (const node of el.modalCard.querySelectorAll('.swatch')) node.classList.toggle('active', node === button);
  });

  el.modalCard.querySelector('[data-photo]').addEventListener('click', () => {
    el.modalCard.querySelector('#status-photo').click();
  });

  el.modalCard.querySelector('#status-photo').addEventListener('change', (event) => {
    [chosenFile] = event.target.files || [];
    note().textContent = chosenFile ? `Siap dibagikan: ${chosenFile.name}` : 'Pilih warna latar, atau lampirkan foto/video.';
  });

  el.modalCard.querySelector('[data-publish]').addEventListener('click', async () => {
    const text = el.modalCard.querySelector('#status-text').value.trim();
    if (!text && !chosenFile) return showToast('Tulis sesuatu atau lampirkan foto dulu.');

    const publish = el.modalCard.querySelector('[data-publish]');
    publish.disabled = true;

    try {
      let attachment = null;
      if (chosenFile) {
        attachment = await uploadAttachment({
          file: chosenFile,
          getIdToken: () => state.auth.getIdToken(),
          maxBytes: state.config.files.maxBytes,
          onStage: (stage, fraction) => {
            const verb = stage === 'encrypt' ? 'Mengenkripsi' : 'Mengunggah';
            note().textContent = `${verb} ${chosenFile.name}… ${Math.round(fraction * 100)}%`;
          },
        });
      }

      await publishStatus({ text, color, attachment });
      closeModal();
      showToast('Status dibagikan. Hilang sendiri dalam 24 jam.');
      const mine = statusesFrom(state.me.uid);
      openStatusViewer(state.me.uid, mine.length - 1);
    } catch (err) {
      note().textContent = `Gagal: ${err.message}`;
      publish.disabled = false;
    }
  });

  el.modalCard.querySelector('[data-close]').addEventListener('click', closeModal);
}

/* ------------------------------------------------------------------ *
 * Username wiring
 * ------------------------------------------------------------------ */
let usernameTimer = null;

el.usernameInput.addEventListener('input', () => {
  el.usernameSubmit.disabled = true;
  // The previous answer was about a different value, so stop showing it as if
  // it still described what is in the field.
  setUsernameNote('Memeriksa ketersediaan…');
  clearTimeout(usernameTimer);
  // Typing should not fire a request per keystroke, but the answer still has to
  // arrive while the person is looking at the field.
  usernameTimer = setTimeout(checkUsername, 300);
});

el.usernameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (!el.usernameSubmit.disabled) claimUsername();
  }
});

el.usernameSubmit.addEventListener('click', claimUsername);

el.usernameLogout.addEventListener('click', async () => {
  if (!confirm('Keluar dan pakai akun lain?')) return;
  await state.auth.signOut();
  location.reload();
});

/* ------------------------------------------------------------------ *
 * Login wiring
 * ------------------------------------------------------------------ */
el.btnGoogle.addEventListener('click', async () => {
  el.loginError.hidden = true;
  el.btnGoogle.disabled = true;
  try {
    await state.auth.signInWithGoogle();
  } catch (err) {
    el.loginError.textContent = googleError(err);
    el.loginError.hidden = false;
  } finally {
    el.btnGoogle.disabled = false;
  }
});

function googleError(err) {
  if (err.code === 'auth/popup-blocked') return 'Popup diblokir browser. Izinkan popup lalu coba lagi.';
  if (err.code === 'auth/operation-not-allowed') return 'Google sign-in belum diaktifkan di Firebase Console.';
  if (err.code === 'auth/unauthorized-domain') return 'Domain ini belum didaftarkan di Firebase → Authentication → Settings → Authorized domains.';
  return err.message || 'Login Google gagal.';
}

el.btnSendCode.addEventListener('click', async () => {
  el.loginError.hidden = true;
  const phone = el.phoneNumber.value.trim();
  if (!phone) return showToast('Isi nomor HP dulu (format internasional, misal +62812…).');

  el.btnSendCode.disabled = true;
  el.btnSendCode.textContent = 'Mengirim…';
  try {
    const handle = await state.auth.startPhoneSignIn(phone, el.recaptcha);
    state.phoneHandle = handle;
    el.phoneShown.textContent = phone;
    el.phoneStep1.hidden = true;
    el.phoneStep2.hidden = false;
    el.otpCode.focus();
  } catch (err) {
    el.loginError.textContent = err.message || 'Gagal kirim OTP.';
    el.loginError.hidden = false;
  } finally {
    el.btnSendCode.disabled = false;
    el.btnSendCode.textContent = 'Kirim kode OTP';
  }
});

el.btnVerifyCode.addEventListener('click', async () => {
  const code = el.otpCode.value.trim();
  if (!code) return;
  el.loginError.hidden = true;
  el.btnVerifyCode.disabled = true;
  try {
    await state.phoneHandle.confirm(code);
  } catch (err) {
    el.loginError.textContent = err.message || 'Kode salah.';
    el.loginError.hidden = false;
  } finally {
    el.btnVerifyCode.disabled = false;
  }
});

el.btnChangePhone.addEventListener('click', () => {
  el.phoneStep1.hidden = false;
  el.phoneStep2.hidden = true;
  el.otpCode.value = '';
});

el.loginDev.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.loginError.hidden = true;
  el.loginSubmit.disabled = true;
  try {
    await state.auth.signInAs(el.loginUsername.value);
  } catch (err) {
    el.loginError.textContent = err.message;
    el.loginError.hidden = false;
  } finally {
    el.loginSubmit.disabled = false;
  }
});

/* ------------------------------------------------------------------ *
 * App wiring
 * ------------------------------------------------------------------ */
el.btnLogout.addEventListener('click', async () => {
  if (!confirm('Keluar? Identitas dan riwayat di browser ini akan dihapus dan nggak bisa dibuka lagi.')) return;
  store.drop(identityKey(state.me.uid));
  store.drop(roomsKey(state.me.uid));
  await state.auth.signOut();
  location.reload();
});

el.btnSettings.addEventListener('click', openSettings);
// `+` membuka halaman tambah kontak, bukan daftar orang yang sedang online.
el.btnNewChat.addEventListener('click', openContactPage);
el.btnReport.addEventListener('click', openReportModal);
el.btnAdmin.addEventListener('click', () => window.open('/admin.html', '_blank', 'noopener'));
el.contactForm.addEventListener('submit', (event) => {
  event.preventDefault();
  lookupContact();
});
el.contactBack.addEventListener('click', closeContactPage);
el.bannedLogout.addEventListener('click', async () => {
  await state.auth.signOut();
  location.reload();
});

/* Status: satu baris di sidebar buat lihat punya sendiri, satu tombol buat bikin. */
el.statusMeOpen.addEventListener('click', () => {
  const mine = statusesFrom(state.me.uid);
  if (mine.length) openStatusViewer(state.me.uid, mine.length - 1);
  else openStatusComposer();
});
el.statusMeAdd.addEventListener('click', openStatusComposer);

el.statusViewerClose.addEventListener('click', closeStatusViewer);
el.statusPrev.addEventListener('click', () => nextStatus(-1));
el.statusNext.addEventListener('click', () => nextStatus(1));
el.statusViewerMenu.addEventListener('click', async () => {
  const view = state.statusView;
  if (!view || view.uid !== state.me.uid) return;
  const status = statusesFrom(view.uid)[view.index];
  if (!status) return;

  try {
    await deleteStatus(status.id);
    showToast('Status dihapus.');
    nextStatus(0);
  } catch (err) {
    showToast(err.message);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!el.statusViewer.hidden) return closeStatusViewer();
  if (!el.contactPage.hidden) closeContactPage();
});
el.btnNewGroup.addEventListener('click', openNewGroup);
el.btnVerify.addEventListener('click', openSafetyNumber);
el.btnBack.addEventListener('click', () => el.app.classList.remove('show-chat'));
el.search.addEventListener('input', renderChatList);

el.btnCallAudio.addEventListener('click', () => startCall(false));
el.btnCallVideo.addEventListener('click', () => startCall(true));
el.ctlHangup.addEventListener('click', () => state.calls?.end());
el.ctlMic.addEventListener('click', () => state.calls?.toggleMic());
el.ctlCamera.addEventListener('click', () => state.calls?.toggleCamera().catch((e) => showToast(e.message)));
el.ctlScreen.addEventListener('click', () => state.calls?.toggleScreenShare().catch((e) => showToast(e.message)));

el.btnAccept.addEventListener('click', () => {
  el.incoming.hidden = true;
  state.calls?.acceptCall();
});
el.btnDecline.addEventListener('click', () => {
  el.incoming.hidden = true;
  state.calls?.rejectCall();
});

el.modal.addEventListener('click', (event) => {
  if (event.target === el.modal) closeModal();
});

el.btnAttach.addEventListener('click', () => el.fileInput.click());
function showEmojiPicker(button, stickerMode = false) {
  document.querySelector('.emoji-picker')?.remove();
  const values = stickerMode ? ['😂','🥹','😍','😭','👍','❤️','🔥','🙏','🎉','😎','🤔','💯','👀','✨','🫡','🤝','🥳','🤗','💖','🙌'] : ['😀','😂','🥹','😍','🥳','😭','👍','❤️','🔥','🙏','🎉','🤔','😎','💯','👀','✨','😊','😅','😴','👏','💀','🫶','😡','🤩','🙃','😇'];
  const picker = document.createElement('div'); picker.className = 'emoji-picker';
  for (const value of values) { const b = document.createElement('button'); b.type = 'button'; b.textContent = value; b.title = stickerMode ? 'Kirim stiker' : 'Masukkan emoji'; b.addEventListener('click', () => { picker.remove(); if (stickerMode) sendMessage('', null, { sticker: value }); else { const start = el.input.selectionStart ?? el.input.value.length; const end = el.input.selectionEnd ?? start; el.input.value = el.input.value.slice(0,start) + value + el.input.value.slice(end); el.input.focus(); el.input.setSelectionRange(start + value.length, start + value.length); } }); picker.appendChild(b); }
  document.body.appendChild(picker); const rect = button.getBoundingClientRect(); picker.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`; picker.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 8)}px`;
  const close = (event) => { if (!picker.contains(event.target) && event.target !== button) { picker.remove(); document.removeEventListener('pointerdown', close); } }; setTimeout(() => document.addEventListener('pointerdown', close), 0);
}
$('#btn-emoji')?.addEventListener('click', (event) => showEmojiPicker(event.currentTarget, false));
$('#btn-sticker')?.addEventListener('click', (event) => showEmojiPicker(event.currentTarget, true));
$('#reply-cancel')?.addEventListener('click', () => { state.replyTo = null; if (el.replyBar) el.replyBar.hidden = true; });
el.fileInput.addEventListener('change', async () => {
  const files = [...el.fileInput.files];
  el.fileInput.value = '';
  await sendFiles(files);
});
el.uploadCancel.addEventListener('click', () => {
  state.uploadToken++;
  el.uploadBar.hidden = true;
});

el.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = el.input.value;
  el.input.value = '';
  el.input.style.height = 'auto';
  stopTyping();
  sendMessage(text, null);
});

// Dropping files straight onto the conversation.
el.messages.addEventListener('dragover', (event) => event.preventDefault());
el.messages.addEventListener('drop', (event) => {
  event.preventDefault();
  if (event.dataTransfer?.files?.length) sendFiles([...event.dataTransfer.files]);
});

let typingTimer = null;
el.input.addEventListener('input', () => {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 140)}px`;
  const room = state.rooms.get(state.activeRoomId);
  if (room) {
    socket?.emit('typing', { roomId: room.id, members: room.members, typing: true });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 1600);
  }
});

el.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    el.composer.requestSubmit();
  }
});

function stopTyping() {
  clearTimeout(typingTimer);
  const room = state.rooms.get(state.activeRoomId);
  if (room) socket?.emit('typing', { roomId: room.id, members: room.members, typing: false });
}

/* ------------------------------------------------------------------ *
 * Go
 * ------------------------------------------------------------------ */
renderEmptyState();
boot();
