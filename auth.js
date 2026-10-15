/**
 * auth.js — server-side identity verification.
 *
 * Two drivers behind one interface:
 *
 *   firebase : verifies a real Firebase ID token with the Admin SDK. This is
 *              the production path — the token is signed by Google, so a client
 *              cannot claim a uid it does not own.
 *   dev      : decodes a token the browser made up. No cryptography at all.
 *              config.js refuses to start with this driver when
 *              NODE_ENV=production, so it can never be exposed by accident.
 *
 * `verify()` resolves to a profile: { uid, displayName, phone, email, photoURL }.
 */

const UID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const clean = (value, max) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);

function normalizeProfile(raw) {
  // Validate the uid strictly and without normalising it first. Trimming or
  // truncating would let two different uids collapse into one account —
  // 'a'.repeat(200) and 'a'.repeat(64) + 'b' would otherwise be the same user.
  const uid = typeof raw?.uid === 'string' ? raw.uid : '';
  if (!UID_RE.test(uid)) throw new Error('uid tidak valid');
  return {
    uid,
    displayName: clean(raw?.displayName, 40) || `user-${uid.slice(0, 6)}`,
    phone: clean(raw?.phone, 20) || null,
    // Email sudah diverifikasi penyedia login (Google/HP), jadi aman dipakai
    // buat mencari kontak — tapi tidak pernah disiarkan ke klien lain.
    email: clean(raw?.email, 254).toLowerCase() || null,
    photoURL: /^https:\/\//.test(raw?.photoURL || '') ? raw.photoURL : null,
  };
}

/* ------------------------------------------------------------------ *
 * Firebase driver
 * ------------------------------------------------------------------ */

async function createFirebaseVerifier(authConfig) {
  const { initializeApp, cert, applicationDefault, getApps } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');

  if (authConfig.emulatorHost) {
    // The Admin SDK switches to the emulator when this env var is present.
    process.env.FIREBASE_AUTH_EMULATOR_HOST = authConfig.emulatorHost;
  }

  const existing = getApps()[0];
  const app =
    existing ||
    initializeApp({
      projectId: authConfig.firebase.projectId || undefined,
      credential: authConfig.firebase.serviceAccount
        ? cert(JSON.parse(authConfig.firebase.serviceAccount))
        : applicationDefault(),
    });

  const adminAuth = getAuth(app);

  return {
    mode: 'firebase',
    async verify(token) {
      const decoded = await adminAuth.verifyIdToken(String(token || ''));
      return normalizeProfile({
        uid: decoded.uid,
        displayName: decoded.name,
        phone: decoded.phone_number,
        email: decoded.email,
        photoURL: decoded.picture,
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * Dev driver
 * ------------------------------------------------------------------ */

function createDevVerifier() {
  return {
    mode: 'dev',
    async verify(token) {
      const raw = String(token || '');
      if (!raw.startsWith('dev.')) throw new Error('Token dev tidak valid');
      let parsed;
      try {
        parsed = JSON.parse(Buffer.from(raw.slice(4), 'base64url').toString('utf8'));
      } catch {
        throw new Error('Token dev tidak bisa dibaca');
      }
      return normalizeProfile(parsed);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

export async function createVerifier(config) {
  if (config.auth.mode === 'firebase') return createFirebaseVerifier(config.auth);
  return createDevVerifier();
}

/** The token the dev client should send. Exported so tests and the client agree. */
export function makeDevToken({ uid, displayName, phone, photoURL, email }) {
  const payload = Buffer.from(
    JSON.stringify({ uid, displayName, phone, photoURL, email })
  ).toString('base64url');
  return `dev.${payload}`;
}
