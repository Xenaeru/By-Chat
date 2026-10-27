/**
 * firebase-auth-proxy.js — melayani jalur /__/auth/* dari domain aplikasi sendiri.
 *
 * Kenapa perlu: Firebase Auth menaruh halaman pembantu login di
 * `https://<project>.firebaseapp.com/__/auth/handler`. Di halaman biasa itu
 * tidak masalah. Di aplikasi terpasang (APK/TWA) dan di Chrome modern, tidak:
 *
 *   - Chrome mempartisi penyimpanan per situs teratas. Hasil login yang ditulis
 *     halaman pembantu di origin firebaseapp.com tidak pernah terlihat oleh
 *     halaman aplikasi di bychat.web.id.
 *   - TWA hanya boleh menampilkan domainnya sendiri. Begitu navigasinya keluar
 *     ke firebaseapp.com, Chrome membukanya di tab lain, jadi aplikasinya
 *     sendiri tetap di layar login.
 *
 * Gejalanya sama untuk dua sebab itu: sudah memilih akun Google, lalu balik
 * lagi ke layar login dan tidak bisa masuk.
 *
 * Jalan keluarnya yang dipakai Firebase sendiri: layani /__/auth/* dari domain
 * aplikasi dan teruskan ke <project>.firebaseapp.com. Semua jadi satu origin,
 * dan `FIREBASE_AUTH_DOMAIN` diisi domain aplikasi (lihat .env.example).
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // fetch sudah membuka kompresinya, jadi header ini tidak lagi menggambarkan
  // isi yang diteruskan. Kalau ikut dikirim, browser mencoba meng-unzip teks
  // biasa dan halaman loginnya rusak.
  'content-encoding',
  'content-length',
]);

// Hanya header yang memang dibutuhkan halaman pembantu. Menyalin semuanya
// berarti ikut mengirim header milik domain ini ke pihak lain.
const FORWARD_REQUEST_HEADERS = ['accept', 'accept-language', 'cache-control', 'content-type', 'user-agent'];

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/i;

/** Alamat asli halaman pembantu Firebase, atau null kalau project id aneh. */
export function firebaseAuthUpstream(projectId) {
  const id = String(projectId || '').trim();
  if (!PROJECT_ID_RE.test(id)) return null;
  return `https://${id}.firebaseapp.com`;
}

function sendText(res, status, message) {
  if (res.headersSent) return res.end();
  res.status(status).type('text/plain; charset=utf-8').send(message);
}

/**
 * Middleware siap pakai: `app.use('/__/auth', createFirebaseAuthProxy({...}))`.
 *
 * `fetchImpl` bisa diganti di test supaya tidak ada permintaan jaringan.
 */
export function createFirebaseAuthProxy({
  upstream,
  prefix = '/__/auth',
  timeoutMs = 15_000,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  if (!upstream) throw new Error('createFirebaseAuthProxy butuh upstream.');

  const upstreamUrl = new URL(upstream);
  const upstreamHost = upstreamUrl.host;

  return async function firebaseAuthProxy(req, res, next) {
    if (!req.originalUrl.startsWith(`${prefix}/`) && req.originalUrl !== prefix) return next();

    let target;
    try {
      target = new URL(req.originalUrl, upstreamUrl);
    } catch {
      return sendText(res, 400, 'Alamat login tidak valid.');
    }
    // Jaga-jaga: apa pun yang datang dari luar tidak boleh memindahkan tujuan
    // ke host lain.
    if (target.host !== upstreamHost) return sendText(res, 400, 'Alamat login tidak valid.');

    const method = String(req.method || 'GET').toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : req;

    const headers = {};
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (value) headers[name] = value;
    }

    let response;
    try {
      response = await fetchImpl(target, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        ...(body ? { duplex: 'half' } : {}),
      });
    } catch (err) {
      return sendText(res, 502, `Halaman login Firebase tidak bisa dihubungi: ${err?.message || err}`);
    }

    res.status(response.status);

    for (const [name, value] of response.headers) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === 'set-cookie') continue;
      if (lower === 'location') {
        // Tujuan internal Firebase dikirim sebagai jalur relatif: alamatnya
        // jadi ikut domain ini tanpa perlu menebak skema di belakang proxy.
        let next_;
        try {
          next_ = new URL(value, upstreamUrl);
        } catch {
          next_ = null;
        }
        res.setHeader(
          'location',
          next_ && next_.host === upstreamHost ? `${next_.pathname}${next_.search}${next_.hash}` : value
        );
        continue;
      }
      res.setHeader(name, value);
    }

    // Cookie dari Firebase membawa Domain=.firebaseapp.com, yang akan dibuang
    // browser karena tidak cocok dengan domain ini. Atribut itu yang dibuang.
    for (const cookie of response.headers.getSetCookie?.() || []) {
      res.append('set-cookie', String(cookie).replace(/;\s*domain=[^;]*/gi, ''));
    }

    if (!response.body) return res.end();

    const { Readable } = await import('node:stream');
    const stream = Readable.fromWeb(response.body);
    stream.on('error', () => res.destroy());
    res.on('close', () => {
      // Respons yang selesai normal juga memicu 'close'; jangan memotong
      // salurannya sendiri di tengah jalan.
      if (!res.writableEnded) stream.destroy();
    });
    stream.pipe(res);
  };
}
