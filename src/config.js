/**
 * config.js — one place that reads the environment and decides which drivers
 * to use. It also splits the config into what the browser may see and what
 * must never leave the server.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPORT_REASONS, MAX_DETAIL } from './moderation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

// Node can read a .env file itself (21.7+). Absent file is fine.
// Tests set SECURECHAT_SKIP_DOTENV so a developer's local .env can never
// change what the suite is exercising.
if (!process.env.SECURECHAT_SKIP_DOTENV) {
  try {
    process.loadEnvFile(path.join(projectRoot, '.env'));
  } catch {
    /* no .env — rely on real environment variables */
  }
}

const env = process.env;
const bool = (v) => String(v ?? '').toLowerCase() === 'true' || String(v ?? '') === '1';

const isProduction = env.NODE_ENV === 'production';

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

const firebaseProjectId = env.FIREBASE_PROJECT_ID || '';
const firebaseApiKey = env.FIREBASE_API_KEY || '';
const firebaseAuthDomain = env.FIREBASE_AUTH_DOMAIN || '';
const firebaseAppId = env.FIREBASE_APP_ID || '';
const firebaseSenderId = env.FIREBASE_MESSAGING_SENDER_ID || '';

const firebaseConfigured = Boolean(firebaseProjectId && firebaseApiKey && firebaseAuthDomain);

// Explicit AUTH_MODE wins; otherwise follow whatever credentials exist.
let authMode = env.AUTH_MODE || (firebaseConfigured ? 'firebase' : 'dev');

if (authMode === 'firebase' && !firebaseConfigured) {
  throw new Error(
    'AUTH_MODE=firebase tapi FIREBASE_API_KEY / FIREBASE_AUTH_DOMAIN / FIREBASE_PROJECT_ID belum diisi.'
  );
}

// Dev auth trusts whatever name the browser claims. That is a development
// convenience and must never be reachable from the public internet.
if (isProduction && authMode === 'dev') {
  throw new Error(
    'AUTH_MODE=dev nggak boleh dipakai di NODE_ENV=production. Isi kredensial Firebase dulu.'
  );
}

/* ------------------------------------------------------------------ *
 * File storage
 * ------------------------------------------------------------------ */

const supabaseUrl = env.SUPABASE_URL || '';
const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseBucket = env.SUPABASE_BUCKET || 'attachments';

let storageDriver = env.STORAGE_DRIVER || (supabaseUrl && supabaseServiceKey ? 'supabase' : 'local');
if (storageDriver === 'supabase' && !(supabaseUrl && supabaseServiceKey)) {
  throw new Error('STORAGE_DRIVER=supabase tapi SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diisi.');
}

/* ------------------------------------------------------------------ *
 * Usernames (@name)
 * ------------------------------------------------------------------ */

// Claims have to outlive a restart, otherwise the namespace is just a race.
// Supabase is used when that driver is active; otherwise this JSON file.
const usernameStore = {
  file: env.USERNAME_STORE || path.join(projectRoot, 'data', 'usernames.json'),
  object: env.USERNAME_STORE_OBJECT || 'registry/usernames.json',
};

/* ------------------------------------------------------------------ *
 * Moderasi: siapa yang jadi admin, dan di mana datanya disimpan
 * ------------------------------------------------------------------ */

