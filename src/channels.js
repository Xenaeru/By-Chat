/**
 * channels.js — saluran siaran (mirip Saluran WhatsApp).
 *
 * Saluran itu satu arah: pengikut cuma membaca, dan yang boleh menulis hanya
 * admin saluran. Karena itu pesannya disimpan di server sebagai blob terenkripsi
 * dengan kunci yang ikut di dalam envelope ("mode publik" di crypto.js): isinya
 * siaran untuk semua pengikut, jadi siapa pun yang sudah mengikuti saluran boleh
 * membacanya — termasuk yang baru bergabung setelah pesannya terbit.
 *
 * Yang dijaga di sini:
 *   - Pembuat saluran otomatis jadi pemilik + admin.
 *   - Nama dan deskripsi hanya bisa diubah pemilik/admin saluran.
 *   - Daftar pengikut cuma keluar lewat channel:members, dan di sana server
 *     memeriksa dulu bahwa pemintanya admin saluran.
 *   - Postingan tidak pernah membawa uid penulis ke pengikut: dari sisi mereka
 *     semua pesan datang "dari saluran".
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_POSTS = 300;
const MAX_FOLLOWERS = 5000;
const MAX_ADMINS = 50;

const cleanName = (value) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

const cleanDescription = (value) =>
  String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 500);

export const channelSummary = (channel, viewerUid = '') => ({
  id: channel.id,
  name: channel.name,
  description: channel.description,
  avatarVersion: channel.avatarVersion || null,
  followers: channel.followers.length,
  admins: channel.admins.length,
  owner: channel.owner,
  isFollowing: channel.followers.includes(viewerUid),
  isAdmin: channel.admins.includes(viewerUid),
  createdAt: channel.createdAt,
});

/* ------------------------------------------------------------------
 * Persistence
 * ------------------------------------------------------------------ */

