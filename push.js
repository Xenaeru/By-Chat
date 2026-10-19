/**
 * push.js — notifikasi panggilan saat aplikasinya belum terbuka.
 *
 * Tanpa ini, satu-satunya cara tahu ada telepon masuk adalah halaman yang
 * sedang tersambung ke server. Web Push memutus ketergantungan itu: server
 * mengirim notifikasi ke browser lewat layanan push-nya sendiri (FCM/APNs),
 * jadi HP atau laptop tetap berbunyi walau tabnya sudah ditutup.
 *
 * Kunci VAPID adalah identitas server di mata layanan push. Kunci itu dibuat
 * sekali lalu disimpan bersama data registry lainnya (Supabase, atau file JSON
 * saat driver local dipakai). Kalau kuncinya berubah, semua langganan lama
 * tidak sah lagi — jadi menyimpannya bukan pilihan, melainkan syarat.
 *
 * Yang dikirim ke layanan push hanyalah nama pemanggil dan id panggilan. Tidak
 * ada isi percakapan, tidak ada kunci enkripsi.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import webpush from 'web-push';

const MAX_SUBS_PER_USER = 5;

/** Bentuk langganan yang diterima dari browser; selain ini ditolak. */
function isSubscription(value) {
  if (!value || typeof value !== 'object') return false;
  const endpoint = String(value.endpoint || '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2048) return false;
  const keys = value.keys || {};
  return (
    typeof keys.p256dh === 'string' &&
    keys.p256dh.length > 16 &&
    typeof keys.auth === 'string' &&
    keys.auth.length > 4
  );
}

/**
 * Tempat langganan + kunci disimpan. Polanya sama dengan registry username:
 * Supabase kalau driver itu yang aktif, file JSON kalau tidak.
 */
async function createPushStore(config) {
  if (config.storage.driver === 'supabase') {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(config.secrets.supabaseUrl, config.secrets.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const bucket = config.storage.bucket;
    const object = config.push.object;

    return {
      kind: 'supabase',
      async read() {
        const { data, error } = await client.storage.from(bucket).download(object);
        if (error) {
          if (/not found|does not exist|no such/i.test(error.message || '')) return null;
          throw new Error(`Gagal baca data push: ${error.message}`);
        }
        return JSON.parse(await data.text());
      },
      async write(value) {
        const { error } = await client.storage.from(bucket).upload(object, JSON.stringify(value), {
          upsert: true,
          contentType: 'application/json',
        });
        if (error) throw new Error(`Gagal simpan data push: ${error.message}`);
      },
    };
  }

  const file = config.push.file;
  return {
    kind: 'file',
    file,
    async read() {
      try {
        const text = await fs.readFile(file, 'utf8');
        return text.trim() ? JSON.parse(text) : null;
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        console.warn(`⚠️  Data push nggak bisa dibaca (${err.message}) — mulai dari kosong.`);
        return null;
      }
    },
    async write(value) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

export async function createPushService(config) {
  const store = await createPushStore(config);

  let saved = null;
  try {
    saved = await store.read();
  } catch (err) {
    console.warn(`⚠️  ${err.message}`);
  }

  let publicKey = config.push.publicKey || saved?.keys?.publicKey || '';
  let privateKey = config.push.privateKey || saved?.keys?.privateKey || '';
  const fresh = !publicKey || !privateKey;
  if (fresh) {
    const generated = webpush.generateVAPIDKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
  }

  let ready = true;
  try {
    webpush.setVapidDetails(config.push.subject, publicKey, privateKey);
  } catch (err) {
    ready = false;
    console.warn(`⚠️  Web Push dimatikan: ${err.message}`);
  }

  /** uid -> Map(endpoint -> subscription) */
  const byUid = new Map();
  const subs = saved?.subscriptions && typeof saved.subscriptions === 'object' ? saved.subscriptions : {};
  for (const [uid, list] of Object.entries(subs)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list.slice(0, MAX_SUBS_PER_USER)) {
      if (!isSubscription(entry)) continue;
      if (!byUid.has(uid)) byUid.set(uid, new Map());
      byUid.get(uid).set(entry.endpoint, entry);
    }
  }

  let writing = Promise.resolve();
  function persist() {
    const snapshot = {
      version: 1,
      keys: { publicKey, privateKey },
      subscriptions: Object.fromEntries(
        [...byUid.entries()].map(([uid, list]) => [uid, [...list.values()]])
      ),
    };
    writing = writing
      .catch(() => {})
      .then(() => store.write(snapshot))
      .catch((err) => console.warn(`⚠️  ${err.message} — langganan push bisa hilang saat restart.`));
    return writing;
  }

  if (fresh || !saved) await persist();

  function count() {
    let total = 0;
    for (const list of byUid.values()) total += list.size;
    return total;
  }

  return {
    enabled: ready,
    publicKey: () => (ready ? publicKey : null),
    has: (uid) => Boolean(byUid.get(uid)?.size),
    count,

    async subscribe(uid, subscription) {
      if (!isSubscription(subscription)) return false;
      if (!byUid.has(uid)) byUid.set(uid, new Map());
      const list = byUid.get(uid);
      list.delete(subscription.endpoint);
      list.set(subscription.endpoint, subscription);
      // Browser lama yang sudah tidak dipakai jangan menumpuk selamanya.
      while (list.size > MAX_SUBS_PER_USER) list.delete(list.keys().next().value);
      await persist();
      return true;
    },

    async unsubscribe(uid, endpoint) {
      const list = byUid.get(uid);
      if (!list) return false;
      const removed = list.delete(String(endpoint || ''));
      if (removed && !list.size) byUid.delete(uid);
      if (removed) await persist();
      return removed;
    },

    /**
     * Kirim satu notifikasi ke semua perangkat milik uid. Langganan yang sudah
     * mati (404/410) dibuang, karena menyimpannya cuma bikin pengiriman gagal
     * berulang kali.
     */
    async notify(uid, payload, { ttl = 120 } = {}) {
      if (!ready) return 0;
      const list = byUid.get(String(uid || ''));
      if (!list?.size) return 0;

      const body = JSON.stringify(payload);
      let sent = 0;
      let dropped = false;

      await Promise.all(
        [...list.values()].map(async (subscription) => {
          try {
            await webpush.sendNotification(subscription, body, { TTL: ttl, urgency: 'high' });
            sent += 1;
          } catch (err) {
            const status = Number(err?.statusCode);
            if (status === 404 || status === 410) {
              list.delete(subscription.endpoint);
              dropped = true;
            } else if (status !== 429) {
              console.warn(`⚠️  Notifikasi push gagal (${status || err.message})`);
            }
          }
        })
      );

      if (dropped) {
        if (!list.size) byUid.delete(String(uid));
        await persist();
      }
      return sent;
    },
  };
}
