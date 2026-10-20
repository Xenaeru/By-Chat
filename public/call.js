/**
 * call.js — panggilan suara, video, dan layar bersama; 1:1 maupun grup.
 *
 * Media tetap peer-to-peer: setiap pasangan anggota punya RTCPeerConnection
 * sendiri (mesh), jadi server hanya meneruskan SDP/ICE dan tidak pernah
 * menyentuh audio/video. Untuk grup kecil (sampai 8 orang) ini cara yang
 * paling sederhana dan tetap terenkripsi DTLS-SRTP antar browser.
 *
 * Supaya tidak ada dua pihak menawarkan koneksi pada saat yang sama, aturannya
 * ditentukan oleh siapa yang bergabung belakangan: anggota yang baru masuk
 * yang mengirim offer ke semua anggota yang sudah ada; anggota lama menunggu
 * dan menjawab. Jadi tidak perlu negosiasi dua arah (glare).
 */

const RING_TIMEOUT_MS = 50_000;
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Permintaan mikrofon yang sama dipakai di semua jalur (panggilan, ambil ulang
 * setelah perangkat dicabut). Tiga penyaring ini yang membuat suara orang
 * kedengaran seperti suara, bukan gema ruangan — beberapa perangkat Android
 * mematikannya kalau constraint-nya tidak diminta secara eksplisit.
 */
const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * Kegagalan WebRTC hampir tidak terbaca dari UI, jadi mesinnya bisa dilacak:
 *   window.__SECURECHAT_CALL_DEBUG = true
 */
let DEBUG = false;
try {
  DEBUG = globalThis.__SECURECHAT_CALL_DEBUG === true;
} catch {
  /* ignore */
}
const log = (...args) => DEBUG && console.log('[call]', ...args);