const cleanList = (value) =>
  String(value ?? '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);

// Dua jalan menuju admin: uid (cocok di mode dev maupun Firebase) atau email
// yang sudah diverifikasi penyedia login. Daftar ini yang menentukan; halaman
// admin sendiri nggak pernah memutuskan siapa yang boleh masuk.
const adminUids = cleanList(env.ADMIN_UIDS);
const adminEmails = cleanList(env.ADMIN_EMAILS).map((email) => email.toLowerCase());

// Untuk data diskalakan halus, driver Supabase menyimpannya di dalam bucket
// yang sudah dipakai blobs, sedangkan driver local memakai file JSON di data/.
const registeredStore = (fileKey, objectKey, defaultFile, defaultObject) => ({
  file: env[fileKey] || path.join(projectRoot, 'data', defaultFile),
  object: env[objectKey] || defaultObject,
});

const moderationStore = registeredStore(
  'MODERATION_STORE',
  'MODERATION_STORE_OBJECT',
  'moderation.json',
  'registry/moderation.json'
);

const accountStore = registeredStore(
  'ACCOUNT_STORE',
  'ACCOUNT_STORE_OBJECT',
  'accounts.json',
  'registry/accounts.json'
);

// Akun username + kata sandi. Isinya hash scrypt + kunci tanda tangan sesi,
// jadi file ini sama rahasianya dengan kunci privat: jangan pernah dibagikan.
const credentialStore = registeredStore(
  'CREDENTIAL_STORE',
  'CREDENTIAL_STORE_OBJECT',
  'credentials.json',
  'registry/credentials.json'
);

// Profil publik: ID pengguna, status, tahun lahir, sakelar profil publik,
// centang biru, jabatan, dan catatan siapa yang pernah chat dengan siapa.
const profileStore = registeredStore(
  'PROFILE_STORE',
  'PROFILE_STORE_OBJECT',
  'profiles.json',
  'registry/profiles.json'
);

// Saluran siaran: pengikut, admin saluran, dan postingan terenkripsinya.
const channelStore = registeredStore(
  'CHANNEL_STORE',
  'CHANNEL_STORE_OBJECT',
  'channels.json',
  'registry/channels.json'
);

/* ------------------------------------------------------------------ *
 * Web Push (dering walau aplikasinya belum dibuka)
 * ------------------------------------------------------------------ */

// Kunci VAPID boleh datang dari env; kalau kosong, server membuatnya sekali
// dan menyimpannya lewat store di bawah. Mengganti kunci = semua langganan
// push lama tidak sah lagi, jadi env hanya perlu diisi kalau kuncinya memang
// mau dipakai bersama instance lain.
const pushStore = registeredStore(
  'PUSH_STORE',
  'PUSH_STORE_OBJECT',
  'push.json',
  'registry/push.json'
);

/* ------------------------------------------------------------------ *
 * Aplikasi Android (Trusted Web Activity)
 * ------------------------------------------------------------------ */

// APK-nya bukan program terpisah: isinya aplikasi web ini yang dibuka di dalam
// Chrome. Supaya Chrome mau membukanya layar penuh (tanpa address bar), domain
// ini harus menyatakan bahwa APK dengan package name di bawah memang miliknya.
// Pernyataan itu dilayani /.well-known/assetlinks.json dan berisi sidik jari
// sertifikat yang dipakai menandatangani APK.
const androidPackage = (env.ANDROID_PACKAGE_NAME || '').trim();
const androidFingerprints = (env.ANDROID_SHA256_CERT_FINGERPRINTS || '')
  .split(/[,\s]+/)
  .map((fp) => fp.trim().toUpperCase())
  .filter((fp) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fp));

/* ------------------------------------------------------------------ *
 * TURN (needed for calls on real networks, not just LAN)
 * ------------------------------------------------------------------ */

