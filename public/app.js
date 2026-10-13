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

  app: $('#app'),
  meAvatar: $('#me-avatar'),
  meName: $('#me-name'),
  meStatus: $('#me-status'),
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

const packMessage = (text, attachment) => JSON.stringify({ text: text || '', attachment: attachment || null });

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
    if (type === 'group' && name) room.name = name;
    return room;
  }
  room = { id, name, type, members, messages: [] };
  state.rooms.set(id, room);
  return room;
}

const displayName = (room) =>
  room.type === 'group' ? room.name : peerByUid(room.members.find((m) => m !== state.me.uid))?.displayName || 'Tidak dikenal';

const otherUid = (room) => room.members.find((m) => m !== state.me.uid);

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
  state.rooms.clear();
  el.app.hidden = true;
  el.login.hidden = false;
}

async function enterApp(profile) {
  if (state.me?.uid === profile.uid && socket) return;

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
    setStatus('gagal tersambung');
    showToast(`Koneksi ditolak: ${err.message}`);
  });

  socket.on('disconnect', () => setStatus('terputus — mencoba lagi…'));

  socket.on('session:replaced', () => {
    showToast('Akun ini dibuka di jendela lain. Sesi di sini dihentikan.', 8000);
  });

  socket.on('ready', (payload) => {
    state.directory = payload.directory || [];
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
  });

  socket.on('message', (envelope) => receiveMessage(envelope));

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
    el.incomingKind.textContent = data.video ? 'Panggilan video masuk' : 'Panggilan suara masuk';
    el.incoming.hidden = false;
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
async function sendMessage(text, attachment) {
  const room = state.rooms.get(state.activeRoomId);
  if (!room) return;
  if (!text.trim() && !attachment) return;

  const sharedKeys = new Map();
  try {
    for (const member of room.members) sharedKeys.set(member, await sharedKeyWith(member));
  } catch (err) {
    pushSystemNote(room, `⚠️ ${err.message}. Minta dia buka aplikasinya dulu.`);
    renderMessages();
    return;
  }

  const payload = await encryptMessage(packMessage(text, attachment), sharedKeys);
  const local = {
    id: `local:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    from: state.me.uid,
    text,
    attachment: attachment || null,
    at: Date.now(),
    status: 'sending',
  };
  room.messages.push(local);
  renderMessages();
  saveRooms();

  socket.emit('send', { roomId: room.id, roomName: room.name, type: room.type, members: room.members, payload }, (ack) => {
    local.status = ack?.ok ? (ack.queued?.length ? 'sent' : 'delivered') : 'failed';
    renderMessages();
    saveRooms();
  });
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

    if (message.attachment.mime?.startsWith('image/')) {
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

  const peer = peerByUid(otherUid(room));
  const shield = state.verified.has(otherUid(room)) ? '🛡️ ' : '';
  el.peerSub.textContent = !peer ? 'tidak dikenal' : shield + (peer.online ? 'online' : 'terakhir dilihat baru-baru ini');
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

    const li = document.createElement('li');
    li.className = 'chat-item' + (room.id === state.activeRoomId ? ' active' : '');
    li.innerHTML = `
      <div class="avatar">${esc(initials(name))}</div>
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
    el.chatList.appendChild(li);
  }

  el.chatListEmpty.hidden = shown > 0;
  el.chatListEmpty.textContent = filter ? 'Nggak ada chat yang cocok.' : 'Belum ada chat. Tekan 💬 buat mulai.';
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
    wrap.appendChild(img);
    wrap.addEventListener('click', () => window.open(cached, '_blank'));
    return wrap;
  }

  wrap.innerHTML = `
    <span class="attach-icon">${a.mime?.startsWith('image/') ? '🖼️' : a.mime?.startsWith('video/') ? '🎬' : a.mime?.startsWith('audio/') ? '🎵' : '📄'}</span>
    <span class="attach-info">
      <span class="attach-name">${esc(a.name)}</span>
      <span class="attach-size">${esc(formatBytes(a.size))} · terenkripsi</span>
    </span>
  `;
  wrap.addEventListener('click', () => downloadAttachment(message, wrap));
  return wrap;
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
      if (message.attachment) div.appendChild(attachmentNode(message));
      if (message.text) div.appendChild(document.createTextNode(message.text));
    }

    const meta = document.createElement('span');
    meta.className = 'msg-meta';
    meta.innerHTML = `${formatTime(message.at)} ${mine ? statusIcon(message.status) : ''}`;
    div.appendChild(meta);

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
    el.remoteVideo.srcObject = call.remoteStream;
    el.callPlaceholder.hidden = true;
  } else {
    el.callPlaceholder.hidden = false;
  }

  const peerName = call.peer?.displayName || '—';
  el.callName.textContent = peerName;
  el.callAvatar.textContent = initials(peerName);
  el.callStatus.textContent =
    call.status === 'outgoing' ? 'memanggil…' : call.status === 'incoming' ? 'panggilan masuk' : 'menyambungkan…';

  el.ctlMic.classList.toggle('off', call.micOn === false);
  el.ctlCamera.classList.toggle('off', call.cameraOn === false);
  el.ctlScreen.classList.toggle('off', call.screenSharing === true);
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
}

function closeModal() {
  el.modal.hidden = true;
  el.modalCard.innerHTML = '';
}

function openNewChat() {
  const people = state.directory.filter((u) => u.uid !== state.me.uid);
  openModal(`
    <h3>Chat baru</h3>
    <p class="sub">Pilih orang yang sudah pernah masuk.</p>
    <ul class="picker">
      ${people
        .map(
          (u) => `<li data-uid="${esc(u.uid)}">
            <span class="avatar" style="width:30px;height:30px;font-size:13px">${esc(initials(u.displayName))}</span>
            <span style="flex:1">${esc(u.displayName)}</span>
            ${u.online ? '<span class="dot"></span>' : '<span class="muted" style="font-size:12px">offline</span>'}
          </li>`
        )
        .join('')}
    </ul>
    ${people.length ? '' : '<p class="sub" style="margin-top:14px">Belum ada user lain. Buka aplikasi ini di jendela lain dan masuk dengan akun berbeda.</p>'}
    <div class="modal-actions"><button data-close>Tutup</button></div>
  `);
  el.modalCard.querySelectorAll('[data-uid]').forEach((li) =>
    li.addEventListener('click', () => {
      const uid = li.dataset.uid;
      const id = dmRoomId(state.me.uid, uid);
      ensureRoom({ id, name: peerByUid(uid)?.displayName, type: 'dm', members: [state.me.uid, uid] });
      saveRooms();
      closeModal();
      selectRoom(id);
    })
  );
  el.modalCard.querySelector('[data-close]').addEventListener('click', closeModal);
}

function openNewGroup() {
  const people = state.directory.filter((u) => u.uid !== state.me.uid);
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
            <label for="m-${esc(u.uid)}" style="margin:0;color:var(--text);font-size:14px">${esc(u.displayName)}</label></li>`
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
    <label for="display-name">Nama tampilan</label>
    <input id="display-name" type="text" maxlength="40" value="${esc(state.profile.displayName)}" />
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
    await state.auth.setDisplayName(name);
    state.profile = { ...state.profile, displayName: name };
    state.me.displayName = name;
    el.meName.textContent = name;
    socket?.emit('profile:update', { displayName: name });
    closeModal();
    showToast('Nama disimpan.');
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
el.btnNewChat.addEventListener('click', openNewChat);
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
