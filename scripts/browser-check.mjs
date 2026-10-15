/**
 * Runs the real UI in a real browser: two isolated Chrome profiles sign in,
 * chat, exchange an encrypted attachment, and place an actual WebRTC call.
 *
 *   npm run test:browser
 *
 * WebRTC runs against Chrome's fake capture devices, so no real camera or
 * microphone is involved.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CALL_DEBUG = process.env.CALL_DEBUG === '1';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'securechat-browser-'));
process.env.SECURECHAT_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = path.join(TMP, 'attachments');
process.env.LOCAL_AVATAR_DIR = path.join(TMP, 'avatars');
// Username claims belong to the temp dir too, so a check run never leaves names
// behind in the developer's data/ folder.
process.env.USERNAME_STORE = path.join(TMP, 'usernames.json');
process.env.MODERATION_STORE = path.join(TMP, 'moderation.json');
process.env.ACCOUNT_STORE = path.join(TMP, 'accounts.json');
// `andi` yang jadi admin di jalur ini, jadi tautan admin muncul di sidebar-nya
// dan halaman /admin.html benar-benar bisa dibuka — sekaligus bisa diuji bahwa
// akun lain ditolak.
process.env.ADMIN_UIDS = `dev-${crypto.createHash('sha256').update('andi').digest('hex').slice(0, 20)}`;
process.env.PORT = process.env.PORT || '4400';

const { server, directory, inbox, statuses, moderation } = await import('../server.js');
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));

const BASE_URL = `http://127.0.0.1:${process.env.PORT}`;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
});

if (!chromePath) {
  console.error('Chrome nggak ketemu. Set CHROME_PATH ke binary Chrome kamu.');
  process.exit(1);
}

const results = [];
function check(label, condition, detail = '') {
  results.push({ label, ok: Boolean(condition) });
  if (!condition) throw new Error(`GAGAL: ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const display = (page, sel) => page.$eval(sel, (e) => getComputedStyle(e).display);

/* ---- Alat bantu interaksi ------------------------------------------ *
 * Klik dan sentuhan cuma diproses untuk halaman yang sedang tampil, dan dua
 * halaman di sini bergantian jadi yang tampil. Jadi setiap kali mau
 * berinteraksi, halamannya dibawa ke depan dulu. Titik kliknya juga dihitung
 * dari elemennya sendiri setelah dibawa ke tengah area gulir: `page.click`
 * bawaan kadang memakai titik yang ketutup kolom ketik, jadi kliknya tidak
 * sampai ke tujuannya. */
const front = (page) => page.bringToFront();

const menuActions = (page) =>
  page.$$eval('#msg-menu-list .msg-menu-item', (nodes) => nodes.map((node) => node.dataset.action));

const bubbleWith = async (page, text) => {
  const handles = await page.$$('.msg');
  for (const handle of handles) {
    const content = await handle.evaluate((node) => node.textContent);
    if (content.includes(text)) return handle;
  }
  throw new Error(`pesan "${text}" nggak ada di layar`);
};

const clickAt = async (page, target) => {
  await front(page);
  const handle = typeof target === 'string' ? await page.$(target) : target;
  const point = await handle.evaluate((node) => {
    node.scrollIntoView({ block: 'center' });
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  });
  await page.mouse.click(point.x, point.y);
};

const openMenu = async (page, target, { longPress = false } = {}) => {
  await front(page);
  const handle = typeof target === 'string' ? await page.$(target) : target;
  const point = await handle.evaluate((node) => {
    node.scrollIntoView({ block: 'center' });
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  });
  if (longPress) {
    // Tahan: mousedown ditahan lebih lama dari ambang 420 ms di app.js.
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await sleep(700);
    await page.mouse.up();
  } else {
    await page.mouse.click(point.x, point.y, { button: 'right' });
  }
  await page.waitForSelector('#msg-menu:not([hidden])', { timeout: 5000 });
};

const pickMenuAction = (page, action) =>
  clickAt(page, `#msg-menu-list .msg-menu-item[data-action="${action}"]`);

/** The dev driver derives the uid from the name, so we can predict it here. */
const devUid = (name) => 'dev-' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 20);

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true })
    .map((rel) => path.join(dir, rel))
    .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());
}

const CONSOLE_LOG = [];

