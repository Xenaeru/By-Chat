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
const starredKey = (uid) => `securechat.starred.v1.${uid}`;

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
  replyTo: null,
  starred: new Set(),
  /** Id pesan yang sudah dihapus untuk semua orang: jangan dimunculkan lagi. */
  deletedIds: new Set(),
  menuOpen: false,
  menuOpenedAt: 0,
  viewer: null,
  viewerToken: 0,
  statuses: [],
  statusSeen: new Set(),
  statusDecoded: new Map(),
  statusView: null,
  isAdmin: false,
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
  btnAttach: $('#btn-attach'),
  fileInput: $('#file-input'),
  uploadBar: $('#upload-bar'),
  uploadLabel: $('#upload-label'),
  uploadFill: $('#upload-fill'),
  uploadCancel: $('#upload-cancel'),
  replyStrip: $('#reply-strip'),
  replyName: $('#reply-strip-name'),
  replyPreview: $('#reply-strip-preview'),
  replyCancel: $('#reply-strip-cancel'),

  msgMenu: $('#msg-menu'),
  msgMenuCatcher: $('#msg-menu-catcher'),
  msgMenuQuick: $('#msg-menu-quick'),
  msgMenuList: $('#msg-menu-list'),

  viewer: $('#viewer'),
  viewerName: $('#viewer-name'),
  viewerSub: $('#viewer-sub'),
  viewerSave: $('#viewer-save'),
  viewerClose: $('#viewer-close'),
  viewerStage: $('#viewer-stage'),
  viewerLoading: $('#viewer-loading'),
  viewerLoadingLabel: $('#viewer-loading-label'),

  callOverlay: $('#call-overlay'),
  remoteVideo: $('#remote-video'),
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

const packMessage = (text, attachment, extra = {}) =>
  JSON.stringify({
    text: text || '',
    attachment: attachment || null,
    replyTo: extra.replyTo || null,
    forwarded: Boolean(extra.forwarded),
  });

function unpackMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    // Reaksi bukan pesan tersendiri: dia menempel ke pesan yang sudah ada.
    if (parsed?.reaction) return parsed;
    if (typeof parsed?.text === 'string') {
      return { attachment: null, replyTo: null, forwarded: false, ...parsed };
    }
  } catch {
    /* older or plain-text payload */
  }
  return { text: raw, attachment: null, replyTo: null, forwarded: false };
}

/**
 * Id yang dikenal server untuk sebuah pesan. Pesan yang kita kirim punya id
 * lokal sampai server menjawab, dan "hapus untuk semua orang" butuh id server
 * itu — bukan id lokal yang cuma ada di perangkat ini.
 */
const serverIdOf = (message) =>
  message.serverId || (String(message.id || '').startsWith('local:') ? null : message.id);

function fileKind(mime = '') {
  const type = String(mime || '');
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'file';
}

const KIND_LABEL = { image: 'Foto', video: 'Video', audio: 'Audio', file: 'Lampiran' };

/** Satu baris ringkas: dipakai di daftar chat dan di kutipan balasan. */
function messagePreview(message) {
  if (message.deleted) return 'Pesan ini sudah dihapus';
  if (message.error) return 'Pesan nggak bisa dibuka';
  const attachment = message.attachment;
  if (!attachment) return message.text || '';
  const label = KIND_LABEL[fileKind(attachment.mime)];
  const name = attachment.name ? ` · ${attachment.name}` : '';
  return `${label}${name}${message.text ? ` — ${message.text}` : ''}`;
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
    messages: r.messages.map((m) => ({
      ...m,
      pending: false,
      // Pratinjau lokal cuma hidup selama sesi ini: blob URL di perangkat lain
      // tidak menunjuk apa pun, jadi jangan ikut disimpan.
      attachment: m.attachment ? { ...m.attachment, localUrl: undefined } : m.attachment,
    })),
  }));
  if (!store.set(roomsKey(state.me.uid), data)) {
    showToast('⚠️ Penyimpanan browser penuh — riwayat baru nggak kesimpan.');
  }
}

function loadRooms(uid) {
  for (const room of store.get(roomsKey(uid), [])) {
    const messages = (room.messages || []).map((message) => ({
      ...message,
      starred: state.starred.has(`${room.id}:${message.serverId || message.id}`),
    }));
    state.rooms.set(room.id, { ...room, messages });
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
  closeMessageMenu();
  closeViewer();
  cancelReply();
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
  state.starred = new Set(store.get(starredKey(profile.uid), []));
  state.deletedIds.clear();
  cancelReply();
  closeMessageMenu();
  closeViewer();
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
/** Satu permintaan-tunggu-jawaban lewat socket, dengan batas waktu. */
function emitAck(event, payload, timeout = 8000) {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, error: 'Belum tersambung ke server.' });
    const timer = setTimeout(() => resolve({ ok: false, error: 'Server nggak menjawab.' }), timeout);
    socket.emit(event, payload, (answer) => {
      clearTimeout(timer);
      resolve(answer || { ok: false, error: 'Jawaban server tidak terbaca.' });
    });
  });
}

async function keysForRoom(room) {
  const sharedKeys = new Map();
  for (const member of room.members) sharedKeys.set(member, await sharedKeyWith(member));
  return sharedKeys;
}