export async function createChannelStore(config) {
  if (config.storage.driver === 'supabase') {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(config.secrets.supabaseUrl, config.secrets.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const bucket = config.storage.bucket;
    const object = config.channels.object;

    return {
      kind: 'supabase',
      async read() {
        const { data, error } = await client.storage.from(bucket).download(object);
        if (error) {
          if (/not found|does not exist|no such/i.test(error.message || '')) return null;
          throw new Error(`Gagal baca saluran: ${error.message}`);
        }
        return JSON.parse(await data.text());
      },
      async write(value) {
        const { error } = await client.storage.from(bucket).upload(object, JSON.stringify(value), {
          upsert: true,
          contentType: 'application/json',
        });
        if (error) throw new Error(`Gagal simpan saluran: ${error.message}`);
      },
    };
  }

  const file = config.channels.file;
  return {
    kind: 'file',
    file,
    async read() {
      try {
        const raw = await fs.readFile(file, 'utf8');
        return raw.trim() ? JSON.parse(raw) : null;
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        console.warn(`⚠️  Saluran nggak bisa dibaca (${err.message}) — mulai dari kosong.`);
        return null;
      }
    },
    async write(value) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

/* ------------------------------------------------------------------
 * Registry
 * ------------------------------------------------------------------ */

const isUid = (uid) => typeof uid === 'string' && uid.length > 0 && uid.length <= 128;

export async function createChannelRegistry({ store = null } = {}) {
  /** id -> channel */
  const channels = new Map();

  async function load() {
    let saved = null;
    try {
      saved = await store?.read();
    } catch (err) {
      console.warn(`⚠️  ${err.message}`);
    }

    const entries = saved?.channels && typeof saved.channels === 'object' ? saved.channels : {};
    for (const [id, entry] of Object.entries(entries)) {
      if (!/^ch_[a-z0-9]{6,32}$/.test(id)) continue;
      const owner = isUid(entry?.owner) ? entry.owner : '';
      if (!owner) continue;

      const followers = Array.isArray(entry?.followers)
        ? [...new Set(entry.followers.filter(isUid))].slice(0, MAX_FOLLOWERS)
        : [owner];
      const admins = Array.isArray(entry?.admins)
        ? [...new Set(entry.admins.filter((uid) => isUid(uid) && followers.includes(uid)))].slice(0, MAX_ADMINS)
        : [];

      channels.set(id, {
        id,
        name: cleanName(entry?.name) || 'Saluran',
        description: cleanDescription(entry?.description),
        owner,
        admins: admins.length ? admins : [owner],
        followers,
        avatarVersion: entry?.avatarVersion ? String(entry.avatarVersion).slice(0, 32) : null,
        posts: Array.isArray(entry?.posts)
          ? entry.posts
              .filter((post) => post && typeof post?.payload?.ct === 'string')
              .slice(-MAX_POSTS)
              .map((post) => ({
                id: String(post.id || crypto.randomUUID()),
                payload: post.payload,
                at: Number(post.at) || Date.now(),
                from: isUid(post.from) ? post.from : owner,
              }))
          : [],
        createdAt: Number(entry?.createdAt) || Date.now(),
        updatedAt: Number(entry?.updatedAt) || Date.now(),
      });
    }
    return channels.size;
  }

  async function persist() {
    if (!store) return;
    try {
      await store.write({ version: 1, channels: Object.fromEntries(channels) });
    } catch (err) {
      console.warn(`⚠️  ${err.message} — saluran terakhir mungkin hilang setelah restart.`);
    }
  }

  return {
    load,
    size: () => channels.size,
    get: (id) => channels.get(String(id || '')) || null,
    all: () => [...channels.values()],

    /** Semua saluran, untuk halaman "Jelajahi". */
    summaries(viewerUid = '') {
      return [...channels.values()]
        .map((channel) => channelSummary(channel, viewerUid))
        .sort((a, b) => b.followers - a.followers || b.createdAt - a.createdAt);
    },

    async create({ name, description, owner }) {
      const cleanChannelName = cleanName(name);
      if (cleanChannelName.length < 2) return { ok: false, error: 'Nama saluran minimal 2 huruf.' };
      if (!isUid(owner)) return { ok: false, error: 'Pemilik saluran tidak jelas.' };

      const id = `ch_${crypto.randomBytes(9).toString('hex')}`;
      const channel = {
        id,
        name: cleanChannelName,
        description: cleanDescription(description),
        owner,
        admins: [owner],
        followers: [owner],
        avatarVersion: null,
        posts: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      channels.set(id, channel);
      await persist();
      return { ok: true, channel };
    },

    async update(id, patch = {}) {
      const channel = channels.get(String(id || ''));
      if (!channel) return { ok: false, error: 'Saluran tidak ditemukan.' };

      if (patch.name !== undefined) {
        const name = cleanName(patch.name);
        if (name.length < 2) return { ok: false, error: 'Nama saluran minimal 2 huruf.' };
        channel.name = name;
      }
      if (patch.description !== undefined) channel.description = cleanDescription(patch.description);

      channel.updatedAt = Date.now();
      await persist();
      return { ok: true, channel };
    },

    async setAvatar(id, version) {
      const channel = channels.get(String(id || ''));
      if (!channel) return null;
      channel.avatarVersion = version ? String(version) : null;
      channel.updatedAt = Date.now();
      await persist();
      return channel;
    },

    async follow(id, uid) {
      const channel = channels.get(String(id || ''));
      if (!channel) return { ok: false, error: 'Saluran tidak ditemukan.' };
      if (!isUid(uid)) return { ok: false, error: 'Pengguna tidak jelas.' };

      if (!channel.followers.includes(uid)) {
        if (channel.followers.length >= MAX_FOLLOWERS) {
          return { ok: false, error: 'Saluran ini sudah penuh.' };
        }
        channel.followers.push(uid);
        channel.updatedAt = Date.now();
        await persist();
      }
      return { ok: true, channel };
    },

    async unfollow(id, uid) {
      const channel = channels.get(String(id || ''));
      if (!channel) return { ok: false, error: 'Saluran tidak ditemukan.' };
      if (channel.owner === uid) {
        return { ok: false, error: 'Pemilik saluran nggak bisa berhenti mengikuti salurannya sendiri.' };
      }

      const before = channel.followers.length;
      channel.followers = channel.followers.filter((follower) => follower !== uid);
      channel.admins = channel.admins.filter((admin) => admin !== uid);
      if (channel.followers.length !== before) {
        channel.updatedAt = Date.now();
        await persist();
      }
      return { ok: true, channel };
    },

    async setAdmin(id, uid, value) {
      const channel = channels.get(String(id || ''));
      if (!channel) return { ok: false, error: 'Saluran tidak ditemukan.' };
      if (!channel.followers.includes(uid)) {
        return { ok: false, error: 'Orang itu belum jadi pengikut saluran ini.' };
      }
      if (channel.owner === uid && !value) {
        return { ok: false, error: 'Pemilik saluran nggak bisa dicabut status adminnya.' };
      }

      if (value && !channel.admins.includes(uid)) {
        if (channel.admins.length >= MAX_ADMINS) return { ok: false, error: 'Admin saluran sudah penuh.' };
        channel.admins.push(uid);
      } else if (!value) {
        channel.admins = channel.admins.filter((admin) => admin !== uid);
      } else {
        return { ok: true, channel };
      }

      channel.updatedAt = Date.now();
      await persist();
      return { ok: true, channel };
    },

    async addPost(id, { payload, from }) {
      const channel = channels.get(String(id || ''));
      if (!channel) return { ok: false, error: 'Saluran tidak ditemukan.' };
      if (typeof payload?.ct !== 'string' || !payload.ct) {
        return { ok: false, error: 'Isi pesan tidak lengkap.' };
      }

      const post = { id: crypto.randomUUID(), payload, at: Date.now(), from: String(from || '') };
      channel.posts.push(post);
      if (channel.posts.length > MAX_POSTS) channel.posts.splice(0, channel.posts.length - MAX_POSTS);
      channel.updatedAt = Date.now();
      await persist();
      return { ok: true, post };
    },
  };
}
