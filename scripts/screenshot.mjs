/**
 * screenshot.mjs — ambil gambar layar UI asli, tanpa perlu klik-klik sendiri.
 *
 *   npm run screenshots
 *
 * Hasilnya masuk ke folder screenshots/. Server dijalankan di mode dev dengan
 * data di folder sementara, jadi jalan ini nggak mengubah .env atau data/ kamu.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'securechat-shots-'));
const OUT = path.join(process.cwd(), 'screenshots');

process.env.SECURECHAT_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = path.join(TMP, 'attachments');
process.env.LOCAL_AVATAR_DIR = path.join(TMP, 'avatars');
process.env.USERNAME_STORE = path.join(TMP, 'usernames.json');
process.env.MODERATION_STORE = path.join(TMP, 'moderation.json');
process.env.ACCOUNT_STORE = path.join(TMP, 'accounts.json');
// `andi` jadi admin di jalur ini, supaya tangkapan layar halaman admin bisa
// dibuat tanpa menyiapkan apa pun secara manual.
process.env.ADMIN_UIDS = `dev-${crypto.createHash('sha256').update('andi').digest('hex').slice(0, 20)}`;
process.env.PORT = process.env.PORT || '4500';

const { server } = await import('../src/server.js');
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

const chromePath = CHROME_CANDIDATES.find((candidate) => {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
});

if (!chromePath) {
  console.error('Chrome nggak ketemu. Set CHROME_PATH ke binary Chrome kamu.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(OUT, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

/** Pindah panel lewat menu yang terlihat (rail di desktop, navbar di hp). */
async function goView(page, view) {
  const clicked = await page.evaluate((name) => {
    const button = [...document.querySelectorAll(`[data-view="${name}"]`)].find(
      (node) => node.getBoundingClientRect().width > 0
    );
    button?.click();
    return Boolean(button);
  }, view);
  if (!clicked) {
    const dump = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      showChat: document.querySelector('#app')?.className,
      app: document.querySelector('#app')?.hidden,
      modal: document.querySelector('#modal')?.hidden,
      buttons: [...document.querySelectorAll('[data-view]')].map((node) => [
        node.dataset.view,
        Math.round(node.getBoundingClientRect().width),
        getComputedStyle(node).display,
      ]),
    }));
    throw new Error(`menu ${view} nggak ketemu — ${JSON.stringify(dump)}`);
  }
  await page.waitForFunction(
    (name) => document.querySelector(`.panel[data-panel="${name}"]`)?.hidden === false,
    { timeout: 5000 },
    view
  );
}

const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });

/** Masuk lewat form dev + gerbang username, persis seperti pengguna baru. */
async function signIn(username) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 2 });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login:not([hidden])');
  await page.type('#login-username', username);
  await page.click('#login-submit');
  await page.waitForSelector('#onboarding:not([hidden])');
  await page.$eval('#username-input', (field) => {
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type('#username-input', username);
  await page.waitForFunction(() => document.querySelector('#username-status')?.classList.contains('good'));
  return { context, page };
}

/** Satu halaman yang sudah melewati gerbang, untuk foto layar. */
async function login(username) {
  const client = await signIn(username);
  await client.page.click('#username-submit');
  await client.page.waitForSelector('#onboarding[hidden]');
  await client.page.waitForFunction(() => document.querySelector('#me-status')?.textContent.includes('online'));
  return client;
}

try {
  /* 1. Layar login */
  const fresh = await browser.createBrowserContext();
  const loginPage = await fresh.newPage();
  await loginPage.setViewport({ width: 1280, height: 820, deviceScaleFactor: 2 });
  await loginPage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await loginPage.waitForSelector('#login:not([hidden])');
  await sleep(400);
  await shot(loginPage, '01-login.png');

  /* 2. Gerbang username */
  await loginPage.type('#login-username', 'azhari');
  await loginPage.click('#login-submit');
  await loginPage.waitForSelector('#onboarding:not([hidden])');
  await sleep(500);
  await shot(loginPage, '02-pilih-username.png');
  await fresh.close();

  const andi = await login('andi');
  const budi = await login('budi');

  /* 3. Percakapan + panel status */
  await goView(budi.page, 'status');
  await budi.page.click('#status-me-add');
  await budi.page.waitForSelector('#status-text');
  await budi.page.type('#status-text', 'Lagi ngerjain project baru 🚀');
  await sleep(300);
  await shot(budi.page, '03-buat-status.png');
  await budi.page.click('.modal-card [data-publish]');
  await sleep(600);
  await shot(budi.page, '04-lihat-status.png');
  await budi.page.click('#status-viewer-close');
  await goView(budi.page, 'chats');

  /* Cari kontak dulu: tanpa ini nggak ada percakapan yang bisa dibuka. */
  await andi.page.click('#btn-new-chat');
  await andi.page.waitForSelector('#contact-page:not([hidden])');
  await andi.page.type('#contact-query', 'budi');
  await andi.page.click('#contact-submit');
  await andi.page.waitForSelector('#contact-results:not([hidden]) .contact-result');
  await sleep(500);
  await shot(andi.page, '05-tambah-kontak.png');
  await andi.page.click('.contact-result');
  await andi.page.waitForSelector('#chat-view:not([hidden])');

  await andi.page.type('#composer-input', 'Ini pesan terenkripsi, server cuma lihat blob 🔐');
  await andi.page.click('.send');
  await sleep(700);
  await andi.page.type('#composer-input', 'Status kamu keren 👌');
  await andi.page.click('.send');
  await sleep(900);
  await shot(andi.page, '06-chat.png');

  /* 4. Panel Pengaturan (profil, notifikasi, keluar) */
  await goView(andi.page, 'settings');
  await andi.page.waitForSelector('#me-avatar');
  await sleep(450);
  await shot(andi.page, '07-pengaturan.png');
  await goView(andi.page, 'chats');

  /* 5. Sisi penerima: cincin status + badge belum dibaca
     Status Andi dipasang di sini, bukan di awal: status cuma sampai ke orang
     yang sudah pernah chat, dan percakapannya baru saja dibuat di atas. */
  await goView(andi.page, 'status');
  await andi.page.click('#status-me-add');
  await andi.page.waitForSelector('#status-text');
  await andi.page.type('#status-text', 'Ngopi dulu ☕');
  await andi.page.click('.modal-card [data-publish]');
  await sleep(400);
  await andi.page.click('#status-viewer-close');
  await goView(andi.page, 'chats');

  await budi.page.waitForSelector('.chat-item', { timeout: 15000 });
  await sleep(400);
  await shot(budi.page, '08-daftar-chat.png');
  await goView(budi.page, 'status');
  await budi.page.waitForSelector('.status-item', { timeout: 15000 });
  await sleep(400);
  await shot(budi.page, '08b-panel-status.png');
  await goView(budi.page, 'chats');

  /* 6. Balasan di sisi Budi */
  await budi.page.click('.chat-item');
  await budi.page.waitForSelector('#chat-view:not([hidden])');
  await budi.page.type('#composer-input', 'Siap, nanti aku balas 🙂');
  await budi.page.click('.send');
  await sleep(900);
  await shot(budi.page, '09-balasan.png');

  /* 6b. Foto terenkripsi + penampil selayar penuh -------------------
     Budi mengirim foto, Andi membukanya: hasilnya dibuka di atas chat, bukan
     diunduh dan bukan di tab baru berisi blob:. */
  const samplePath = path.join(TMP, 'contoh-foto.svg');
  fs.writeFileSync(
    samplePath,
    // Warnanya dari palet DESIGN.md, biar contoh lampirannya sewarna UI-nya.
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">' +
      '<rect width="480" height="320" fill="#f7f8fa"/>' +
      '<circle cx="150" cy="150" r="90" fill="#e8f0ff"/>' +
      '<rect x="240" y="70" width="180" height="180" rx="16" fill="#2563eb"/>' +
      '</svg>'
  );

  const photoInput = await budi.page.$('#file-input');
  await photoInput.uploadFile(samplePath);
  await budi.page.waitForFunction(() => document.querySelector('.msg.out .attach-media img'), { timeout: 20000 });
  await andi.page.waitForFunction(() => document.querySelector('.msg .attach'), { timeout: 20000 });
  await sleep(400);
  await shot(budi.page, '12-foto-di-chat.png');

  await andi.page.click('.msg .attach');
  await andi.page.waitForSelector('#viewer:not([hidden]) .viewer-stage img', { timeout: 30000 });
  await sleep(600);
  await shot(andi.page, '13-foto-selayar-penuh.png');
  await andi.page.click('#viewer-close');
  await andi.page.waitForSelector('#viewer[hidden]');

  /* 6c. Pilihan pesan: klik kanan → sisanya diblur, yang dipilih tajam */
  const targetBubble = await andi.page.$('.msg.out');
  const targetPoint = await targetBubble.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  });
  await andi.page.mouse.click(targetPoint.x, targetPoint.y, { button: 'right' });
  await andi.page.waitForSelector('#msg-menu:not([hidden])');
  await sleep(500);
  await shot(andi.page, '14-pilihan-pesan.png');
  await andi.page.keyboard.press('Escape');
  await andi.page.waitForSelector('#msg-menu[hidden]');

  /* 7. Laporan dari header chat */
  await andi.page.click('#btn-report');
  await andi.page.waitForSelector('#report-reason');
  await andi.page.type('#report-detail', 'kirim link iklan terus-terusan');
  await sleep(400);
  await shot(andi.page, '10-laporan.png');
  await andi.page.click('.modal-card [data-send]');
  await sleep(700);

  /* 8. Halaman admin — sesi Andi dipakai ulang, jadi nggak ada login kedua. */
  const adminPage = await andi.context.newPage();
  await adminPage.setViewport({ width: 1280, height: 820, deviceScaleFactor: 2 });
  await adminPage.goto(`${BASE_URL}/admin.html`, { waitUntil: 'domcontentloaded' });
  await adminPage.waitForSelector('#admin:not([hidden])', { timeout: 15000 });
  await sleep(900);
  await shot(adminPage, '11-halaman-admin.png');
  await adminPage.close();

  /* 9. Navbar bawah di layar hp: oval, melayang, berkaca. */
  await goView(andi.page, 'chats');
  await budi.page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  // Ukuran barunya kadang belum sempat dihitung saat goView jalan, jadi beri
  // satu putaran layout dulu (bukan memperlambat tanpa alasan).
  await sleep(350);
  await goView(budi.page, 'chats');
  await sleep(600);
  await shot(budi.page, '15-navbar-hp.png');

  console.log(`\n${fs.readdirSync(OUT).length} gambar tersimpan di ${OUT}\n`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}
