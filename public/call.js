/**
 * call.js — 1:1 audio, video and screen-share calls.
 *
 * The media path is pure peer-to-peer WebRTC, so it is encrypted with
 * DTLS-SRTP between the two browsers. Our server only relays SDP and ICE
 * candidates; it never carries audio or video. If a TURN relay is configured
 * it still only forwards those already-encrypted packets — TURN sees
 * ciphertext, exactly like the chat server does.
 *
 * Negotiation is deliberately one-directional: whoever answers is the only
 * one who reacts to an offer, and both sides add their transceivers up front.
 * That means toggling the camera or starting a screen share only ever needs
 * `replaceTrack`, never a renegotiation.
 */

const RING_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * WebRTC failures are almost impossible to read off the UI, so the state
 * machine can be traced. Turn it on before the page loads:
 *   window.__SECURECHAT_CALL_DEBUG = true
 */
let DEBUG = false;
try {
  DEBUG = globalThis.__SECURECHAT_CALL_DEBUG === true;
} catch {
  /* ignore */
}
const log = (...args) => DEBUG && console.log('[call]', ...args);

export function createCallManager({ socket, iceServers, onState, onError }) {
  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let callId = null;
  let peer = null; // { uid, displayName, photoURL }
  let role = null; // 'caller' | 'callee'
  let wantsVideo = false;
  let videoSender = null;
  let cameraTrack = null;
  let screenTrack = null;
  let pendingIce = [];
  let pendingSignals = [];
  let timers = [];

  const emit = (patch) => onState?.({ ...snapshot(), ...patch });

  const snapshot = () => ({
    status: callId ? (remoteStream?.getTracks().length ? 'active' : role === 'caller' ? 'outgoing' : 'connecting') : 'idle',
    callId,
    role,
    peer,
    localStream,
    remoteStream,
    video: wantsVideo,
    micOn: localStream ? localStream.getAudioTracks().every((t) => t.enabled) : false,
    cameraOn: Boolean(cameraTrack?.enabled),
    screenSharing: Boolean(screenTrack),
  });

  const clearTimers = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };

  const after = (ms, fn) => timers.push(setTimeout(fn, ms));

  /* ---------------------------------------------------------------- *
   * Media
   * ---------------------------------------------------------------- */

  async function acquireLocalStream(withVideo) {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
    cameraTrack = localStream.getVideoTracks()[0] || null;
    return localStream;
  }

  function buildPeerConnection() {
    pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    remoteStream = new MediaStream();

    // Real tracks go in with addTrack: the transceivers are then created
    // together with their track, which is what makes the answerer's m-lines
    // line up as sendrecv. (Building the transceivers by hand with
    // addTransceiver + replaceTrack looks equivalent, but the answer comes
    // back as a=recvonly and the caller silently receives no media at all.)
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    videoSender = pc.getSenders().find((s) => s.track?.kind === 'video') || null;

    // An audio-only call still reserves a video m-line, so turning the camera
    // on later is just a track swap rather than a renegotiation.
    if (!videoSender) {
      videoSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
    }

    syncVideoSender();

    pc.onicecandidate = (event) => {
      if (!event.candidate) log('ice gathering complete');
      else send({ type: 'ice', candidate: event.candidate.toJSON() });
    };

    pc.ontrack = (event) => {
      log('ontrack', event.track.kind, 'streams:', event.streams.length, 'total:', remoteStream.getTracks().length);
      if (!remoteStream.getTracks().includes(event.track)) {
        remoteStream.addTrack(event.track);
        remoteStream = new MediaStream(remoteStream.getTracks());
      }
      emit({});
    };

    pc.onconnectionstatechange = () => {
      log('connectionState', pc.connectionState, 'ice', pc.iceConnectionState);
      if (pc.state === 'connected') clearTimers();
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        if (pc.connectionState !== 'closed') end('koneksi terputus');
      }
      emit({ connection: pc.connectionState });
    };

    return pc;
  }

  const send = (data) => {
    if (callId && peer) socket.emit('call:signal', { callId, toUid: peer.uid, data });
  };

  /**
   * Point `videoSender` at the video transceiver that actually owns the
   * negotiated m-line. Plain `getSenders()[kind==='video']` is not enough on
   * the answering side: reserving an m-line for a later camera can leave an
   * extra, unassociated video transceiver behind, and sending on that one goes
   * nowhere.
   */
  function syncVideoSender() {
    if (!pc) return;
    const videoTxs = pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video');
    const negotiated = videoTxs.find((t) => t.mid !== null);
    videoSender = (negotiated || videoTxs[0])?.sender || null;
  }

  /* ---------------------------------------------------------------- *
   * Signaling
   * ---------------------------------------------------------------- */

  async function applySignal(data) {
    log('applySignal', data.type, data.description?.type || '', 'state:', pc?.signalingState);
    try {
      if (data.type === 'ice') {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else pendingIce.push(data.candidate);
      } else if (data.type === 'description') {
        await pc.setRemoteDescription(data.description);
        log(
          'remote m-lines:',
          (pc.remoteDescription?.sdp || '')
            .split('\r\n')
            .filter((l) => /^(m=|a=sendrecv|a=sendonly|a=recvonly|a=inactive)/.test(l))
            .join(' | ')
        );
        syncVideoSender();
        if (pendingIce.length) {
          for (const candidate of pendingIce) await pc.addIceCandidate(candidate).catch(() => {});
          pendingIce = [];
        }
        if (data.description.type === 'offer') {
          // Negotiate the video m-line as sendrecv even when neither side has a
          // camera yet, so starting video later needs no renegotiation.
          const videoTx = pc
            .getTransceivers()
            .find((t) => t.receiver.track.kind === 'video' && t.mid !== null);
          if (videoTx) videoTx.direction = 'sendrecv';

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          syncVideoSender();
          log('sending answer');
          send({ type: 'description', description: pc.localDescription.toJSON() });
        }
      }
    } catch (err) {
      log('applySignal failed', err.name, err.message);
      onError?.(err);
    }
  }

  /**
   * The peer connection only exists once the camera/mic permission has been
   * granted, but the caller starts sending its offer as soon as the other side
   * accepts. Anything that lands before `pc` exists is queued here instead of
   * being dropped — otherwise a slow permission prompt silently kills the call.
   */
  function onSignal(payload) {
    if (!payload?.data) return;
    if (!pc) {
      log('signal buffered until the peer connection exists', payload.data.type);
      pendingSignals.push(payload.data);
      return;
    }
    return applySignal(payload.data);
  }

  /* ---------------------------------------------------------------- *
   * Public API
   * ---------------------------------------------------------------- */

  async function startCall(peerUid, peerInfo, { video } = {}) {
    if (callId) throw new Error('Masih ada panggilan berjalan');
    peer = { uid: peerUid, ...peerInfo };
    wantsVideo = Boolean(video);
    role = 'caller';
    emit({});

    const ack = await new Promise((resolve) => {
      socket.emit('call:invite', { toUid: peerUid, video: wantsVideo }, resolve);
    });
    if (!ack?.ok) {
      peer = null;
      role = null;
      emit({});
      throw new Error(ack?.error || 'Panggilan gagal dimulai');
    }
    callId = ack.callId;
    emit({ status: 'outgoing' });

    after(RING_TIMEOUT_MS, () => {
      if (role === 'caller') end('tidak dijawab');
    });
  }

  async function acceptCall() {
    if (!callId || role !== 'callee') return;
    socket.emit('call:accept', { callId, toUid: peer.uid });
    await beginMedia();
  }

  function rejectCall() {
    if (!callId) return;
    socket.emit('call:reject', { callId, toUid: peer.uid });
    teardown();
    emit({ status: 'idle' });
  }

  async function beginMedia() {
    try {
      await acquireLocalStream(wantsVideo);
      buildPeerConnection();

      const queued = pendingSignals;
      pendingSignals = [];
      for (const data of queued) await applySignal(data);

      emit({ status: 'connecting' });
      after(CONNECT_TIMEOUT_MS, () => {
        if (pc && pc.connectionState !== 'connected') end('gagal tersambung');
      });
      if (role === 'caller') {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        log('sending offer');
        send({ type: 'description', description: pc.localDescription.toJSON() });
      }
    } catch (err) {
      log('beginMedia failed', err);
      onError?.(err);
      end('gagal akses kamera/mikrofon');
    }
  }

  function teardown() {
    clearTimers();
    localStream?.getTracks().forEach((t) => t.stop());
    screenTrack?.stop();
    try {
      pc?.close();
    } catch {
      /* already closed */
    }
    pc = null;
    localStream = null;
    remoteStream = null;
    videoSender = null;
    cameraTrack = null;
    screenTrack = null;
    pendingIce = [];
    pendingSignals = [];
    callId = null;
    peer = null;
    role = null;
    wantsVideo = false;
  }

  function end(reason) {
    const had = callId;
    if (had && peer) socket.emit('call:end', { callId: had, toUid: peer.uid });
    const peerName = peer?.displayName;
    teardown();
    onState?.({ status: 'idle', endedReason: reason || '', endedPeer: peerName || '' });
  }

  /* ---- in-call controls ---- */

  const toggleMic = () => {
    if (!localStream) return false;
    const next = !localStream.getAudioTracks().every((t) => t.enabled);
    localStream.getAudioTracks().forEach((t) => (t.enabled = next));
    emit({});
    return next;
  };

  async function toggleCamera() {
    if (!videoSender) return false;
    if (cameraTrack) {
      const next = !cameraTrack.enabled;
      cameraTrack.enabled = next;
      if (next) await videoSender.replaceTrack(screenTrack || cameraTrack);
      else if (!screenTrack) await videoSender.replaceTrack(null);
      emit({});
      return next;
    }
    const fresh = await navigator.mediaDevices.getUserMedia({ video: true });
    cameraTrack = fresh.getVideoTracks()[0];
    localStream.addTrack(cameraTrack);
    await videoSender.replaceTrack(cameraTrack);
    emit({});
    return true;
  }

  async function toggleScreenShare() {
    if (!videoSender) return false;
    if (screenTrack) {
      screenTrack.stop();
      screenTrack = null;
      await videoSender.replaceTrack(cameraTrack && cameraTrack.enabled ? cameraTrack : null);
      emit({});
      return false;
    }
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
    screenTrack = display.getVideoTracks()[0];
    screenTrack.onended = () => {
      if (screenTrack) toggleScreenShare();
    };
    await videoSender.replaceTrack(screenTrack);
    emit({});
    return true;
  }

  /* ---- socket wiring ---- */

  const handlers = {
    'call:accepted': () => {
      if (role === 'caller') beginMedia();
    },
    'call:rejected': () => {
      const name = peer?.displayName;
      teardown();
      onState?.({ status: 'idle', endedReason: 'ditolak', endedPeer: name || '' });
    },
    'call:ended': ({ reason }) => {
      const name = peer?.displayName;
      const wasActive = Boolean(remoteStream?.getTracks().length) || pc;
      teardown();
      onState?.({ status: 'idle', endedReason: reason || (wasActive ? '' : 'dibatalkan'), endedPeer: name || '' });
    },
    'call:signal': (data) => onSignal(data),
  };

  for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);

  function handleIncoming({ callId: id, from, video }) {
    if (callId) {
      socket.emit('call:reject', { callId: id, toUid: from.uid });
      return;
    }
    callId = id;
    peer = from;
    role = 'callee';
    wantsVideo = Boolean(video);
    emit({ status: 'incoming' });
  }

  return {
    startCall,
    acceptCall,
    rejectCall,
    end,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    handleIncoming,
    get active() {
      return Boolean(callId);
    },
  };
}