export function createCallManager({ socket, iceServers, onState, onError, selfUid }) {
  let callId = null;
  let role = null; // 'caller' | 'callee'
  let videoWanted = false;
  let localStream = null;
  let cameraTrack = null;
  let screenTrack = null;
  let startedAt = 0;
  let answeredAt = 0;
  /** Pesan sekali-tampil yang ikut di emit berikutnya (mis. kamera gagal). */
  let pendingNotice = '';
  /** Kapan kita bergabung — penentu siapa yang mengirim offer. */
  let selfJoinedAt = 0;
  /** Anggota lain: uid -> { uid, displayName, photoURL, pc, stream, connection, ... } */
  const members = new Map();
  let timers = [];
  let connectTimer = null;

  const me = () => selfUid?.() || null;
  const others = () => [...members.values()].filter((member) => member.uid !== me());
  const connectedCount = () =>
    others().filter((member) => member.connection === 'connected' || member.stream?.getTracks().length).length;

  function phase() {
    if (!callId) return 'idle';
    if (role === 'callee' && !localStream) return 'incoming';
    if (role === 'caller' && !localStream) return 'outgoing';
    return connectedCount() ? 'active' : 'connecting';
  }

  const snapshot = () => ({
    status: phase(),
    callId,
    role,
    video: videoWanted,
    peer: others()[0] || null,
    participants: others().map((member) => ({
      uid: member.uid,
      displayName: member.displayName,
      photoURL: member.photoURL,
      stream: member.stream,
      connection: member.connection || 'new',
    })),
    localStream,
    micOn: localStream ? localStream.getAudioTracks().every((track) => track.enabled) : false,
    cameraOn: Boolean(cameraTrack?.enabled),
    screenSharing: Boolean(screenTrack),
    startedAt,
    answeredAt,
  });

  const emit = (extra = {}) => {
    const notice = extra.notice || pendingNotice;
    pendingNotice = '';
    onState?.({ ...snapshot(), ...(notice ? { notice } : {}), ...extra });
  };

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
    clearTimeout(connectTimer);
    connectTimer = null;
  }

  const after = (ms, fn) => timers.push(setTimeout(fn, ms));

  /* ---------------------------------------------------------------- *
   * Media
   * ---------------------------------------------------------------- */

  const request = (withVideo) =>
    navigator.mediaDevices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });

  async function acquireLocalStream() {
    if (localStream) return localStream;
    try {
      localStream = await request(videoWanted);
    } catch (err) {
      // Kamera yang ditolak/dipakai aplikasi lain bukan alasan mematikan
      // panggilan video: coba sekali lagi dengan suara saja, lalu beri tahu
      // orangnya lewat notice. Tanpa ini, satu kamera sibuk = panggilan mati.
      if (!videoWanted) throw err;
      log('kamera gagal, lanjut dengan suara saja', err.name, err.message);
      videoWanted = false;
      localStream = await request(false);
      pendingNotice = 'Kamera tidak bisa dipakai — panggilan lanjut dengan suara saja.';
    }
    cameraTrack = localStream.getVideoTracks()[0] || null;
    watchLocalAudio();
    return localStream;
  }

  /**
   * Mikrofon bisa hilang di tengah panggilan: headset dicabut, izin dicabut,
   * atau aplikasi lain mengambil perangkatnya. Kalau track-nya berakhir, sisi
   * lawan berhenti mendengar apa pun tanpa error. Track baru diambil dan
   * ditukar ke sender yang sudah ada, jadi panggilannya tidak perlu diulang.
   */
  function watchLocalAudio() {
    for (const track of localStream?.getAudioTracks?.() || []) {
      if (track.watched) continue;
      track.watched = true;
      track.addEventListener('ended', () => {
        log('track audio berakhir — ambil ulang mikrofon');
        recoverMicrophone();
      });
    }
  }

  let recoveringMic = false;

  async function recoverMicrophone() {
    if (recoveringMic || !callId || !localStream) return;
    if (localStream.getAudioTracks().some((track) => track.readyState === 'live')) return;
    recoveringMic = true;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      const track = fresh.getAudioTracks()[0];
      if (!track) throw new Error('Tidak ada mikrofon');
      if (!localStream) {
        track.stop();
        return;
      }
      localStream.addTrack(track);
      for (const member of members.values()) {
        const sender = member.pc
          ?.getTransceivers()
          .find((tx) => tx.sender.track?.kind === 'audio' || tx.receiver.track?.kind === 'audio')?.sender;
        if (sender) await sender.replaceTrack(track).catch(() => {});
      }
      watchLocalAudio();
      pendingNotice = 'Mikrofon tersambung ulang.';
    } catch (err) {
      log('mikrofon gagal diambil ulang', err.name, err.message);
      pendingNotice = 'Mikrofon terputus dan tidak bisa diambil lagi — lawan bicara tidak mendengar kamu.';
    } finally {
      recoveringMic = false;
      emit();
    }
  }

  function syncVideoSender(member) {
    if (!member.pc) return null;
    const videoTxs = member.pc.getTransceivers().filter((tx) => tx.receiver.track.kind === 'video');
    const negotiated = videoTxs.find((tx) => tx.mid !== null);
    member.videoSender = (negotiated || videoTxs[0])?.sender || null;
    return member.videoSender;
  }

  function ensurePeer(member) {
    if (member.pc) return member.pc;

    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    member.pc = pc;
    member.stream = new MediaStream();

    // Track asli dimasukkan dengan addTrack supaya arah m-line hasil negosiasi
    // benar-benar sendrecv; transceiver video cadangan dipasang supaya menyalakan
    // kamera di tengah panggilan cuma perlu replaceTrack, bukan negosiasi ulang.
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    if (!pc.getSenders().some((sender) => sender.track?.kind === 'video')) {
      pc.addTransceiver('video', { direction: 'sendrecv' });
    }
    syncVideoSender(member);

    pc.onicecandidate = (event) => {
      if (event.candidate) send(member, { type: 'ice', candidate: event.candidate.toJSON() });
      else log('ice gathering complete', member.uid);
    };

    pc.ontrack = (event) => {
      log('ontrack', member.uid, event.track.kind, 'total:', member.stream.getTracks().length);
      if (!member.stream.getTracks().includes(event.track)) {
        member.stream.addTrack(event.track);
        member.stream = new MediaStream(member.stream.getTracks());
      }
      emit();
    };

    pc.onconnectionstatechange = () => {
      member.connection = pc.connectionState;
      log('connectionState', member.uid, pc.connectionState);
      if (pc.connectionState === 'connected') {
        answeredAt = answeredAt || Date.now();
        member.established = true;
        member.iceRetried = false;
        clearTimeout(connectTimer);
      }
      if (pc.connectionState === 'failed') {
        // Jalur P2P putus (pindah WiFi → seluler, atau diblokir jaringan). Coba
        // susun ulang jalur ICE sekali, lalu jelaskan penyebab yang paling
        // sering: server ini belum punya relay TURN.
        if (!member.iceRetried) {
          member.iceRetried = true;
          try {
            pc.restartIce();
          } catch {
            /* browser lama tanpa restartIce: pesannya tetap disampaikan */
          }
        }
        onError?.(
          new Error(
            `Koneksi ke ${member.displayName || 'anggota'} gagal. Jaringan ini kemungkinan butuh relay TURN — coba WiFi lain, atau isi TURN_URLS di server.`
          )
        );
      }
      emit();
    };

    // Negosiasi ulang hanya untuk koneksi yang sudah pernah tersambung. Alur
    // pertama tetap milik aturan offer di syncRoster, jadi dua pihak tidak
    // pernah menawarkan koneksi pada saat yang sama.
    pc.onnegotiationneeded = () => {
      if (!member.established || !callId || !shouldOffer(member)) return;
      offerTo(member).catch((err) => log('renegotiation failed', err.message));
    };

    // Sinyal yang datang sebelum peer connection siap (mis. offer balapan
    // dengan izin mikrofon) dijalankan sekarang, berurutan.
    const queued = member.pending;
    member.pending = [];
    for (const item of queued) applySignal(member, item).catch((err) => log('queued signal failed', err.message));

    return pc;
  }

  const send = (member, data) => {
    if (!callId || !member?.uid) return;
    socket.emit('call:signal', { callId, toUid: member.uid, data });
  };

  /* ---------------------------------------------------------------- *
   * Signaling
   * ---------------------------------------------------------------- */

  async function applySignal(member, data) {
    if (!data) return;
    try {
      if (data.type === 'ice') {
        if (member.pc?.remoteDescription) await member.pc.addIceCandidate(data.candidate);
        else member.pendingIce.push(data.candidate);
      } else if (data.type === 'description') {
        if (!localStream) {
          member.pending.push(data);
          return;
        }
        ensurePeer(member);
        await member.pc.setRemoteDescription(data.description);

        if (member.pendingIce.length) {
          for (const candidate of member.pendingIce) await member.pc.addIceCandidate(candidate).catch(() => {});
          member.pendingIce = [];
        }

        if (data.description.type === 'offer') {
          const videoTx = member.pc
            .getTransceivers()
            .find((tx) => tx.receiver.track.kind === 'video' && tx.mid !== null);
          if (videoTx) videoTx.direction = 'sendrecv';

          const answer = await member.pc.createAnswer();
          await member.pc.setLocalDescription(answer);
          syncVideoSender(member);
          send(member, { type: 'description', description: member.pc.localDescription.toJSON() });
        }
      }
    } catch (err) {
      log('applySignal failed', err.name, err.message);
      onError?.(err);
    }
  }

  function onSignal({ from, data }) {
    if (!from || !callId) return;
    const member = members.get(from) || upsertMember({ uid: from, displayName: from.slice(0, 8) });
    if (!localStream) {
      member.pending.push(data);
      return;
    }
    applySignal(member, data);
  }

  /* ---------------------------------------------------------------- *
   * Anggota
   * ---------------------------------------------------------------- */

  function upsertMember(info) {
    const uid = String(info?.uid || '');
    if (!uid) return null;
    let member = members.get(uid);
    if (!member) {
      member = {
        uid,
        displayName: info.displayName || uid.slice(0, 8),
        photoURL: info.photoURL || null,
        joinedAt: Number(info.joinedAt) || 0,
        pc: null,
        stream: null,
        connection: null,
        established: false,
        iceRetried: false,
        videoSender: null,
        pending: [],
        pendingIce: [],
        offered: false,
      };
      members.set(uid, member);
    } else {
      if (info.displayName) member.displayName = info.displayName;
      if (info.photoURL !== undefined) member.photoURL = info.photoURL;
      if (info.joinedAt) member.joinedAt = Number(info.joinedAt) || member.joinedAt;
    }
    return member;
  }

  /**
   * Daftar anggota dari server. Yang bergabung belakangan (role callee, atau
   * anggota yang baru ditambahkan) mengirim offer; anggota lama menunggu.
   */
  /**
   * Aturan offer: yang bergabung belakangan menawarkan koneksi ke yang sudah
   * ada. Membandingkan `joinedAt` (bukan sekadar peran callee) penting di grup:
   * anggota lama yang dulu masuk sebagai callee tidak boleh ikut menawarkan
   * koneksi ke anggota yang baru ditambahkan, atau dua offer bertabrakan.
   */
  function shouldOffer(info) {
    const theirJoin = Number(info?.joinedAt) || 0;
    if (!theirJoin || !selfJoinedAt) return role === 'callee';
    if (theirJoin !== selfJoinedAt) return selfJoinedAt > theirJoin;
    return String(me() || '') > String(info.uid || '');
  }

  function noteSelfJoin(list = []) {
    const mine = list.find((info) => info?.uid === me());
    if (mine?.joinedAt) selfJoinedAt = Number(mine.joinedAt) || selfJoinedAt;
  }

  function syncRoster(list = []) {
    noteSelfJoin(list);
    for (const info of list) {
      if (!info?.uid || info.uid === me()) continue;
      const member = upsertMember(info);
      if (localStream && !member.pc) ensurePeer(member);
      if (localStream && !member.offered && shouldOffer(info)) {
        member.offered = true;
        offerTo(member).catch((err) => {
          log('offer failed', err.message);
          onError?.(err);
        });
      }
    }
    emit();
  }

  async function offerTo(member) {
    ensurePeer(member);
    const offer = await member.pc.createOffer();
    await member.pc.setLocalDescription(offer);
    send(member, { type: 'description', description: member.pc.localDescription.toJSON() });
  }

  function dropMember(uid, { silent = false } = {}) {
    const member = members.get(uid);
    if (!member) return;
    try {
      member.pc?.close();
    } catch {
      /* already closed */
    }
    members.delete(uid);
    if (!silent) emit();
  }

  /**
   * Server mengirim `call:member-joined` dan `call:accepted` untuk peristiwa yang
   * sama (yang kedua demi klien lama), jadi beginMedia bisa terpanggil dua kali
   * dalam satu tick. Satu promise dipakai bersama supaya mikrofon cuma diminta
   * sekali dan peer connection tidak dibangun dua kali.
   */
  let beginning = null;

  function beginMedia() {
    if (beginning) return beginning;
    beginning = doBeginMedia().finally(() => {
      beginning = null;
    });
    return beginning;
  }

  async function doBeginMedia() {
    try {
      await acquireLocalStream();
      emit();
      syncRoster(pendingRoster);
      pendingRoster = [];

      clearTimeout(connectTimer);
      connectTimer = setTimeout(() => {
        if (callId && !connectedCount()) end('gagal tersambung');
      }, CONNECT_TIMEOUT_MS);
      timers.push(connectTimer);
    } catch (err) {
      log('beginMedia failed', err);
      onError?.(err);
      end('gagal akses kamera/mikrofon');
    }
  }

  let pendingRoster = [];

  /* ---------------------------------------------------------------- *
   * Public API
   * ---------------------------------------------------------------- */

  const emitAck = (event, payload) =>
    new Promise((resolve) => {
      if (!socket?.connected) return resolve({ ok: false, error: 'Belum tersambung ke server.' });
      const timer = setTimeout(() => resolve({ ok: false, error: 'Server nggak menjawab.' }), 10_000);
      socket.emit(event, payload, (answer) => {
        clearTimeout(timer);
        resolve(answer || { ok: false, error: 'Jawaban server tidak terbaca.' });
      });
    });

  async function startCall(peerUid, peerInfo, { video } = {}) {
    if (callId) throw new Error('Masih ada panggilan berjalan');
    callId = 'pending';
    role = 'caller';
    videoWanted = Boolean(video);
    upsertMember({ uid: peerUid, ...peerInfo });
    emit({ status: 'outgoing' });

    const ack = await emitAck('call:invite', { toUid: peerUid, video: videoWanted });
    if (!ack?.ok) {
      reset();
      const error = new Error(ack?.error || 'Panggilan gagal dimulai');
      error.busy = Boolean(ack?.busy);
      throw error;
    }

    callId = ack.callId;
    startedAt = ack.startedAt || Date.now();
    answeredAt = ack.answeredAt || 0;
    noteSelfJoin(ack.members || []);
    emit({ status: 'outgoing' });

    // Server juga punya batas waktu sendiri; ini cuma jaring pengaman kalau
    // kabar berakhirnya tidak pernah sampai.
    after(RING_TIMEOUT_MS, () => {
      if (role === 'caller' && !localStream && callId) end('tidak dijawab');
    });
  }

  async function acceptCall() {
    if (!callId || role !== 'callee' || callId === 'pending') return;
    emit({ status: 'connecting' });
    await beginMedia();

    const ack = await emitAck('call:accept', { callId });
    if (!ack?.ok) {
      end('panggilan sudah selesai');
      return;
    }
    if (ack.members) syncRoster(ack.members);
  }

  function rejectCall(reason = 'ditolak') {
    if (!callId) return;
    const id = callId;
    const peerUid = others()[0]?.uid;
    reset();
    emit({ status: 'idle', endedReason: reason, endedPeer: '' });
    socket.emit('call:reject', { callId: id, toUid: peerUid });
  }

  /** Tambah satu orang ke panggilan yang sedang berjalan. */
  async function addParticipant(uid, info = {}) {
    if (!callId || callId === 'pending') throw new Error('Belum ada panggilan berjalan.');
    const target = String(uid || '');
    if (!target || target === me()) return;
    if (members.has(target)) throw new Error('Dia sudah ada di panggilan ini.');

    const ack = await emitAck('call:invite', { callId, toUid: target, video: videoWanted });
    if (!ack?.ok) throw new Error(ack?.error || 'Gagal mengundang.');
    upsertMember({ uid: target, ...info });
    emit();
  }

  function reset() {
    clearTimers();
    for (const member of members.values()) {
      try {
        member.pc?.close();
      } catch {
        /* already closed */
      }
    }
    members.clear();
    localStream?.getTracks().forEach((track) => track.stop());
    screenTrack?.stop();
    localStream = null;
    cameraTrack = null;
    screenTrack = null;
    pendingRoster = [];
    callId = null;
    role = null;
    videoWanted = false;
    startedAt = 0;
    answeredAt = 0;
    selfJoinedAt = 0;
  }

  function end(reason) {
    const had = callId && callId !== 'pending' ? callId : null;
    const peerName = others()[0]?.displayName || '';
    if (had) socket.emit('call:end', { callId: had });
    reset();
    onState?.({ status: 'idle', endedReason: reason || '', endedPeer: peerName });
  }

  /* ---- kontrol saat panggilan berjalan ---- */

  const toggleMic = () => {
    if (!localStream) return false;
    const next = !localStream.getAudioTracks().every((track) => track.enabled);
    localStream.getAudioTracks().forEach((track) => (track.enabled = next));
    emit();
    return next;
  };

  async function applyVideoTrack(track) {
    for (const member of members.values()) {
      const sender = member.videoSender || syncVideoSender(member);
      if (sender) await sender.replaceTrack(track).catch(() => {});
    }
  }

  async function toggleCamera() {
    if (!localStream) return false;
    if (cameraTrack) {
      const next = !cameraTrack.enabled;
      cameraTrack.enabled = next;
      if (next) await applyVideoTrack(screenTrack || cameraTrack);
      else if (!screenTrack) await applyVideoTrack(null);
      emit();
      return next;
    }
    const fresh = await navigator.mediaDevices.getUserMedia({ video: true });
    cameraTrack = fresh.getVideoTracks()[0];
    localStream.addTrack(cameraTrack);
    await applyVideoTrack(cameraTrack);
    emit();
    return true;
  }

  async function toggleScreenShare() {
    if (!localStream) return false;
    if (screenTrack) {
      screenTrack.stop();
      screenTrack = null;
      await applyVideoTrack(cameraTrack && cameraTrack.enabled ? cameraTrack : null);
      emit();
      return false;
    }
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
    screenTrack = display.getVideoTracks()[0];
    screenTrack.onended = () => {
      if (screenTrack) toggleScreenShare();
    };
    await applyVideoTrack(screenTrack);
    emit();
    return true;
  }

  /* ---- socket wiring ---- */

  const handlers = {
    'call:incoming': (data) => handleIncoming(data),
    'call:joined': (data) => {
      if (!callId || data.callId !== callId) return;
      answeredAt = data.answeredAt || Date.now();
      noteSelfJoin(data.members || []);
      pendingRoster = data.members || [];
      syncRoster(pendingRoster);
      localStream && emit();
    },
    'call:member-joined': (data) => {
      if (!callId || data.callId !== callId) return;
      if (data.member) upsertMember(data.member);
      if (!localStream) {
        // Penelepon baru mulai menangkap media saat lawannya menjawab.
        pendingRoster = data.members || [];
        if (role === 'caller') beginMedia();
        return;
      }
      syncRoster(data.members);
    },
    'call:member-left': ({ callId: id, uid }) => {
      if (id !== callId) return;
      const name = members.get(uid)?.displayName || '';
      dropMember(uid, { silent: true });
      onState?.({ ...snapshot(), notice: name ? `${name} keluar dari panggilan.` : '' });
    },
    'call:accepted': () => {
      // Kompatibilitas: server versi baru juga mengirim call:member-joined.
      if (role === 'caller' && !localStream) beginMedia();
    },
    'call:rejected': ({ by } = {}) => {
      const name = members.get(by)?.displayName;
      if (name) onError?.(new Error(`${name} menolak panggilan.`));
    },
    'call:ended': ({ reason, duration, answered }) => {
      if (!callId) return;
      const name = others()[0]?.displayName || '';
      reset();
      onState?.({
        status: 'idle',
        endedReason: reason || '',
        endedPeer: name,
        endedDuration: Number(duration) || 0,
        endedAnswered: Boolean(answered),
      });
    },
    'call:signal': (data) => onSignal(data),
  };

  for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);

  function handleIncoming({ callId: id, from, video, members: roster = [], answeredAt: answered }) {
    if (callId) {
      socket.emit('call:reject', { callId: id, toUid: from?.uid });
      return;
    }
    if (!id || !from) return;
    callId = id;
    role = 'callee';
    videoWanted = Boolean(video);
    startedAt = Date.now();
    answeredAt = answered || 0;
    upsertMember(from);
    for (const info of roster) upsertMember(info);
    emit({ status: 'incoming' });
  }

  return {
    startCall,
    acceptCall,
    rejectCall,
    end,
    addParticipant,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    handleIncoming,
    get active() {
      return Boolean(callId);
    },
  };
}