async function login(browser, username) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('pageerror', (err) => {
    console.error(`[${username}] page error:`, err.message);
    CONSOLE_LOG.push(`${username} pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') CONSOLE_LOG.push(`${username} console: ${msg.text()}`);
  });

  // Opt-in WebRTC tracing inside the page (see public/call.js).
  if (CALL_DEBUG) await page.evaluateOnNewDocument(() => (globalThis.__SECURECHAT_CALL_DEBUG = true));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login:not([hidden])', { timeout: 15000 });
  check(`${username}: form login dev yang tampil`, (await display(page, '#login-dev')) === 'block');
  check(
    `${username}: opsi Google disembunyikan di mode dev`,
    (await display(page, '#login-firebase')) === 'none'
  );

  check(`${username}: kartu login memakai logo baru`, (await page.$('.brand-mark')) !== null);
  const logoWidth = await page.$eval('.brand-mark', (img) => img.naturalWidth);
  check(`${username}: file logo benar-benar termuat`, logoWidth > 0, `naturalWidth=${logoWidth}`);

  await page.type('#login-username', username);
  await page.click('#login-submit');
  await page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#me-status')?.textContent.includes('online'), {
    timeout: 15000,
  });

  // Signing in is not the whole story: a fresh account has to claim a username
  // before the server will relay anything, so the gate is part of the flow.
  await page.waitForSelector('#onboarding:not([hidden])', { timeout: 15000 });
  check(
    `${username}: diminta memilih username setelah masuk`,
    (await display(page, '#onboarding')) === 'grid'
  );

  await page.focus('#username-input');
  // Empty the pre-filled suggestion through the real `input` path rather than
  // editing it in place — a stray character left behind would silently change
  // the name under test.
  await page.$eval('#username-input', (field) => {
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type('#username-input', username);
  const typed = await page.$eval('#username-input', (field) => field.value);
  check(`${username}: nama yang diketik masuk apa adanya`, typed === username, typed);
  await page.waitForFunction(
    (name) => {
      const note = document.querySelector('#username-status');
      const button = document.querySelector('#username-submit');
      // The button is only unlocked by a fresh answer for the current value, so
      // waiting on it too rules out reading a stale "available" note.
      return (
        note?.classList.contains('good') &&
        note.textContent.includes(`@${name}`) &&
        Boolean(button) && button.disabled === false
      );
    },
    { timeout: 10000 },
    username
  );
  check(`${username}: server bilang nama itu masih kosong`, true);

  await page.click('#username-submit');
  await page.waitForSelector('#onboarding[hidden]', { timeout: 15000 });
  await page.waitForFunction(
    (name) => document.querySelector('#me-name')?.textContent === name,
    { timeout: 10000 },
    username
  );
  check(`${username}: username langsung jadi identitas di sidebar`, true);
  const avatarHue = await page.$eval('#me-avatar', (el) => el.style.getPropertyValue('--hue'));
  check(`${username}: warna avatar diturunkan dari namanya`, avatarHue !== '', `--hue="${avatarHue}"`);

  check(`${username}: layar login hilang setelah masuk`, (await display(page, '#login')) === 'none');
  check(`${username}: aplikasi benar-benar tampil`, (await display(page, '#app')) === 'grid');
  check(`${username}: overlay modal tidak menutupi layar`, (await display(page, '#modal')) === 'none');
  check(
    `${username}: overlay panggilan nggak muncul sendiri`,
    (await display(page, '#call-overlay')) === 'none'
  );
  check(`${username}: tombol log keluar terlihat`, (await display(page, '#btn-logout')) !== 'none');
  check(`${username}: layar sambutan tampil sebelum ada chat`, (await display(page, '#empty-state')) !== 'none');
  check(
    `${username}: fitur utama dijelaskan di layar sambutan`,
    (await page.$$eval('#empty-state .chip', (nodes) => nodes.length)) === 3
  );

  // Tampilan tidak bisa dinilai dari satu nilai, tapi tata letak yang rusak
  // selalu kelihatan dari ukuran nol dan halaman yang meluber ke samping.
  const layout = await page.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { w: Math.round(rect.width), h: Math.round(rect.height) };
    };
    return {
      chatList: box('#chat-list'),
      statusPanel: box('.status-panel'),
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    };
  });
  check(
    `${username}: panel sidebar benar-benar punya ukuran`,
    [layout.chatList, layout.statusPanel].every((rect) => rect && rect.w > 0 && rect.h > 0),
    JSON.stringify(layout)
  );
  check(`${username}: halaman nggak meluber ke samping`, layout.overflowX <= 1, `overflow ${layout.overflowX}px`);
  check(
    `${username}: warna aksen mengikuti palet logo`,
    layout.accent === '#38c6ff',
    layout.accent
  );

  return { context, page };
}

/**
 * The other half of the rule: a name somebody already holds must be refused in
 * the UI, not just on the server.
 */
async function expectUsernameRefused(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login:not([hidden])', { timeout: 15000 });
  await page.type('#login-username', 'penyusup');
  await page.click('#login-submit');
  await page.waitForSelector('#onboarding:not([hidden])', { timeout: 15000 });

  await page.focus('#username-input');
  await page.$eval('#username-input', (field) => {
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Different case on purpose: 'andi' is taken, and so is 'ANDI'.
  await page.type('#username-input', 'ANDI');
  await page.waitForFunction(
    () => document.querySelector('#username-status')?.classList.contains('bad'),
    { timeout: 10000 }
  );

  const state = await page.evaluate(() => ({
    note: document.querySelector('#username-status').textContent,
    disabled: document.querySelector('#username-submit').disabled,
  }));
  check('username yang sudah dipakai ditolak di layar', /sudah dipakai/.test(state.note), state.note);
  check('tombol simpan terkunci selama namanya sudah dipakai', state.disabled === true);

  await context.close();
}

/** A valid, deterministic SVG so the attachment renders inline (no download plumbing). */
function writeSampleImage() {
  const rects = Array.from(
    { length: 1500 },
    (_, i) => `<rect x="${i % 200}" y="${(i / 200) | 0}" width="1" height="1" fill="#a884${i % 9}"/>`
  ).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">${rects}</svg>`;
  const file = path.join(TMP, 'rahasia-desain.svg');
  fs.writeFileSync(file, svg);
  return {
    file,
    name: path.basename(file),
    sha256: crypto.createHash('sha256').update(svg).digest('hex'),
    bytes: Buffer.byteLength(svg),
  };
}

/**
 * Buka halaman tambah kontak, cari satu orang, dan kembalikan hasil teratasnya.
 * Ini jalur yang sekarang dipakai setiap percakapan baru, jadi dipakai berkali-kali.
 */
async function findContact(page, query) {
  await page.click('#btn-new-chat');
  await page.waitForSelector('#contact-page:not([hidden])', { timeout: 10000 });
  await page.$eval('#contact-query', (field) => {
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type('#contact-query', query);
  await page.click('#contact-submit');
  await page.waitForSelector('#contact-results:not([hidden]) .contact-result', { timeout: 15000 });
  return page.$eval('.contact-result', (li) => ({
    uid: li.dataset.uid,
    text: li.textContent,
    avatar: li.querySelector('.avatar')?.style.backgroundImage || '',
  }));
}

/**
 * Foto profil dan status lewat jalur yang berbeda dari pesan: foto profil
 * memang publik, status tetap terenkripsi. Keduanya diuji dari UI aslinya.
 *
 * @returns {string} teks status yang tadi dikirim, buat dicek di memori server
 */
async function checkPhotoAndStatus(andi, budi) {
  const png = path.join(TMP, 'foto-profil.png');
  fs.writeFileSync(
    png,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARAAH/wAB/9p9AAAAAElFTkSuQmCC',
      'base64'
    )
  );

  /* ---- Foto profil ---- */
  await andi.page.click('#btn-settings');
  await andi.page.waitForSelector('#settings-avatar', { timeout: 10000 });
  const avatarInput = await andi.page.$('#avatar-input');
  await avatarInput.uploadFile(png);
  await andi.page.waitForFunction(
    () => (document.querySelector('#settings-avatar')?.style.backgroundImage || '').includes('/api/avatar/'),
    { timeout: 15000 }
  );
  check('Foto profil terpasang dari Pengaturan', true);

  await andi.page.click('[data-close]');
  await andi.page.waitForSelector('#modal[hidden]', { timeout: 10000 });
  await andi.page.waitForFunction(
    () => (document.querySelector('#me-avatar')?.style.backgroundImage || '').includes('/api/avatar/'),
    { timeout: 10000 }
  );
  check('Avatar di sidebar memakai foto yang baru diunggah', true);

  // Kontak lain melihat foto yang sama saat mencari namanya, tanpa minta apa pun.
  const listed = await findContact(budi.page, 'andi');
  check(
    'Kontak lain melihat foto profil itu',
    listed.avatar.includes('/api/avatar/'),
    listed.avatar || '(tanpa foto)'
  );
  await budi.page.click('#contact-back');
  await budi.page.waitForSelector('#contact-page[hidden]', { timeout: 10000 });

  /* ---- Status ---- */
  const statusText = `status uji otomatis ${Date.now()}`;
  await andi.page.click('#status-me-add');
  await andi.page.waitForSelector('#status-text', { timeout: 10000 });
  await andi.page.type('#status-text', statusText);
  await andi.page.click('.modal-card [data-publish]');
  await andi.page.waitForFunction(
    (text) => document.querySelector('#status-stage .status-text')?.textContent.includes(text),
    { timeout: 15000 },
    statusText
  );
  check('Status sendiri langsung tampil penuh layar', true);
  await andi.page.click('#status-viewer-close');
  await andi.page.waitForSelector('#status-viewer[hidden]', { timeout: 10000 });

  await budi.page.waitForSelector('.status-item', { timeout: 15000 });
  const ringed = await budi.page.$eval('.status-item .avatar', (node) => node.classList.contains('ring'));
  check('Status yang belum dibuka ditandai cincin', ringed === true);

  await budi.page.click('.status-item');
  await budi.page.waitForFunction(
    (text) => document.querySelector('#status-stage .status-text')?.textContent.includes(text),
    { timeout: 15000 },
    statusText
  );
  check('Budi membaca isi status terenkripsi itu', true);
  await budi.page.click('#status-viewer-close');
  await budi.page.waitForSelector('#status-viewer[hidden]', { timeout: 10000 });
  await budi.page.waitForFunction(
    () => document.querySelector('.status-item')?.textContent.includes('Sudah dilihat'),
    { timeout: 10000 }
  );
  check('Sesudah dibaca, status ditandai sudah dilihat', true);

  /* ---- Status foto: jalur lampiran terenkripsi lewat status ---- */
  await andi.page.click('#status-me-add');
  await andi.page.waitForSelector('#status-photo', { timeout: 10000 });
  const statusPhoto = await andi.page.$('#status-photo');
  await statusPhoto.uploadFile(png);
  await andi.page.click('.modal-card [data-publish]');
  await andi.page.waitForFunction(
    () => Boolean(document.querySelector('#status-stage .status-image')),
    { timeout: 20000 }
  );
  check('Status foto sendiri tampil', true);
  await andi.page.click('#status-viewer-close');
  await andi.page.waitForSelector('#status-viewer[hidden]', { timeout: 10000 });

  // Budi membuka lagi: yang pertama sudah dilihat, jadi pembukanya seharusnya
  // langsung ke status foto. Kalau ternyata mulai dari awal, maju satu langkah.
  const photoShown = () =>
    budi.page.waitForFunction(
      () => (document.querySelector('#status-stage .status-image')?.naturalWidth || 0) > 0,
      { timeout: 8000 }
    );

  await budi.page.waitForSelector('.status-item', { timeout: 15000 });
  await budi.page.click('.status-item');
  const straightToPhoto = await photoShown().then(
    () => true,
    () => false
  );
  if (!straightToPhoto) {
    await budi.page.click('#status-next');
    await photoShown();
  }
  check('Status foto sampai ke Budi dan berhasil didekripsi', true);
  await budi.page.click('#status-viewer-close');
  await budi.page.waitForSelector('#status-viewer[hidden]', { timeout: 10000 });

  return statusText;
}

/**
 * Laporan + halaman admin, lewat jalur yang benar-benar dipakai orang:
 * Andi melaporkan Budi dari header chat, halaman admin membaca laporannya,
 * lalu memblokir dan membuka blokir lagi — dan sisi Budi ikut diperiksa.
 */
async function checkReportAndAdmin(andi, budi) {
  /* ---- Laporkan dari header chat ---- */
  await andi.page.waitForSelector('#chat-view:not([hidden])');
  check('Tombol lapor ada di chat pribadi', (await andi.page.$eval('#btn-report', (e) => !e.hidden)) === true);

  await andi.page.click('#btn-report');
  await andi.page.waitForSelector('#report-reason', { timeout: 10000 });
  const reasonCount = await andi.page.$$eval('#report-reason option', (nodes) => nodes.length);
  check('Alasan laporan datang dari server', reasonCount >= 4, `${reasonCount} pilihan`);

  await andi.page.select('#report-reason', 'spam');
  await andi.page.type('#report-detail', 'kirim iklan terus');
  await andi.page.click('.modal-card [data-send]');
  await andi.page.waitForFunction(() => document.querySelector('#modal')?.hidden === true, { timeout: 15000 });
  check('Laporan bisa dikirim dari layar', true);

  const stored = moderation
    .reports()
    .find((report) => report.from === devUid('andi') && report.about === devUid('budi'));
  check(
    'Server menyimpan laporan itu beserta alasannya',
    Boolean(stored) && stored.reason === 'spam' && stored.detail === 'kirim iklan terus',
    JSON.stringify(stored)
  );
  check(
    'Isi chat tidak ikut ke dalam laporan',
    !JSON.stringify(stored).includes('rahasia dari andi'),
    JSON.stringify(stored)
  );

  /* ---- Halaman admin ---- */
  // Akun biasa ditolak oleh servernya, bukan cuma disembunyikan tautannya.
  const intruder = await budi.context.newPage();
  await intruder.goto(`${BASE_URL}/admin.html`, { waitUntil: 'domcontentloaded' });
  await intruder.waitForSelector('#denied:not([hidden])', { timeout: 15000 });
  const deniedText = await intruder.$eval('#denied-detail', (node) => node.textContent);
  check('Akun bukan admin ditolak halaman admin', /bukan admin/i.test(deniedText), deniedText);
  await intruder.close();

  check(
    'Tautan admin cuma muncul untuk yang punya aksesnya',
    (await andi.page.$eval('#btn-admin', (node) => !node.hidden)) === true &&
      (await budi.page.$eval('#btn-admin', (node) => node.hidden)) === true
  );

  // Sesi chat Andi dipakai ulang di halaman admin, jadi nggak ada login kedua.
  const adminPage = await andi.context.newPage();
  adminPage.on('pageerror', (err) => CONSOLE_LOG.push(`admin pageerror: ${err.message}`));
  await adminPage.goto(`${BASE_URL}/admin.html`, { waitUntil: 'domcontentloaded' });
  await adminPage.waitForSelector('#admin:not([hidden])', { timeout: 15000 });
  check('Halaman admin terbuka untuk akun admin', (await display(adminPage, '#admin')) !== 'none');
  check('Tidak ada form login kedua di halaman admin', (await display(adminPage, '#login')) === 'none');

  await adminPage.waitForFunction(
    () => document.querySelector('#tab-reports')?.textContent.trim() === 'Laporan 1',
    { timeout: 15000 }
  );
  const panelText = await adminPage.$eval('#admin-panel', (node) => node.textContent);
  check('Laporan terlihat di halaman admin', /spam/i.test(panelText), panelText.slice(0, 120));
  const stats = await adminPage.$$eval('.admin-stat strong', (nodes) => nodes.map((node) => node.textContent));
  check('Statistik admin menghitung laporan terbuka', stats[0] === '1', JSON.stringify(stats));

  // Blokir Budi dari daftar pengguna.
  await adminPage.click('.admin-tab[data-tab="users"]');
  await adminPage.waitForSelector('#admin-search', { timeout: 10000 });
  await adminPage.type('#admin-search', 'budi');
  await adminPage.waitForFunction(
    () => [...document.querySelectorAll('[data-user] strong')].some((node) => node.textContent.includes('budi')),
    { timeout: 10000 }
  );
  await adminPage.evaluate(() => {
    const card = [...document.querySelectorAll('[data-user]')].find((node) => node.textContent.includes('budi'));
    card.querySelector('[data-act="ban"]').click();
  });
  await adminPage.waitForSelector('#ban-reason', { timeout: 10000 });
  await adminPage.type('#ban-reason', 'uji otomatis');
  await adminPage.click('.modal-card [data-ok]');
  await adminPage.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('diblokir'), {
    timeout: 15000,
  });
  check('Admin bisa memblokir akun dari halaman admin', true);

  // Sisi Budi: sesi yang sedang jalan langsung berhenti, dengan alasannya.
  await budi.page.waitForSelector('#banned:not([hidden])', { timeout: 15000 });
  const bannedReason = await budi.page.$eval('#banned-reason', (node) => node.textContent);
  check('Akun yang diblokir melihat alasan dari admin', bannedReason.includes('uji otomatis'), bannedReason);
  check('Aplikasi chat disembunyikan setelah diblokir', (await display(budi.page, '#app')) === 'none');

  // Buka blokir lagi, dan Budi bisa kembali dengan username yang sama.
  await adminPage.click('.admin-tab[data-tab="bans"]');
  await adminPage.waitForSelector('[data-act="unban"]', { timeout: 10000 });
  await adminPage.click('[data-act="unban"]');
  await adminPage.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('dibuka'), {
    timeout: 15000,
  });
  check('Admin bisa membuka blokir', true);

  await budi.page.reload({ waitUntil: 'domcontentloaded' });
  await budi.page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
  await budi.page.waitForFunction(() => document.querySelector('#me-name')?.textContent === 'budi', {
    timeout: 15000,
  });
  check('Setelah blokirnya dibuka, akunnya jalan lagi seperti semula', true);

  await adminPage.close();
}

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Fake camera + mic, and auto-grant the permission prompt.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-usermedia-screen-capturing',
    '--auto-select-desktop-capture-source=Entire screen',
  ],
});