const turnUrls = (env.TURN_URLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (turnUrls.length) {
  iceServers.push({
    urls: turnUrls,
    username: env.TURN_USERNAME || '',
    credential: env.TURN_CREDENTIAL || '',
  });
}

/* ------------------------------------------------------------------ *
 * Asisten AI (By AI)
 * ------------------------------------------------------------------ */

// Server cuma meneruskan percakapan ke penyedia yang kompatibel dengan API
// OpenAI (/chat/completions). Itu artinya Gemini, Groq, DeepSeek, OpenRouter,
// sampai Ollama lokal semuanya bisa dipakai tanpa mengubah kode.
// Percakapan AI TIDAK end-to-end encrypted: server harus membacanya untuk
// diteruskan. Chat antarmanusia tetap E2EE karena tidak pernah lewat sini.
const aiApiKey = env.AI_API_KEY || '';
const aiBaseUrl = (env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(
  /\/+$/,
  ''
);
const aiModel = env.AI_MODEL || 'gemini-3.8-flash';
const aiEnabled = bool(env.AI_ENABLED ?? (aiApiKey ? 'true' : 'false'));
// 0 = tanpa batas dari sisi aplikasi. Penyedia AI tetap punya kuotanya sendiri.
const aiDailyLimitValue = String(env.AI_DAILY_LIMIT ?? '').trim();
const aiDailyLimit =
  aiDailyLimitValue === '' ? 100 : Math.max(0, Number(aiDailyLimitValue) || 0);
// Kunci AI Studio baru (AQ.) hanya diterima endpoint native Gemini. Aktif
// otomatis untuk base URL Gemini; AI_GEMINI_NATIVE=true memaksa jalur yang sama
// kalau penyedia Gemini dipasang di balik domain/proxy lain.
const aiGeminiNative = bool(env.AI_GEMINI_NATIVE) || aiBaseUrl.includes('generativelanguage.googleapis.com');
// Cari di web + baca URL yang ditempel. Hanya jalur native Gemini yang punya
// tool ini; provider OpenAI-compat mengabaikannya.
const aiWeb = bool(env.AI_WEB ?? 'true');
// Penyedia cadangan (mis. Ollama llama3.2). Dipakai otomatis kalau penyedia
// utama menolak/kehabisan kuota. Aktif kalau base URL dan modelnya diisi.
const aiFallbackBaseUrl = (env.AI_FALLBACK_BASE_URL || '').replace(/\/+$/, '');
const aiFallbackModel = env.AI_FALLBACK_MODEL || '';
const aiFallbackApiKey = env.AI_FALLBACK_API_KEY || '';
const aiFallbackGeminiNative =
  bool(env.AI_FALLBACK_GEMINI_NATIVE) || aiFallbackBaseUrl.includes('generativelanguage.googleapis.com');

/* ------------------------------------------------------------------ *
 * Exported shapes
 * ------------------------------------------------------------------ */

export const config = {
  isProduction,
  port: Number(env.PORT || 3000),

  auth: {
    mode: authMode,
    emulatorHost: env.FIREBASE_AUTH_EMULATOR_HOST || '',
    firebase: {
      projectId: firebaseProjectId,
      authDomain: firebaseAuthDomain,
      serviceAccount: env.FIREBASE_SERVICE_ACCOUNT || '',
    },
  },

  storage: {
    driver: storageDriver,
    bucket: supabaseBucket,
    localDir: env.LOCAL_STORAGE_DIR || path.join(projectRoot, 'data', 'attachments'),
    avatarDir: env.LOCAL_AVATAR_DIR || path.join(projectRoot, 'data', 'avatars'),
    maxBytes: Number(env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024),
  },

  iceServers,

  usernames: usernameStore,
  moderation: moderationStore,
  accounts: accountStore,
  credentials: credentialStore,
  profiles: profileStore,
  channels: channelStore,
  push: {
    ...pushStore,
    subject: env.VAPID_SUBJECT || 'mailto:admin@bychat.app',
    publicKey: env.VAPID_PUBLIC_KEY || '',
    privateKey: env.VAPID_PRIVATE_KEY || '',
  },

  admins: {
    uids: adminUids,
    emails: adminEmails,
  },

  android: {
    packageName: androidPackage,
    fingerprints: androidFingerprints,
  },

  ai: {
    enabled: aiEnabled,
    baseUrl: aiBaseUrl,
    apiKey: aiApiKey,
    model: aiModel,
    dailyLimit: aiDailyLimit,
    geminiNative: aiGeminiNative,
    web: aiWeb,
    fallback:
      aiFallbackBaseUrl && aiFallbackModel
        ? {
            baseUrl: aiFallbackBaseUrl,
            apiKey: aiFallbackApiKey,
            model: aiFallbackModel,
            geminiNative: aiFallbackGeminiNative,
          }
        : null,
    maxTokens: Math.max(64, Number(env.AI_MAX_TOKENS) || 800),
    systemPrompt:
      env.AI_SYSTEM_PROMPT ||
      'Kamu adalah By AI, asisten di aplikasi pesan By Chat. Jawab dalam bahasa yang dipakai pengguna, ringkas, ramah, dan jujur. Kalau tidak tahu, bilang tidak tahu.',
  },

  secrets: {
    supabaseUrl,
    supabaseServiceKey,
  },
};

/**
 * Isi /.well-known/assetlinks.json. Daftar kosong artinya server ini belum
 * dihubungkan ke APK mana pun, dan Chrome akan menampilkan APK sebagai Custom
 * Tab biasa (lengkap dengan address bar).
 */
export function assetLinks() {
  if (!config.android.packageName || !config.android.fingerprints.length) return [];
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: config.android.packageName,
        sha256_cert_fingerprints: config.android.fingerprints,
      },
    },
  ];
}

/** The subset of the config that is safe to hand to the browser. */
export function publicConfig(pushPublicKey = '') {
  return {
    auth: {
      mode: config.auth.mode,
      emulatorHost: config.auth.emulatorHost || null,
      firebase: firebaseConfigured
        ? {
            apiKey: firebaseApiKey,
            authDomain: firebaseAuthDomain,
            projectId: firebaseProjectId,
            appId: firebaseAppId || undefined,
            messagingSenderId: firebaseSenderId || undefined,
          }
        : null,
    },
    files: {
      enabled: true,
      maxBytes: config.storage.maxBytes,
      driver: config.storage.driver,
    },
    calls: {
      enabled: bool(env.CALLS_ENABLED ?? 'true'),
      hasTurn: turnUrls.length > 0,
      iceServers: config.iceServers,
      // Boleh dilihat siapa saja: ini kunci publik. Kunci privatnya tetap di
      // server dan tidak pernah ikut terkirim.
      pushPublicKey: pushPublicKey || null,
    },
    // Alasan laporan datang dari server supaya daftarnya cuma ada di satu
    // tempat (moderation.js). `adminMode` dipakai halaman admin buat bilang
    // terus terang kalau server ini belum punya admin sama sekali.
    reports: {
      reasons: REPORT_REASONS.map((reason) => ({ ...reason })),
      maxDetail: MAX_DETAIL,
      adminMode: config.admins.uids.length > 0 || config.admins.emails.length > 0,
    },
    // Key dan base URL penyedia tidak ikut: browser cuma perlu tahu fiturnya
    // hidup dan berapa kuota hariannya.
    ai: {
      enabled: config.ai.enabled,
      dailyLimit: config.ai.dailyLimit,
    },
  };
}
