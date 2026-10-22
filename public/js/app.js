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
import { MAX_VOICE_SECONDS, startVoiceRecording } from './voice.js';
import { createCallManager } from './call.js';
import { createNotifier } from './notifications.js';

/* ------------------------------------------------------------------ *
 * Local storage — everything here stays on this device.
 * ------------------------------------------------------------------ */
const identityKey = (uid) => `securechat.identity.v3.${uid}`;
const roomsKey = (uid) => `securechat.rooms.v3.${uid}`;
const verifiedKey = (uid) => `securechat.verified.v3.${uid}`;
const statusSeenKey = (uid) => `securechat.status.v1.${uid}`;
const starredKey = (uid) => `securechat.starred.v1.${uid}`;
// Preferensi per obrolan (favorit, bisu, pesan sementara), daftar buatan
// sendiri, dan kontak yang diblokir. Semuanya lokal: server tetap buta isi
// percakapan, jadi tidak ada yang perlu dia ketahui soal ini.
const chatPrefsKey = (uid) => `securechat.chatprefs.v1.${uid}`;
const listsKey = (uid) => `securechat.lists.v1.${uid}`;
const blockedKey = (uid) => `securechat.blocked.v1.${uid}`;

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
 * Tema: terang, gelap, atau ikut perangkat
 *
 * Pilihan disimpan di localStorage biasa (bukan di dalam profil), karena
 * layar login pun ikut berwarna dan belum ada uid saat itu. Skrip kecil di
 * index.html sudah memasang atribut `data-theme` sebelum CSS dilukis; fungsi
 * di sini yang menjaga sisanya tetap sinkron setelah halaman hidup.
 * ------------------------------------------------------------------ */
const THEME_KEY = 'securechat.theme.v1';
const THEMES = ['light', 'dark', 'system'];
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
let themeChoice = 'system';

function readThemeChoice() {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return THEMES.includes(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

const effectiveTheme = () =>
  themeChoice === 'system' ? (systemDark.matches ? 'dark' : 'light') : themeChoice;

function paintTheme() {
  const theme = effectiveTheme();
  const label = theme === 'dark' ? 'gelap' : 'terang';
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeChoice = themeChoice;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#0b141a' : '#f7f8fa';

  if (el.themeNote) {
    el.themeNote.textContent =
      themeChoice === 'system' ? `Ikut perangkat — sekarang ${label}` : `${label} di perangkat ini`;
  }
  // Dropdown tetap menunjuk pilihan tersimpan, termasuk saat tema berubah
  // sendiri karena perangkatnya beralih ke mode gelap.
  if (el.themeSelect) el.themeSelect.value = themeChoice;
}

function setTheme(choice) {
  themeChoice = THEMES.includes(choice) ? choice : 'system';
  try {
    localStorage.setItem(THEME_KEY, themeChoice);
  } catch {
    /* storage penuh / dimatikan: pilihannya tetap berlaku sampai tab ditutup */
  }
  paintTheme();
}

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
  /** Pemutar pesan suara yang sedang aktif; cuma satu yang boleh berbunyi. */
  voice: { id: null, audio: null, speed: 1, loading: null },
  /** Node pemutar di DOM sekarang, dipakai buat memperbarui progres. */
  voiceNodes: [],
  voiceRecording: null,
  voiceTimer: null,
  replyTo: null,
  starred: new Set(),
  /** Id pesan yang sudah dihapus untuk semua orang: jangan dimunculkan lagi. */
  deletedIds: new Set(),
  menuOpen: false,
  menuOpenedAt: 0,
  /** Kapan menu chat terakhir dibuka: menelan klik sintetis sesudah tahan. */
  chatMenuOpenedAt: 0,
  viewer: null,
  viewerToken: 0,
  statuses: [],
  statusSeen: new Set(),
  statusDecoded: new Map(),
  statusView: null,
  isAdmin: false,
  notifier: null,
  /** Panel yang sedang terbuka di kolom daftar: chats | status | calls | settings. */
  view: 'chats',
  /** Riwayat panggilan lokal + keadaan panggilan yang sedang berjalan. */
  callLog: [],
  callState: null,
  /** roomId -> { favorite, mutedUntil, mutedFor, disappearMs, lists[] } */
  chatPrefs: new Map(),
  /** Daftar obrolan buatan sendiri: [{ id, name }] */
  lists: [],
  /** uid yang diblokir di perangkat ini. */
  blocked: new Set(),
  /** Filter daftar obrolan: 'all' | 'favorite' | id daftar. */
  listFilter: 'all',
  /** Mode pilih pesan: Set berisi id pesan, atau null saat tidak aktif. */
  selection: null,
  /** Pencarian di dalam obrolan. */
  searchQuery: '',
  searchHits: [],
  searchIndex: -1,
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
  loginNotice: $('#login-notice'),
  loginDivider: $('#login-divider'),
  loginPasswordForm: $('#login-password'),
  loginAccount: $('#login-account'),
  loginPasswordInput: $('#login-password-input'),
  loginPasswordSubmit: $('#login-password-submit'),
  loginToRegister: $('#login-to-register'),
  registerForm: $('#register-form'),
  registerUsername: $('#register-username'),
  registerPassword: $('#register-password'),
  registerConfirm: $('#register-confirm'),
  registerSubmit: $('#register-submit'),
  registerToLogin: $('#register-to-login'),
  btnGoogle: $('#btn-google'),

  onboarding: $('#onboarding'),
  usernameField: $('#username-field'),
  usernameInput: $('#username-input'),
  usernameMark: $('#username-mark'),
  usernameStatus: $('#username-status'),
  usernameSubmit: $('#username-submit'),
  usernameLogout: $('#username-logout'),

  app: $('#app'),
  lists: $('#lists'),
  rail: $('#rail'),
  railAvatar: $('#rail-avatar'),
  railUnread: $('#rail-unread'),
  railStatusDot: $('#rail-status-dot'),
  tabbar: $('#tabbar'),
  tabUnread: $('#tab-unread'),
  tabStatusDot: $('#tab-status-dot'),
  meAvatar: $('#me-avatar'),
  meName: $('#me-name'),
  meStatus: $('#me-status'),
  displayName: $('#display-name'),
  nameTag: $('[data-name-tag]'),
  panelSettings: $('#panel-settings'),
  avatarInput: $('#avatar-input'),
  callList: $('#call-list'),
  callEmpty: $('#call-empty'),
  statusEmpty: $('#status-empty'),
  btnAdmin: $('#btn-admin'),
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
  btnSend: $('#btn-send'),
  sendIcon: $('#send-icon'),
  recordBar: $('#record-bar'),
  recordTime: $('#record-time'),
  recordHint: $('#record-hint'),
  recordCancel: $('#record-cancel'),
  recordSend: $('#record-send'),
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

  chatMenu: $('#chat-menu'),
  chatMenuCatcher: $('#chat-menu-catcher'),
  chatMenuList: $('#chat-menu-list'),

  btnChatMore: $('#btn-chat-more'),
  chatOptions: $('#chat-options'),
  chatOptionsCatcher: $('#chat-options-catcher'),
  chatOptionsList: $('#chat-options-list'),
  chatSearch: $('#chat-search'),
  chatSearchInput: $('#chat-search-input'),
  chatSearchCount: $('#chat-search-count'),
  chatSearchPrev: $('#chat-search-prev'),
  chatSearchNext: $('#chat-search-next'),
  chatSearchClose: $('#chat-search-close'),
  blockedBar: $('#blocked-bar'),
  blockedText: $('#blocked-text'),
  blockedUnblock: $('#blocked-unblock'),
  selectBar: $('#select-bar'),
  selectCount: $('#select-count'),
  selectClose: $('#select-close'),
  selectCopy: $('#select-copy'),
  selectForward: $('#select-forward'),
  selectDelete: $('#select-delete'),
  listFilters: $('#list-filters'),
  themeNote: $('[data-theme-note]'),
  themeSelect: $('#theme-select'),

  viewer: $('#viewer'),
  viewerName: $('#viewer-name'),
  viewerSub: $('#viewer-sub'),
  viewerSave: $('#viewer-save'),
  viewerClose: $('#viewer-close'),
  viewerStage: $('#viewer-stage'),
  viewerLoading: $('#viewer-loading'),
  viewerLoadingLabel: $('#viewer-loading-label'),

  callOverlay: $('#call-overlay'),
  callGrid: $('#call-grid'),
  callParticipants: $('#call-participants'),
  callDuration: $('#call-duration'),
  localVideo: $('#local-video'),
  callPlaceholder: $('#call-placeholder'),
  callAvatar: $('#call-avatar'),
  callName: $('#call-name'),
  callStatus: $('#call-status'),
  ctlMic: $('#ctl-mic'),
  ctlCamera: $('#ctl-camera'),
  ctlScreen: $('#ctl-screen'),
  ctlAdd: $('#ctl-add'),
  ctlHangup: $('#ctl-hangup'),
  callAudio: $('#call-audio'),
  callSound: $('#call-sound'),
  callMic: $('#call-mic'),
  callMicLevel: $('#call-mic-level'),
  callMicNote: $('#call-mic-note'),

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
 * colour — you recognise a contact before you finish reading the name. Casing is
 * folded away: fixing the capitals shouldn't repaint someone's avatar.
 */
function nameHue(name) {
  let hue = 0;
  for (const char of String(name).toLowerCase()) {
    hue = (hue * 31 + char.codePointAt(0)) % 360;
  }
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
    // Penanda pesan suara ikut di dalam payload terenkripsi, bukan di
    // attachment: server nggak perlu (dan nggak boleh) tahu isinya suara.
    voice: Boolean(extra.voice),
    duration: extra.voice ? Math.round(Number(extra.duration) || 0) : null,
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
  if (message.call) return callLabel(message.call);
  if (message.deleted) return 'Pesan ini sudah dihapus';
  if (message.error) return 'Pesan nggak bisa dibuka';
  const attachment = message.attachment;
  if (message.voice) {
    const length = message.duration ? ` · ${formatClock(message.duration)}` : '';
    return `Pesan suara${length}${message.text ? ` — ${message.text}` : ''}`;
  }
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
  // Kotak username + kata sandi jalan di kedua mode: akunnya dibuat server ini
  // sendiri, bukan oleh penyedia login.
  el.loginPasswordForm.hidden = false;
  el.loginDivider.hidden = !firebaseMode;

  // Notifikasi: dibuat sekali, dipakai ulang tiap akun. Kalau orangnya pernah
  // menyalakannya, service worker dipasang lagi tanpa menanyakan izin ulang.
  state.notifier = createNotifier({
    onAction: handleNotificationAction,
    onAccountUid: () => state.me?.uid || null,
  });
  state.notifier.resume();

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
  el.loginNotice.hidden = true;
  el.loginError.hidden = true;
  showAuthPanel('login');
  state.chatPrefs = new Map();
  state.lists = [];
  state.blocked = new Set();
  state.listFilter = 'all';
  state.selection = null;
  closeChatSearch();
  closeChatOptions();
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
  loadChatPrefs(profile.uid);
  state.listFilter = 'all';
  state.selection = null;
  closeChatSearch();
  closeChatOptions();
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
  // Pesan sementara langsung berlaku saat aplikasi dibuka, bukan menunggu
  // interval pertama.
  pruneDisappearing();
  state.callState = null;
  loadCallLog(profile.uid);

  el.login.hidden = true;
  el.app.hidden = false;
  document.title = 'By Chat';
  renderSettings();
  renderCalls();
  setView('chats', { animate: false });
  setStatus('menyambung…');

  const token = await state.auth.getIdToken();
  connect(token);
}

function setStatus(text, online = false) {
  el.meStatus.textContent = text;
  el.meStatus.classList.toggle('online', online);
}

/* ------------------------------------------------------------------ *
 * Shell: rail (desktop) + navbar bawah (hp) yang cuma memindahkan panel
 * ------------------------------------------------------------------ */
const VIEWS = ['chats', 'status', 'calls', 'settings'];

/**
 * Pindah panel di kolom daftar. Di hp ini yang bikin "halaman" berganti,
 * dan percakapan yang sedang terbuka ikut ditutup supaya kembali ke daftar.
 */
function setView(view, { animate = true } = {}) {
  if (!VIEWS.includes(view)) return;
  state.view = view;

  for (const panel of el.lists.querySelectorAll('.panel')) {
    const active = panel.dataset.panel === view;
    panel.hidden = !active;
    if (!active) {
      panel.classList.remove('view-in');
      continue;
    }
    if (animate) {
      // Animasi dimulai ulang tiap kali panelnya dibuka, bukan cuma sekali.
      panel.classList.remove('view-in');
      void panel.offsetWidth;
      panel.classList.add('view-in');
    }
  }

  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === view;
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('active', active);
  }

  // Di hp, memilih menu berarti kembali ke daftar (keluar dari percakapan).
  el.app.classList.remove('show-chat');

  if (view === 'settings') renderSettings();
  if (view === 'calls') renderCalls();
  if (view === 'status') renderStatuses();
}

/* ------------------------------------------------------------------ *
 * Panggilan: riwayat lokal di perangkat ini
 * ------------------------------------------------------------------ */
const callLogKey = (uid) => `bychat.calls.v1.${uid}`;

function loadCallLog(uid) {
  state.callLog = store.get(callLogKey(uid), []) || [];
}

function saveCallLog() {
  if (!state.me) return;
  store.set(callLogKey(state.me.uid), state.callLog.slice(0, 50));
}

function addCallEntry(entry) {
  state.callLog = [entry, ...state.callLog].slice(0, 50);
  saveCallLog();
  renderCalls();
  paintNavBadges();
}

const CALL_STATUS_LABEL = {
  answered: null,
  missed: 'Tidak terjawab',
  unanswered: 'Tidak terjawab',
  busy: 'Sedang ada panggilan',
};

function callDuration(seconds) {
  if (!seconds) return '';
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} mnt ${seconds % 60} dtk` : `${seconds} dtk`;
}

function renderCalls() {
  if (!el.callList) return;
  el.callList.innerHTML = '';
  el.callEmpty.hidden = state.callLog.length > 0;

  for (const entry of state.callLog) {
    const label = CALL_STATUS_LABEL[entry.status] || callDuration(entry.duration);
    const li = document.createElement('li');
    li.className = `call-item${entry.status === 'missed' ? ' missed' : ''}`;
    li.dataset.uid = entry.uid || '';
    li.innerHTML = `
      <span class="avatar" data-uid="${esc(entry.uid || '')}">${esc(initials(entry.name))}</span>
      <span class="call-item-main">
        <strong>${esc(entry.name)}</strong>
        <span class="muted">
          <svg class="ico call-icon${entry.status === 'missed' ? ' bad' : ''}"><use href="#${entry.direction === 'in' ? 'i-call-in' : 'i-call-out'}" /></svg>
          ${entry.direction === 'in' ? 'Masuk' : 'Keluar'}${entry.video ? ' · video' : ''}
          ${label ? `· ${esc(label)}` : ''}
        </span>
      </span>
      <span class="call-when muted">${formatListTime(entry.at)}</span>
    `;
    li.addEventListener('click', () => openCallPeer(entry.uid));
    el.callList.appendChild(li);
  }

  paintAvatars(el.callList);
}

/** Mengetuk riwayat membuka percakapan orangnya, kalau roomnya memang ada. */
function openCallPeer(uid) {
  if (!uid) return;
  const room = [...state.rooms.values()].find((entry) => entry.type === 'dm' && entry.members.includes(uid));
  if (!room) return showToast('Percakapan dengan orang ini belum ada di perangkat ini.');
  setView('chats');
  selectRoom(room.id);
}

/** Room DM dengan seseorang, kalau percakapannya memang ada di perangkat ini. */
function dmRoomWith(uid) {
  if (!uid || !state.me) return null;
  for (const room of state.rooms.values()) {
    if (room.type === 'dm' && room.members.includes(uid)) return room;
  }
  return null;
}

/** Detik → "2 mnt 5 dtk". */
function callDurationText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes ? `${minutes} mnt ${rest} dtk` : `${rest} dtk`;
}

/** Detik berjalan → "01:07", atau "1:02:03" untuk panggilan panjang. */
function callClock(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Hasil panggilan dari server: satu baris di panel Panggilan, satu bubble di
 * chat. Server yang mengirimnya ke kedua pihak, jadi panggilan yang tidak
 * terjawab tetap muncul di chat orang yang sedang offline.
 */
function applyCallLog(entry) {
  if (!entry || !state.me) return;
  const mineUid = state.me.uid;
  const direction = entry.from?.uid === mineUid ? 'out' : 'in';
  const peerUid = direction === 'out' ? entry.to?.uid : entry.from?.uid;
  const peer = peerByUid(peerUid);
  const name = entry.group ? 'Panggilan grup' : peer?.displayName || (direction === 'out' ? entry.to?.displayName : entry.from?.displayName) || 'Tidak dikenal';

  addCallEntry({
    id: entry.id,
    uid: peerUid || '',
    name,
    photoURL: peer?.photoURL || null,
    video: Boolean(entry.video),
    at: entry.at || Date.now(),
    direction,
    status: entry.kind === 'busy' ? 'busy' : entry.kind === 'answered' ? 'answered' : 'missed',
    duration: Number(entry.duration) || 0,
  });

  const room = dmRoomWith(peerUid);
  if (!room) return;
  const id = `call:${entry.id}`;
  if (room.messages.some((message) => message.id === id)) return;

  room.messages.push({
    id,
    from: direction === 'out' ? mineUid : peerUid,
    at: entry.at || Date.now(),
    call: {
      kind: entry.kind === 'busy' ? 'busy' : entry.kind === 'answered' ? 'answered' : 'missed',
      video: Boolean(entry.video),
      direction,
      duration: Number(entry.duration) || 0,
      group: Boolean(entry.group),
    },
  });

  saveRooms();
  if (state.activeRoomId === room.id) renderMessages();
  renderChatList();
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
  el.displayName.value = username;
  el.nameTag.textContent = `@${username}`;
  el.railAvatar.textContent = initials(username);
  el.railAvatar.dataset.hueFor = username;
  el.railAvatar.dataset.uid = state.me?.uid || '';
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
    // Catatan panggilan yang terjadi saat perangkat ini tertutup.
    for (const entry of payload.callLogs || []) applyCallLog(entry);
    if (!state.activeRoomId) renderEmptyState();
    openRoomFromQuery();
    flushNotificationReply();
    syncPushSubscription(token);
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

/** Daftarkan endpoint Web Push supaya panggilan tetap berdering saat tab ditutup. */
function syncPushSubscription(token) {
  const publicKey = state.config?.calls?.pushPublicKey;
  if (!publicKey || !token) return;
  state.notifier?.syncPush?.(publicKey, token);
}

function setupCalls() {
  // Hasil panggilan (terjawab/tidak terjawab/sibuk) ditulis ke chat kedua pihak.
  socket.on('call:log', (entry) => applyCallLog(entry));

  socket.on('call:incoming', (data) => {
    state.incoming = data;
    const from = data.from || { uid: '', displayName: '—' };
    el.incomingName.textContent = from.displayName;
    el.incomingAvatar.textContent = initials(from.displayName);
    el.incomingAvatar.dataset.uid = from.uid;
    const extra = (data.members || []).filter((member) => member.uid !== from.uid).length;
    el.incomingKind.textContent = [
      data.video ? 'Panggilan video masuk' : 'Panggilan suara masuk',
      extra ? `${extra + 1} orang` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    el.incoming.hidden = false;
    paintAvatars();
    // Call manager sudah menerima event yang sama dari socket dan menyiapkan
    // state-nya; memanggil handleIncoming lagi di sini akan dianggap panggilan
    // kedua dan langsung ditolak.
    startRingtone();
    showToast(`${from.displayName} menelepon…`, 5000);

    // Notifikasi push punya tombol Terima/Tolak; keduanya membuka halaman ini
    // dengan callId yang sama, jadi keputusannya diteruskan ke sini.
    const params = new URLSearchParams(location.search);
    if (params.get('answer') === data.callId) {
      history.replaceState(null, '', location.pathname);
      setTimeout(() => state.calls?.acceptCall(), 350);
    } else if (params.get('decline') === data.callId) {
      history.replaceState(null, '', location.pathname);
      setTimeout(() => state.calls?.rejectCall(), 250);
    }
  });

  state.calls = createCallManager({
    socket,
    selfUid: () => state.me?.uid || null,
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
async function sendToRoom(
  room,
  text,
  attachment,
  { replyTo = null, forwarded = false, voice = false, duration = 0 } = {}
) {
  if (!room) return;
  if (!String(text || '').trim() && !attachment) return;
  // Pesan ke kontak yang diblokir tidak dikirim: blokir yang cuma menyembunyikan
  // pesan masuk akan jadi tombol tanpa arti.
  if (peerBlocked(room)) return showToast('Buka blokir dulu untuk mengirim pesan ke kontak ini.');

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

  const payload = await encryptMessage(
    packMessage(text, outgoing, { replyTo, forwarded, voice, duration }),
    sharedKeys
  );
  const local = {
    id: `local:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    from: state.me.uid,
    text: text || '',
    attachment: attachment || null,
    replyTo: replyTo || null,
    forwarded: Boolean(forwarded),
    voice: Boolean(voice),
    duration: voice ? Math.round(Number(duration) || 0) : null,
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
  // Kontak yang diblokir di perangkat ini: pesannya tidak masuk ke riwayat,
  // tidak menambah belum-dibaca, dan tidak memicu notifikasi.
  if (isPeerBlocked(envelope.from)) return;

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
    voice: Boolean(parsed.voice),
    duration: parsed.voice ? Number(parsed.duration) || 0 : null,
    error,
  });

  const reading =
    state.activeRoomId === room.id && document.visibilityState === 'visible' && document.hasFocus();
  if (state.activeRoomId === room.id) renderMessages();
  else state.unread.set(room.id, (state.unread.get(room.id) || 0) + 1);

  saveRooms();
  renderChatList();

  // Notifikasi cuma kalau orangnya memang tidak sedang membaca percakapan ini,
  // dan obrolannya tidak sedang dibisukan. Isinya sudah didekripsi di sini;
  // SW cuma menampilkan teksnya.
  if (!reading && envelope.from !== state.me.uid && !isMuted(room.id)) {
    notifyIncoming(room, envelope, parsed, error);
  }

  // Pesan sementara: yang datang telat pun ikut hilang kalau umurnya lewat.
  if (Number(roomPrefs(room.id).disappearMs)) pruneDisappearing();
}

