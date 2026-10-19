/**
 * Notifikasi pesan + balas dari notifikasi.
 *
 * Isi pesan tetap cuma ada di perangkat ini: yang dikirim ke service worker
 * hanyalah nama pengirim dan cuplikan teks yang sudah didekripsi di halaman.
 * Balasan yang diketik di notifikasi (kalau platform mendukung) dikirim balik
 * ke halaman ini lewat postMessage, lalu dienkripsi dan dikirim seperti pesan
 * biasa — service worker sendiri nggak pernah punya kunci.
 *
 * Ketersediaan:
 *   - Chrome/Edge desktop: notifikasi tampil, tapi kolom "Balas" di dalam
 *     notifikasi belum didukung. Klik notifikasi membuka chat-nya dan fokus ke
 *     kolom ketik, jadi balasan tetap satu ketukan.
 *   - Chrome Android: `actions` dengan `type: "text"` menampilkan kolom balas
 *     langsung di notifikasi, dan teksnya diteruskan ke halaman ini.
 */

const SW_URL = '/sw.js';
const SETTINGS_KEY = 'bychat.notifications.v1';
const REPLY_CACHE = 'bychat-notif-replies';
const REPLY_URL = '/__notif-reply__';
const ICON = '/logo.svg';

const supported = () =>
  typeof window !== 'undefined' &&
  'Notification' in window &&
  'serviceWorker' in navigator &&
  window.isSecureContext;

