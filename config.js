/**
 * config.js — one place that reads the environment and decides which drivers
 * to use. It also splits the config into what the browser may see and what
 * must never leave the server.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Node can read a .env file itself (21.7+). Absent file is fine.
// Tests set SECURECHAT_SKIP_DOTENV so a developer's local .env can never
// change what the suite is exercising.
if (!process.env.SECURECHAT_SKIP_DOTENV) {
  try {
    process.loadEnvFile(path.join(__dirname, '.env'));
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
      serviceAccount: env.FIREBASE_SERVICE_ACCOUNT || '',
    },
  },

  storage: {
    driver: storageDriver,
    bucket: supabaseBucket,
    localDir: env.LOCAL_STORAGE_DIR || path.join(__dirname, 'data', 'attachments'),
    maxBytes: Number(env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024),
  },

  iceServers,

  secrets: {
    supabaseUrl,
    supabaseServiceKey,
  },
};

/** The subset of the config that is safe to hand to the browser. */
export function publicConfig() {
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
    },
  };
}