/** Cuplikan singkat untuk notifikasi — sama seperti yang tampil di daftar chat. */
function notificationPreview(parsed, error) {
  if (error) return 'Pesan tidak bisa dibuka di perangkat ini.';
  const text = String(parsed.text || '').trim();
  if (parsed.voice) return 'Pesan suara';
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text;
  if (parsed.attachment) return KIND_LABEL[fileKind(parsed.attachment.mime)] || 'Lampiran';
  return 'Pesan baru';
}

function notifyIncoming(room, envelope, parsed, error) {
  const sender =
    peerByUid(envelope.from)?.displayName || (room.type === 'group' ? room.name : null) || 'Seseorang';
  const title = room.type === 'group' && room.name ? `${sender} · ${room.name}` : sender;
  state.notifier?.notify({
    roomId: room.id,
    uid: state.me?.uid,
    title,
    body: notificationPreview(parsed, error),
  });
}

/**
 * Aksi dari notifikasi: buka chat-nya, dan kalau platformnya mendukung balasan
 * langsung (Chrome Android), kirim teks yang sudah diketik di sana.
 */
async function handleNotificationAction({ action = 'open', roomId, reply, callId } = {}) {
  // Tombol Terima/Tolak di notifikasi panggilan.
  if (action === 'call-answer' || action === 'call-decline') {
    if (!state.calls?.active) return;
    if (action === 'call-answer') {
      el.incoming.hidden = true;
      stopRingtone();
      state.calls.acceptCall();
    } else {
      el.incoming.hidden = true;
      stopRingtone();
      state.calls.rejectCall();
    }
    return;
  }

  if (!roomId) return;
  const room = state.rooms.get(roomId);
  if (!room) return;

  // Notifikasi bisa diklik dari panel mana pun; percakapannya dibuka di panel
  // Chat, dan di hp itu berarti keluar dulu dari daftarnya.
  if (state.view !== 'chats') setView('chats');
  if (state.activeRoomId !== roomId) selectRoom(roomId);

  const text = String(reply || '').trim();
  if (text) {
    await sendToRoom(room, text, null);
    showToast('Balasan dari notifikasi terkirim.');
    return;
  }

  // Desktop belum punya kolom balas di notifikasi: chat dibuka dan kolom ketik
  // langsung difokuskan, jadi balasannya tetap satu langkah.
  if (action === 'reply') {
    el.input.focus();
    showToast(`Balas ${displayName(room)} di sini.`);
  }
}

/** Balasan yang dititipkan service worker saat aplikasinya belum terbuka. */
async function flushNotificationReply() {
  const pending = await state.notifier?.takePendingReply();
  if (!pending) return;
  const room = state.rooms.get(pending.roomId);
  if (!room) return;
  await sendToRoom(room, pending.text, null);
  showToast('Balasan dari notifikasi terkirim.');
}

/** `/?chat=<id>` — dipakai notifikasi untuk membuka percakapan yang tepat. */
function openRoomFromQuery() {
  const params = new URLSearchParams(location.search);
  // `chat` membuka percakapan, `call` membuka percakapan sekaligus menelepon —
  // yang terakhir itulah tautan dari menu "Kirim tautan menelepon".
  const roomId = params.get('chat');
  const callRoom = params.get('call');
  const target = roomId || callRoom;
  if (!target) return;
  history.replaceState(null, '', location.pathname);
  if (!state.rooms.has(target)) return;
  setView('chats', { animate: false });
  selectRoom(target);
  if (callRoom) setTimeout(() => joinCallFromLink(callRoom), 400);
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

/** Salin teks, dengan jalan cadangan kalau Clipboard API ditolak. */
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API butuh HTTPS dan izin; ini jalan terakhirnya.
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.style.position = 'fixed';
    scratch.style.opacity = '0';
    document.body.appendChild(scratch);
    scratch.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      scratch.remove();
    }
  }
}

