/**
 * auth-client.js — sign-in drivers for the browser.
 *
 *   firebase : real Firebase Authentication, Google sign-in via popup. (SMS OTP
 *              phone sign-in was removed: it is a paid Firebase tier, so that
 *              path could never run on this project's plan.) The SDK is loaded
 *              from Google's CDN as an ES module, so the app still needs no
 *              build step.
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

/** Token sesi akun username + kata sandi. Sandinya sendiri tidak disimpan. */
const PASSWORD_SESSION_KEY = 'securechat.pwsession.v1';

function b64urlUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Apakah halaman ini dibuka dari APK Android? Di dalam APK, `document.referrer`
 * berisi `android-app://<package>` karena APK-nya menitipkan halamannya ke
 * Chrome. Hanya APK yang dites begini: PWA terpasang di desktop tetap bisa
 * memakai popup, jadi tidak perlu dipaksa redirect.
 */
function insideAndroidApp() {
  return document.referrer.startsWith('android-app://');
}

/* Penanda "sedang menunggu balik dari Google". Disimpan di sessionStorage
 * karena sifatnya satu tab: kalau aplikasinya dibuka ulang, penandanya memang
 * tidak berlaku lagi. */
const REDIRECT_PENDING_KEY = 'securechat.google.pending';
const REDIRECT_RELOAD_KEY = 'securechat.google.reloads';
const REDIRECT_STALE_MS = 10 * 60 * 1000;

function readPendingSince() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(REDIRECT_PENDING_KEY) || 'null');
    return Number(raw?.at) || null;
  } catch {
    return null;
  }
}

function markRedirectPending() {
  try {
    sessionStorage.setItem(REDIRECT_PENDING_KEY, JSON.stringify({ at: Date.now() }));
  } catch {
    /* storage dimatikan: alur tetap jalan, cuma tanpa pemulihan otomatis */
  }
}

function clearRedirectPending() {
  try {
    sessionStorage.removeItem(REDIRECT_PENDING_KEY);
    sessionStorage.removeItem(REDIRECT_RELOAD_KEY);
  } catch {
    /* abaikan */
  }
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

/**
 * Memulihkan login Google yang selesai di luar halaman ini.
 *
 * Hanya untuk APK: di browser biasa hasil redirect selalu dibaca oleh halaman
 * yang sama, jadi tidak ada yang perlu dipulihkan.
 */
function installRedirectRecovery(auth, fbAuth) {
  const since = readPendingSince();
  if (!since) return;
  if (Date.now() - since > REDIRECT_STALE_MS) return clearRedirectPending();

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (auth.currentUser) return clearRedirectPending();
    if (!readPendingSince()) return;

    const result = await fbAuth.getRedirectResult(auth).catch(() => null);
    if (result?.user) return clearRedirectPending();

    let reloads = 0;
    try {
      reloads = Number(sessionStorage.getItem(REDIRECT_RELOAD_KEY) || 0);
      // Satu kali cukup: sesi yang sudah tersimpan di perangkat terbaca saat
      // halaman dimuat. Lebih dari itu cuma mengulang kalau orangnya memang
      // membatalkan login.
      if (reloads >= 1) return clearRedirectPending();
      sessionStorage.setItem(REDIRECT_RELOAD_KEY, String(reloads + 1));
    } catch {
      // Tanpa sessionStorage penghitungnya tidak bisa diandalkan, dan memuat
      // ulang tanpa batas jauh lebih buruk daripada tetap di layar login.
      return;
    }

    location.reload();
  });
}

