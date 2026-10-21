/**
 * voice.js — rekaman pesan suara.
 *
 * Yang direkam di sini belum menyentuh jaringan sama sekali. Hasilnya blob
 * audio biasa; app.js yang membungkusnya jadi File lalu memakai jalur lampiran
 * yang sudah ada (dienkripsi di browser sebelum diunggah). Jadi server tetap
 * cuma melihat ciphertext, sama seperti foto dan dokumen.
 */

// Urutan ini sengaja: Opus paling kecil dan paling didukung untuk suara.
// Safari lama cuma punya audio/mp4, jadi itu cadangan terakhir.
const FORMATS = [
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/webm', ext: 'webm' },
  { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
  { mime: 'audio/mp4', ext: 'm4a' },
];

/** Batas satu pesan suara. Cukup panjang, tapi nggak mau kiriman raksasa. */
export const MAX_VOICE_SECONDS = 300;

export function voiceFormat() {
  if (typeof MediaRecorder === 'undefined') return null;
  return FORMATS.find((format) => MediaRecorder.isTypeSupported(format.mime)) || null;
}

export function voiceSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia && voiceFormat());
}

/**
 * Mulai merekam. Pemanggil yang mengurus UI; di sini cuma mikrofon dan
 * encoder. `stop()` mengembalikan blob beserta durasi sebenarnya (diukur dari
 * jam, bukan dari metadata — MediaRecorder nggak menulis durasi ke header).
 */
export async function startVoiceRecording() {
  const format = voiceFormat();
  if (!format) throw new Error('Browser ini belum bisa merekam suara.');

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    if (err?.name === 'NotAllowedError') {
      throw new Error('Izin mikrofon ditolak. Aktifkan izinnya dulu, lalu coba lagi.');
    }
    if (err?.name === 'NotFoundError') throw new Error('Nggak ada mikrofon yang bisa dipakai.');
    throw new Error(`Mikrofon nggak bisa dibuka: ${err?.message || err}`);
  }

  let recorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: format.mime, audioBitsPerSecond: 64000 });
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error(`Format rekaman tidak didukung: ${err?.message || err}`);
  }

  const chunks = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data?.size) chunks.push(event.data);
  });

  const startedAt = performance.now();
  const release = () => stream.getTracks().forEach((track) => track.stop());
  let finished = null;
  let cancelled = false;

  // timeslice 1 detik: kalau tab ditutup di tengah rekaman, potongan yang sudah
  // sempat dikirim ke handler tetap ada.
  recorder.start(1000);

  const stop = () => {
    if (finished) return finished;
    finished = new Promise((resolve) => {
      recorder.addEventListener(
        'stop',
        () => {
          release();
          resolve({
            blob: new Blob(chunks, { type: format.mime }),
            mime: format.mime,
            ext: format.ext,
            duration: Math.max(0.5, (performance.now() - startedAt) / 1000),
          });
        },
        { once: true }
      );
      if (recorder.state !== 'inactive') recorder.stop();
      else release();
    });
    return finished;
  };

  return {
    mime: format.mime,
    elapsed: () => (performance.now() - startedAt) / 1000,
    stop,
    cancel() {
      cancelled = true;
      stop();
    },
    get cancelled() {
      return cancelled;
    },
  };
}