const activeClients = {};
try {
  const andi = await login(browser, 'andi');
  activeClients.andi = andi;
  const budi = await login(browser, 'budi');
  activeClients.budi = budi;
  await expectUsernameRefused(browser);
  const statusText = await checkPhotoAndStatus(andi, budi);

  /* ---- 1. Mencari kontak sebelum bisa chat ---------------------- */
  await andi.page.click('#btn-new-chat');
  await andi.page.waitForSelector('#contact-page:not([hidden])');
  check('Tombol ＋ membuka halaman tambah kontak', (await display(andi.page, '#contact-page')) === 'grid');
  check('Daftar orang nggak langsung bermunculan', (await display(andi.page, '#contact-results')) === 'none');
  check(
    'Halaman tambah kontak bukan modal yang menutupi layar',
    (await display(andi.page, '#modal')) === 'none'
  );
  check(
    'Sidebar tetap punya ukuran selama halaman itu terbuka',
    await andi.page.$eval('#chat-list, .sidebar', (node) => node.getBoundingClientRect().width > 0)
  );

  // Kueri yang terlalu pendek ditahan sebelum menyentuh server.
  await andi.page.type('#contact-query', 'bu');
  await andi.page.click('#contact-submit');
  await andi.page.waitForFunction(
    () => document.querySelector('#contact-note')?.classList.contains('bad'),
    { timeout: 10000 }
  );
  const shortNote = await andi.page.$eval('#contact-note', (node) => node.textContent);
  check('Pencarian ditolak kalau kurang dari 3 karakter', /3 karakter/i.test(shortNote), shortNote);

  await andi.page.$eval('#contact-query', (field) => {
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await andi.page.type('#contact-query', 'budi');
  await andi.page.click('#contact-submit');
  await andi.page.waitForSelector('#contact-results:not([hidden]) .contact-result', { timeout: 15000 });
  const foundBudi = await andi.page.$eval('.contact-result', (li) => li.textContent);
  check('Andi menemukan Budi lewat username', /budi/i.test(foundBudi), foundBudi);
  check('Hasil pencarian bilang alasannya ketemu', /ditemukan lewat username/i.test(foundBudi), foundBudi);

  await andi.page.click('.contact-result');
  await andi.page.waitForSelector('#contact-page[hidden]', { timeout: 10000 });
  await andi.page.waitForSelector('#chat-view:not([hidden])');
  check('Chat baru terbuka setelah kontaknya ditemukan', true);
  check('Panel chat terlihat', (await display(andi.page, '#chat-view')) === 'flex');
  const composerBox = await andi.page.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { w: Math.round(rect.width), h: Math.round(rect.height) };
    };
    return { input: box('#composer-input'), send: box('.send'), attach: box('#btn-attach') };
  });
  check(
    'Komposer dan tombol kirim benar-benar bisa dipakai (bukan ukuran nol)',
    [composerBox.input, composerBox.send, composerBox.attach].every(
      (rect) => rect && rect.w > 0 && rect.h > 0
    ),
    JSON.stringify(composerBox)
  );
  check('Layar sambutan hilang saat chat dibuka', (await display(andi.page, '#empty-state')) === 'none');
  check('Tombol telpon muncul di chat pribadi', (await andi.page.$eval('#btn-call-audio', (e) => !e.hidden)) === true);
  check(
    'Ikon tombol dirender sebagai SVG, bukan emoji',
    await andi.page.$eval('#btn-call-audio, .send, #btn-attach', (node) => node.querySelector('svg') !== null)
  );

  /* ---- 2. Text message ------------------------------------------ */
  const andiMessage = 'halo budi 👋 ini rahasia dari andi';
  await andi.page.type('#composer-input', andiMessage);
  await andi.page.click('.send');
  await andi.page.waitForFunction(
    (t) => [...document.querySelectorAll('.msg')].some((m) => m.textContent.includes(t)),
    { timeout: 10000 },
    andiMessage
  );
  check('Pesan Andi tampil di layar Andi sendiri', true);

  await budi.page.waitForSelector('.chat-item', { timeout: 10000 });
  const badge = await budi.page.$eval('.chat-item .badge', (el) => el.textContent).catch(() => null);
  check('Budi melihat badge belum dibaca', badge === '1', `badge=${badge}`);

  await budi.page.click('.chat-item');
  await budi.page.waitForSelector('#chat-view:not([hidden])');
  await budi.page.waitForFunction(
    (t) => [...document.querySelectorAll('.msg')].some((m) => m.textContent.includes(t)),
    { timeout: 10000 },
    andiMessage
  );
  const budiSaw = await budi.page.$eval('.msg', (el) => el.textContent);
  check('Budi membaca pesan terenkripsi dengan benar', budiSaw.includes(andiMessage), budiSaw);

  /* ---- 3. Encrypted attachment ---------------------------------- */
  const sample = writeSampleImage();
  // Status foto juga menaruh blob di folder yang sama, jadi yang dihitung di
  // sini adalah blob yang benar-benar muncul akibat kiriman ini.
  const blobsBefore = new Set(listFiles(process.env.LOCAL_STORAGE_DIR));
  const fileInput = await andi.page.$('#file-input');
  await fileInput.uploadFile(sample.file);

  await andi.page.waitForFunction(() => document.querySelector('.msg.out .attach-media img')?.naturalWidth > 0, {
    timeout: 20000,
  });
  check('Andi mengirim lampiran terenkripsi', true);
  const ownPreview = await andi.page.$eval('.msg.out .attach-media img', (img) => ({
    src: img.src,
    width: img.naturalWidth,
  }));
  check(
    'Pengirimnya langsung melihat fotonya sendiri sebagai gambar di chat',
    ownPreview.src.startsWith('blob:') && ownPreview.width === 200,
    JSON.stringify(ownPreview)
  );

  await andi.page.click('.msg.out .attach-media');
  await andi.page.waitForSelector('#viewer:not([hidden]) .viewer-stage img', { timeout: 10000 });
  check('Mengklik foto sendiri membuka penampil selayar penuh', true);
  await andi.page.click('#viewer-close');
  await andi.page.waitForSelector('#viewer[hidden]', { timeout: 5000 });

  // Whatever landed on disk must be ciphertext under a meaningless name.
  const storedFiles = listFiles(process.env.LOCAL_STORAGE_DIR).filter((file) => !blobsBefore.has(file));
  check('Lampiran tersimpan sebagai tepat satu blob baru', storedFiles.length === 1, JSON.stringify(storedFiles));
  check(
    'Nama file asli nggak bocor ke penyimpanan',
    !storedFiles[0].includes('rahasia-desain'),
    storedFiles[0]
  );
  const ciphertextOnDisk = fs.readFileSync(storedFiles[0]);
  check(
    'Isi blob di disk benar-benar ciphertext',
    !ciphertextOnDisk.includes('<svg') && !ciphertextOnDisk.includes('a884') && ciphertextOnDisk.length > sample.bytes,
    `blob ${ciphertextOnDisk.length} byte vs asli ${sample.bytes}`
  );

  await budi.page.waitForFunction(
    (name) => [...document.querySelectorAll('.msg .attach-name')].some((n) => n.textContent.includes(name)),
    { timeout: 20000 },
    sample.name
  );
  check('Lampiran sampai ke Budi', true);

  /* Klik pada lampiran = buka selayar penuh. Bukan unduh, dan bukan tab baru
     berisi blob: yang cuma jadi halaman kosong. */
  await clickAt(budi.page, '.msg .attach');
  await budi.page.waitForSelector('#viewer:not([hidden]) .viewer-stage img', { timeout: 30000 });
  check('Klik foto membuka penampil selayar penuh, bukan mengunduh', true);

  const viewerShot = await budi.page.evaluate(() => {
    const viewer = document.querySelector('#viewer');
    const img = document.querySelector('#viewer-stage img');
    const rect = viewer.getBoundingClientRect();
    return {
      fullscreen: rect.width >= window.innerWidth - 1 && rect.height >= window.innerHeight - 1,
      blob: img.src.startsWith('blob:'),
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
  });
  check('Penampilnya benar-benar menutupi seluruh layar', viewerShot.fullscreen, JSON.stringify(viewerShot));
  check('Fotonya ditampilkan sebagai blob lokal, bukan tautan server', viewerShot.blob === true);
  check(
    'Dimensi fotonya utuh setelah didekripsi',
    viewerShot.width === 200 && viewerShot.height === 200,
    JSON.stringify(viewerShot)
  );

  // Ketukan di fotonya sendiri tidak boleh melempar ke halaman blob:.
  const urlBefore = budi.page.url();
  await budi.page.click('#viewer-stage img');
  await sleep(200);
  check('Ketuk foto di dalam penampil tidak membuka halaman blob', budi.page.url() === urlBefore, budi.page.url());
  check('Penampilnya tetap terbuka setelah fotonya diketuk', (await display(budi.page, '#viewer')) !== 'none');
  const pages = await budi.context.pages();
  check('Tidak ada tab baru yang terbuka karenanya', pages.length === 1, `${pages.length} halaman`);

  const decrypted = await budi.page.evaluate(async () => {
    const img = document.querySelector('#viewer-stage img');
    const bytes = await fetch(img.src).then((r) => r.arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return {
      sha: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      size: bytes.byteLength,
    };
  });
  check('Budi mendekripsi lampiran secara utuh', decrypted.size === sample.bytes, JSON.stringify(decrypted));
  check(
    'Byte hasil dekripsi identik dengan file aslinya',
    decrypted.sha === sample.sha256,
    `${decrypted.sha} != ${sample.sha256}`
  );

  await budi.page.click('#viewer-close');
  await budi.page.waitForSelector('#viewer[hidden]', { timeout: 5000 });
  await budi.page.waitForSelector('.msg .attach-media img', { timeout: 10000 });
  check('Setelah dibuka sekali, fotonya tampil sebagai thumbnail di chat', true);

  await clickAt(budi.page, '.msg .attach-media');
  await budi.page.waitForSelector('#viewer:not([hidden]) .viewer-stage img', { timeout: 10000 });
  check('Klik thumbnail yang sudah terbuka juga membuka penampil lagi', true);
  await budi.page.click('#viewer-close');
  await budi.page.waitForSelector('#viewer[hidden]', { timeout: 5000 });

  /* ---- 3b. Video: diputar di penampil, bukan diunduh ---------------
     Videonya dibuat di browser ini juga (canvas + MediaRecorder), jadi yang
     diuji benar-benar file video, bukan byte acak berlabel video. */
  // Halaman yang tidak sedang tampil tidak menghasilkan frame canvas, jadi Andi
  // harus jadi tab aktif dulu sebelum merekam.
  await andi.page.bringToFront();
  const videoBase64 = await andi.page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    // VP8 eksplisit + requestData(): tanpa keduanya, encoder di Chrome headless
    // kadang cuma menghasilkan header kosong.
    const recorder = new MediaRecorder(canvas.captureStream(25), { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start(1000);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = i % 2 ? '#38c6ff' : '#1f4bff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
    }
    recorder.requestData();
    recorder.stop();
    await stopped;
    canvas.remove();
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  check('Video contoh benar-benar terbentuk', videoBase64.length > 2000, `${videoBase64.length} byte base64`);

  await andi.page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const file = new File([bytes], 'contoh-video.webm', { type: 'video/webm' });
    const input = document.querySelector('#file-input');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, videoBase64);

  await andi.page.waitForFunction(
    () => [...document.querySelectorAll('.msg.out .attach-video')].some((node) => node.querySelector('.attach-badge')),
    { timeout: 30000 }
  );
  check('Video terkirim sebagai kartu dengan tanda putar', true);

  await budi.page.waitForFunction(
    () => [...document.querySelectorAll('.msg .attach-video')].some((node) => node.querySelector('.attach-name')?.textContent.includes('contoh-video.webm')),
    { timeout: 30000 }
  );
  const videoUrlBefore = budi.page.url();
  await clickAt(budi.page, '.msg .attach-video');
  await budi.page.waitForSelector('#viewer:not([hidden]) .viewer-stage video', { timeout: 30000 });
  await budi.page.waitForFunction(() => document.querySelector('#viewer-stage video')?.readyState >= 1, {
    timeout: 15000,
  });

  const videoState = await budi.page.evaluate(() => {
    const video = document.querySelector('#viewer-stage video');
    const viewer = document.querySelector('#viewer').getBoundingClientRect();
    return {
      blob: video.src.startsWith('blob:'),
      controls: video.controls,
      width: video.videoWidth,
      fullscreen: viewer.width >= window.innerWidth - 1 && viewer.height >= window.innerHeight - 1,
      saveVisible: !document.querySelector('#viewer-save').hidden,
    };
  });
  check('Klik video membuka pemutarnya, bukan mengunduh file', true);
  check('Videonya benar-benar ter-dekode dan siap diputar', videoState.width > 0, JSON.stringify(videoState));
  check('Pemutarnya punya kontrol', videoState.controls === true, JSON.stringify(videoState));
  check('Sumbernya blob lokal (server tetap nggak lihat isinya)', videoState.blob === true);
  check('Pemutar video menutupi seluruh layar', videoState.fullscreen, JSON.stringify(videoState));
  check('Tombol simpan ke perangkat tetap tersedia di penampil', videoState.saveVisible === true);
  check('Membuka video tidak memindahkan halaman', budi.page.url() === videoUrlBefore, budi.page.url());
  check('Membuka video tidak membuka tab baru', (await budi.context.pages()).length === 1);

  await budi.page.click('#viewer-close');
  await budi.page.waitForSelector('#viewer[hidden]', { timeout: 5000 });

  /* ---- 3c. Pilihan pesan: klik kanan, tahan, balas, teruskan, hapus ---- */
  // Tahan di pesan (jalur layar sentuh) membuka baris reaksi + daftar pilihan.
  await openMenu(budi.page, '.msg:not(.out)', { longPress: true });
  const quickReactions = await budi.page.$$eval('#msg-menu-quick button', (nodes) =>
    nodes.map((node) => node.textContent)
  );
  check('Tahan di pesan membuka baris reaksi cepat', quickReactions.length >= 6, quickReactions.join(' '));

  const blurState = await budi.page.evaluate(() => {
    const messages = [...document.querySelectorAll('.msg')];
    const others = messages.filter((node) => !node.classList.contains('menu-target'));
    const target = document.querySelector('.msg.menu-target');
    return {
      others: others.length,
      othersBlurred: others.every((node) => getComputedStyle(node).filter !== 'none'),
      targetSharp: target ? getComputedStyle(target).filter === 'none' : false,
      sidebarBlurred: getComputedStyle(document.querySelector('.sidebar')).filter !== 'none',
    };
  });
  check('Ada pesan lain yang ikut diblur', blurState.others > 0, JSON.stringify(blurState));
  check('Pesan lain diblur saat pilihan terbuka', blurState.othersBlurred, JSON.stringify(blurState));
  check('Pesan yang dipilih tetap tajam', blurState.targetSharp, JSON.stringify(blurState));
  check('Sidebar dan kolom chat ikut diblur', blurState.sidebarBlurred, JSON.stringify(blurState));

  const othersActions = await menuActions(budi.page);
  check(
    'Pesan orang lain menawarkan Balas, Teruskan, Salin, Bintang, Laporkan, Hapus untuk saya',
    ['reply', 'forward', 'copy', 'star', 'report', 'delete-me'].every((id) => othersActions.includes(id)),
    othersActions.join(' ')
  );
  check(
    'Pesan orang lain tidak menawarkan Hapus untuk semua orang',
    !othersActions.includes('delete-all'),
    othersActions.join(' ')
  );

  await budi.page.keyboard.press('Escape');
  await budi.page.waitForSelector('#msg-menu[hidden]', { timeout: 5000 });
  check(
    'Escape menutup pilihan dan tampilan kembali normal',
    await budi.page.$eval('body', (node) => !node.classList.contains('menu-open'))
  );

  // Setiap tombol di daftar harus benar-benar mengerjakan sesuatu. Laporkan
  // membuka form laporan untuk orang yang mengirim pesan itu.
  await openMenu(budi.page, await bubbleWith(budi.page, 'rahasia dari andi'));
  await pickMenuAction(budi.page, 'report');
  await budi.page.waitForSelector('#modal:not([hidden]) #report-reason', { timeout: 5000 });
  const reportTitle = await budi.page.$eval('.modal-card h3', (node) => node.textContent);
  check('Laporkan dari menu membuka form laporan untuk pengirimnya', /andi/i.test(reportTitle), reportTitle);
  await budi.page.click('.modal-card [data-close]');
  await budi.page.waitForSelector('#modal[hidden]', { timeout: 5000 });

  await openMenu(andi.page, '.msg.out');
  const ownActions = await menuActions(andi.page);
  check('Pesan sendiri menawarkan Hapus untuk semua orang', ownActions.includes('delete-all'), ownActions.join(' '));
  check('Pesan sendiri tidak menawarkan Laporkan', !ownActions.includes('report'), ownActions.join(' '));

  /* ---- Balas ---- */
  await pickMenuAction(andi.page, 'reply');
  await andi.page.waitForSelector('#reply-strip:not([hidden])', { timeout: 5000 });
  const strip = await andi.page.evaluate(() => ({
    name: document.querySelector('#reply-strip-name').textContent,
    preview: document.querySelector('#reply-strip-preview').textContent,
  }));
  check('Balas menampilkan kutipan pesan yang dibalas', strip.preview.includes('rahasia dari andi'), JSON.stringify(strip));
  check('Kutipan menyebut pengirimnya', strip.name === 'Kamu', strip.name);

  const replyText = 'balasan andi yang terenkripsi';
  await andi.page.type('#composer-input', replyText);
  await andi.page.click('.send');
  await andi.page.waitForFunction(
    (text) => [...document.querySelectorAll('.msg.out')].some((node) => node.textContent.includes(text)),
    { timeout: 10000 },
    replyText
  );
  check('Strip balasan hilang lagi setelah pesannya terkirim', await andi.page.$eval('#reply-strip', (node) => node.hidden));

  await budi.page.waitForFunction(
    (text) =>
      [...document.querySelectorAll('.msg')].some(
        (node) => node.querySelector('.msg-quote-text') && node.textContent.includes(text)
      ),
    { timeout: 15000 },
    replyText
  );
  const quoted = await budi.page.evaluate(() => {
    const node = [...document.querySelectorAll('.msg')].find((entry) => entry.querySelector('.msg-quote'));
    return {
      name: node.querySelector('.msg-quote-name').textContent,
      text: node.querySelector('.msg-quote-text').textContent,
    };
  });
  check('Budi melihat balasannya lengkap dengan kutipan', quoted.text.includes('rahasia dari andi'), JSON.stringify(quoted));
  check('Kutipannya menyebut nama pengirim aslinya', quoted.name === 'andi', quoted.name);

  // Kutipannya harus benar-benar bisa diketuk: tidak tertutup kolom ketik atau
  // elemen lain yang menempel di atasnya.
  const quoteHit = await budi.page.evaluate(() => {
    const quote = document.querySelector('.msg-quote');
    if (!quote) return { count: 0 };
    const rect = quote.getBoundingClientRect();
    const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    const top = document.elementFromPoint(point.x, point.y);
    return { count: document.querySelectorAll('.msg-quote').length, inQuote: Boolean(top && quote.contains(top)), top: top?.className || top?.tagName };
  });
  check('Kutipan balasan bisa diketuk (nggak ketutup apa pun)', quoteHit.inQuote === true, JSON.stringify(quoteHit));

  // Ketukan asli di titik tengah kutipan sudah dipastikan mengenai kutipannya
  // oleh pemeriksaan geometri di atas. Yang diuji di sini perilakunya: mengetuk
  // kutipan membawa pesan aslinya ke tengah dan menyorotnya.
  const jumped = await budi.page.evaluate(async () => {
    const quote = document.querySelector('.msg-quote');
    quote.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const flashed = document.querySelector('.msg.flash');
    return {
      flashed: flashed ? flashed.textContent : null,
      flashedIsTheReplyBubble: flashed ? Boolean(flashed.querySelector('.msg-quote')) : null,
    };
  });
  check(
    'Ketuk kutipan menyorot pesan aslinya',
    Boolean(jumped.flashed) && jumped.flashed.includes('rahasia dari andi'),
    JSON.stringify(jumped)
  );
  check('Yang disorot bukan gelembung balasannya sendiri', jumped.flashedIsTheReplyBubble === false, JSON.stringify(jumped));

  /* ---- Salin ----
     Clipboard OS tidak bisa dibaca dari Chrome headless di sini (izinnya
     ditolak), jadi yang diperiksa adalah teks yang benar-benar diserahkan ke
     clipboard API — dan bahwa jalan terakhirnya tetap dipakai kalau API itu
     menolak. */
  await andi.page.bringToFront();
  await andi.page.evaluate(() => {
    window.__copied = null;
    Clipboard.prototype.writeText = function (text) {
      window.__copied = text;
      return Promise.resolve();
    };
  });

  await openMenu(andi.page, await bubbleWith(andi.page, 'rahasia dari andi'));
  await pickMenuAction(andi.page, 'copy');
  const copyState = await andi.page.evaluate(() => ({
    copied: window.__copied,
    toast: document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent,
  }));
  check('Salin menyerahkan teks pesannya ke clipboard', copyState.copied === andiMessage, JSON.stringify(copyState));
  check('Salin memberi kabar ke pengguna', /disalin/i.test(copyState.toast), copyState.toast);

  // Clipboard API ditolak (misalnya di server tanpa HTTPS): harus tetap jalan.
  await andi.page.evaluate(() => {
    Clipboard.prototype.writeText = () => Promise.reject(new Error('write permission denied'));
    window.__execCopy = 0;
    const original = document.execCommand.bind(document);
    document.execCommand = (command) => {
      window.__execCopy += 1;
      return original(command);
    };
  });
  await openMenu(andi.page, await bubbleWith(andi.page, 'rahasia dari andi'));
  await pickMenuAction(andi.page, 'copy');
  await sleep(150);
  const fallback = await andi.page.evaluate(() => ({
    calls: window.__execCopy,
    toast: document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent,
  }));
  check('Kalau Clipboard API ditolak, salinan tetap jalan', fallback.calls === 1, JSON.stringify(fallback));
  check('Pengguna tetap dikabari pesannya disalin', /disalin/i.test(fallback.toast), fallback.toast);

  /* ---- Beri bintang ---- */
  await openMenu(andi.page, await bubbleWith(andi.page, 'rahasia dari andi'));
  await pickMenuAction(andi.page, 'star');
  await andi.page.waitForFunction(
    (text) =>
      [...document.querySelectorAll('.msg.out')].some(
        (node) => node.textContent.includes(text) && node.querySelector('.msg-meta .star')
      ),
    { timeout: 5000 },
    'rahasia dari andi'
  );
  check('Beri bintang menandai pesannya', true);

  await openMenu(andi.page, await bubbleWith(andi.page, 'rahasia dari andi'));
  const starredActions = await andi.page.evaluate(
    () => document.querySelector('#msg-menu-list .msg-menu-item[data-action="star"] span').textContent
  );
  check('Pilihannya berubah jadi Lepas bintang', /lepas bintang/i.test(starredActions), starredActions);
  await andi.page.keyboard.press('Escape');
  await andi.page.waitForSelector('#msg-menu[hidden]', { timeout: 5000 });

  /* ---- Teruskan ---- */
  await openMenu(andi.page, await bubbleWith(andi.page, 'rahasia dari andi'));
  await pickMenuAction(andi.page, 'forward');
  await andi.page.waitForSelector('#modal:not([hidden]) .forward-target', { timeout: 5000 });
  await clickAt(andi.page, '.forward-target');
  await andi.page.waitForSelector('#modal[hidden]', { timeout: 5000 });
  await andi.page.waitForFunction(
    () => [...document.querySelectorAll('.msg.forwarded, .msg')].some((node) => node.querySelector('.msg-forwarded')),
    { timeout: 10000 }
  );
  check('Teruskan mengirim ulang pesannya ke chat tujuan', true);
  await budi.page.waitForFunction(
    () => [...document.querySelectorAll('.msg')].some((node) => node.querySelector('.msg-forwarded')),
    { timeout: 15000 }
  );
  const forwarded = await budi.page.evaluate(() => {
    const node = [...document.querySelectorAll('.msg')].find((entry) => entry.querySelector('.msg-forwarded'));
    return node.textContent;
  });
  check('Budi menerima pesan yang diteruskan beserta isinya', forwarded.includes('rahasia dari andi'), forwarded);

  /* ---- Reaksi cepat ---- */
  await openMenu(budi.page, await bubbleWith(budi.page, 'rahasia dari andi'));
  await clickAt(budi.page, '#msg-menu-quick button[data-reaction="👍"]');
  await budi.page.waitForSelector('.msg .msg-reaction', { timeout: 5000 });
  const reaction = await budi.page.$eval('.msg .msg-reaction', (node) => ({
    emoji: node.dataset.emoji,
    mine: node.classList.contains('mine'),
  }));
  check('Reaksi cepat menempel di pesannya', reaction.emoji === '👍', JSON.stringify(reaction));
  check('Reaksi sendiri ditandai', reaction.mine === true, JSON.stringify(reaction));
  await andi.page.waitForFunction(
    () => [...document.querySelectorAll('.msg .msg-reaction')].some((node) => node.dataset.emoji === '👍'),
    { timeout: 15000 }
  );
  check('Reaksinya sampai ke perangkat Andi juga', true);

  /* ---- Hapus untuk saya ---- */
  const doomedForMe = 'pesan yang cuma aku hapus';
  await andi.page.bringToFront();
  await andi.page.type('#composer-input', doomedForMe);
  await andi.page.click('.send');
  await budi.page.waitForFunction(
    (text) => [...document.querySelectorAll('.msg')].some((node) => node.textContent.includes(text)),
    { timeout: 15000 },
    doomedForMe
  );
  await openMenu(andi.page, await bubbleWith(andi.page, doomedForMe));
  await pickMenuAction(andi.page, 'delete-me');
  await andi.page.waitForFunction(
    (text) => ![...document.querySelectorAll('.msg')].some((node) => node.textContent.includes(text)),
    { timeout: 5000 },
    doomedForMe
  );
  check('Hapus untuk saya menghilangkan pesannya di perangkat itu saja', true);
  const stillOnBudi = await budi.page.$$eval('.msg', (nodes) =>
    nodes.some((node) => node.textContent.includes('cuma aku hapus'))
  );
  check('Hapus untuk saya tidak menyentuh perangkat orang lain', stillOnBudi === true);

  /* ---- Hapus untuk semua orang ---- */
  const doomedForAll = 'pesan yang dihapus buat semua orang';
  await andi.page.type('#composer-input', doomedForAll);
  await andi.page.click('.send');
  await budi.page.waitForFunction(
    (text) => [...document.querySelectorAll('.msg')].some((node) => node.textContent.includes(text)),
    { timeout: 15000 },
    doomedForAll
  );
  await openMenu(andi.page, await bubbleWith(andi.page, doomedForAll));
  await pickMenuAction(andi.page, 'delete-all');
  await budi.page.waitForFunction(() => [...document.querySelectorAll('.msg.deleted')].length > 0, { timeout: 15000 });
  const tombstone = await budi.page.evaluate(() => {
    const node = [...document.querySelectorAll('.msg.deleted')].at(-1);
    return node.textContent;
  });
  check('Budi melihat pesannya berubah jadi "sudah dihapus"', /sudah dihapus/i.test(tombstone), tombstone);
  check('Isi pesan yang dihapus benar-benar hilang dari layar Budi', !tombstone.includes('buat semua orang'), tombstone);
  await andi.page.waitForFunction(() => [...document.querySelectorAll('.msg.deleted')].length > 0, { timeout: 5000 });
  check('Di layar Andi pesan itu juga berubah jadi "sudah dihapus"', true);

  /* ---- 4. Real WebRTC call -------------------------------------- */
  await andi.page.click('#btn-call-audio');
  await budi.page.waitForSelector('#incoming:not([hidden])', { timeout: 15000 });
  const incomingName = await budi.page.$eval('#incoming-name', (e) => e.textContent);
  check('Budi menerima notifikasi panggilan masuk', incomingName === 'andi', incomingName);

  await budi.page.click('#btn-accept');

  await Promise.all([
    andi.page.waitForFunction(() => document.querySelector('#call-placeholder')?.hidden === true, {
      timeout: 30000,
    }),
    budi.page.waitForFunction(() => document.querySelector('#call-placeholder')?.hidden === true, {
      timeout: 30000,
    }),
  ]);
  check('Panggilan tersambung dan media mengalir kedua arah', true);

  const readCall = (page) =>
    page.evaluate(() => {
      const remote = document.querySelector('#remote-video').srcObject;
      const local = document.querySelector('#local-video').srcObject;
      return {
        remoteTracks: remote ? remote.getTracks().map((t) => t.kind) : [],
        localTracks: local ? local.getTracks().map((t) => t.kind) : [],
        overlayVisible: getComputedStyle(document.querySelector('#call-overlay')).display !== 'none',
        peerLabel: document.querySelector('#call-name').textContent,
        remoteVideoWidth: document.querySelector('#remote-video').videoWidth,
        remoteLive: remote ? remote.getTracks().some((t) => t.readyState === 'live') : false,
      };
    });

  const andiCall = await readCall(andi.page);
  const budiCall = await readCall(budi.page);
  check('Overlay panggilan tampil di kedua sisi', andiCall.overlayVisible && budiCall.overlayVisible);
  check('Nama lawan bicara benar', andiCall.peerLabel === 'budi' && budiCall.peerLabel === 'andi');
  check('Mikrofon lokal mengalir', andiCall.localTracks.includes('audio'), JSON.stringify(andiCall.localTracks));
  check(
    'Audio dan video dari lawan bicara sampai ke kedua sisi',
    andiCall.remoteTracks.includes('audio') &&
      andiCall.remoteTracks.includes('video') &&
      budiCall.remoteTracks.includes('audio') &&
      budiCall.remoteTracks.includes('video'),
    JSON.stringify({ andi: andiCall.remoteTracks, budi: budiCall.remoteTracks })
  );
  check('Track yang diterima masih hidup', andiCall.remoteLive && budiCall.remoteLive);

  /* Keberadaan track belum berarti ada suara. Energi audionya diukur: mikrofon
     sendiri (yang dikirim) dan suara lawan bicara (yang keluar dari elemen
     pemutarnya). Kalau elemennya paused, orangnya memang tidak mendengar apa-apa. */
  const listen = (page) =>
    page.evaluate(async () => {
      const measure = async (stream) => {
        if (!stream?.getAudioTracks?.().length) return null;
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        let peak = 0;
        const deadline = performance.now() + 1500;
        while (performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          analyser.getFloatTimeDomainData(samples);
          for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        }
        await context.close();
        return Math.round(peak * 10000) / 10000;
      };

      const remote = document.querySelector('#remote-video');
      const local = document.querySelector('#local-video');
      return {
        paused: remote.paused,
        muted: remote.muted,
        volume: remote.volume,
        remoteLevel: await measure(remote.srcObject),
        localLevel: await measure(local.srcObject),
      };
    });

  const andiListen = await listen(andi.page);
  const budiListen = await listen(budi.page);
  check(
    'Elemen suara lawan bicara benar-benar jalan, bukan paused',
    andiListen.paused === false && budiListen.paused === false,
    JSON.stringify({ andi: andiListen.paused, budi: budiListen.paused })
  );
  check(
    'Elemen suaranya tidak di-mute dan volumenya penuh',
    andiListen.muted === false && budiListen.muted === false && andiListen.volume === 1 && budiListen.volume === 1,
    JSON.stringify({ andi: andiListen, budi: budiListen })
  );
  check(
    'Suara lawan bicara beneran terdengar (ada energi audio)',
    andiListen.remoteLevel > 0.001 && budiListen.remoteLevel > 0.001,
    JSON.stringify({ andi: andiListen.remoteLevel, budi: budiListen.remoteLevel })
  );
  check(
    'Mikrofon sendiri beneran nangkep suara (yang dikirim ke lawan)',
    andiListen.localLevel > 0.001 && budiListen.localLevel > 0.001,
    JSON.stringify({ andi: andiListen.localLevel, budi: budiListen.localLevel })
  );

  // Panggilan suara tadi belum mengirim gambar. Nyalakan kamera Andi di tengah
  // panggilan: ini latihan langsung dari jalur 'ganti track tanpa renegosiasi'.
  await andi.page.click('#ctl-camera');
  await budi.page.waitForFunction(() => document.querySelector('#remote-video').videoWidth > 0, {
    timeout: 20000,
  });
  const budiSeesVideo = await budi.page.evaluate(() => document.querySelector('#remote-video').videoWidth);
  check('Kamera yang dinyalakan belakangan langsung terlihat lawan bicara', budiSeesVideo > 0, `lebar ${budiSeesVideo}`);

  // Toggling is asynchronous, so always wait for the UI to catch up instead of
  // reading the class straight after the click.
  const waitForCtl = (page, id, on) =>
    page.waitForFunction(
      (selector, want) => document.querySelector(selector)?.classList.contains('off') === want,
      { timeout: 15000 },
      id,
      on
    );

  await andi.page.click('#ctl-mic');
  await waitForCtl(andi.page, '#ctl-mic', true);
  check('Tombol mikrofon bisa mematikan suara', true);
  await andi.page.click('#ctl-mic');
  await waitForCtl(andi.page, '#ctl-mic', false);

  await andi.page.click('#ctl-screen');
  try {
    await waitForCtl(andi.page, '#ctl-screen', true);
    check('Bagikan layar bisa dinyalakan', true);
  } catch {
    const toast = await andi.page.$eval('#toast', (e) => (e.hidden ? 'tanpa pesan error' : e.textContent)).catch(() => '?');
    check('Bagikan layar bisa dinyalakan', false, toast);
  }
  await andi.page.click('#ctl-screen');
  await waitForCtl(andi.page, '#ctl-screen', false);

  await andi.page.click('#ctl-camera');
  await andi.page.click('#ctl-hangup');
  await andi.page.waitForFunction(() => document.querySelector('#call-overlay').hidden === true, { timeout: 15000 });
  await budi.page.waitForFunction(() => document.querySelector('#call-overlay').hidden === true, { timeout: 15000 });
  check('Menutup panggilan mengembalikan kedua sisi ke chat', true);

  await checkReportAndAdmin(andi, budi);

  /* ---- 5. Nothing readable on the server ------------------------ */
  const serverMemory = JSON.stringify({
    directory: [...directory.entries()].map(([uid, e]) => ({
      uid,
      displayName: e.profile.displayName,
      publicKey: e.publicKey,
    })),
    inbox: [...inbox.entries()],
    statuses: [...statuses.entries()],
    // Laporan memang pernah berisi tulisan seseorang — tapi tulisan pelapornya
    // sendiri, bukan isi percakapan.
    reports: moderation.reports(),
  });
  check('Server tidak pernah memegang teks pesan', !serverMemory.includes('rahasia dari andi'));
  check('Server tidak pernah memegang isi file', !serverMemory.includes('a884'));
  check('Server tidak pernah memegang isi status', !serverMemory.includes(statusText));

  for (const [name, client] of [['andi', andi], ['budi', budi]]) {
    const uid = devUid(name);
    const entry = directory.get(uid);
    check(`Server cuma menyimpan public key ${name}`, entry?.publicKey?.d === undefined);

    const stored = await client.page.evaluate((key) => localStorage.getItem(key), `securechat.identity.v3.${uid}`);
    const identity = stored ? JSON.parse(stored) : null;
    check(`${name} menyimpan private key cuma di browsernya`, Boolean(identity?.privateKey?.d));
    check(`${name} nggak mengirim private key ke server`, !JSON.stringify(entry?.publicKey || {}).includes('"d"'));
  }

  /* ---- 6. Layar hp: tahan pesan untuk membuka pilihan -------------
     Ini jalur sentuh yang sebenarnya (bukan klik kanan yang dipalsukan):
     touchend cepat = ketuk biasa, sentuhan yang ditahan = menu pilihan. */
  await budi.page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
  await sleep(400);
  if (await budi.page.$eval('#chat-view', (node) => node.hidden)) {
    await budi.page.click('.chat-item');
    await budi.page.waitForSelector('#chat-view:not([hidden])', { timeout: 10000 });
  }

  // Pesan terakhir yang masih punya isi, dibawa ke tengah layar dulu: titik
  // sentuh harus benar-benar mengenai gelembungnya, bukan area kosong.
  const mobilePoint = await budi.page.$$eval('.msg', (nodes) => {
    const node = [...nodes].reverse().find((entry) => !entry.classList.contains('deleted'));
    if (!node) return null;
    node.scrollIntoView({ block: 'center' });
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  });
  // `scrollIntoView` di atas sinkron, tapi pastikan dulu posisinya benar-benar
  // di dalam layar sebelum titik sentuhnya dipakai.
  check('Ada gelembung pesan yang bisa ditahan di layar hp', mobilePoint !== null, JSON.stringify(mobilePoint));

  const touch = await budi.page.createCDPSession();
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const touchAt = (type) =>
    touch.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: mobilePoint.x, y: mobilePoint.y }],
    });

  // Sentuhan yang ditahan: jari masih menempel ketika ambang 420 ms terlewat,
  // jadi menunya harus sudah terbuka sebelum jari diangkat.
  await touchAt('touchStart');
  await sleep(700);
  await budi.page.waitForSelector('#msg-menu:not([hidden])', { timeout: 4000 });
  check('Di layar hp, tahan di pesan membuka pilihan yang sama', true);
  await touchAt('touchEnd');
  await sleep(250);
  check(
    'Menu tetap terbuka setelah jari diangkat',
    (await display(budi.page, '#msg-menu')) !== 'none'
  );
  const mobileActions = await menuActions(budi.page);
  check(
    'Pilihannya lengkap di layar kecil',
    mobileActions.includes('reply') && mobileActions.includes('delete-me'),
    mobileActions.join(' ')
  );
  const menuFits = await budi.page.evaluate(() => {
    const list = document.querySelector('#msg-menu-list').getBoundingClientRect();
    return {
      insideX: list.left >= 0 && list.right <= window.innerWidth + 1,
      insideY: list.top >= -1 && list.bottom <= window.innerHeight + 1,
    };
  });
  check('Menunya nggak keluar dari layar hp', menuFits.insideX && menuFits.insideY, JSON.stringify(menuFits));
  await budi.page.keyboard.press('Escape');
  await budi.page.waitForSelector('#msg-menu[hidden]', { timeout: 5000 });

  // Ketukan pendek di lampiran tetap membuka penampil, bukan memicu pilihan.
  await budi.page.touchscreen.tap(mobilePoint.x, mobilePoint.y);
  await sleep(300);
  check('Ketuk pendek di hp tidak membuka pilihan pesan', (await display(budi.page, '#msg-menu')) === 'none');

  console.log('');
  for (const r of results) console.log(`  ✔ ${r.label}`);
  console.log(`\n${results.length} cek browser lulus.\n`);
} catch (err) {
  console.error(`\nDititik terakhir yang lulus: ${results.at(-1)?.label || '(belum ada)'}`);
  for (const [name, client] of Object.entries(activeClients)) {
    const toast = await client.page.$eval('#toast', (e) => (e.hidden ? '' : e.textContent)).catch(() => '');
    if (toast) console.error(`[${name}] toast: ${toast}`);
    const gate = await client.page
      .evaluate(() => ({
        onboarding: document.querySelector('#onboarding')?.hidden === false,
        username: document.querySelector('#username-input')?.value,
        status: document.querySelector('#username-status')?.textContent,
        submitDisabled: document.querySelector('#username-submit')?.disabled,
      }))
      .catch(() => null);
    if (gate) console.error(`[${name}] username: ${JSON.stringify(gate)}`);
    const call = await client.page
      .evaluate(() => ({
        status: document.querySelector('#call-status')?.textContent,
        overlay: document.querySelector('#call-overlay')?.hidden === false,
        incoming: document.querySelector('#incoming')?.hidden === false,
        remoteTracks: document.querySelector('#remote-video')?.srcObject?.getTracks().length ?? 0,
        localTracks: document.querySelector('#local-video')?.srcObject?.getTracks().length ?? 0,
      }))
      .catch(() => null);
    if (call) console.error(`[${name}] call: ${JSON.stringify(call)}`);
  }
  for (const line of CONSOLE_LOG.slice(-10)) console.error(`[browser] ${line}`);
  throw err;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}
