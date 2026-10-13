/**
 * auth-client.js — sign-in drivers for the browser.
 *
 *   firebase : real Firebase Authentication. Google sign-in via popup, phone
 *              sign-in via SMS OTP. The SDK is loaded from Google's CDN as an
 *              ES module, so the app still needs no build step.
 *   dev      : type a name, no verification. Only offered when the server
 *              itself is running in dev auth mode.
 *
 * Either way the result is the same shape: a profile + a `getIdToken()` that
 * the server independently verifies. Signing in proves *who you are to the
 * server*; it has nothing to do with the message encryption, which stays
 * entirely on this device.
 */

const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/13.0.0';

const DEV_PROFILE_KEY = 'securechat.devprofile.v1';

function b64urlUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const profileFromUser = (user) => ({
  uid: user.uid,
  displayName: user.displayName || user.phoneNumber || `user-${user.uid.slice(0, 6)}`,
  phone: user.phoneNumber || null,
  photoURL: user.photoURL || null,
});

/* ------------------------------------------------------------------ *
 * Firebase
 * ------------------------------------------------------------------ */

async function createFirebaseAuth(authConfig) {
  const [{ initializeApp }, fbAuth] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-auth.js`),
  ]);

  const app = initializeApp(authConfig.firebase);
  const auth = fbAuth.getAuth(app);

  if (authConfig.emulatorHost) {
    fbAuth.connectAuthEmulator(auth, `http://${authConfig.emulatorHost}`, { disableWarnings: true });
  }

  const listeners = new Set();
  fbAuth.onAuthStateChanged(auth, (user) => {
    const profile = user ? profileFromUser(user) : null;
    for (const fn of listeners) fn(profile);
  });

  return {
    mode: 'firebase',

    onUserChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async getIdToken() {
      return auth.currentUser ? auth.currentUser.getIdToken() : null;
    },

    async signInWithGoogle() {
      const provider = new fbAuth.GoogleAuthProvider();
      const result = await fbAuth.signInWithPopup(auth, provider);
      return profileFromUser(result.user);
    },

    /** Returns a handle whose confirm(code) finishes the SMS OTP flow. */
    async startPhoneSignIn(phoneNumber, recaptchaContainer) {
      const verifier = new fbAuth.RecaptchaVerifier(auth, recaptchaContainer, { size: 'invisible' });
      try {
        const confirmation = await fbAuth.signInWithPhoneNumber(auth, phoneNumber, verifier);
        return {
          async confirm(code) {
            const result = await confirmation.confirm(code);
            return profileFromUser(result.user);
          },
        };
      } catch (err) {
        verifier.clear();
        throw err;
      }
    },

    async setDisplayName(name) {
      if (auth.currentUser) await fbAuth.updateProfile(auth.currentUser, { displayName: name });
    },

    async signOut() {
      await fbAuth.signOut(auth);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Dev
 * ------------------------------------------------------------------ */

function createDevAuth() {
  const listeners = new Set();
  let profile = null;

  try {
    const raw = localStorage.getItem(DEV_PROFILE_KEY);
    if (raw) profile = JSON.parse(raw);
  } catch {
    /* ignore */
  }

  return {
    mode: 'dev',

    onUserChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    resume() {
      if (profile) for (const fn of listeners) fn(profile);
    },

    async getIdToken() {
      return profile ? `dev.${b64urlUtf8(JSON.stringify(profile))}` : null;
    },

    async signInAs(displayName) {
      const name = String(displayName || '').trim().slice(0, 40);
      if (!name) throw new Error('Nama belum diisi');
      // A stable uid, so the same name keeps the same account between reloads.
      profile = {
        uid: 'dev-' + (await sha256Hex(name)).slice(0, 20),
        displayName: name,
        phone: null,
        photoURL: null,
      };
      localStorage.setItem(DEV_PROFILE_KEY, JSON.stringify(profile));
      for (const fn of listeners) fn(profile);
      return profile;
    },

    async setDisplayName(name) {
      profile = { ...profile, displayName: String(name).slice(0, 40) };
      localStorage.setItem(DEV_PROFILE_KEY, JSON.stringify(profile));
      for (const fn of listeners) fn(profile);
    },

    async signOut() {
      profile = null;
      localStorage.removeItem(DEV_PROFILE_KEY);
      for (const fn of listeners) fn(null);
    },
  };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

export async function createAuthClient(serverConfig) {
  return serverConfig.auth.mode === 'firebase'
    ? createFirebaseAuth(serverConfig.auth)
    : createDevAuth();
}

export { FIREBASE_SDK };