function copyMessage(message) {
  const text = String(message.text || '').trim();
  if (!text) return showToast('Pesan ini nggak punya teks buat disalin.');
  return writeClipboard(text).then((ok) =>
    showToast(ok ? 'Pesan disalin.' : 'Teksnya nggak bisa disalin di browser ini.')
  );
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
      await sendToRoom(target, message.text, message.attachment, {
        forwarded: true,
        voice: Boolean(message.voice),
        duration: message.duration,
      });
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
  // Di mode pilih pesan, satu ketukan mencentang pesan — bukan membuka menu.
  if (state.selection) return toggleSelected(bubble);

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

/* ---- Pesan suara ---------------------------------------------------
 * Merekam tidak mengirim apa pun. Begitu tombol kirim ditekan, blob-nya
 * dibungkus jadi File lalu masuk jalur lampiran yang sama dengan foto:
 * dienkripsi di browser, diunggah sebagai ciphertext, dan kuncinya cuma ada
 * di dalam pesan terenkripsi. Penerima men-download + mendekripsi saat
 * memutar, bukan saat pesannya masuk.
 */

/** Tombol kanan komposer: mikrofon saat kosong, panah saat ada teks. */
function paintComposerAction() {
  const hasText = Boolean(el.input.value.trim());
  const label = hasText ? 'Kirim' : 'Rekam pesan suara';
  if (el.sendIcon) el.sendIcon.setAttribute('href', hasText ? '#i-send' : '#i-mic');
  el.btnSend.title = label;
  el.btnSend.setAttribute('aria-label', label);
}

function paintRecordingUi(recording) {
  el.recordBar.hidden = !recording;
  el.composer.hidden = Boolean(recording);
  el.recordBar.classList.toggle('live', Boolean(recording));
  if (recording) {
    el.recordTime.textContent = '0:00';
    el.recordHint.textContent = 'Merekam…';
    el.recordSend.disabled = false;
  }
}

async function startVoiceNote() {
  if (state.voiceRecording) return;
  if (!state.rooms.get(state.activeRoomId)) return;
  stopTyping();

  let recording;
  try {
    recording = await startVoiceRecording();
  } catch (err) {
    showToast(err.message, 6000);
    return;
  }

  state.voiceRecording = recording;
  paintRecordingUi(recording);
  state.voiceTimer = setInterval(() => {
    if (!state.voiceRecording) return;
    const seconds = state.voiceRecording.elapsed();
    el.recordTime.textContent = formatClock(seconds);
    if (seconds >= MAX_VOICE_SECONDS) {
      el.recordHint.textContent = 'Batas 5 menit — mengirim…';
      finishVoiceNote();
    }
  }, 200);
}

function clearRecordingState() {
  state.voiceRecording = null;
  clearInterval(state.voiceTimer);
  state.voiceTimer = null;
  paintRecordingUi(null);
  paintComposerAction();
  el.input.focus();
}

function cancelVoiceNote() {
  const recording = state.voiceRecording;
  if (!recording) return;
  clearRecordingState();
  recording.cancel();
}

async function finishVoiceNote() {
  const recording = state.voiceRecording;
  if (!recording) return;
  el.recordSend.disabled = true;
  el.recordHint.textContent = 'Menyiapkan…';
  const result = await recording.stop();
  if (!state.voiceRecording) return;
  clearRecordingState();

  if (result.duration < 0.5 || !result.blob.size) {
    showToast('Rekamannya terlalu pendek. Coba tahan tombolnya sebentar.');
    return;
  }
  await sendVoiceNote(result);
}

const VOICE_EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' };

async function sendVoiceNote({ blob, mime, ext, duration }) {
  const room = state.rooms.get(state.activeRoomId);
  if (!room) return;

  const replyTo = state.replyTo;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = new File([blob], `pesan-suara-${stamp}.${VOICE_EXT[mime] || ext || 'webm'}`, {
    type: mime,
  });

  const token = ++state.uploadToken;
  el.uploadBar.hidden = false;
  el.uploadLabel.textContent = 'Menyiapkan pesan suara…';
  el.uploadFill.style.width = '0%';

  try {
    const attachment = await uploadAttachment({
      file,
      getIdToken: () => state.auth.getIdToken(),
      maxBytes: state.config.files.maxBytes,
      onStage: (stage, fraction) => {
        if (token !== state.uploadToken) return;
        const verb = stage === 'encrypt' ? 'Mengenkripsi' : 'Mengunggah';
        el.uploadLabel.textContent = `${verb} pesan suara — ${Math.round(fraction * 100)}%`;
        el.uploadFill.style.width = `${Math.round(fraction * 100)}%`;
      },
    });
    if (token !== state.uploadToken) return;

    // Pratinjau langsung dari blob lokal: pengirim nggak perlu mengunduh
    // rekamannya sendiri cuma buat mendengarkannya lagi.
    attachment.localUrl = URL.createObjectURL(blob);
    cancelReply();
    await sendToRoom(room, '', attachment, { replyTo, voice: true, duration });
  } catch (err) {
    showToast(`Gagal kirim pesan suara: ${err.message}`, 6000);
  } finally {
    if (token === state.uploadToken) el.uploadBar.hidden = true;
    el.uploadFill.style.width = '0%';
  }
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
  // Pindah chat menghentikan rekaman dan suara yang sedang diputar; keduanya
  // milik percakapan yang sedang dibuka, bukan percakapan berikutnya.
  if (state.voiceRecording) cancelVoiceNote();
  stopVoicePlayback();
  closeChatOptions();
  closeChatSearch();
  exitSelection({ render: false });
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
  paintComposerAction();
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
  el.btnReport.hidden = !isDm;

  // Blokir berlaku di perangkat ini saja: kolom ketik dikunci dan pesan dari
  // kontak itu tidak dimunculkan (lihat receiveMessage).
  const blocked = peerBlocked(room);
  el.blockedBar.hidden = !blocked;
  if (blocked) el.blockedText.textContent = `Kamu memblokir ${name}. Pesannya nggak akan muncul di perangkat ini.`;
  el.input.disabled = blocked;
  el.btnSend.disabled = blocked;
  el.btnAttach.disabled = blocked;

  if (!isDm) {
    const names = room.members.filter((m) => m !== state.me.uid).map((m) => peerByUid(m)?.displayName || '?');
    el.peerSub.textContent = `${room.members.length} anggota · ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`;
    return;
  }

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
  renderListFilters();

  const inFilter = (room) => {
    if (state.listFilter === 'all') return true;
    if (state.listFilter === 'favorite') return isFavorite(room.id);
    return roomPrefs(room.id).lists.includes(state.listFilter);
  };

  const rooms = [...state.rooms.values()]
    .filter(inFilter)
    .sort((a, b) => {
      const at = a.messages[a.messages.length - 1]?.at || 0;
      const bt = b.messages[b.messages.length - 1]?.at || 0;
      // Favorit selalu di atas; sisanya urut pesan terbaru.
      return Number(isFavorite(b.id)) - Number(isFavorite(a.id)) || bt - at;
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
    const fav = isFavorite(room.id);
    const muted = isMuted(room.id);
    const blocked = peerBlocked(room);

    const peerUid = room.type === 'dm' ? otherUid(room) : null;
    const peerStatuses = peerUid ? statusesFrom(peerUid).length : 0;
    const ring = peerStatuses ? (unseenStatusCount(peerUid) ? ' ring' : ' ring-seen') : '';

    const li = document.createElement('li');
    li.className =
      'chat-item' +
      (room.id === state.activeRoomId ? ' active' : '') +
      (blocked ? ' blocked' : '');
    li.innerHTML = `
      <div class="avatar${ring}"${peerUid ? ` data-uid="${esc(peerUid)}"` : ''}>${esc(initials(name))}</div>
      <div class="chat-item-main">
        <div class="chat-item-top">
          <span class="chat-item-name">${esc(name)}${room.type === 'group' ? ' 👥' : ''}${
            fav ? '<svg class="ico chat-item-flag star"><use href="#i-star-filled" /></svg>' : ''
          }</span>
          <span class="chat-item-time">${
            muted ? '<svg class="ico chat-item-flag muted"><use href="#i-bell-off" /></svg>' : ''
          }${last ? formatListTime(last.at) : ''}</span>
        </div>
        <div class="chat-item-sub">${esc(
          blocked ? 'Diblokir — pesan dari kontak ini disembunyikan' : preview(last)
        )}</div>
      </div>
      ${peerOnline ? '<span class="dot"></span>' : ''}
      ${unread ? `<span class="badge">${unread}</span>` : ''}
      <button type="button" class="chat-menu-btn" title="Menu chat" aria-label="Menu chat ${esc(name)}">
        <svg class="ico"><use href="#i-chevron" /></svg>
      </button>
    `;
    li.addEventListener('click', () => {
      // Klik sintetis yang menyusul tahan-sebentar tidak boleh ikut membuka chat.
      if (Date.now() - state.chatMenuOpenedAt < 600) return;
      selectRoom(room.id);
    });
    li.querySelector('.chat-menu-btn').addEventListener('click', (event) => {
      event.stopPropagation();
      openChatMenu(li, room);
    });
    // Di layar sentuh panahnya nggak muncul; tahan baris chat sebentar sebagai
    // jalan yang sama seperti WhatsApp.
    bindChatLongPress(li, room);
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
  el.chatListEmpty.textContent = filter
    ? 'Nggak ada chat yang cocok.'
    : state.listFilter === 'all'
      ? 'Belum ada chat. Tekan ＋ buat mulai.'
      : 'Belum ada chat di daftar ini.';
  paintAvatars(el.chatList);

  // Jumlah belum dibaca ikut ke judul tab, supaya kelihatan walau jendelanya
  // sedang di belakang.
  const unreadTotal = [...state.unread.values()].reduce((sum, count) => sum + count, 0);
  document.title = unreadTotal ? `(${unreadTotal}) By Chat` : 'By Chat';
  paintNavBadges(unreadTotal);
}

/** Badge jumlah belum dibaca di rail (desktop) dan navbar bawah (hp). */
function paintNavBadges(unreadTotal = [...state.unread.values()].reduce((sum, count) => sum + count, 0)) {
  for (const badge of [el.railUnread, el.tabUnread]) {
    if (!badge) continue;
    badge.hidden = unreadTotal === 0;
    badge.textContent = unreadTotal > 99 ? '99+' : String(unreadTotal);
  }
}

/* ---- Menu chat (panah di baris daftar chat) ------------------------
 * Isinya sengaja cuma yang benar-benar dikerjakan aplikasi ini. "Bersihkan
 * chat" menghapus semua pesannya tapi chatnya tetap ada; "Hapus chat"
 * membuang chatnya sekalian dari perangkat ini. Dua-duanya lokal: server cuma
 * perantara dan memang tidak menyimpan riwayat.
 */
const CHAT_LONG_PRESS_MS = 460;
let chatPressTimer = null;
let chatPressPoint = { x: 0, y: 0 };

function chatMenuActions(room) {
  const unread = state.unread.get(room.id) || 0;
  const actions = [
    {
      id: unread ? 'read' : 'unread',
      label: unread ? 'Tandai sudah dibaca' : 'Tandai belum dibaca',
      icon: unread ? '#i-checks' : '#i-chat',
    },
  ];
  if (room.messages.length) actions.push({ id: 'clear', label: 'Bersihkan chat', icon: '#i-broom' });
  actions.push({ id: 'delete', label: 'Hapus chat', icon: '#i-trash', danger: true });
  return actions;
}

function placeChatMenu(li) {
  const rect = li.getBoundingClientRect();
  const pad = 10;
  const box = el.chatMenuList.getBoundingClientRect();
  const left = Math.min(Math.max(pad, rect.right - box.width), Math.max(pad, innerWidth - box.width - pad));
  let top = rect.bottom + 6;
  if (top + box.height > innerHeight - pad) top = Math.max(pad, rect.top - box.height - 6);
  el.chatMenuList.style.left = `${left}px`;
  el.chatMenuList.style.top = `${top}px`;
}

function openChatMenu(li, room) {
  if (!li || !room) return;
  closeMessageMenu();
  closeChatMenu();
  state.chatMenuOpenedAt = Date.now();
  el.chatMenu.hidden = false;
  el.chatMenuList.innerHTML = '';
  el.chatMenu.dataset.target = room.id;
  li.classList.add('menu-target');

  for (const action of chatMenuActions(room)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'msg-menu-item' + (action.danger ? ' danger' : '');
    button.dataset.action = action.id;
    button.setAttribute('role', 'menuitem');
    button.innerHTML = `<svg class="ico"><use href="${action.icon}" /></svg><span>${esc(action.label)}</span>`;
    button.addEventListener('click', () => {
      closeChatMenu();
      runChatAction(action.id, room);
    });
    el.chatMenuList.appendChild(button);
  }

  placeChatMenu(li);
}

function closeChatMenu() {
  if (el.chatMenu.hidden) return;
  el.chatMenu.hidden = true;
  el.chatMenuList.innerHTML = '';
  delete el.chatMenu.dataset.target;
  for (const node of el.chatList.querySelectorAll('.chat-item.menu-target')) node.classList.remove('menu-target');
}

/** Tahan baris chat (layar sentuh): jalan yang sama dengan panah di desktop. */
function bindChatLongPress(li, room) {
  const start = (point) => {
    clearTimeout(chatPressTimer);
    chatPressPoint = point;
    chatPressTimer = setTimeout(() => {
      chatPressTimer = null;
      openChatMenu(li, room);
    }, CHAT_LONG_PRESS_MS);
  };
  const cancel = () => clearTimeout(chatPressTimer);

  li.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target.closest('.chat-menu-btn')) return;
    start({ x: event.clientX, y: event.clientY });
  });
  li.addEventListener('pointermove', (event) => {
    if (!chatPressTimer) return;
    if (Math.hypot(event.clientX - chatPressPoint.x, event.clientY - chatPressPoint.y) > 10) cancel();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) li.addEventListener(type, cancel);
}

/* ------------------------------------------------------------------ *
 * Preferensi obrolan: favorit, bisu, pesan sementara, daftar, blokir
 *
 * Semuanya lokal dan disimpan per akun. Server memang perantara buta: dia
 * tidak punya riwayat untuk dimute atau dihapus, jadi mengatur semua ini di
 * sini bukan kekurangan — itu satu-satunya tempat yang masuk akal.
 * ------------------------------------------------------------------ */

/** Nilai khusus untuk "dibisukan sampai kapan pun". */
const FOREVER = 'forever';
const MUTE_OPTIONS = [
  { label: '8 jam', value: 8 * 60 * 60 * 1000 },
  { label: '1 minggu', value: 7 * 24 * 60 * 60 * 1000 },
  { label: 'Selamanya', value: FOREVER },
];
const DISAPPEAR_OPTIONS = [
  { label: '24 jam', value: 24 * 60 * 60 * 1000 },
  { label: '7 hari', value: 7 * 24 * 60 * 60 * 1000 },
  { label: '90 hari', value: 90 * 24 * 60 * 60 * 1000 },
];
const THEME_OPTIONS = [
  { label: 'Terang', value: 'light' },
  { label: 'Gelap', value: 'dark' },
  { label: 'Otomatis (ikut perangkat)', value: 'system' },
];

function roomPrefs(roomId) {
  let prefs = state.chatPrefs.get(roomId);
  if (!prefs || typeof prefs !== 'object') {
    prefs = { favorite: false, mutedUntil: 0, mutedFor: 0, disappearMs: 0, lists: [] };
    state.chatPrefs.set(roomId, prefs);
  }
  if (!Array.isArray(prefs.lists)) prefs.lists = [];
  return prefs;
}

function loadChatPrefs(uid) {
  const saved = store.get(chatPrefsKey(uid), []) || [];
  state.chatPrefs = new Map(Array.isArray(saved) ? saved.filter((entry) => Array.isArray(entry)) : []);
  state.lists = (store.get(listsKey(uid), []) || []).filter((list) => list?.id && list?.name);
  state.blocked = new Set(store.get(blockedKey(uid), []) || []);
}

function saveChatPrefs() {
  if (!state.me) return;
  store.set(chatPrefsKey(state.me.uid), [...state.chatPrefs]);
  store.set(listsKey(state.me.uid), state.lists);
  store.set(blockedKey(state.me.uid), [...state.blocked]);
}

const isFavorite = (roomId) => Boolean(roomPrefs(roomId).favorite);
const isMuted = (roomId) => {
  const until = roomPrefs(roomId).mutedUntil;
  return until === FOREVER || Number(until) > Date.now();
};
const isPeerBlocked = (uid) => state.blocked.has(String(uid || ''));
const peerBlocked = (room) => room?.type === 'dm' && isPeerBlocked(otherUid(room));

function muteLabel(roomId) {
  const until = roomPrefs(roomId).mutedUntil;
  if (until === FOREVER) return 'selamanya';
  if (Number(until) > Date.now()) {
    const hours = Math.ceil((Number(until) - Date.now()) / (60 * 60 * 1000));
    return hours > 24 ? `${Math.ceil(hours / 24)} hari` : `${hours} jam`;
  }
  return null;
}

function setMute(room, value) {
  const prefs = roomPrefs(room.id);
  // `value` dari menu itu durasi (8 jam, 1 minggu), bukan waktu kedaluwarsa:
  // yang disimpan harus titik berakhirnya, supaya bisunya benar-benar habis.
  prefs.mutedFor = value === FOREVER ? FOREVER : Number(value) || 0;
  prefs.mutedUntil = value === FOREVER ? FOREVER : value ? Date.now() + Number(value) : 0;
  saveChatPrefs();
  renderChatList();
  if (!value) return showToast('Notifikasi obrolan ini berbunyi lagi.');
  showToast(
    value === FOREVER
      ? `Notifikasi ${displayName(room)} dimatikan selamanya.`
      : `Notifikasi ${displayName(room)} dimatikan selama ${MUTE_OPTIONS.find((o) => o.value === value)?.label || 'sebentar'}.`
  );
}

const disappearLabel = (ms) => DISAPPEAR_OPTIONS.find((option) => option.value === ms)?.label || null;

/**
 * Buang pesan yang umurnya sudah lewat batas "pesan sementara". Batasnya
 * dihitung dari waktu pesan itu diterima, di perangkat ini — satu-satunya jam
 * yang bisa dipercaya karena server tidak menyimpan riwayat sama sekali.
 */
function pruneDisappearing() {
  let removed = 0;
  for (const room of state.rooms.values()) {
    const ttl = Number(roomPrefs(room.id).disappearMs) || 0;
    if (!ttl) continue;
    const cutoff = Date.now() - ttl;
    // Catatan sistem dan riwayat panggilan bukan pesan, jadi tidak ikut hilang
    // bersama isi percakapannya.
    const kept = room.messages.filter((m) => m.system || m.call || (Number(m.at) || 0) >= cutoff);
    removed += room.messages.length - kept.length;
    room.messages = kept;
  }
  if (!removed) return false;
  saveRooms();
  renderChatList();
  if (state.activeRoomId) renderMessages();
  return true;
}

function setDisappearing(room, ms) {
  const prefs = roomPrefs(room.id);
  prefs.disappearMs = Number(ms) || 0;
  saveChatPrefs();
  if (prefs.disappearMs) {
    pushSystemNote(
      room,
      `Pesan sementara ${disappearLabel(prefs.disappearMs)} aktif. Pesan yang lebih lama dari itu hilang dari perangkat ini.`
    );
  } else {
    pushSystemNote(room, 'Pesan sementara dimatikan.');
  }
  saveRooms();
  if (state.activeRoomId === room.id) renderMessages();
  renderChatList();
  showToast(prefs.disappearMs ? `Pesan sementara ${disappearLabel(prefs.disappearMs)}.` : 'Pesan sementara dimatikan.');
}

/* ---- Daftar obrolan buatan sendiri ---- */
function createList(name) {
  const clean = String(name || '').trim().slice(0, 24);
  if (!clean) return null;
  if (state.lists.some((list) => list.name.toLowerCase() === clean.toLowerCase())) {
    showToast('Daftar dengan nama itu sudah ada.');
    return null;
  }
  const list = { id: `list-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: clean };
  state.lists.push(list);
  saveChatPrefs();
  return list;
}

function toggleRoomList(room, listId) {
  const prefs = roomPrefs(room.id);
  const has = prefs.lists.includes(listId);
  prefs.lists = has ? prefs.lists.filter((id) => id !== listId) : [...prefs.lists, listId];
  saveChatPrefs();
  renderChatList();
  return !has;
}

/** Baris chip "Semua / Favorit / daftar…" di atas daftar chat. */
function renderListFilters() {
  if (!el.listFilters) return;
  const hasFavorites = [...state.rooms.values()].some((room) => isFavorite(room.id));
  const chips = [
    { id: 'all', label: 'Semua' },
    ...(hasFavorites ? [{ id: 'favorite', label: 'Favorit' }] : []),
    ...state.lists.map((list) => ({ id: list.id, label: list.name })),
  ];
  el.listFilters.hidden = chips.length < 2;
  el.listFilters.innerHTML = '';
  for (const chip of chips) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.filter = chip.id;
    button.textContent = chip.label;
    button.classList.toggle('active', state.listFilter === chip.id);
    button.addEventListener('click', () => {
      state.listFilter = chip.id;
      renderChatList();
    });
    el.listFilters.appendChild(button);
  }
}

/* ---- Blokir (lokal) ---- */
function toggleBlock(room) {
  if (room?.type !== 'dm') return showToast('Blokir cuma berlaku untuk chat pribadi.');
  const uid = otherUid(room);
  if (state.blocked.has(uid)) {
    state.blocked.delete(uid);
    showToast(`${displayName(room)} nggak lagi diblokir di perangkat ini.`);
  } else {
    state.blocked.add(uid);
    showToast(`${displayName(room)} diblokir di perangkat ini. Pesannya disembunyikan.`);
  }
  saveChatPrefs();
  renderChatList();
  if (state.activeRoomId === room.id) {
    renderPeerHeader();
    renderMessages();
  }
}

/* ------------------------------------------------------------------ *
 * Menu obrolan (titik tiga di header)
 * ------------------------------------------------------------------ */

function chatMenuItems(room) {
  const prefs = roomPrefs(room.id);
  const isDm = room.type === 'dm';
  const muted = isMuted(room.id);
  const ttl = Number(prefs.disappearMs) || 0;
  const blocked = peerBlocked(room);

  return [
    { id: 'info', label: 'Info kontak', icon: '#i-info' },
    { id: 'search', label: 'Cari', icon: '#i-search' },
    {
      id: 'select',
      label: 'Pilih pesan',
      icon: '#i-checks',
      disabled: !room.messages.some((message) => !message.system && !message.call),
    },
    {
      id: 'mute',
      label: muted ? 'Bisukan notifikasi · aktif' : 'Bisukan notifikasi',
      icon: '#i-bell-off',
      submenu: () => ({
        title: 'Bisukan notifikasi',
        items: [
          ...MUTE_OPTIONS.map((option) => ({
            label: option.label,
            active: muted && prefs.mutedFor === option.value,
            run: () => setMute(room, option.value),
          })),
          ...(muted ? [{ label: 'Matikan bisu', run: () => setMute(room, 0) }] : []),
        ],
      }),
    },
    {
      id: 'disappear',
      label: ttl ? `Pesan sementara · ${disappearLabel(ttl)}` : 'Pesan sementara',
      icon: '#i-timer',
      submenu: () => ({
        title: 'Pesan sementara',
        note: 'Pesan yang lebih lama dari batas ini hilang dari perangkat ini.',
        items: [
          ...DISAPPEAR_OPTIONS.map((option) => ({
            label: option.label,
            active: ttl === option.value,
            run: () => setDisappearing(room, option.value),
          })),
          ...(ttl ? [{ label: 'Matikan', run: () => setDisappearing(room, 0) }] : []),
        ],
      }),
    },
    {
      id: 'theme',
      label: 'Tema obrolan',
      icon: '#i-sun',
      submenu: () => ({
        title: 'Tema obrolan',
        note: 'Berlaku untuk seluruh aplikasi di perangkat ini.',
        items: THEME_OPTIONS.map((option) => ({
          label: option.label,
          active: themeChoice === option.value,
          run: () => setTheme(option.value),
        })),
      }),
    },
    {
      id: 'favorite',
      label: prefs.favorite ? 'Hapus dari favorit' : 'Tambah ke favorit',
      icon: '#i-star',
    },
    {
      id: 'lists',
      label: 'Tambah ke daftar',
      icon: '#i-list',
      submenu: () => ({
        title: 'Tambah ke daftar',
        items: [
          ...state.lists.map((list) => ({
            label: list.name,
            active: prefs.lists.includes(list.id),
            keepOpen: true,
            run: () => {
              const added = toggleRoomList(room, list.id);
              showToast(added ? `Ditambahkan ke daftar ${list.name}.` : `Dikeluarkan dari daftar ${list.name}.`);
              return true;
            },
          })),
          { label: '+ Daftar baru…', run: () => promptList(room) },
        ],
      }),
    },
    { id: 'close', label: 'Tutup obrolan', icon: '#i-logout' },
    { sep: true },
    { id: 'call-link', label: 'Kirim tautan menelepon', icon: '#i-link' },
    { id: 'group-call', label: 'Telepon grup baru', icon: '#i-users', hidden: room.type !== 'group' },
    { sep: true },
    { id: 'report', label: 'Laporkan', icon: '#i-flag', hidden: !isDm },
    { id: 'block', label: blocked ? 'Buka blokir' : 'Blokir', icon: '#i-ban', hidden: !isDm },
    { sep: true },
    {
      id: 'clear',
      label: 'Bersihkan obrolan',
      icon: '#i-broom',
      disabled: room.messages.length === 0,
    },
    { id: 'delete', label: 'Hapus obrolan', icon: '#i-trash', danger: true },
  ];
}

function optionRow({ label, icon, danger, disabled, arrow, active, onSelect }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-option' + (danger ? ' danger' : '');
  button.setAttribute('role', 'menuitem');
  button.disabled = Boolean(disabled);
  button.innerHTML = `
    ${icon ? `<svg class="ico"><use href="${icon}" /></svg>` : ''}
    <span>${esc(label)}</span>
    ${active ? '<svg class="ico chat-option-check"><use href="#i-check" /></svg>' : ''}
    ${arrow ? '<svg class="ico chat-option-arrow"><use href="#i-chevron" /></svg>' : ''}
  `;
  if (danger) button.style.color = 'var(--danger)';
  if (onSelect) button.addEventListener('click', onSelect);
  return button;
}

function renderChatOptions(room, submenuId = null) {
  if (!room) return;
  const list = el.chatOptionsList;
  list.innerHTML = '';

  // Submenu dibangun ulang dari definisinya tiap kali digambar, jadi tanda
  // centangnya selalu mengikuti nilai yang tersimpan sekarang.
  const submenu = submenuId
    ? chatMenuItems(room).find((entry) => entry.id === submenuId)?.submenu?.()
    : null;

  if (submenu) {
    const head = document.createElement('div');
    head.className = 'chat-option-head';
    head.innerHTML = '<button type="button" data-back><svg class="ico"><use href="#i-back" /></svg> Kembali</button>';
    head.appendChild(Object.assign(document.createElement('strong'), { textContent: submenu.title }));
    head.querySelector('[data-back]').addEventListener('click', () => renderChatOptions(room));
    list.appendChild(head);

    if (submenu.note) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.style.padding = '0 10px 8px';
      note.textContent = submenu.note;
      list.appendChild(note);
    }

    for (const item of submenu.items) {
      list.appendChild(
        optionRow({
          label: item.label,
          active: item.active,
          onSelect: () => {
            // Item bertanda keepOpen tetap membuka submenu ini supaya orang bisa
            // mencentang beberapa daftar berturut-turut.
            if (!item.keepOpen) closeChatOptions();
            item.run();
            if (item.keepOpen) renderChatOptions(room, submenuId);
          },
        })
      );
    }
    placeChatOptions();
    return;
  }

  for (const item of chatMenuItems(room)) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'chat-option-sep';
      list.appendChild(sep);
      continue;
    }
    if (item.hidden) continue;
    list.appendChild(
      optionRow({
        label: item.label,
        icon: item.icon,
        danger: item.danger,
        disabled: item.disabled,
        arrow: Boolean(item.submenu),
        onSelect: () => {
          if (item.submenu) return renderChatOptions(room, item.id);
          closeChatOptions();
          runChatOption(item.id, room);
        },
      })
    );
  }
  placeChatOptions();
}

function placeChatOptions() {
  const rect = el.btnChatMore.getBoundingClientRect();
  const box = el.chatOptionsList.getBoundingClientRect();
  const pad = 8;
  const left = Math.min(Math.max(pad, rect.right - box.width), Math.max(pad, innerWidth - box.width - pad));
  const top = Math.min(Math.max(pad, rect.bottom + 6), Math.max(pad, innerHeight - box.height - pad));
  el.chatOptionsList.style.left = `${left}px`;
  el.chatOptionsList.style.top = `${top}px`;
}

function openChatOptions() {
  const room = state.rooms.get(state.activeRoomId);
  if (!room) return;
  closeMessageMenu();
  closeChatMenu();
  el.chatOptions.dataset.room = room.id;
  el.chatOptions.hidden = false;
  el.btnChatMore.setAttribute('aria-expanded', 'true');
  renderChatOptions(room);
}

function closeChatOptions() {
  if (!el.chatOptions || el.chatOptions.hidden) return;
  el.chatOptions.hidden = true;
  el.chatOptionsList.innerHTML = '';
  delete el.chatOptions.dataset.room;
  el.btnChatMore.setAttribute('aria-expanded', 'false');
}

function runChatOption(id, room) {
  const prefs = roomPrefs(room.id);
  if (id === 'info') return openContactInfo(room);
  if (id === 'search') return openChatSearch();
  if (id === 'select') return startSelection();
  if (id === 'favorite') {
    prefs.favorite = !prefs.favorite;
    saveChatPrefs();
    renderChatList();
    return showToast(prefs.favorite ? 'Ditambahkan ke favorit.' : 'Dihapus dari favorit.');
  }
  if (id === 'close') return closeConversation();
  if (id === 'call-link') return sendCallLink(room);
  if (id === 'group-call') return startGroupCall(false);
  if (id === 'report') return openReportModal();
  if (id === 'block') return toggleBlock(room);
  if (id === 'clear') return runChatAction('clear', room);
  if (id === 'delete') return runChatAction('delete', room);
}

/* ---- Info kontak ---- */
function openContactInfo(room) {
  const isDm = room.type === 'dm';
  const peer = isDm ? peerByUid(otherUid(room)) : null;
  const name = displayName(room);
  const blocked = peerBlocked(room);
  const muted = isMuted(room.id);
  const ttl = Number(roomPrefs(room.id).disappearMs) || 0;

  const rows = [
    ['Status', peer ? (peer.online ? 'online' : 'offline') : `${room.members.length} anggota`],
    ['Enkripsi', 'End-to-end — server cuma perantara buta'],
    ['Notifikasi', muted ? 'dibisukan' : 'berbunyi'],
    ['Pesan sementara', ttl ? disappearLabel(ttl) : 'mati'],
  ];
  if (isDm && peer?.uid) rows.push(['ID', peer.uid.slice(0, 12)]);

  openModal(`
    <h3>Info kontak</h3>
    <div class="contact-info-head">
      <span class="avatar" ${peer?.uid ? `data-uid="${esc(peer.uid)}"` : ''}>${esc(initials(name))}</span>
      <div>
        <strong>${esc(name)}</strong>
        <span class="muted">${room.type === 'group' ? 'Grup' : 'Chat pribadi'} · terenkripsi end-to-end</span>
      </div>
    </div>
    <ul class="contact-info-list">
      ${rows
        .map(
          ([key, value]) =>
            `<li><span class="muted">${esc(key)}</span><strong>${esc(value)}</strong></li>`
        )
        .join('')}
    </ul>
    <div class="modal-actions">
      ${isDm ? '<button type="button" data-info="verify">Safety number</button>' : ''}
      ${isDm ? `<button type="button" data-info="block">${blocked ? 'Buka blokir' : 'Blokir'}</button>` : ''}
      <button type="button" data-close>Tutup</button>
    </div>
  `);

  el.modalCard.querySelector('[data-close]').addEventListener('click', closeModal);
  el.modalCard.querySelector('[data-info="verify"]')?.addEventListener('click', () => {
    closeModal();
    openSafetyNumber();
  });
  el.modalCard.querySelector('[data-info="block"]')?.addEventListener('click', () => {
    closeModal();
    toggleBlock(room);
  });
}

/* ---- Tutup obrolan ---- */
function closeConversation() {
  if (state.voiceRecording) cancelVoiceNote();
  stopVoicePlayback();
  exitSelection({ render: false });
  closeChatSearch();
  cancelReply();
  closeMessageMenu();
  state.activeRoomId = null;
  el.app.classList.remove('show-chat');
  renderEmptyState();
  renderChatList();
}

/* ---- Cari di dalam obrolan ---- */
function openChatSearch() {
  el.chatSearch.hidden = false;
  el.chatSearchInput.value = '';
  state.searchQuery = '';
  applyChatSearch();
  el.chatSearchInput.focus();
}

function closeChatSearch() {
  if (!el.chatSearch || el.chatSearch.hidden) return;
  el.chatSearch.hidden = true;
  el.chatSearchInput.value = '';
  state.searchQuery = '';
  state.searchHits = [];
  state.searchIndex = -1;
  for (const node of el.messages.querySelectorAll('.msg')) {
    node.classList.remove('search-hidden', 'search-hit', 'search-current');
  }
  el.chatSearchCount.textContent = '';
}

function applyChatSearch() {
  const query = state.searchQuery.trim().toLowerCase();
  const room = state.rooms.get(state.activeRoomId);
  const bubbles = [...el.messages.querySelectorAll('.msg')];
  state.searchHits = [];
  state.searchIndex = -1;

  if (!room || !query) {
    for (const node of bubbles) node.classList.remove('search-hidden', 'search-hit', 'search-current');
    el.chatSearchCount.textContent = '';
    return;
  }

  // Yang dicari cuma isi pesan yang benar-benar ada di perangkat ini: teks,
  // nama lampiran, dan pesan sistem (mis. catatan pesan sementara).
  const matched = new Set();
  for (const message of room.messages) {
    const haystack = `${message.text || ''} ${message.attachment?.name || ''}`.toLowerCase();
    if (haystack.includes(query)) matched.add(String(serverIdOf(message) || message.id));
  }

  for (const node of bubbles) {
    const hit = matched.has(node.dataset.id);
    node.classList.toggle('search-hit', hit);
    node.classList.toggle('search-hidden', !hit);
    if (hit) state.searchHits.push(node);
  }

  if (state.searchHits.length) state.searchIndex = 0;
  paintSearchCurrent();
}

function paintSearchCurrent() {
  el.chatSearchCount.textContent = state.searchHits.length
    ? `${state.searchIndex + 1}/${state.searchHits.length}`
    : '0';
  state.searchHits.forEach((node, index) => node.classList.toggle('search-current', index === state.searchIndex));
  const current = state.searchHits[state.searchIndex];
  if (current) current.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function stepChatSearch(delta) {
  if (!state.searchHits.length) return;
  state.searchIndex = (state.searchIndex + delta + state.searchHits.length) % state.searchHits.length;
  paintSearchCurrent();
}

/* ---- Pilih beberapa pesan ---- */
function startSelection() {
  if (state.selection) return;
  state.selection = new Set();
  el.chatView.classList.add('selecting');
  el.selectBar.hidden = false;
  paintSelection();
  renderMessages();
}

function exitSelection({ render = true } = {}) {
  if (!state.selection) return;
  state.selection = null;
  el.chatView.classList.remove('selecting');
  el.selectBar.hidden = true;
  if (render && state.activeRoomId) renderMessages();
}

function toggleSelected(bubble) {
  if (!state.selection) return;
  const id = bubble?.dataset?.id;
  if (!id) return;
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  bubble.classList.toggle('selected', state.selection.has(id));
  paintSelection();
}

function selectedMessages() {
  const room = state.rooms.get(state.activeRoomId);
  if (!room || !state.selection) return [];
  return room.messages.filter((message) => state.selection.has(String(serverIdOf(message) || message.id)));
}

function paintSelection() {
  const count = state.selection?.size || 0;
  el.selectCount.textContent = `${count} dipilih`;
  el.selectCopy.disabled = count === 0;
  el.selectForward.disabled = count === 0;
  el.selectDelete.disabled = count === 0;
}

async function copySelected() {
  const messages = selectedMessages().filter((message) => String(message.text || '').trim());
  if (!messages.length) return showToast('Pesan yang dipilih nggak punya teks buat disalin.');
  await writeClipboard(messages.map((message) => message.text).join('\n'));
  exitSelection();
  showToast(`${messages.length} pesan disalin.`);
}

function forwardSelected() {
  const messages = selectedMessages().filter((message) => !message.deleted);
  if (!messages.length) return showToast('Pilih pesan yang mau diteruskan dulu.');
  const rooms = [...state.rooms.values()].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  if (!rooms.length) return showToast('Belum ada chat lain buat tujuan teruskan.');

  openModal(`
    <h3>Teruskan ${messages.length} pesan</h3>
    <p class="sub">Pilih chat tujuan. Isinya dienkripsi ulang untuk chat itu, jadi server tetap nggak bisa membacanya.</p>
    <ul class="forward-list">
      ${rooms
        .map(
          (room) => `<li><button type="button" class="forward-target" data-room="${esc(room.id)}">
            <span class="avatar" data-hue-for="${esc(room.type === 'group' ? room.name : displayName(room))}">${esc(
              initials(room.type === 'group' ? room.name : displayName(room))
            )}</span>
            <span class="forward-target-main">
              <strong>${esc(room.type === 'group' ? room.name : displayName(room))}</strong>
              <span class="muted">${esc(preview(room.messages[room.messages.length - 1]))}</span>
            </span>
          </button></li>`
        )
        .join('')}
    </ul>
    <div class="modal-actions"><button type="button" data-close>Tutup</button></div>
  `);

  el.modalCard.querySelector('[data-close]').addEventListener('click', closeModal);
  for (const button of el.modalCard.querySelectorAll('.forward-target')) {
    button.addEventListener('click', async () => {
      const target = state.rooms.get(button.dataset.room);
      closeModal();
      if (!target) return;
      for (const message of messages) {
        await sendToRoom(target, message.text, message.attachment, {
          forwarded: true,
          voice: Boolean(message.voice),
          duration: message.duration,
        });
      }
      exitSelection();
      selectRoom(target.id);
      showToast(`${messages.length} pesan diteruskan ke ${target.type === 'group' ? target.name : displayName(target)}.`);
    });
  }
}

function deleteSelected() {
  const messages = selectedMessages();
  if (!messages.length) return;
  confirmDialog({
    title: `Hapus ${messages.length} pesan?`,
    body: 'Pesan yang dipilih hilang dari perangkat ini saja. Orang lain tidak terpengaruh.',
    confirmLabel: 'Hapus',
    danger: true,
    onConfirm: () => {
      const room = state.rooms.get(state.activeRoomId);
      if (!room) return;
      for (const message of messages) {
        const index = room.messages.indexOf(message);
        if (index !== -1) room.messages.splice(index, 1);
        state.blobUrls.delete(message.id);
      }
      saveRooms();
      exitSelection({ render: false });
      renderMessages();
      renderChatList();
      showToast(`${messages.length} pesan dihapus dari perangkat ini.`);
    },
  });
}

/* ---- Tautan menelepon ---- */

/** Ambil id ruang dari tautan panggilan By Chat di dalam sebuah pesan. */
function callRoomInText(text) {
  const match = String(text || '').match(/https?:\/\/\S*[?&]call=([A-Za-z0-9%:_-]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function joinCallFromLink(roomId) {
  const room = state.rooms.get(roomId);
  if (!room) return showToast('Obrolan untuk tautan panggilan ini nggak ada di perangkat ini.');
  if (!state.config.calls.enabled) return showToast('Panggilan dimatikan di server ini.');
  if (state.activeRoomId !== roomId) selectRoom(roomId);
  if (room.type === 'group') return startGroupCall(false);
  return startCall(false);
}

async function sendCallLink(room) {
  const url = new URL(location.href);
  url.search = `?call=${encodeURIComponent(room.id)}`;
  const label = room.type === 'group' ? 'Ayo gabung panggilan grup di By Chat' : 'Ayo telepon di By Chat';
  await sendToRoom(room, `${label}: ${url.toString()}`);
  showToast('Tautan panggilan dikirim.');
}

/**
 * Panggilan grup: mulai dengan satu anggota, lalu undang sisanya ke room yang
 * sama. Batas anggota ditegakkan server (8 orang), jadi undangan yang ditolak
 * cuma dilewati.
 */
async function startGroupCall(video) {
  const room = state.rooms.get(state.activeRoomId);
  if (!room || room.type !== 'group') return showToast('Panggilan grup cuma bisa dimulai dari grup.');
  const others = room.members.filter((uid) => uid !== state.me.uid);
  if (!others.length) return showToast('Grup ini belum punya anggota lain.');

  const person = (uid) => ({
    displayName: peerByUid(uid)?.displayName || 'Anggota',
    photoURL: peerByUid(uid)?.photoURL || null,
  });
  const [first, ...rest] = others;
  try {
    await state.calls.startCall(first, person(first), { video: Boolean(video) });
    for (const uid of rest.slice(0, 6)) {
      await state.calls.addParticipant(uid, person(uid)).catch(() => {});
    }
    showToast(`Panggilan grup dimulai dengan ${others.length} anggota.`);
  } catch (err) {
    showToast(err.message);
  }
}

/* ---- Daftar baru (dari menu "Tambah ke daftar") ---- */
function promptList(room) {
  openModal(`
    <h3>Daftar baru</h3>
    <p class="sub">Daftar cuma ada di perangkat ini, dan dipakai buat menyaring daftar obrolan.</p>
    <label for="new-list-name">Nama daftar</label>
    <input id="new-list-name" type="text" maxlength="24" placeholder="misal: Kantor" />
    <div class="modal-actions">
      <button type="button" data-cancel>Batal</button>
      <button type="button" class="primary" data-save>Buat</button>
    </div>
  `);
  const input = el.modalCard.querySelector('#new-list-name');
  input.focus();
  el.modalCard.querySelector('[data-cancel]').addEventListener('click', closeModal);
  const save = () => {
    const list = createList(input.value);
    if (!list) return;
    if (room && !roomPrefs(room.id).lists.includes(list.id)) roomPrefs(room.id).lists.push(list.id);
    saveChatPrefs();
    closeModal();
    renderChatList();
    showToast(`Daftar ${list.name} dibuat.`);
  };
  el.modalCard.querySelector('[data-save]').addEventListener('click', save);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  });
}

function dropRoomMedia(room) {
  for (const message of room.messages) {
    const url = state.blobUrls.get(message.id);
    if (!url) continue;
    URL.revokeObjectURL(url);
    state.blobUrls.delete(message.id);
  }
}

/** Dialog konfirmasi kecil — dipakai sebelum ada pesan yang benar-benar hilang. */
function confirmDialog({ title, body, confirmLabel, danger = false, onConfirm }) {
  openModal(`
    <h3>${esc(title)}</h3>
    <p class="sub">${esc(body)}</p>
    <div class="modal-actions">
      <button type="button" data-cancel>Batal</button>
      <button type="button" class="${danger ? 'danger' : 'primary'}" data-confirm>${esc(confirmLabel)}</button>
    </div>
  `);
  el.modalCard.querySelector('[data-cancel]').addEventListener('click', closeModal);
  el.modalCard.querySelector('[data-confirm]').addEventListener('click', () => {
    closeModal();
    onConfirm();
  });
}

function clearChat(room) {
  if (!room) return;
  dropRoomMedia(room);
  room.messages = [];
  state.unread.set(room.id, 0);
  cancelReply();
  saveRooms();
  renderChatList();
  if (state.activeRoomId === room.id) renderMessages();
  showToast('Chat dibersihkan — semua pesannya dihapus dari perangkat ini.');
}

function removeChat(room) {
  if (!room) return;
  dropRoomMedia(room);
  state.rooms.delete(room.id);
  state.unread.delete(room.id);
  saveRooms();
  if (state.activeRoomId === room.id) {
    state.activeRoomId = null;
    cancelReply();
    closeMessageMenu();
    el.app.classList.remove('show-chat');
    renderEmptyState();
  }
  renderChatList();
  showToast('Chat dihapus dari perangkat ini.');
}

function runChatAction(action, room) {
  if (action === 'read') {
    state.unread.set(room.id, 0);
    renderChatList();
    return;
  }
  if (action === 'unread') {
    if (state.activeRoomId !== room.id) state.unread.set(room.id, 1);
    renderChatList();
    return;
  }
  if (action === 'clear') {
    return confirmDialog({
      title: 'Bersihkan chat ini?',
      body: `Semua pesan dengan ${displayName(room)} dihapus dari perangkat ini. Chatnya tetap ada, jadi kamu bisa mulai lagi dari kosong.`,
      confirmLabel: 'Bersihkan',
      onConfirm: () => clearChat(room),
    });
  }
  if (action === 'delete') {
    return confirmDialog({
      title: 'Hapus chat ini?',
      body: `Chat dengan ${displayName(room)} dan seluruh pesannya hilang dari perangkat ini. Orang lain tidak terpengaruh, dan chatnya bisa dibuat lagi nanti.`,
      confirmLabel: 'Hapus',
      danger: true,
      onConfirm: () => removeChat(room),
    });
  }
}

function preview(message) {
  if (!message) return 'Belum ada pesan';
  if (message.system) return message.text;
  if (message.call) return messagePreview(message);
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

/* ---- Pemutar pesan suara ------------------------------------------
 * Suara yang datang diunduh + didekripsi dulu, baru diputar. Cuma satu
 * pemutar yang boleh berbunyi; mulai yang lain menghentikan yang lama.
 * Progres ditulis langsung ke node, bukan lewat render ulang seluruh chat,
 * supaya audio nggak ikut terhenti tiap kali ada pesan baru masuk.
 */
const VOICE_BARS = 30;

/** Detik → "0:07" / "12:40". Dipakai bubble suara dan timer rekaman. */
function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/** Tinggi batang diturunkan dari id pesan: sama di semua perangkat, stabil. */
function voiceBars(message) {
  let seed = 7;
  for (const char of String(serverIdOf(message) || message.id)) {
    seed = (seed * 31 + char.charCodeAt(0)) % 2147483647;
  }
  return Array.from({ length: VOICE_BARS }, (_, index) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const shape = 0.55 + Math.sin((index / VOICE_BARS) * Math.PI) * 0.45;
    return 20 + Math.round((seed / 2147483648) * 62 * shape);
  });
}

function paintVoiceEntry(entry) {
  const active = state.voice;
  const isActive = active.id === entry.id && Boolean(active.audio);
  const playing = Boolean(isActive && !active.audio.paused && !active.audio.ended);
  const loading = active.loading === entry.id;

  entry.btn.disabled = loading;
  entry.btn.classList.toggle('playing', playing);
  entry.btn.setAttribute('aria-label', playing ? 'Jeda pesan suara' : 'Putar pesan suara');
  entry.btn.innerHTML = `<svg class="ico"><use href="#${playing ? 'i-pause' : 'i-play'}" /></svg>`;

  entry.speed.hidden = !isActive;
  entry.speed.textContent = `${active.speed}x`;

  const current = isActive ? Math.min(active.audio.currentTime || 0, entry.total) : 0;
  const progress = entry.total ? current / entry.total : 0;
  entry.bars.forEach((bar, index) => {
    bar.classList.toggle('on', (index + 1) / entry.bars.length <= progress + 0.001);
  });

  entry.time.textContent = loading ? '…' : formatClock(current > 0 ? current : entry.total);
  entry.root.classList.toggle('active', isActive);
}

function paintVoice() {
  for (const entry of state.voiceNodes) paintVoiceEntry(entry);
}

function stopVoicePlayback() {
  const active = state.voice;
  if (active.audio) {
    active.audio.pause();
    active.audio.currentTime = 0;
  }
  active.id = null;
  active.audio = null;
  paintVoice();
}

/** URL siap putar: pratinjau lokal, cache sesi, atau unduhan terenkripsi. */
async function voiceSource(message) {
  const ready = message.attachment?.localUrl || state.blobUrls.get(message.id);
  if (ready) return ready;
  if (state.voice.loading === message.id) return null;

  state.voice.loading = message.id;
  paintVoice();
  try {
    const url = await fetchAttachment({
      attachment: message.attachment,
      getIdToken: () => state.auth.getIdToken(),
    });
    state.blobUrls.set(message.id, url);
    return url;
  } finally {
    if (state.voice.loading === message.id) state.voice.loading = null;
    paintVoice();
  }
}

async function toggleVoice(message) {
  if (!message.attachment) return;
  const active = state.voice;

  if (active.id === message.id && active.audio) {
    if (active.audio.paused) {
      await active.audio.play().catch((err) => showToast(`Gagal memutar: ${err.message}`));
    } else {
      active.audio.pause();
    }
    paintVoice();
    return;
  }

  if (active.audio) {
    active.audio.pause();
    active.audio.currentTime = 0;
  }
  active.id = message.id;
  active.audio = null;
  paintVoice();

  let url;
  try {
    url = await voiceSource(message);
  } catch (err) {
    if (active.id === message.id) {
      active.id = null;
      paintVoice();
    }
    console.warn('VOICE err', err.message);
    showToast(`Gagal memutar pesan suara: ${err.message}`, 6000);
    return;
  }
  // Kedaluwarsa: orangnya sudah pindah ke pesan suara lain saat menunggu.
  if (!url || active.id !== message.id) return;

  const audio = new Audio(url);
  audio.preload = 'metadata';
  audio.playbackRate = active.speed;
  active.audio = audio;
  audio.addEventListener('timeupdate', paintVoice);
  audio.addEventListener('play', paintVoice);
  audio.addEventListener('pause', paintVoice);
  audio.addEventListener('ended', () => {
    audio.currentTime = 0;
    paintVoice();
  });
  audio.addEventListener('error', () => showToast('Pesan suara ini nggak bisa diputar di perangkat ini.', 6000));

  try {
    await audio.play();
  } catch (err) {
    showToast(`Gagal memutar: ${err.message}`, 5000);
  }
  paintVoice();
}

/** 1x → 1,5x → 2x → 1x. Kecepatannya berlaku untuk semua pesan suara. */
function cycleVoiceSpeed() {
  const order = [1, 1.5, 2];
  state.voice.speed = order[(order.indexOf(state.voice.speed) + 1) % order.length];
  if (state.voice.audio) state.voice.audio.playbackRate = state.voice.speed;
  paintVoice();
}

function voiceNode(message) {
  const total = Math.max(0.1, Number(message.duration) || 0);
  const root = document.createElement('div');
  root.className = 'voice';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'voice-btn';
  btn.setAttribute('aria-label', 'Putar pesan suara');
  btn.innerHTML = '<svg class="ico"><use href="#i-play" /></svg>';

  const main = document.createElement('div');
  main.className = 'voice-main';

  const wave = document.createElement('div');
  wave.className = 'voice-wave';
  const bars = voiceBars(message).map((height) => {
    const bar = document.createElement('i');
    bar.style.height = `${height}%`;
    wave.appendChild(bar);
    return bar;
  });

  const foot = document.createElement('div');
  foot.className = 'voice-foot';
  const time = document.createElement('span');
  time.className = 'voice-time';
  time.textContent = formatClock(total);
  const hint = document.createElement('span');
  hint.className = 'voice-hint';
  hint.innerHTML = '<svg class="ico"><use href="#i-mic" /></svg><span>Pesan suara</span>';
  const speed = document.createElement('button');
  speed.type = 'button';
  speed.className = 'voice-speed';
  speed.textContent = `${state.voice.speed}x`;
  speed.title = 'Ubah kecepatan putar';
  speed.hidden = true;
  foot.append(time, hint, speed);

  main.append(wave, foot);
  root.append(btn, main);

  const entry = { id: message.id, total, root, bars, time, btn, speed };
  state.voiceNodes.push(entry);
  btn.addEventListener('click', () => toggleVoice(message));
  speed.addEventListener('click', cycleVoiceSpeed);
  paintVoiceEntry(entry);
  return root;
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

function callLabel(info = {}) {
  if (info.kind === 'busy') return 'Ada panggilan yang sedang berlangsung';
  if (info.kind === 'answered') return 'Panggilan terjawab';
  return 'Panggilan tidak terjawab';
}

/** Satu panggilan yang sudah selesai, ditulis di dalam percakapan. */
function callBubbleNode(message) {
  const info = message.call || {};
  const node = document.createElement('div');
  node.className = `msg-call${info.kind === 'missed' ? ' missed' : ''}${info.direction === 'out' ? ' out' : ''}`;
  const detail = [
    info.video ? 'Video' : 'Suara',
    info.direction === 'out' ? 'keluar' : 'masuk',
    info.kind === 'answered' && info.duration ? callDurationText(info.duration) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  node.innerHTML = `
    <span class="msg-call-icon"><svg class="ico"><use href="#${info.video ? 'i-video' : 'i-phone'}" /></svg></span>
    <span class="msg-call-body">
      <strong>${esc(callLabel(info))}</strong>
      <span class="muted">${esc(detail)}</span>
    </span>
    <span class="msg-call-time muted">${formatTime(message.at)}</span>
  `;
  return node;
}

/** Panggilan yang berlangsung dengan lawan bicara room ini, kalau ada. */
function ongoingCallFor(room) {
  const call = state.callState;
  if (!call || !state.calls?.active || call.status === 'incoming') return null;
  const uids = (call.participants || []).map((person) => person.uid);
  if (room.type === 'dm') return uids.includes(otherUid(room)) ? call : null;
  return null;
}

function ongoingCallBubble(call) {
  const ringing = call.status === 'outgoing';
  const started = Number(call.answeredAt) || Date.now();
  const node = document.createElement('div');
  node.className = 'msg-call live';
  node.innerHTML = `
    <span class="msg-call-icon"><svg class="ico"><use href="#i-phone" /></svg></span>
    <span class="msg-call-body">
      <strong>${ringing ? 'Memanggil…' : 'Panggilan sedang berlangsung'}</strong>
      <span class="muted">
        <span class="call-dot"></span>
        ${ringing ? 'menunggu dijawab' : `<span data-live-call="${started}">${callClock(Date.now() - started)}</span>`}
        · ${call.video ? 'video' : 'suara'}
      </span>
    </span>
  `;
  return node;
}

function renderMessages() {
  const room = state.rooms.get(state.activeRoomId);
  el.messages.innerHTML = '';
  // Setiap render membangun ulang pemutarnya; daftar node lama dibuang supaya
  // progres nggak ditulis ke elemen yang sudah lepas dari halaman.
  state.voiceNodes.length = 0;
  if (!room) return;

  let lastDay = null;
  for (const message of room.messages) {
    if (message.call) {
      el.messages.appendChild(callBubbleNode(message));
      continue;
    }
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

    // Mode pilih pesan: tiap gelembung dapat kotak centang dan ikut ditandai
    // kalau id-nya ada di pilihan.
    if (state.selection) {
      div.classList.toggle('selected', state.selection.has(div.dataset.id));
      const check = document.createElement('span');
      check.className = 'msg-check';
      check.innerHTML = '<svg class="ico"><use href="#i-check" /></svg>';
      div.appendChild(check);
    }

    if (message.deleted) {
      div.appendChild(deletedNode());
    } else if (message.error) {
      div.appendChild(document.createTextNode(`Pesan ini nggak bisa dibuka (${message.error})`));
    } else {
      if (message.forwarded) div.appendChild(forwardedNode());
      if (message.replyTo?.id) div.appendChild(quoteNode(message));
      if (message.attachment && message.voice) div.appendChild(voiceNode(message));
      else if (message.attachment) div.appendChild(attachmentNode(message));
      if (message.text) {
        const body = document.createElement('span');
        body.className = 'msg-text';
        body.textContent = message.text;
        div.appendChild(body);
      }
      // Tautan panggilan yang dikirim lewat menu "Kirim tautan menelepon"
      // dibuat bisa diketuk, bukan cuma teks panjang yang harus disalin.
      const callRoom = callRoomInText(message.text);
      if (callRoom) {
        const join = document.createElement('button');
        join.type = 'button';
        join.className = 'call-link';
        join.innerHTML = '<svg class="ico"><use href="#i-phone" /></svg><span>Gabung panggilan</span>';
        join.addEventListener('click', (event) => {
          event.stopPropagation();
          joinCallFromLink(callRoom);
        });
        div.appendChild(join);
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

    // Panah kecil di sudut gelembung: jalur menu yang sama dengan klik kanan /
    // tahan-sebentar, cuma kelihatan saat kursor mendekat (CSS yang mengatur).
    div.classList.add('has-menu');
    const menuButton = document.createElement('button');
    menuButton.type = 'button';
    menuButton.className = 'msg-menu-btn';
    menuButton.title = 'Menu pesan';
    menuButton.setAttribute('aria-label', 'Buka menu pesan');
    menuButton.innerHTML = '<svg class="ico"><use href="#i-chevron" /></svg>';
    menuButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMessageMenu(div);
    });
    div.appendChild(menuButton);

    el.messages.appendChild(div);
  }

  // Panggilan yang sedang berjalan tampil sebagai bubble hidup paling bawah,
  // lengkap dengan detik yang terus berjalan.
  const ongoing = ongoingCallFor(room);
  if (ongoing) el.messages.appendChild(ongoingCallBubble(ongoing));

  el.messages.scrollTop = el.messages.scrollHeight;
  renderTyping();
  // Pencarian yang sedang terbuka ikut disaring ulang setelah render, kalau
  // tidak, pesan baru muncul tanpa highlight dan jumlah hasilnya basi.
  if (el.chatSearch && !el.chatSearch.hidden) applyChatSearch();
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
  played
    ?.then(() => {
      if (node.dataset.callAudio === '1') paintSoundBanner(false);
    })
    .catch((err) => {
      console.warn('Pemutaran media panggilan ditolak:', err.message, '- ketuk layar sekali untuk mencoba lagi.');
      // Suara lawan bicara tidak boleh gagal diam-diam. Kalau yang tertahan
      // justru elemen audionya, tombol "nyalakan suara" yang muncul; ketukan
      // berikutnya di mana pun di halaman membuka kuncinya.
      if (node.dataset.callAudio === '1') return paintSoundBanner(true);
      showToast('Suaranya belum keluar. Ketuk layar panggilan sekali lagi.', 6000);
    });
}

/* ---- Suara lawan bicara --------------------------------------------
 * Satu elemen <audio> per peserta, terpisah dari petak video. Petak video bisa
 * disembunyikan (kamera mati, layar dibagikan, video belum datang) dan elemen
 * media yang tidak dilukis bukan tempat yang bisa diandalkan untuk mengeluarkan
 * suara — di Safari bahkan tidak berbunyi sama sekali. Elemen audio ini nggak
 * pernah disembunyikan, cuma dibuat berukuran nol.
 */
const callAudioNodes = new Map(); // uid -> HTMLAudioElement

function callAudioFor(uid) {
  let node = callAudioNodes.get(uid);
  if (!node) {
    node = document.createElement('audio');
    node.autoplay = true;
    node.playsInline = true;
    node.dataset.callAudio = '1';
    node.dataset.uid = uid;
    el.callAudio.appendChild(node);
    callAudioNodes.set(uid, node);
  }
  return node;
}

/** Buang elemen audio milik orang yang sudah tidak ada di panggilan. */
function pruneCallAudio(keep) {
  for (const [uid, node] of [...callAudioNodes]) {
    if (keep.has(uid)) continue;
    node.srcObject = null;
    node.remove();
    callAudioNodes.delete(uid);
  }
}

function paintSoundBanner(show) {
  if (!el.callSound) return;
  el.callSound.hidden = !show;
}

/**
 * Ketukan berikutnya mencoba membuka kunci autoplay untuk semua elemen audio.
 * `play()` diulang dari gestur itu, jadi browser yang tadinya menolak (mis.
 * panggilan yang dijawab dari notifikasi push) akhirnya boleh bersuara.
 */
async function retryCallAudio() {
  let blocked = 0;
  for (const node of callAudioNodes.values()) {
    if (!node.srcObject) continue;
    if (!node.paused) continue;
    try {
      await node.play();
    } catch {
      blocked += 1;
    }
  }
  paintSoundBanner(blocked > 0);
}

/* ---- Meter mikrofon ------------------------------------------------
 * Suara yang tidak tertangkap paling sering ketahuan setelah lawan bicara
 * bilang "kamu nggak kedengaran". Meter ini menunjukkan level yang benar-benar
 * dikirim, dan berubah merah kalau mikrofonnya hidup tapi tidak ada suara
 * sama sekali — tanda perangkat input-nya salah atau dipakai aplikasi lain.
 */
let micMeter = null;

function stopMicMeter() {
  if (!micMeter) return;
  cancelAnimationFrame(micMeter.frame);
  micMeter.ctx.close().catch(() => {});
  micMeter = null;
  if (el.callMic) el.callMic.hidden = true;
  if (el.callMicLevel) el.callMicLevel.style.width = '0%';
}

function startMicMeter(stream) {
  const tracks = stream?.getAudioTracks?.() || [];
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!tracks.length || !Ctx) return stopMicMeter();
  if (micMeter?.stream === stream) return;

  stopMicMeter();
  let ctx;
  try {
    ctx = new Ctx();
  } catch {
    return;
  }
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  const meter = { ctx, stream, frame: 0, peak: 0, silentSince: 0, muted: false };
  micMeter = meter;
  el.callMic.hidden = false;
  el.callMicNote.textContent = 'mikrofon';
  el.callMic.classList.remove('quiet');

  const tick = () => {
    if (!micMeter || micMeter !== meter) return;
    const live = stream.getAudioTracks();
    const enabled = live.length > 0 && live.some((track) => track.enabled) && live.every((track) => track.readyState === 'live');

    analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (const value of samples) peak = Math.max(peak, Math.abs(value));
    meter.peak = Math.max(peak, meter.peak * 0.92);

    el.callMicLevel.style.width = `${Math.min(100, Math.round(meter.peak * 320))}%`;

    if (!live.length || live.every((track) => track.readyState === 'ended')) {
      el.callMic.classList.add('quiet');
      el.callMicNote.textContent = 'mikrofon terputus';
      meter.silentSince = 0;
    } else if (!enabled) {
      el.callMic.classList.remove('quiet');
      el.callMicNote.textContent = 'mikrofon mati';
      meter.silentSince = 0;
    } else if (peak > 0.02) {
      el.callMic.classList.remove('quiet');
      el.callMicNote.textContent = 'mikrofon';
      meter.silentSince = 0;
    } else if (!meter.silentSince) {
      meter.silentSince = performance.now();
    } else if (performance.now() - meter.silentSince > 5000) {
      el.callMic.classList.add('quiet');
      el.callMicNote.textContent = 'tidak ada suara masuk';
    }

    meter.frame = requestAnimationFrame(tick);
  };
  tick();
}

/* ---- Dering ---- *
 * Nada dering dibuat dengan Web Audio, bukan file audio: tidak ada aset yang
 * perlu diunduh dan tidak ada permintaan jaringan saat telepon masuk.
 */
let ringtone = null;

function startRingtone() {
  if (ringtone) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    // Browser bisa menahan audio sampai ada interaksi; kalau sudah pernah
    // mengetuk apa pun (login, chat), konteksnya langsung jalan.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660;
    gain.gain.value = 0;
    osc.connect(gain).connect(ctx.destination);
    osc.start();

    const pulse = () => {
      if (!ringtone) return;
      const now = ctx.currentTime + 0.02;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
      gain.gain.setValueAtTime(0.0001, now + 0.7);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.76);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
      ringtone.timer = setTimeout(pulse, 2400);
    };

    ringtone = { ctx, osc, timer: null };
    pulse();
    navigator.vibrate?.([400, 180, 400, 180, 700]);
  } catch (err) {
    console.warn('Dering panggilan gagal diputar:', err.message);
  }
}

function stopRingtone() {
  if (!ringtone) return;
  clearTimeout(ringtone.timer);
  try {
    ringtone.osc.stop();
    ringtone.ctx.close();
  } catch {
    /* sudah berhenti */
  }
  ringtone = null;
  navigator.vibrate?.(0);
}

/* ---- Tampilan panggilan ---- */

function clearCallGrid() {
  el.callGrid.innerHTML = '';
  el.callGrid.hidden = true;
}

/**
 * Satu petak per peserta — <video> selalu ada, karena elemen itulah yang
 * memutar suara lawan bicara. Kalau kameranya mati, petaknya menampilkan
 * avatar, bukan kotak hitam.
 */
function syncCallGrid(participants) {
  el.callGrid.hidden = participants.length === 0;
  el.callPlaceholder.hidden = participants.length > 0;

  const keep = new Set();
  for (const person of participants) {
    keep.add(person.uid);
    let tile = el.callGrid.querySelector(`[data-uid="${person.uid}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'call-tile';
      tile.dataset.uid = person.uid;
      const media = document.createElement('video');
      media.autoplay = true;
      media.playsInline = true;
      const avatar = document.createElement('span');
      avatar.className = 'avatar call-tile-avatar';
      const name = document.createElement('span');
      name.className = 'call-tile-name';
      tile.append(media, avatar, name);
      el.callGrid.appendChild(tile);
    }

    const hasVideo = Boolean(person.stream?.getVideoTracks().length);
    const media = tile.querySelector('video');
    // Petak ini cuma gambar. Suaranya keluar dari elemen <audio> pasangannya,
    // supaya tidak dobel dan tidak ikut mati saat petaknya disembunyikan.
    media.muted = true;
    media.hidden = !hasVideo;
    tile.classList.toggle('no-video', !hasVideo);
    tile.querySelector('.call-tile-name').textContent = person.displayName || '—';
    const avatar = tile.querySelector('.call-tile-avatar');
    avatar.textContent = initials(person.displayName);
    avatar.dataset.uid = person.uid;
    if (person.stream) {
      attachCallMedia(media, person.stream);
      attachCallMedia(callAudioFor(person.uid), person.stream);
    }
  }

  for (const tile of [...el.callGrid.children]) if (!keep.has(tile.dataset.uid)) tile.remove();
  pruneCallAudio(keep);
  el.callGrid.classList.toggle('multi', participants.length > 1);
  paintAvatars(el.callGrid);
}

function renderCallParticipants(participants) {
  el.callParticipants.innerHTML = '';
  el.callParticipants.hidden = participants.length < 2;
  for (const person of participants) {
    const chip = document.createElement('span');
    chip.className = 'call-chip';
    chip.classList.toggle('live', person.connection === 'connected' || Boolean(person.stream?.getTracks().length));
    chip.innerHTML = `<span class="avatar">${esc(initials(person.displayName))}</span><span>${esc(person.displayName || '—')}</span>`;
    chip.querySelector('.avatar').dataset.uid = person.uid;
    el.callParticipants.appendChild(chip);
  }
  paintAvatars(el.callParticipants);
}

function renderCall(call = {}) {
  const active = state.calls?.active;
  state.callState = active ? call : null;
  // Dipakai skrip browser-check untuk membaca keadaan panggilan yang sebenarnya.
  window.__bychatCallState = state.callState;
  el.callOverlay.hidden = !active;
  if (call.notice) showToast(call.notice, 3000);

  if (!active) {
    stopRingtone();
    el.incoming.hidden = true;
    state.incoming = null;
    el.localVideo.srcObject = null;
    el.localVideo.hidden = true;
    clearCallGrid();
    pruneCallAudio(new Set());
    stopMicMeter();
    paintSoundBanner(false);
    el.callParticipants.hidden = true;
    el.callDuration.hidden = true;
    // Bubble "panggilan sedang berlangsung" harus hilang dari chat.
    if (state.activeRoomId) renderMessages();
    if (call.endedPeer) {
      const duration =
        call.endedAnswered && call.endedDuration ? ` (${callDurationText(call.endedDuration)})` : '';
      showToast(
        call.endedReason
          ? `Panggilan dengan ${call.endedPeer} berakhir: ${call.endedReason}.`
          : `Panggilan dengan ${call.endedPeer} berakhir${duration}.`
      );
    }
    return;
  }

  if (call.status === 'incoming') {
    startRingtone();
  } else {
    stopRingtone();
    el.incoming.hidden = true;
  }

  if (call.localStream) {
    attachCallMedia(el.localVideo, call.localStream);
    el.localVideo.hidden = !(call.cameraOn || call.screenSharing);
    startMicMeter(call.localStream);
  } else {
    stopMicMeter();
  }

  const participants = call.participants || [];
  syncCallGrid(participants);
  renderCallParticipants(participants);

  const primary = call.peer?.displayName || participants[0]?.displayName || '—';
  const names = participants.map((person) => person.displayName).filter(Boolean);
  el.callName.textContent = participants.length > 1 ? `Panggilan grup · ${participants.length + 1} orang` : primary;
  el.callAvatar.textContent = initials(primary);
  el.callAvatar.dataset.uid = call.peer?.uid || '';

  if (call.status === 'outgoing') {
    el.callStatus.textContent = names.length ? `memanggil ${names.join(', ')}…` : 'memanggil…';
  } else if (call.status === 'incoming') {
    el.callStatus.textContent = 'panggilan masuk';
  } else if (call.status === 'connecting') {
    el.callStatus.textContent = 'menyambungkan…';
  } else {
    el.callStatus.textContent = 'panggilan berlangsung';
  }

  const answeredAt = Number(call.answeredAt) || 0;
  el.callDuration.hidden = !answeredAt || call.status === 'incoming';
  if (answeredAt) {
    el.callDuration.dataset.liveCall = String(answeredAt);
    el.callDuration.textContent = callClock(Date.now() - answeredAt);
  } else {
    delete el.callDuration.dataset.liveCall;
  }

  el.ctlMic.classList.toggle('off', call.micOn === false);
  el.ctlCamera.classList.toggle('off', call.cameraOn === false);
  el.ctlScreen.classList.toggle('off', call.screenSharing === true);
  el.ctlAdd.hidden = participants.length + 1 >= 8;
  paintAvatars();
}

function startCall(video) {
  const room = state.rooms.get(state.activeRoomId);
  if (!room || room.type !== 'dm') return;
  const uid = otherUid(room);
  const peer = peerByUid(uid);

  // Panggilan tidak lagi mensyaratkan lawannya online: undangannya tetap
  // berdering dan dia dapat notifikasi push. Statusnya akan tampil "memanggil…".
  state.calls
    .startCall(
      uid,
      { displayName: peer?.displayName || displayName(room), photoURL: peer?.photoURL || null },
      { video }
    )
    .catch((err) => showToast(err.message));
}

/** Pilih kontak untuk ditambahkan ke panggilan yang sedang berjalan. */
function openAddPersonPicker() {
  if (!state.calls?.active) return;
  const current = new Set([state.me.uid, ...(state.callState?.participants || []).map((person) => person.uid)]);

  const people = new Map();
  for (const person of contactList()) people.set(person.uid, person);
  for (const person of state.directory) {
    if (!people.has(person.uid)) {
      people.set(person.uid, { uid: person.uid, name: person.displayName, online: person.online });
    }
  }

  const candidates = [...people.values()].filter((person) => !current.has(person.uid));
  if (!candidates.length) return showToast('Belum ada kontak lain yang bisa ditambahkan.');

  openModal(`
    <h3>Tambah ke panggilan</h3>
    <p class="sub">Panggilan tetap berjalan. Orang yang aplikasinya belum terbuka tetap mendapat notifikasi.</p>
    <div class="add-person-list" id="add-person-list"></div>
  `);

  const list = document.getElementById('add-person-list');
  for (const person of candidates.slice(0, 40)) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'add-person-row';
    row.innerHTML = `
      <span class="avatar">${esc(initials(person.name))}</span>
      <span class="add-person-text">
        <strong>${esc(person.name)}</strong>
        <span class="muted">${person.online ? 'online' : 'offline — tetap dapat notifikasi'}</span>
      </span>
      <span class="ghost">Tambah</span>
    `;
    row.querySelector('.avatar').dataset.uid = person.uid;
    row.addEventListener('click', async () => {
      row.disabled = true;
      try {
        await state.calls.addParticipant(person.uid, { displayName: person.name });
        closeModal();
        showToast(`Undangan panggilan dikirim ke ${person.name}.`);
      } catch (err) {
        row.disabled = false;
        showToast(err.message);
      }
    });
    list.appendChild(row);
  }
  paintAvatars(list);
}