async function createFirebaseAuth(authConfig) {
  const [{ initializeApp }, fbAuth] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-auth.js`),
  ]);

  const app = initializeApp(authConfig.firebase);
  const auth = fbAuth.getAuth(app);

  // Balik dari halaman Google belum berarti selesai: hasilnya baru dibaca di
  // sini. Tanpa pemanggilan ini, kegagalan (domain belum diizinkan di Firebase,
  // popup ditutup, dsb.) hilang tanpa jejak dan tombolnya seolah tidak bekerja.
  let redirectError = null;
  const redirectReady = fbAuth.getRedirectResult(auth).catch((err) => {
    redirectError = err;
  });

  if (authConfig.emulatorHost) {
    fbAuth.connectAuthEmulator(auth, `http://${authConfig.emulatorHost}`, { disableWarnings: true });
  }

  const listeners = new Set();
  fbAuth.onAuthStateChanged(auth, (user) => {
    if (user) clearRedirectPending();
    const profile = user ? profileFromUser(user) : null;
    for (const fn of listeners) fn(profile);
  });

  // Di APK, Chrome kadang menyelesaikan login Google di tab lain sementara
  // halaman ini tetap di layar login. Begitu aplikasi terlihat lagi, hasilnya
  // dibaca ulang (kalau tetap kosong, halaman dimuat ulang sekali-dua kali).
  if (insideAndroidApp()) installRedirectRecovery(auth, fbAuth);

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
      // Di dalam APK tidak ada jendela popup, jadi signInWithPopup gagal dan
      // halamannya malah terlempar keluar aplikasi. Redirect tetap di dalam
      // aplikasi karena Chrome-nya sama. Hasilnya tidak dikembalikan di sini:
      // setelah balik dari Google, onAuthStateChanged di atas yang mengabari.
      if (insideAndroidApp()) {
        markRedirectPending();
        await fbAuth.signInWithRedirect(auth, provider);
        return null;
      }
      try {
        const result = await fbAuth.signInWithPopup(auth, provider);
        return profileFromUser(result.user);
      } catch (err) {
        // APK yang belum lolos verifikasi domain dibuka sebagai Custom Tab,
        // dan di sana popup tetap tidak bisa dipakai. Redirect juga jalan di
        // sana, jadi jangan berhenti di galat popup.
        if (
          err.code === 'auth/popup-blocked' ||
          err.code === 'auth/popup-closed-by-user' ||
          err.code === 'auth/cancelled-popup-request' ||
          err.code === 'auth/operation-not-supported-in-this-environment' ||
          err.code === 'auth/web-storage-unsupported'
        ) {
          markRedirectPending();
          await fbAuth.signInWithRedirect(auth, provider);
          return null;
        }
        throw err;
      }
    },

    /** Galat dari baliknya redirect Google, sekali ambil saja. */
    async takeRedirectError() {
      await redirectReady;
      const err = redirectError;
      redirectError = null;
      return err;
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

/* ------------------------------------------------------------------ *
 * Akun username + kata sandi
 * ------------------------------------------------------------------ */

/**
 * Akun dibuat dan diperiksa oleh server ini sendiri (src/credentials.js), jadi
 * driver ini tidak menyentuh Firebase sama sekali. Yang disimpan di perangkat
 * hanya token sesi yang sudah ditandatangani server — sandi tidak pernah
 * disimpan, dan tidak pernah ikut terkirim ke mana pun selain saat masuk.
 */
function createPasswordAuth() {
  const listeners = new Set();
  let session = null;

  try {
    const saved = JSON.parse(localStorage.getItem(PASSWORD_SESSION_KEY) || 'null');
    if (saved?.token && saved?.profile?.uid) session = saved;
  } catch {
    /* storage rusak atau dimatikan: mulai tanpa sesi */
  }

  const call = async (path, body) => {
    let response;
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('Server tidak bisa dihubungi. Coba lagi.');
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* balasan tanpa JSON — pesan di bawah tetap masuk akal */
    }
    if (!response.ok) throw new Error(data?.error || 'Permintaan gagal. Coba lagi.');
    return data || {};
  };

  const emit = (profile) => {
    for (const fn of listeners) fn(profile);
  };

  const save = () => {
    try {
      localStorage.setItem(PASSWORD_SESSION_KEY, JSON.stringify(session));
    } catch {
      /* storage penuh/dimatikan: sesi tetap jalan sampai tab ini ditutup */
    }
  };

  return {
    mode: 'password',

    onUserChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    restoreProfile: () => session?.profile || null,

    async getIdToken() {
      return session?.token || null;
    },

    async register(username, password) {
      await call('/api/auth/register', { username, password });
    },

    async signInWithPassword(username, password) {
      const data = await call('/api/auth/login', { username, password });
      session = { token: data.token, profile: data.profile };
      save();
      emit(session.profile);
      return session.profile;
    },

    async setDisplayName(name) {
      if (!session) return;
      session = {
        ...session,
        profile: { ...session.profile, displayName: String(name).slice(0, 40) },
      };
      save();
    },

    async signOut() {
      const had = Boolean(session);
      session = null;
      try {
        localStorage.removeItem(PASSWORD_SESSION_KEY);
      } catch {
        /* abaikan */
      }
      if (had) emit(null);
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

/**
 * Dua sumber identitas hidup berdampingan: penyedia login (Google, atau nama
 * bebas di mode dev) dan akun username+kata sandi. Yang menang adalah yang
 * terakhir dipakai, dan keduanya menghasilkan bentuk yang sama: profil +
 * `getIdToken()` yang diverifikasi server. Karena itu sisa aplikasi tidak tahu
 * (dan tidak perlu tahu) orangnya masuk lewat jalan yang mana.
 */
export async function createAuthClient(serverConfig) {
  const provider =
    serverConfig.auth.mode === 'firebase'
      ? await createFirebaseAuth(serverConfig.auth)
      : createDevAuth();
  const password = createPasswordAuth();

  const listeners = new Set();
  let current = password.restoreProfile();
  let source = current ? 'password' : null;

  const emit = (profile) => {
    current = profile;
    for (const fn of listeners) fn(profile);
  };

  provider.onUserChange((profile) => {
    // Firebase mengirim null saat tidak ada sesi. Itu bukan alasan memutus
    // sesi kata sandi yang memang sedang dipakai di tab ini.
    if (!profile && source === 'password') return;
    if (profile) source = 'provider';
    emit(profile);
  });

  password.onUserChange((profile) => {
    source = profile ? 'password' : null;
    emit(profile);
  });

  return {
    mode: provider.mode,

    onUserChange(fn) {
      listeners.add(fn);
      if (current) fn(current);
      return () => listeners.delete(fn);
    },

    resume() {
      provider.resume?.();
    },

    getIdToken() {
      return source === 'password' ? password.getIdToken() : provider.getIdToken();
    },

    register: (username, pass) => password.register(username, pass),

    async signInWithPassword(username, pass) {
      // Sesi penyedia yang masih hidup dilepas dulu, supaya tidak ada dua
      // identitas aktif sekaligus.
      try {
        await provider.signOut?.();
      } catch {
        /* tidak ada sesi yang perlu dilepas */
      }
      await password.signInWithPassword(username, pass);
    },

    async signInWithGoogle() {
      await password.signOut();
      return provider.signInWithGoogle();
    },

    takeRedirectError: () => provider.takeRedirectError?.() ?? Promise.resolve(null),

    async signInAs(name) {
      await password.signOut();
      return provider.signInAs?.(name);
    },

    async setDisplayName(name) {
      if (source === 'password') return password.setDisplayName(name);
      return provider.setDisplayName?.(name);
    },

    async signOut() {
      await password.signOut();
      try {
        await provider.signOut?.();
      } catch {
        /* abaikan */
      }
      emit(null);
    },
  };
}

export { FIREBASE_SDK };