/**
 * Kirim ke ruangan tertentu — bukan selalu ruangan yang sedang terbuka, karena
 * "Teruskan" mengirim ke chat lain sambil layarnya tetap di sini.
 */
async function sendToRoom(room, text, attachment, { replyTo = null, forwarded = false } = {}) {
  if (!room) return;
  if (!String(text || '').trim() && !attachment) return;

  let sharedKeys;
  try {
    sharedKeys = await keysForRoom(room);
  } catch (err) {
    pushSystemNote(room, `⚠️ ${err.message}. Minta dia buka aplikasinya dulu.`);
    if (state.activeRoomId === room.id) renderMessages();
    saveRooms();
    return;
  }

  // Pratinjau lokal (blob di perangkat ini) tidak ikut dikirim: di perangkat
  // lain alamat itu tidak menunjuk apa pun.
  const outgoing = attachment ? { ...attachment } : null;
  if (outgoing) delete outgoing.localUrl;

  const payload = await encryptMessage(packMessage(text, outgoing, { replyTo, forwarded }), sharedKeys);
  const local = {
    id: `local:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    from: state.me.uid,
    text: text || '',
    attachment: attachment || null,
    replyTo: replyTo || null,
    forwarded: Boolean(forwarded),
    at: Date.now(),
    status: 'sending',
  };
  room.messages.push(local);
  if (state.activeRoomId === room.id) renderMessages();
  renderChatList();
  saveRooms();

  socket.emit(
    'send',
    { roomId: room.id, roomName: room.name, type: room.type, members: room.members, payload },
    (ack) => {
      if (ack?.ok) {
        local.serverId = ack.id;
        if (ack.at) local.at = ack.at;
        local.status = ack.queued?.length ? 'sent' : 'delivered';
      } else {
        local.status = 'failed';
      }
      if (state.activeRoomId === room.id) renderMessages();
      renderChatList();
      saveRooms();
    }
  );
}

const sendMessage = (text, attachment, options) =>
  sendToRoom(state.rooms.get(state.activeRoomId), text, attachment, options);

async function receiveMessage(envelope) {
  // Kabar "sudah dihapus" datang tanpa payload: yang diurus cuma id-nya.
  if (envelope.deleted) return applyRemoteDelete(envelope);
  // Bisa saja kabar hapusnya duluan sampai (misalnya dari inbox offline).
  if (state.deletedIds.has(envelope.id)) return;

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

  if (parsed.reaction) return applyRemoteReaction(envelope, parsed.reaction);

  room.messages.push({
    id: envelope.id,
    from: envelope.from,
    at: envelope.at,
    text: parsed.text,
    attachment: parsed.attachment,
    replyTo: parsed.replyTo || null,
    forwarded: Boolean(parsed.forwarded),
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
 * Aksi atas satu pesan: reaksi, balas, teruskan, salin, bintang, hapus
 * ------------------------------------------------------------------ */

/** Satu orang cuma punya satu reaksi per pesan: yang baru menggantikan yang lama. */
function setReaction(message, from, emoji, on) {
  const map = message.reactions || (message.reactions = {});
  for (const [key, uids] of Object.entries(map)) {
    const at = uids.indexOf(from);
    if (at === -1) continue;
    uids.splice(at, 1);
    if (!uids.length) delete map[key];
  }
  if (on) (map[emoji] || (map[emoji] = [])).push(from);
  if (!Object.keys(map).length) delete message.reactions;
}

function applyRemoteReaction(envelope, reaction) {
  const room = state.rooms.get(envelope.roomId);
  if (!room) return;
  const target = room.messages.find((message) => serverIdOf(message) === reaction.targetId);
  if (!target || target.deleted) return;
  setReaction(target, envelope.from, reaction.emoji, Boolean(reaction.on));
  saveRooms();
  if (state.activeRoomId === room.id) renderMessages();
}

async function reactToMessage(message, emoji) {
  const room = state.rooms.get(state.activeRoomId);
  const targetId = serverIdOf(message);
  if (!room || !targetId || message.deleted || message.error) return;

  const on = !(message.reactions?.[emoji] || []).includes(state.me.uid);
  setReaction(message, state.me.uid, emoji, on);
  renderMessages();
  saveRooms();

  try {
    const sharedKeys = await keysForRoom(room);
    const payload = await encryptMessage(JSON.stringify({ reaction: { targetId, emoji, on } }), sharedKeys);
    socket?.emit('send', {
      roomId: room.id,
      roomName: room.name,
      type: room.type,
      members: room.members,
      payload,
    });
  } catch (err) {
    showToast(`Reaksi nggak terkirim: ${err.message}`);
  }
}

function markDeleted(room, id, from = state.me.uid) {
  const message = room.messages.find((m) => serverIdOf(m) === id);
  if (!message) return false;
  message.deleted = true;
  message.deletedBy = from;
  message.text = '';
  message.attachment = null;
  message.error = undefined;
  delete message.reactions;
  return true;
}

/** Kabar dari server: pengirimnya menghapus pesannya untuk semua orang. */
function applyRemoteDelete(envelope) {
  state.deletedIds.add(envelope.id);
  const room = state.rooms.get(envelope.roomId);
  if (!room) return;
  if (!markDeleted(room, envelope.id, envelope.from)) return;
  saveRooms();
  if (state.activeRoomId === room.id) renderMessages();
  renderChatList();
}

/**
 * Hapus untuk semua orang. Server yang menentukan siapa pengirim sebuah id, jadi
 * jawabannya bisa ditolak — dan kalau ditolak, layarnya tidak berpura-pura
 * sudah terhapus.
 */
async function deleteForEveryone(message) {
  const room = state.rooms.get(state.activeRoomId);
  if (!room || message.deleted) return;
  const targetId = serverIdOf(message);

  if (!targetId) {
    // Belum pernah sampai ke server (atau gagal kirim): cukup hilang di sini.
    markDeleted(room, message.id);
    saveRooms();
    renderMessages();
    renderChatList();
    return showToast('Pesan yang belum terkirim cuma bisa dihapus dari perangkat ini.');
  }

  const ack = await emitAck('message:delete', { id: targetId, roomId: room.id });
  if (!ack?.ok) return showToast(`Gagal menghapus: ${ack?.error || 'tidak diketahui'}`);

  markDeleted(room, targetId);
  state.blobUrls.delete(message.id);
  saveRooms();
  renderMessages();
  renderChatList();
  showToast('Pesan dihapus untuk semua orang.');
}

function deleteForMe(message) {
  const room = state.rooms.get(state.activeRoomId);
  if (!room) return;
  const at = room.messages.indexOf(message);
  if (at === -1) return;
  room.messages.splice(at, 1);
  state.blobUrls.delete(message.id);
  saveRooms();
  renderMessages();
  renderChatList();
  showToast('Pesan dihapus dari perangkat ini saja.');
}

function toggleStar(message) {
  const room = state.rooms.get(state.activeRoomId);
  if (!room) return;
  const key = `${room.id}:${serverIdOf(message) || message.id}`;
  const on = !state.starred.has(key);
  if (on) state.starred.add(key);
  else state.starred.delete(key);
  message.starred = on;
  store.set(starredKey(state.me.uid), [...state.starred]);
  renderMessages();
  showToast(on ? 'Pesan diberi bintang.' : 'Bintangnya dilepas.');
}

function copyMessage(message) {
  const text = String(message.text || '').trim();
  if (!text) return showToast('Pesan ini nggak punya teks buat disalin.');

  return navigator.clipboard
    .writeText(text)
    .then(() => showToast('Pesan disalin.'))
    .catch(() => {
      // Clipboard API butuh HTTPS dan izin; ini jalan terakhirnya.
      const scratch = document.createElement('textarea');
      scratch.value = text;
      scratch.style.position = 'fixed';
      scratch.style.opacity = '0';
      document.body.appendChild(scratch);
      scratch.select();
      document.execCommand('copy');
      scratch.remove();
      showToast('Pesan disalin.');
    });
}

/* ---- Balas ---------------------------------------------------------
 * Yang ikut terkirim adalah uid pengirim aslinya, bukan namanya: "Kamu" bagi
 * pengirim balasan adalah "andi" bagi penerimanya, jadi namanya harus dihitung
 * ulang di tiap perangkat.
 */
function replyNameFor(uid, room, fallback = 'Pesan') {
  if (uid === state.me?.uid) return 'Kamu';
  return peerByUid(uid)?.displayName || (room ? displayName(room) : fallback);
}

function startReply(message) {
  const room = state.rooms.get(state.activeRoomId);
  if (!room) return;
  state.replyTo = {
    id: serverIdOf(message) || message.id,
    uid: message.from,
    name: replyNameFor(message.from, room),
    preview: messagePreview(message).slice(0, 160),
  };
  el.replyName.textContent = state.replyTo.name;
  el.replyPreview.textContent = state.replyTo.preview;
  el.replyStrip.hidden = false;
  el.input.focus();
}

function cancelReply() {
  state.replyTo = null;
  el.replyStrip.hidden = true;
}

function scrollToMessage(id) {
  const node = el.messages.querySelector(`.msg[data-id="${CSS.escape(String(id))}"]`);
  if (!node) return showToast('Pesan aslinya nggak ada lagi di perangkat ini.');
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1100);
}

/* ---- Teruskan ------------------------------------------------------ */
function openForwardPicker(message) {
  const rooms = [...state.rooms.values()].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  if (!rooms.length) return showToast('Belum ada chat lain buat tujuan teruskan.');
  const current = state.activeRoomId;

  openModal(`
    <h3>Teruskan pesan</h3>
    <p class="sub">
      Pilih chat tujuan. Isinya dienkripsi ulang untuk chat itu, jadi server tetap
      nggak bisa membacanya.
    </p>
    <ul class="forward-list">
      ${rooms
        .map((room) => {
          const name = room.type === 'group' ? room.name : displayName(room);
          return `<li><button type="button" class="forward-target" data-room="${esc(room.id)}">
            <span class="avatar" data-hue-for="${esc(name)}">${esc(initials(name))}</span>
            <span class="forward-target-main">
              <strong>${esc(name)}</strong>
              <span class="muted">${esc(preview(room.messages[room.messages.length - 1]))}${room.id === current ? ' · chat ini' : ''}</span>
            </span>
          </button></li>`;
        })
        .join('')}
    </ul>
    <div class="modal-actions"><button data-close>Tutup</button></div>
  `);

  el.modalCard.querySelector('[data-close]').addEventListener('click', closeModal);
  for (const button of el.modalCard.querySelectorAll('.forward-target')) {
    button.addEventListener('click', async () => {
      const target = state.rooms.get(button.dataset.room);
      closeModal();
      if (!target) return;
      await sendToRoom(target, message.text, message.attachment, { forwarded: true });
      selectRoom(target.id);
      showToast(`Pesan diteruskan ke ${target.type === 'group' ? target.name : displayName(target)}.`);
    });
  }
}

/* ---- Lihat lampiran selayar penuh ---------------------------------
 * Foto dan video dibuka di sini — bukan diunduh, dan bukan di tab baru. Tab
 * baru akan menampilkan halaman blob: kosong, dan blob URL-nya hidup di
 * dokumen ini saja. Yang disimpan di server tetap ciphertext.
 */
function showViewerMedia(url, attachment) {
  const kind = fileKind(attachment.mime);
  el.viewerStage.innerHTML = '';

  let node;
  if (kind === 'image') {
    node = document.createElement('img');
    node.src = url;
    node.alt = attachment.name || 'Foto';
  } else if (kind === 'video') {
    node = document.createElement('video');
    node.src = url;
    node.controls = true;
    node.autoplay = true;
    node.playsInline = true;
  } else {
    node = document.createElement('audio');
    node.src = url;
    node.controls = true;
    node.autoplay = true;
  }

  node.className = 'viewer-media';
  node.dataset.kind = kind;
  el.viewerStage.appendChild(node);
  el.viewerSave.hidden = false;
  el.viewerLoading.hidden = true;
}

async function openViewer(message) {
  const attachment = message?.attachment;
  if (!attachment) return;

  const token = ++state.viewerToken;
  state.viewer = message;
  el.viewer.hidden = false;
  el.viewerName.textContent = attachment.name || 'Lampiran';
  el.viewerSub.textContent = `${formatBytes(attachment.size)} · ${KIND_LABEL[fileKind(attachment.mime)]} terenkripsi`;
  el.viewerStage.innerHTML = '';
  el.viewerSave.hidden = true;

  const ready = attachment.localUrl || state.blobUrls.get(message.id);
  if (ready) return showViewerMedia(ready, attachment);

  el.viewerLoading.hidden = false;
  el.viewerLoadingLabel.textContent = `Mengunduh ${attachment.name || ''}…`;
  try {
    const url = await fetchAttachment({
      attachment,
      getIdToken: () => state.auth.getIdToken(),
      onStage: (stage, fraction) => {
        if (token !== state.viewerToken) return;
        el.viewerLoadingLabel.textContent = `${stage === 'decrypt' ? 'Mendekripsi' : 'Mengunduh'} ${
          attachment.name || ''
        } — ${Math.round(fraction * 100)}%`;
      },
    });
    if (token !== state.viewerToken) return URL.revokeObjectURL(url);
    state.blobUrls.set(message.id, url);
    showViewerMedia(url, attachment);
    // Foto yang barusan dibuka sekarang bisa tampil sebagai gambar di chat.
    if (message.attachment && fileKind(message.attachment.mime) === 'image') renderMessages();
  } catch (err) {
    if (token !== state.viewerToken) return;
    el.viewerLoading.hidden = true;
    el.viewerStage.innerHTML = `<p class="viewer-note">Gagal membuka ${esc(attachment.name || 'lampiran')}: ${esc(
      err.message
    )}</p>`;
  }
}

function closeViewer() {
  state.viewerToken++;
  state.viewer = null;
  el.viewer.hidden = true;
  el.viewerStage.innerHTML = '';
  el.viewerLoading.hidden = true;
}

/** Simpan ke perangkat: satu-satunya tempat tombol unduh muncul. */
function saveViewerMedia() {
  const message = state.viewer;
  if (!message?.attachment) return;
  const url = message.attachment.localUrl || state.blobUrls.get(message.id);
  if (!url) return showToast('Filenya belum selesai dibuka.');
  saveBlobUrl(url, message.attachment.name);
  showToast(`Menyimpan ${message.attachment.name || 'lampiran'}…`);
}

function saveBlobUrl(url, name) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name || 'lampiran';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/* ------------------------------------------------------------------ *
 * Pilihan pesan — klik kanan (mouse) atau tahan (layar sentuh)
 *
 * Yang lain diblur, yang dipilih tetap tajam, lalu pilihannya muncul di
 * sebelah gelembung itu. Semua tombol di sini benar-benar mengerjakan
 * sesuatu; tidak ada yang cuma pajangan.
 * ------------------------------------------------------------------ */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const LONG_PRESS_MS = 420;

function isStarred(message, roomId) {
  return Boolean(message.starred) || state.starred.has(`${roomId}:${serverIdOf(message) || message.id}`);
}

/** Daftar pilihan untuk satu pesan, tergantung siapa yang mengirimnya. */
function messageActions(message, room) {
  const mine = message.from === state.me.uid;
  // Pesan yang sudah dihapus atau gagal didekripsi tidak punya isi untuk
  // dibalas/diteruskan; yang tersisa cuma menghapusnya dari sini.
  const readable = !message.deleted && !message.error;
  const actions = [];

  if (readable) {
    actions.push({ id: 'reply', label: 'Balas', icon: '#i-reply' });
    actions.push({ id: 'forward', label: 'Teruskan', icon: '#i-forward' });
    if (message.text) actions.push({ id: 'copy', label: 'Salin', icon: '#i-copy' });
    actions.push({
      id: 'star',
      label: isStarred(message, room.id) ? 'Lepas bintang' : 'Beri bintang',
      icon: '#i-star',
    });
    if (!mine && room.type === 'dm') actions.push({ id: 'report', label: 'Laporkan', icon: '#i-flag' });
  }

  actions.push({ id: 'delete-me', label: 'Hapus untuk saya', icon: '#i-trash', danger: true });
  // Hanya pengirimnya yang boleh menghapus untuk semua orang — server yang
  // memutuskannya, tapi menawarkannya ke orang lain cuma bikin bingung.
  if (mine && !message.deleted) {
    actions.push({ id: 'delete-all', label: 'Hapus untuk semua orang', icon: '#i-trash', danger: true });
  }

  return actions;
}

function runMessageAction(action, message) {
  if (action === 'reply') return startReply(message);
  if (action === 'forward') return openForwardPicker(message);
  if (action === 'copy') return copyMessage(message);
  if (action === 'star') return toggleStar(message);
  if (action === 'report') return openReportModal();
  if (action === 'delete-me') return deleteForMe(message);
  if (action === 'delete-all') return deleteForEveryone(message);
}

/** Taruh baris reaksi di atas gelembung dan daftar pilihan di bawahnya. */
function placeMessageMenu(bubble) {
  const rect = bubble.getBoundingClientRect();
  const pad = 10;
  const quick = el.msgMenuQuick;
  const list = el.msgMenuList;
  const quickBox = quick.hidden ? { width: 0, height: 0 } : quick.getBoundingClientRect();
  const listBox = list.getBoundingClientRect();
  const width = Math.max(quickBox.width, listBox.width);
  const left = Math.min(Math.max(pad, rect.left), Math.max(pad, innerWidth - width - pad));

  // Coba: reaksi di atas, daftar di bawah. Kalau daftarnya tidak muat, keduanya
  // pindah ke atas gelembung — jangan pernah keluar layar.
  let quickTop = rect.top - quickBox.height - 8;
  let listTop = rect.bottom + 8;
  if (listTop + listBox.height > innerHeight - pad) {
    listTop = quickTop - listBox.height - 6;
    quickTop = listTop - quickBox.height - 8;
    if (listTop < pad) {
      listTop = Math.max(pad, innerHeight - listBox.height - pad);
      quickTop = listTop - quickBox.height - 8;
    }
  }

  quick.style.left = `${left}px`;
  quick.style.top = `${Math.max(pad, quickTop)}px`;
  list.style.left = `${left}px`;
  list.style.top = `${Math.min(Math.max(pad, listTop), Math.max(pad, innerHeight - listBox.height - pad))}px`;
}

function openMessageMenu(bubble) {
  const room = state.rooms.get(state.activeRoomId);
  const message = room?.messages.find((m) => (serverIdOf(m) || m.id) === bubble.dataset.id);
  if (!room || !message) return;

  closeMessageMenu();
  state.menuOpen = true;
  state.menuOpenedAt = Date.now();
  el.msgMenu.hidden = false;
  el.msgMenuQuick.innerHTML = '';
  el.msgMenuList.innerHTML = '';

  if (!message.deleted && !message.error) {
    for (const emoji of QUICK_REACTIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.reaction = emoji;
      button.textContent = emoji;
      button.title = `Beri reaksi ${emoji}`;
      button.setAttribute('aria-label', `Beri reaksi ${emoji}`);
      button.addEventListener('click', () => {
        closeMessageMenu();
        reactToMessage(message, emoji);
      });
      el.msgMenuQuick.appendChild(button);
    }
  }
  el.msgMenuQuick.hidden = el.msgMenuQuick.childElementCount === 0;

  for (const action of messageActions(message, room)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'msg-menu-item' + (action.danger ? ' danger' : '');
    button.dataset.action = action.id;
    button.setAttribute('role', 'menuitem');
    button.innerHTML = `<svg class="ico"><use href="${action.icon}" /></svg><span>${esc(action.label)}</span>`;
    button.addEventListener('click', () => {
      closeMessageMenu();
      runMessageAction(action.id, message);
    });
    el.msgMenuList.appendChild(button);
  }

  document.body.classList.add('menu-open');
  el.messages.classList.add('menu-open');
  bubble.classList.add('menu-target');
  el.msgMenu.dataset.target = bubble.dataset.id;
  placeMessageMenu(bubble);
}

function closeMessageMenu() {
  if (el.msgMenu.hidden) return;
  state.menuOpen = false;
  el.msgMenu.hidden = true;
  el.msgMenuQuick.innerHTML = '';
  el.msgMenuList.innerHTML = '';
  delete el.msgMenu.dataset.target;
  document.body.classList.remove('menu-open');
  el.messages.classList.remove('menu-open');
  for (const node of el.messages.querySelectorAll('.msg.menu-target')) node.classList.remove('menu-target');
}

let pressTimer = null;
let pressOrigin = { x: 0, y: 0 };
let suppressClickUntil = 0;
let suppressedBubble = null;

function cancelPress() {
  clearTimeout(pressTimer);
  pressTimer = null;
}

function beginPress(bubble, point) {
  if (!bubble || !el.msgMenu.hidden) return;
  cancelPress();
  pressOrigin = point;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    // Ketukan yang sudah jadi "tahan" tidak boleh ikut membuka lampiran.
    // Penandanya cuma berlaku untuk gelembung yang tadi ditahan itu — kalau
    // tidak, ketukan berikutnya di pesan lain ikut tertelan.
    suppressedBubble = bubble;
    suppressClickUntil = Date.now() + 800;
    openMessageMenu(bubble);
  }, LONG_PRESS_MS);
}

// Mouse: pointerdown (klik kiri). Tombol kanan punya jalurnya sendiri di bawah.
el.messages.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'mouse' || event.button !== 0) return;
  beginPress(event.target.closest('.msg'), { x: event.clientX, y: event.clientY });
});
// Pelepasan jari/mouse bisa mendarat di luar area pesan (misalnya karena
// tampilannya bergeser), jadi pembatalannya dipasang di dokumen, bukan cuma di
// kontainernya. Tanpa ini, timer tahan bisa jalan terus dan menelan klik orang.
document.addEventListener('pointerup', cancelPress);
document.addEventListener('pointercancel', cancelPress);

// Layar sentuh: pakai event sentuh langsung. Ini yang paling bisa diandalkan
// di hp, dan di sinilah "tahan sebentar" harus mengalahkan ketukan biasa.
el.messages.addEventListener(
  'touchstart',
  (event) => {
    const touch = event.touches[0];
    if (!touch) return;
    beginPress(event.target.closest('.msg'), { x: touch.clientX, y: touch.clientY });
  },
  { passive: true }
);
el.messages.addEventListener(
  'touchmove',
  (event) => {
    if (!pressTimer) return;
    const touch = event.touches[0];
    if (!touch) return cancelPress();
    if (Math.hypot(touch.clientX - pressOrigin.x, touch.clientY - pressOrigin.y) > 10) cancelPress();
  },
  { passive: true }
);
for (const type of ['touchend', 'touchcancel']) el.messages.addEventListener(type, cancelPress, { passive: true });

el.messages.addEventListener(
  'click',
  (event) => {
    const bubble = event.target?.closest?.('.msg') || null;
    if (Date.now() > suppressClickUntil || bubble !== suppressedBubble) return;
    suppressClickUntil = 0;
    suppressedBubble = null;
    event.preventDefault();
    event.stopPropagation();
  },
  true
);

el.messages.addEventListener('contextmenu', (event) => {
  const bubble = event.target.closest('.msg');
  if (!bubble) return;
  event.preventDefault();
  cancelPress();
  openMessageMenu(bubble);
});

el.msgMenuCatcher.addEventListener('click', () => {
  // Sentuhan yang memunculkan menu diakhiri satu klik sintetis, dan klik itu
  // mendarat di tirai ini. Tanpa tenggang waktu, menu langsung tertutup lagi
  // sebelum sempat dilihat.
  if (Date.now() - state.menuOpenedAt < 600) return;
  closeMessageMenu();
});

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
      // Pratinjau langsung dari file yang barusan dipilih: pengirimnya tidak
      // perlu mengunduh ulang fotonya sendiri cuma buat melihatnya. Alamat ini
      // cuma hidup di sesi ini dan tidak ikut dikirim ke siapa pun.
      attachment.localUrl = URL.createObjectURL(file);
      await sendMessage('', attachment);
    } catch (err) {
      showToast(`Gagal kirim ${file.name}: ${err.message}`, 6000);
    }
  }

  if (token === state.uploadToken) el.uploadBar.hidden = true;
}

/**
 * Lampiran biasa (dokumen, arsip, apa pun yang bukan media): satu-satunya jenis
 * yang memang diunduh, karena memang itu yang orang mau.
 */
async function downloadAttachment(message) {
  const attachment = message.attachment;
  if (!attachment) return;

  if (attachment.localUrl) {
    saveBlobUrl(attachment.localUrl, attachment.name);
    return;
  }
  const cached = state.blobUrls.get(message.id);
  if (cached) {
    saveBlobUrl(cached, attachment.name);
    return showToast(`Menyimpan ${attachment.name || 'lampiran'}…`);
  }

  const token = ++state.uploadToken;
  el.uploadBar.hidden = false;
  el.uploadLabel.textContent = `Mengunduh ${attachment.name}`;

  try {
    const url = await fetchAttachment({
      attachment,
      getIdToken: () => state.auth.getIdToken(),
      onStage: (stage, fraction) => {
        if (token !== state.uploadToken) return;
        el.uploadLabel.textContent = `${stage === 'decrypt' ? 'Mendekripsi' : 'Mengunduh'} ${attachment.name}`;
        el.uploadFill.style.width = `${Math.round(fraction * 100)}%`;
      },
    });
    if (token !== state.uploadToken) return URL.revokeObjectURL(url);
    state.blobUrls.set(message.id, url);
    saveBlobUrl(url, attachment.name);
    showToast(`Menyimpan ${attachment.name || 'lampiran'}…`);
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
  closeMessageMenu();
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
  if (!message) return 'Belum ada pesan';
  if (message.system) return message.text;
  const body = messagePreview(message);
  return message.from === state.me?.uid ? `Kamu: ${body}` : body;
}

const KIND_ICON = { image: '#i-image', video: '#i-video', audio: '#i-audio', file: '#i-doc' };

/**
 * Satu lampiran di dalam gelembung. Foto yang sudah siap langsung jadi gambar;
 * sisanya jadi kartu yang kalau diketuk membuka penampil selayar penuh (media)
 * atau menyimpan filenya (dokumen).
 */
function attachmentNode(message) {
  const attachment = message.attachment;
  const kind = fileKind(attachment.mime);
  const url = attachment.localUrl || state.blobUrls.get(message.id) || null;
  const wrap = document.createElement('div');
  wrap.className = `attach attach-${kind}`;

  if (kind === 'image' && url) {
    wrap.classList.add('attach-media');
    const img = document.createElement('img');
    img.src = url;
    img.alt = attachment.name || 'Foto';
    img.loading = 'lazy';
    wrap.appendChild(img);
    wrap.addEventListener('click', () => openViewer(message));
    return wrap;
  }

  const hint = kind === 'file' ? 'ketuk buat simpan' : 'ketuk buat buka';
  const badge = kind === 'video' || kind === 'audio' ? '<span class="attach-badge"><svg class="ico"><use href="#i-play" /></svg></span>' : '';
  wrap.innerHTML = `
    <span class="attach-icon"><svg class="ico"><use href="${KIND_ICON[kind]}" /></svg>${badge}</span>
    <span class="attach-info">
      <span class="attach-name">${esc(attachment.name)}</span>
      <span class="attach-size">${esc(formatBytes(attachment.size))} · ${hint}</span>
    </span>
  `;
  wrap.addEventListener('click', () => (kind === 'file' ? downloadAttachment(message) : openViewer(message)));
  return wrap;
}

function dayLabel(ts) {
  const date = new Date(ts);
  const today = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return 'Hari ini';
  if (sameDay(date, new Date(Date.now() - 86400000))) return 'Kemarin';
  return date.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function daySeparator(label) {
  const wrap = document.createElement('div');
  wrap.className = 'day-sep';
  const pill = document.createElement('span');
  pill.textContent = label;
  wrap.appendChild(pill);
  return wrap;
}

function quoteNode(message) {
  const quote = document.createElement('button');
  quote.type = 'button';
  quote.className = 'msg-quote';
  quote.title = 'Buka pesan yang dibalas';

  const name = document.createElement('span');
  name.className = 'msg-quote-name';
  name.textContent = replyNameFor(message.replyTo.uid, null, message.replyTo.name || 'Pesan');
  const text = document.createElement('span');
  text.className = 'msg-quote-text';
  text.textContent = message.replyTo.preview || '';
  quote.append(name, text);

  quote.addEventListener('click', (event) => {
    event.stopPropagation();
    scrollToMessage(message.replyTo.id);
  });
  return quote;
}

function forwardedNode() {
  const node = document.createElement('span');
  node.className = 'msg-forwarded';
  node.innerHTML = '<svg class="ico"><use href="#i-forwarded" /></svg><span>Diteruskan</span>';
  return node;
}

function deletedNode() {
  const node = document.createElement('span');
  node.className = 'msg-deleted';
  node.innerHTML = '<svg class="ico"><use href="#i-ban" /></svg><span>Pesan ini sudah dihapus</span>';
  return node;
}

function reactionsNode(message) {
  const entries = Object.entries(message.reactions || {}).filter(([, uids]) => uids.length);
  if (!entries.length) return null;

  const wrap = document.createElement('div');
  wrap.className = 'msg-reactions';
  for (const [emoji, uids] of entries) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'msg-reaction' + (uids.includes(state.me.uid) ? ' mine' : '');
    chip.dataset.emoji = emoji;
    chip.title = uids.includes(state.me.uid) ? 'Hapus reaksi ini' : 'Ikut beri reaksi ini';
    chip.innerHTML = `${esc(emoji)}${uids.length > 1 ? `<b>${uids.length}</b>` : ''}`;
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      reactToMessage(message, emoji);
    });
    wrap.appendChild(chip);
  }
  return wrap;
}

function renderMessages() {
  const room = state.rooms.get(state.activeRoomId);
  el.messages.innerHTML = '';
  if (!room) return;

  let lastDay = null;
  for (const message of room.messages) {
    if (message.system) {
      const note = document.createElement('div');
      note.className = 'system-note';
      note.textContent = message.text;
      el.messages.appendChild(note);
      continue;
    }

    const label = dayLabel(message.at);
    if (label !== lastDay) {
      el.messages.appendChild(daySeparator(label));
      lastDay = label;
    }

    const mine = message.from === state.me.uid;
    const div = document.createElement('div');
    div.className =
      'msg' + (mine ? ' out' : '') + (message.error ? ' undecryptable' : '') + (message.deleted ? ' deleted' : '');
    div.dataset.id = serverIdOf(message) || message.id;
    div.dataset.mine = mine ? '1' : '0';

    if (room.type === 'group' && !mine && !message.deleted) {
      const sender = document.createElement('span');
      sender.className = 'msg-sender';
      sender.textContent = peerByUid(message.from)?.displayName || 'Tidak dikenal';
      div.appendChild(sender);
    }

    if (message.deleted) {
      div.appendChild(deletedNode());
    } else if (message.error) {
      div.appendChild(document.createTextNode(`Pesan ini nggak bisa dibuka (${message.error})`));
    } else {
      if (message.forwarded) div.appendChild(forwardedNode());
      if (message.replyTo?.id) div.appendChild(quoteNode(message));
      if (message.attachment) div.appendChild(attachmentNode(message));
      if (message.text) {
        const body = document.createElement('span');
        body.className = 'msg-text';
        body.textContent = message.text;
        div.appendChild(body);
      }
    }

    const star = isStarred(message, room.id) ? '<svg class="ico star"><use href="#i-star-filled" /></svg>' : '';
    const meta = document.createElement('span');
    meta.className = 'msg-meta';
    meta.innerHTML = `${star}<span>${formatTime(message.at)}</span>${
      mine && !message.deleted ? statusIcon(message.status) : ''
    }`;
    div.appendChild(meta);

    const reactions = reactionsNode(message);
    if (reactions) div.appendChild(reactions);

    el.messages.appendChild(div);
  }

  el.messages.scrollTop = el.messages.scrollHeight;
  renderTyping();
}

function statusIcon(status) {
  if (status === 'sending') return '<svg class="ico"><use href="#i-clock" /></svg>';
  if (status === 'failed') return '<svg class="ico warn"><use href="#i-alert" /></svg>';
  if (status === 'delivered') return '<svg class="ico read"><use href="#i-checks" /></svg>';
  return '<svg class="ico"><use href="#i-check" /></svg>';
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
/**
 * Pasang satu stream ke elemen media dan pastikan dia benar-benar diputar.
 *
 * Atribut `autoplay` saja tidak cukup: dengan `srcObject` yang dipasang dari
 * skrip, elemennya bisa berhenti di keadaan paused — track audio tetap hidup,
 * tapi tidak ada suara yang keluar, dan panggilannya jadi senyap tanpa pesan
 * error apa pun. Jadi `play()` dipanggil eksplisit, dan penolakannya dilaporkan
 * (bukan ditelan), karena itu satu-satunya petunjuk yang tersisa buat pengguna.
 */
function attachCallMedia(node, stream) {
  if (node.srcObject !== stream) node.srcObject = stream;
  if (!stream || !node.paused) return;

  const played = node.play();
  played?.catch((err) => {
    console.warn('Pemutaran media panggilan ditolak:', err.message, '- ketuk layar sekali untuk mencoba lagi.');
    showToast('Suaranya belum keluar. Ketuk layar panggilan sekali lagi.', 6000);
  });
}

function renderCall(call = {}) {
  const active = state.calls?.active;
  el.callOverlay.hidden = !active;

  if (!active) {
    el.incoming.hidden = true;
    state.incoming = null;
    el.remoteVideo.srcObject = null;
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

  if (call.localStream) attachCallMedia(el.localVideo, call.localStream);

  if (call.remoteStream && call.remoteStream.getTracks().length) {
    attachCallMedia(el.remoteVideo, call.remoteStream);
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

  const owners = statusOwnerList().filter((uid) => uid !== state.me.uid);
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
const STATUS_SHOW_MS = 5000;
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
  scheduleStatusAdvance();
}

async function paintStatusStage(decoded, hint = '') {
  if (decoded.error) {
    el.statusStage.innerHTML = `<div class="status-text" style="--status-bg:#7f1d1d">⚠️ ${esc(decoded.error)}</div>`;
    return;
  }

  if (decoded.attachment) {
    el.statusStage.innerHTML = '<div class="status-note">Membuka gambar…</div>';
    try {
      const url = await fetchAttachment({
        attachment: decoded.attachment,
        getIdToken: () => state.auth.getIdToken(),
      });
      el.statusStage.innerHTML = `
        <img class="status-image" alt="Status" />
        ${decoded.text ? `<span class="status-caption">${esc(decoded.text)}</span>` : ''}
        ${hint ? `<span class="status-hint">${esc(hint)}</span>` : ''}
      `;
      el.statusStage.querySelector('img').src = url;
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
  const audience = [
    ...new Set([
      ...state.directory.filter((user) => user.uid !== state.me.uid && user.publicKey).map((user) => user.uid),
      state.me.uid,
    ]),
  ];

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
    <p class="sub" id="status-note">Pilih warna latar, atau lampirkan foto.</p>
    <input type="file" id="status-photo" accept="image/*" hidden />
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
    note().textContent = chosenFile ? `Siap dibagikan: ${chosenFile.name}` : 'Pilih warna latar, atau lampirkan foto.';
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
  if (!el.msgMenu.hidden) return closeMessageMenu();
  if (!el.viewer.hidden) return closeViewer();
  if (!el.statusViewer.hidden) return closeStatusViewer();
  if (!el.contactPage.hidden) closeContactPage();
});

// Kebijakan autoplay bisa menahan suara panggilan sampai ada ketukan; satu
// ketukan di mana pun membuka kuncinya, jadi kesempatannya dipakai.
document.addEventListener(
  'click',
  () => {
    for (const node of [el.remoteVideo, el.localVideo]) {
      if (node.srcObject && node.paused) attachCallMedia(node, node.srcObject);
    }
  },
  true
);

el.replyCancel.addEventListener('click', cancelReply);
el.viewerClose.addEventListener('click', closeViewer);
el.viewerSave.addEventListener('click', () => saveViewerMedia());
el.viewerStage.addEventListener('click', (event) => {
  // Ketukan di latar menutup penampil; ketukan di fotonya tidak.
  if (event.target === el.viewerStage) closeViewer();
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
  const replyTo = state.replyTo;
  el.input.value = '';
  el.input.style.height = 'auto';
  cancelReply();
  stopTyping();
  sendMessage(text, null, { replyTo });
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