// Detik berjalan di layar panggilan dan di bubble chat diperbarui di satu
// tempat, supaya keduanya tidak pernah berbeda angka.
setInterval(() => {
  for (const node of document.querySelectorAll('[data-live-call]')) {
    const started = Number(node.dataset.liveCall) || 0;
    if (started) node.textContent = callClock(Date.now() - started);
  }
}, 1000);

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
            <label for="m-${esc(u.uid)}" style="margin:0;color:var(--ink);font-size:14px">${esc(u.name)}</label></li>`
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

/** Label + tombol notifikasi di panel Pengaturan, selalu mencerminkan izin asli browser. */
function paintNotificationSetting() {
  const note = el.panelSettings?.querySelector('[data-notify-note]');
  const button = el.panelSettings?.querySelector('[data-notify-toggle]');
  if (!note || !button) return;

  const status = state.notifier?.state() || { supported: false, permission: 'unsupported', enabled: false };
  button.setAttribute('aria-pressed', String(status.enabled));

  if (!status.supported) {
    note.textContent = 'Browser ini belum mendukung notifikasi web.';
    button.textContent = 'Tidak didukung';
    button.disabled = true;
    return;
  }

  if (status.enabled) {
    note.textContent =
      'Aktif. Pesan baru muncul di luar jendela ini, dan bisa dibalas langsung dari notifikasi kalau browser mendukung.';
    button.textContent = 'Matikan';
    button.disabled = false;
    return;
  }

  button.textContent = status.permission === 'denied' ? 'Diblokir browser' : 'Aktifkan';
  button.disabled = status.permission === 'denied';
  note.textContent =
    status.permission === 'denied'
      ? 'Izin notifikasi diblokir. Buka pengaturan situs di browser, izinkan notifikasi, lalu muat ulang halaman.'
      : 'Pesan baru muncul di luar jendela ini — bisa dibalas langsung dari notifikasi di Chrome Android.';
}

/**
 * Panel Pengaturan: identitas, foto, username, dan sakelar notifikasi.
 * Semua elemennya statis di index.html, jadi tinggal diisi ulang — bukan
 * dibangun ulang tiap dibuka (dulu bentuknya modal).
 */
function renderSettings() {
  if (!state.me) return;
  const name = state.username || state.profile?.displayName || '—';

  el.meName.textContent = name;
  el.displayName.value = name;
  el.nameTag.textContent = `@${state.username || '—'}`;

  el.meAvatar.textContent = initials(name);
  el.meAvatar.dataset.hueFor = name;
  el.meAvatar.dataset.uid = state.me.uid;
  el.railAvatar.textContent = initials(name);
  el.railAvatar.dataset.hueFor = name;
  el.railAvatar.dataset.uid = state.me.uid;

  paintNotificationSetting();
  paintTheme();
  paintAvatars(el.panelSettings);
}

/** Simpan username baru lewat namespace yang sama dengan klaim pertama. */
async function saveUsername() {
  const name = el.displayName.value.trim();
  if (!name || !state.me) return;

  const result = await new Promise((resolve) => {
    if (!socket) return resolve({ ok: false, error: 'Belum tersambung ke server.' });
    socket.emit('profile:update', { displayName: name }, (answer) => resolve(answer || {}));
  });
  if (!result.ok) return showToast(result.error || 'Gagal simpan username.', 5000);

  await state.auth.setDisplayName(result.username).catch(() => {});
  applyUsername(result.username);
  renderSettings();
  showToast(`Username disimpan: @${result.username}`);
}

/** Dipakai rail/navbar untuk keluar dari layar ini tanpa modal terpisah. */
function openSettings() {
  setView('settings');
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
// Pilihan warna status diambil dari palet DESIGN.md (By Chat Blue, deep blue,
// ink, dan dua nada slate) supaya teks putih di atasnya selalu punya kontras
// yang cukup dan nggak ada warna saturasi kedua yang masuk ke layar.
const STATUS_BACKGROUNDS = ['#2563eb', '#1d4ed8', '#17202a', '#334155', '#475569'];

/**
 * Orang yang sudah pernah chat dengan kamu: anggota ruang yang sudah punya
 * minimal satu pesan (DM maupun grup). Dipakai dua arah — untuk siapa kunci
 * status dibungkus, dan status siapa yang boleh muncul di sidebar — jadi orang
 * yang belum pernah chat sama sekali nggak bisa lihat status kamu, dan kamu
 * nggak bisa lihat status mereka.
 */
function chatPartnerUids() {
  const me = state.me?.uid;
  const uids = new Set();
  for (const room of state.rooms.values()) {
    if (!room.messages?.length) continue;
    for (const member of room.members || []) if (member && member !== me) uids.add(member);
  }
  return uids;
}

/**
 * Status yang boleh dilihat di perangkat ini: punyamu sendiri, plus punya orang
 * yang sudah pernah chat. Saringan ini juga yang menyembunyikan status lama
 * yang dulu disiarkan ke semua orang sebelum aturannya berubah.
 */
const liveStatuses = () => {
  const partners = chatPartnerUids();
  return state.statuses.filter(
    (status) => status.at > Date.now() - STATUS_TTL_MS && (status.from === state.me?.uid || partners.has(status.from))
  );
};

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
  el.statusEmpty.hidden = owners.length > 0;
  // Titik di rail/navbar: ada status kontak yang belum kamu buka.
  const unseen = owners.some((uid) => unseenStatusCount(uid) > 0);
  for (const dot of [el.railStatusDot, el.tabStatusDot]) if (dot) dot.hidden = !unseen;

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
    el.statusStage.innerHTML = `<div class="status-text" style="--status-bg:#5a1313">⚠️ ${esc(decoded.error)}</div>`;
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
  // Kunci statusnya cuma dibungkus buat orang yang sudah pernah chat: status
  // bukan siaran publik lagi, dan server cuma meneruskan ke daftar ini.
  const partners = [...chatPartnerUids()].filter((uid) => peerByUid(uid)?.publicKey);
  const audience = [...new Set([...partners, state.me.uid])];

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
    <p class="sub">
      Cuma orang yang <strong>sudah pernah chat</strong> dengan kamu yang bisa lihat ini
      (${chatPartnerUids().size} orang).
    </p>
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

/** Satu kartu login, dua kotak: masuk atau daftar. */
function showAuthPanel(panel) {
  const register = panel === 'register';
  el.loginPasswordForm.hidden = register;
  el.registerForm.hidden = !register;
  el.loginNotice.hidden = true;
  el.loginError.hidden = true;
}

/** Satu pesan saja pada satu waktu: galat, atau kabar akun dibuat. */
function authMessage(text, kind = 'error') {
  el.loginNotice.hidden = true;
  el.loginError.hidden = true;
  const target = kind === 'notice' ? el.loginNotice : el.loginError;
  target.textContent = text;
  target.hidden = false;
}

el.loginToRegister.addEventListener('click', () => {
  el.registerUsername.value = el.loginAccount.value.trim();
  showAuthPanel('register');
  el.registerPassword.focus();
});

el.registerToLogin.addEventListener('click', () => {
  el.loginAccount.value = el.registerUsername.value.trim() || el.loginAccount.value;
  showAuthPanel('login');
  el.loginPasswordInput.focus();
});

el.loginPasswordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.loginNotice.hidden = true;
  el.loginError.hidden = true;
  el.loginPasswordSubmit.disabled = true;
  try {
    await state.auth.signInWithPassword(el.loginAccount.value.trim(), el.loginPasswordInput.value);
  } catch (err) {
    authMessage(err.message || 'Gagal masuk.');
  } finally {
    el.loginPasswordSubmit.disabled = false;
  }
});

el.registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.loginNotice.hidden = true;
  el.loginError.hidden = true;

  const username = el.registerUsername.value.trim();
  const password = el.registerPassword.value;
  const repeat = el.registerConfirm.value;

  // Kotak sandi kedua cuma ada di sini, dan tugasnya satu: memastikan sandinya
  // tidak salah ketik sebelum akunnya dibuat.
  if (password !== repeat) {
    authMessage('Kata sandi dan ulangannya belum sama.');
    el.registerConfirm.focus();
    return;
  }
  if (password.length < 6) {
    authMessage('Kata sandi minimal 6 karakter.');
    el.registerPassword.focus();
    return;
  }

  el.registerSubmit.disabled = true;
  try {
    await state.auth.register(username, password);
    // Berhasil berarti akunnya ada, bukan berarti sudah masuk: kembali ke
    // kotak login dengan username terisi, sandinya diketik sekali lagi.
    el.loginAccount.value = username;
    el.loginPasswordInput.value = '';
    el.registerPassword.value = '';
    el.registerConfirm.value = '';
    showAuthPanel('login');
    authMessage('Akun dibuat. Masuk pakai username dan kata sandi kamu.', 'notice');
    el.loginPasswordInput.focus();
  } catch (err) {
    authMessage(err.message || 'Gagal membuat akun.');
  } finally {
    el.registerSubmit.disabled = false;
  }
});

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

// Rail (desktop) dan navbar bawah (hp) memindahkan panel yang sama; satu
// handler untuk keduanya, jadi nggak ada dua jalur yang bisa berbeda perilaku.
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => setView(button.dataset.view));
}

// Isi panel Pengaturan: foto profil (disimpan sendiri saat dipilih), username,
// dan sakelar notifikasi.
el.displayName.value = el.displayName.value || '';
el.panelSettings.querySelector('[data-save]').addEventListener('click', saveUsername);
el.displayName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveUsername();
  }
});
el.panelSettings.querySelector('[data-pick-photo]').addEventListener('click', () => el.avatarInput.click());
el.avatarInput.addEventListener('change', async (event) => {
  const [file] = event.target.files || [];
  event.target.value = '';
  try {
    await uploadAvatar(file);
  } catch (err) {
    showToast(`Foto profil: ${err.message}`, 6000);
  }
});
el.panelSettings.querySelector('[data-remove-photo]').addEventListener('click', async () => {
  try {
    await removeAvatar();
    showToast('Foto profil dihapus.');
  } catch (err) {
    showToast(`Foto profil: ${err.message}`, 6000);
  }
});
el.panelSettings.querySelector('[data-notify-toggle]').addEventListener('click', async () => {
  if (!state.notifier) return;
  if (state.notifier.state().enabled) {
    state.notifier.disable();
    paintNotificationSetting();
    showToast('Notifikasi dimatikan.');
    return;
  }

  const result = await state.notifier.enable();
  paintNotificationSetting();
  if (result.ok) {
    // Langsung daftarkan push, tanpa menunggu halaman dimuat ulang — kalau
    // tidak, panggilan baru bisa berdering di luar tab setelah reload berikutnya.
    state.auth
      ?.getIdToken?.()
      .then((token) => syncPushSubscription(token))
      .catch(() => {});
  }
  showToast(result.ok ? 'Notifikasi aktif.' : result.error, result.ok ? 3000 : 7000);
});
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
  if (!el.chatOptions.hidden) return closeChatOptions();
  if (!el.chatSearch.hidden) return closeChatSearch();
  if (state.selection) return exitSelection();
  if (!el.chatMenu.hidden) return closeChatMenu();
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
    for (const node of document.querySelectorAll('#call-overlay video, #call-audio audio')) {
      if (node.srcObject && node.paused) attachCallMedia(node, node.srcObject);
    }
  },
  true
);

el.callSound.addEventListener('click', (event) => {
  event.stopPropagation();
  retryCallAudio();
});

/* ---- Tema ---------------------------------------------------------- */
themeChoice = readThemeChoice();
paintTheme();
systemDark.addEventListener('change', () => {
  if (themeChoice === 'system') paintTheme();
});
el.themeSelect?.addEventListener('change', () => setTheme(el.themeSelect.value));

el.chatMenuCatcher.addEventListener('click', () => closeChatMenu());

el.replyCancel.addEventListener('click', cancelReply);
el.viewerClose.addEventListener('click', closeViewer);
el.viewerSave.addEventListener('click', () => saveViewerMedia());
el.viewerStage.addEventListener('click', (event) => {
  // Ketukan di latar menutup penampil; ketukan di fotonya tidak.
  if (event.target === el.viewerStage) closeViewer();
});
el.btnNewGroup.addEventListener('click', openNewGroup);
el.btnVerify.addEventListener('click', openSafetyNumber);
el.btnBack.addEventListener('click', () => {
  // Kembali ke daftar chat menutup percakapan: rekaman dan suara yang sedang
  // berjalan ikut berhenti, bukan terus hidup di layar yang sudah hilang.
  if (state.voiceRecording) cancelVoiceNote();
  stopVoicePlayback();
  el.app.classList.remove('show-chat');
});
el.search.addEventListener('input', renderChatList);

/* ---- Menu obrolan, pencarian di obrolan, dan pilih pesan ---- */
el.btnChatMore.addEventListener('click', (event) => {
  event.stopPropagation();
  if (el.chatOptions.hidden) openChatOptions();
  else closeChatOptions();
});
el.chatOptionsCatcher.addEventListener('click', closeChatOptions);
window.addEventListener('resize', closeChatOptions);

el.chatSearchInput.addEventListener('input', () => {
  state.searchQuery = el.chatSearchInput.value;
  applyChatSearch();
});
el.chatSearchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    stepChatSearch(event.shiftKey ? -1 : 1);
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeChatSearch();
  }
});
el.chatSearchNext.addEventListener('click', () => stepChatSearch(1));
el.chatSearchPrev.addEventListener('click', () => stepChatSearch(-1));
el.chatSearchClose.addEventListener('click', closeChatSearch);

el.selectClose.addEventListener('click', () => exitSelection());
el.selectCopy.addEventListener('click', copySelected);
el.selectForward.addEventListener('click', forwardSelected);
el.selectDelete.addEventListener('click', deleteSelected);
el.blockedUnblock.addEventListener('click', () => {
  const room = state.rooms.get(state.activeRoomId);
  if (room) toggleBlock(room);
});

// Mode pilih pesan: satu ketukan mencentang gelembung, bukan membuka menu.
el.messages.addEventListener('click', (event) => {
  if (!state.selection) return;
  const bubble = event.target?.closest?.('.msg') || null;
  if (!bubble) return;
  event.preventDefault();
  toggleSelected(bubble);
});

// Pesan sementara diperiksa berkala, bukan cuma saat chat dibuka: aplikasi
// yang dibiarkan terbuka semalaman juga harus kehilangan pesan yang basi.
setInterval(() => {
  if (state.me) pruneDisappearing();
}, 60_000);

el.btnCallAudio.addEventListener('click', () => startCall(false));
el.btnCallVideo.addEventListener('click', () => startCall(true));
el.ctlHangup.addEventListener('click', () => {
  stopRingtone();
  state.calls?.end();
});
el.ctlAdd.addEventListener('click', openAddPersonPicker);
el.ctlMic.addEventListener('click', () => state.calls?.toggleMic());
el.ctlCamera.addEventListener('click', () => state.calls?.toggleCamera().catch((e) => showToast(e.message)));
el.ctlScreen.addEventListener('click', () => state.calls?.toggleScreenShare().catch((e) => showToast(e.message)));

el.btnAccept.addEventListener('click', () => {
  el.incoming.hidden = true;
  stopRingtone();
  state.calls?.acceptCall();
});
el.btnDecline.addEventListener('click', () => {
  el.incoming.hidden = true;
  stopRingtone();
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
  // Komposer kosong = permintaan merekam, bukan mengirim pesan kosong.
  if (!text.trim()) return startVoiceNote();

  const replyTo = state.replyTo;
  el.input.value = '';
  el.input.style.height = 'auto';
  paintComposerAction();
  cancelReply();
  stopTyping();
  sendMessage(text, null, { replyTo });
});

el.recordCancel.addEventListener('click', cancelVoiceNote);
el.recordSend.addEventListener('click', finishVoiceNote);

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
  paintComposerAction();
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
    // Enter di kolom kosong nggak boleh tiba-tiba menyalakan mikrofon.
    if (el.input.value.trim()) el.composer.requestSubmit();
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
paintComposerAction();
renderEmptyState();
boot();
