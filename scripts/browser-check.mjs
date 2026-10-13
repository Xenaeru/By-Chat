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
process.env.PORT = process.env.PORT || '4400';

const { server, directory, inbox } = await import('../server.js');
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

  await page.type('#login-username', username);
  await page.click('#login-submit');
  await page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#me-status')?.textContent.includes('online'), {
    timeout: 15000,
  });

  check(`${username}: layar login hilang setelah masuk`, (await display(page, '#login')) === 'none');
  check(`${username}: aplikasi benar-benar tampil`, (await display(page, '#app')) === 'grid');
  check(`${username}: overlay modal tidak menutupi layar`, (await display(page, '#modal')) === 'none');
  check(
    `${username}: overlay panggilan nggak muncul sendiri`,
    (await display(page, '#call-overlay')) === 'none'
  );
  check(`${username}: tombol log keluar terlihat`, (await display(page, '#btn-logout')) !== 'none');

  return { context, page };
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

  /* ---- 1. Opening a chat ---------------------------------------- */
  await andi.page.click('#btn-new-chat');
  await andi.page.waitForSelector('.picker li', { timeout: 10000 });
  const pickedBudi = await andi.page.evaluate(() => {
    const li = [...document.querySelectorAll('.picker li')].find((n) => n.textContent.includes('budi'));
    if (li) li.click();
    return Boolean(li);
  });
  check('Andi menemukan Budi di daftar kontak', pickedBudi);
  await andi.page.waitForSelector('#chat-view:not([hidden])');
  check('Panel chat terlihat', (await display(andi.page, '#chat-view')) === 'flex');
  check('Layar sambutan hilang saat chat dibuka', (await display(andi.page, '#empty-state')) === 'none');
  check('Tombol telpon muncul di chat pribadi', (await andi.page.$eval('#btn-call-audio', (e) => !e.hidden)) === true);

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
  const fileInput = await andi.page.$('#file-input');
  await fileInput.uploadFile(sample.file);

  await andi.page.waitForFunction(
    (name) => [...document.querySelectorAll('.msg.out .attach-name')].some((n) => n.textContent.includes(name)),
    { timeout: 20000 },
    sample.name
  );
  check('Andi mengirim lampiran terenkripsi', true);

  // Whatever landed on disk must be ciphertext under a meaningless name.
  const storedFiles = listFiles(process.env.LOCAL_STORAGE_DIR);
  check('Lampiran tersimpan sebagai satu blob', storedFiles.length === 1, JSON.stringify(storedFiles));
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

  await budi.page.click('.msg .attach');
  await budi.page.waitForSelector('.msg .attach img', { timeout: 20000 });

  const decrypted = await budi.page.evaluate(async () => {
    const img = document.querySelector('.msg .attach img');
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

  /* ---- 5. Nothing readable on the server ------------------------ */
  const serverMemory = JSON.stringify({
    directory: [...directory.entries()].map(([uid, e]) => ({
      uid,
      displayName: e.profile.displayName,
      publicKey: e.publicKey,
    })),
    inbox: [...inbox.entries()],
  });
  check('Server tidak pernah memegang teks pesan', !serverMemory.includes('rahasia dari andi'));
  check('Server tidak pernah memegang isi file', !serverMemory.includes('a884'));

  for (const [name, client] of [['andi', andi], ['budi', budi]]) {
    const uid = devUid(name);
    const entry = directory.get(uid);
    check(`Server cuma menyimpan public key ${name}`, entry?.publicKey?.d === undefined);

    const stored = await client.page.evaluate((key) => localStorage.getItem(key), `securechat.identity.v3.${uid}`);
    const identity = stored ? JSON.parse(stored) : null;
    check(`${name} menyimpan private key cuma di browsernya`, Boolean(identity?.privateKey?.d));
    check(`${name} nggak mengirim private key ke server`, !JSON.stringify(entry?.publicKey || {}).includes('"d"'));
  }

  console.log('');
  for (const r of results) console.log(`  ✔ ${r.label}`);
  console.log(`\n${results.length} cek browser lulus.\n`);
} catch (err) {
  console.error(`\nDititik terakhir yang lulus: ${results.at(-1)?.label || '(belum ada)'}`);
  for (const [name, client] of Object.entries(activeClients)) {
    const toast = await client.page.$eval('#toast', (e) => (e.hidden ? '' : e.textContent)).catch(() => '');
    if (toast) console.error(`[${name}] toast: ${toast}`);
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