export function createNotifier({ onAction, onAccountUid } = {}) {
  let registration = null;
  let registering = null;
  /** Token terakhir yang dipakai mendaftarkan push (dipakai saat mematikan). */
  let pushToken = null;

  const readPrefs = () => {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
    } catch {
      return {};
    }
  };
  const writePrefs = (prefs) => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs));
    } catch {
      /* storage penuh / dimatikan: preferensinya cuma hilang, bukan error */
    }
  };

  const enabled = () => Boolean(readPrefs().enabled) && Notification.permission === 'granted';

  function state() {
    if (!supported()) {
      return { supported: false, permission: 'unsupported', enabled: false };
    }
    return { supported: true, permission: Notification.permission, enabled: enabled() };
  }

  function deliver(action) {
    if (!action) return;
    try {
      onAction?.(action);
    } catch (err) {
      console.error('Aksi notifikasi gagal diproses:', err);
    }
  }

  // Service worker meneruskan klik/balasan sebagai pesan ke halaman ini.
  if (supported()) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type !== 'bychat:notification') return;
      // Notifikasi punya pemiliknya sendiri: kalau jendela ini memakai akun
      // lain (dua akun dibuka berbarengan di satu browser), aksinya diabaikan.
      if (data.uid && onAccountUid && data.uid !== onAccountUid()) return;
      deliver({ action: data.action || 'open', roomId: data.roomId, reply: data.reply || '', callId: data.callId || null });
    });
  }

  async function ensureRegistration() {
    if (!supported()) return null;
    if (registration) return registration;
    if (registering) return registering;

    registering = navigator.serviceWorker
      .register(SW_URL)
      .then(async (reg) => {
        registration = reg;
        await navigator.serviceWorker.ready;
        return reg;
      })
      .catch((err) => {
        console.warn('Service worker notifikasi gagal didaftarkan:', err.message);
        registering = null;
        return null;
      });

    return registering;
  }

  async function enable() {
    if (!supported()) {
      return { ok: false, error: 'Browser ini belum mendukung notifikasi web.' };
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      writePrefs({ ...readPrefs(), enabled: false });
      return {
        ok: false,
        error:
          permission === 'denied'
            ? 'Izin notifikasi diblokir browser. Buka pengaturan situs di browser untuk mengizinkannya.'
            : 'Izin notifikasi belum diberikan.',
      };
    }

    const reg = await ensureRegistration();
    if (!reg) return { ok: false, error: 'Service worker notifikasi gagal dipasang.' };
    writePrefs({ ...readPrefs(), enabled: true });
    return { ok: true };
  }

  function disable() {
    writePrefs({ ...readPrefs(), enabled: false });
    // Lepas langganan push juga: kalau tidak, panggilan tetap berdering di
    // perangkat ini walau notifikasinya sudah dimatikan.
    unsubscribePush().catch(() => {});
    return { ok: true };
  }

  /* ---- Web Push: panggilan masuk saat halaman belum terbuka ---- */

  /** VAPID public key datang dari server dalam bentuk base64url. */
  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (String(base64).length % 4)) % 4);
    const raw = atob((String(base64) + padding).replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  /**
   * Daftarkan endpoint push browser ini ke server. Hanya berjalan kalau
   * notifikasi memang sudah diizinkan dan service worker terpasang; tanpa itu
   * tidak ada tempat untuk menerima notifikasi panggilan.
   */
  async function syncPush(publicKey, token) {
    if (!supported() || !enabled() || !publicKey || !token) return false;
    if (!('PushManager' in window)) return false;

    const reg = await ensureRegistration();
    if (!reg?.pushManager) return false;

    try {
      let subscription = await reg.pushManager.getSubscription();
      if (!subscription) {
        subscription = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }
      pushToken = token;
      const response = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ subscription }),
      });
      return response.ok;
    } catch (err) {
      console.warn('Langganan push gagal:', err.message);
      return false;
    }
  }

  async function unsubscribePush() {
    if (!supported()) return;
    const reg = await ensureRegistration();
    const subscription = await reg?.pushManager?.getSubscription();
    if (!subscription) return;

    if (pushToken) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${pushToken}` },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }).catch(() => {});
    }
    await subscription.unsubscribe().catch(() => {});
  }

  /** Dipanggil saat aplikasi dibuka: pasang ulang SW kalau notifikasi pernah dinyalakan. */
  async function resume() {
    if (!enabled()) return;
    await ensureRegistration();
  }

  /**
   * Tampilkan notifikasi untuk satu pesan masuk.
   * `body` sudah berupa teks biasa (hasil dekripsi di halaman), bukan ciphertext.
   */
  async function notify({ roomId, uid, title, body, tag }) {
    if (!enabled() || !roomId) return false;

    const options = {
      body: String(body || 'Pesan baru').slice(0, 180),
      tag: tag || `room:${roomId}`,
      renotify: true,
      icon: ICON,
      badge: ICON,
      requireInteraction: false,
      data: { roomId, uid: uid || null },
      // `type: "text"` bikin kolom balas muncul di platform yang mendukung.
      actions: [
        { action: 'reply', title: 'Balas', type: 'text', placeholder: 'Tulis balasan…' },
        { action: 'open', title: 'Buka' },
      ],
    };

    const reg = await ensureRegistration();
    if (reg?.showNotification) {
      try {
        await reg.showNotification(title || 'Pesan baru', options);
        return true;
      } catch (err) {
        // Beberapa browser menolak `actions` tertentu; coba tanpa aksi.
        try {
          const { actions, ...plain } = options;
          await reg.showNotification(title || 'Pesan baru', plain);
          return true;
        } catch (plainError) {
          console.warn('Notifikasi gagal ditampilkan:', plainError.message, err.message);
        }
      }
    }

    // Cadangan untuk browser yang belum bisa menampilkan lewat service worker.
    try {
      const note = new Notification(title || 'Pesan baru', options);
      note.onclick = () => {
        window.focus();
        deliver({ action: 'open', roomId });
      };
      return true;
    } catch (err) {
      console.warn('Notifikasi gagal ditampilkan:', err.message);
      return false;
    }
  }

  /**
   * Balasan yang diketik saat nggak ada jendela aplikasi terbuka: service
   * worker menitipkannya di Cache Storage, halaman ini yang mengambil dan
   * mengirimnya setelah tersambung.
   */
  async function takePendingReply() {
    if (typeof caches === 'undefined') return null;
    try {
      const cache = await caches.open(REPLY_CACHE);
      const request = new Request(REPLY_URL, { method: 'GET' });
      const response = await cache.match(request);
      if (!response) return null;
      await cache.delete(request);
      const pending = await response.json();
      if (!pending?.roomId || !pending.text) return null;
      // Balasan yang sudah kedaluwarsa (mis. ditulis kemarin) jangan dikirim
      // diam-diam ke percakapan yang sudah berganti konteks.
      if (Date.now() - Number(pending.at || 0) > 10 * 60 * 1000) return null;
      return pending;
    } catch {
      return null;
    }
  }

  return { supported, state, enable, disable, resume, notify, takePendingReply, syncPush };
}
