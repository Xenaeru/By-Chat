/**
 * Service worker By Chat.
 *
 * Tugasnya cuma dua: menampilkan notifikasi pesan dan meneruskan aksi atas
 * notifikasi itu (buka chat / balas) ke jendela aplikasi. Semua isi pesan
 * sudah didekripsi di halaman; SW tidak pernah menyimpan atau membaca kunci,
 * jadi dia juga tidak bisa membaca percakapan.
 */

const REPLY_CACHE = 'bychat-notif-replies';
const REPLY_URL = '/__notif-reply__';
const MAX_REPLY_AGE = 10 * 60 * 1000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      await dropStaleReply();
      await self.clients.claim();
    })()
  )
);

// Service worker ini tidak menyimpan aset apa pun; permintaan tetap langsung
// ke jaringan. Handler-nya ada supaya browser mengenalinya sebagai SW penuh.
self.addEventListener('fetch', () => {});

/** Balasan dari notifikasi dititipkan di sini kalau belum ada jendela terbuka. */
async function stashReply(roomId, text) {
  try {
    const cache = await caches.open(REPLY_CACHE);
    await cache.put(
      new Request(REPLY_URL),
      new Response(JSON.stringify({ roomId, text, at: Date.now() }), {
        headers: { 'content-type': 'application/json' },
      })
    );
  } catch (err) {
    console.warn('Balasan notifikasi gagal dititipkan:', err.message);
  }
}

function openUrl(roomId) {
  const url = new URL('/', self.location.origin);
  if (roomId) url.searchParams.set('chat', roomId);
  return url.href;
}

/**
 * Jalur yang sama dipakai `notificationclick` dan tes browser (lewat
 * `self.bychatNotificationClick`), supaya yang diuji benar-benar yang jalan
 * di produksi.
 */
async function handleNotificationClick({ action = 'open', reply = '', roomId } = {}) {
  const text = String(reply || '').trim();

  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const target =
    windows.find((client) => client.url.startsWith(self.location.origin) && client.focused) || windows[0];

  if (target) {
    // Pesannya lebih dulu, baru fokus: ada lingkungan (mis. jendela tanpa izin
    // fokus di sistem operasinya) yang menolak fokus, dan penolakan itu tidak
    // boleh membatalkan aksinya.
    target.postMessage({ type: 'bychat:notification', action, roomId, reply: text });
    await target.focus().catch(() => {});
    return;
  }

  // Tidak ada jendela yang bisa menerima balasannya: titipkan dulu, halaman
  // yang dibuka di bawah ini akan mengambil dan mengirimnya setelah tersambung.
  if (text && roomId) await stashReply(roomId, text);
  return self.clients.openWindow(openUrl(roomId));
}

self.bychatNotificationClick = handleNotificationClick;

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(
    handleNotificationClick({ action: event.action, reply: event.reply, roomId: data.roomId })
  );
});

/** Balasan yang dititipkan tapi sudah basi dibuang, biar tidak terkirim telat. */
async function dropStaleReply() {
  try {
    const cache = await caches.open(REPLY_CACHE);
    const response = await cache.match(new Request(REPLY_URL));
    if (!response) return;
    const pending = await response.json();
    if (Date.now() - Number(pending.at || 0) > MAX_REPLY_AGE) {
      await cache.delete(new Request(REPLY_URL));
    }
  } catch {
    /* cache kosong / tidak tersedia */
  }
}
