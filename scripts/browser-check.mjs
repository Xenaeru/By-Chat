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
import { io as ioClient } from 'socket.io-client';

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
// Token dev yang sama dengan yang dipakai browser, buat satu klien mentah di
// bawah: pembuktian sisi penerima bahwa status orang asing tetap diabaikan.
const { makeDevToken } = await import('../auth.js');
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

/**
 * DESIGN.md bukan cuma dokumen: palet, bentuk, dan tipografinya diperiksa dari
 * nilai yang benar-benar dihitung browser. Tampilan yang menyimpang — gradasi
 * dekoratif, tombol bulat, warna saturasi di luar palet — ketahuan di sini.
 *
 * `kind` menentukan gelembung mana yang diuji: 'out' untuk halaman orang yang
 * sudah mengirim pesan, 'in' untuk halaman penerimanya.
 */
async function verifyDesignSystem(page, label, kind) {
  // Kursor dijauhkan dulu: kalau dia kebetulan berhenti di atas tombol, warna
  // tombolnya ketangkap di tengah animasi hover (mis. rgb(29, 78, 216) alih-alih
  // rgb(37, 99, 235)) dan pemeriksaannya jadi gagal karena alasan yang salah.
  await page.mouse.move(2, 2);
  await sleep(250);

  const design = await page.evaluate(() => {
    const pick = (selector, props) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const computed = getComputedStyle(node);
      const out = {};
      for (const prop of props) out[prop] = computed[prop];
      return out;
    };
    const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const bubbles = [...document.querySelectorAll('.msg')].map((node) => {
      const computed = getComputedStyle(node);
      return {
        out: node.classList.contains('out'),
        background: computed.backgroundColor,
        colour: computed.color,
        radii: [
          computed.borderTopLeftRadius,
          computed.borderTopRightRadius,
          computed.borderBottomRightRadius,
          computed.borderBottomLeftRadius,
        ],
      };
    });
    return {
      tokens: {
        primary: token('--primary'),
        canvas: token('--canvas'),
        cloud: token('--cloud'),
        ink: token('--ink'),
      },
      body: pick('body', ['backgroundColor', 'color', 'fontFamily', 'backgroundImage']),
      primaryButton: pick('.primary', ['backgroundColor', 'borderRadius', 'textTransform', 'letterSpacing']),
      sendButton: pick('.send', ['backgroundColor', 'borderRadius']),
      rail: pick('#rail', ['backgroundColor', 'borderRightColor']),
      lists: pick('#lists', ['backgroundColor', 'borderRightColor']),
      panelTitle: pick('.panel-head .panel-title', ['color', 'fontSize']),
      conversation: pick('.messages', ['backgroundColor']),
      selectedRow: pick('.chat-item.active', ['backgroundColor']),
      card: pick('.modal-card', ['borderRadius', 'backgroundColor', 'boxShadow']),
      field: pick('.search', ['borderRadius', 'minHeight']),
      avatar: pick('.avatar', ['borderRadius']),
      bubbles,
    };
  });

  check(
    `${label}: token DESIGN.md terpasang (primary, canvas, cloud, ink)`,
    design.tokens.primary === '#2563eb' &&
      design.tokens.canvas === '#ffffff' &&
      design.tokens.cloud === '#f7f8fa' &&
      design.tokens.ink === '#17202a',
    JSON.stringify(design.tokens)
  );
  check(
    `${label}: latar aplikasi {colors.cloud}, permukaannya rata tanpa gradasi`,
    design.body.backgroundColor === 'rgb(247, 248, 250)' && design.body.backgroundImage === 'none',
    JSON.stringify(design.body)
  );
  check(`${label}: teks memakai {colors.ink}`, design.body.color === 'rgb(23, 32, 42)', design.body.color);
  check(
    `${label}: huruf Inter sesuai DESIGN.md`,
    /Inter/.test(design.body.fontFamily),
    design.body.fontFamily
  );
  check(
    `${label}: CTA By Chat Blue, sudut 8px, label kalimat biasa (bukan kapital)`,
    design.primaryButton?.backgroundColor === 'rgb(37, 99, 235)' &&
      design.primaryButton?.borderRadius === '8px' &&
      design.primaryButton?.textTransform === 'none' &&
      design.primaryButton?.letterSpacing === 'normal',
    JSON.stringify(design.primaryButton)
  );
  check(
    `${label}: tombol kirim ikut 8px di atas biru`,
    design.sendButton?.backgroundColor === 'rgb(37, 99, 235)' && design.sendButton?.borderRadius === '8px',
    JSON.stringify(design.sendButton)
  );
  check(
    `${label}: input sudut 8px dengan tinggi minimal 44px`,
    design.field?.borderRadius === '8px' && parseFloat(design.field?.minHeight) >= 44,
    JSON.stringify(design.field)
  );
  // {"colors.ink-surface"} cuma dipakai sesekali (panggilan, penampil media),
  // jadi shell-nya nggak boleh berupa slab gelap: rail abu lembut, kolom daftar
  // putih dengan garis rambut 1px.
  check(
    `${label}: rail kanvas kelabu, kolom daftar permukaan putih`,
    design.rail?.backgroundColor === 'rgb(247, 248, 250)' &&
      design.rail?.borderRightColor === 'rgb(228, 232, 239)' &&
      design.lists?.backgroundColor === 'rgb(255, 255, 255)' &&
      design.lists?.borderRightColor === 'rgb(228, 232, 239)' &&
      design.panelTitle?.color === 'rgb(23, 32, 42)' &&
      design.panelTitle?.fontSize === '20px',
    JSON.stringify({ rail: design.rail, lists: design.lists, title: design.panelTitle })
  );
  check(
    `${label}: permukaan percakapan putih {colors.canvas}`,
    design.conversation?.backgroundColor === 'rgb(255, 255, 255)',
    design.conversation?.backgroundColor
  );
  check(
    `${label}: baris chat terpilih memakai {colors.primary-tint}`,
    design.selectedRow?.backgroundColor === 'rgb(239, 246, 255)',
    design.selectedRow?.backgroundColor
  );
  check(
    `${label}: kartu melayang 16px dengan bayangan Floating Modal`,
    design.card?.borderRadius === '16px' &&
      design.card?.backgroundColor === 'rgb(255, 255, 255)' &&
      design.card?.boxShadow !== 'none',
    JSON.stringify(design.card)
  );
  // DESIGN.md tidak mengatur bentuk avatar; yang dipilih produknya bulat penuh.
  check(`${label}: avatar bulat penuh`, design.avatar?.borderRadius === '50%', design.avatar?.borderRadius);

  const bubble = design.bubbles.find((entry) => (kind === 'out' ? entry.out : !entry.out));
  check(
    kind === 'out'
      ? `${label}: gelembung sendiri biru pucat {colors.primary-soft}, teks ink, ekor 4px`
      : `${label}: gelembung lawan putih {colors.bubble-in}, sudut kartu 16px, ekor 4px`,
    Boolean(bubble) &&
      bubble.background === (kind === 'out' ? 'rgb(232, 240, 255)' : 'rgb(255, 255, 255)') &&
      bubble.colour === 'rgb(23, 32, 42)' &&
      bubble.radii.filter((radius) => radius === '16px').length === 3 &&
      bubble.radii.filter((radius) => radius === '4px').length === 1,
    JSON.stringify(bubble)
  );
}

/* ---- Alat bantu interaksi ------------------------------------------ *
 * Klik dan sentuhan cuma diproses untuk halaman yang sedang tampil, dan dua
 * halaman di sini bergantian jadi yang tampil. Jadi setiap kali mau
 * berinteraksi, halamannya dibawa ke depan dulu. Titik kliknya juga dihitung
 * dari elemennya sendiri setelah dibawa ke tengah area gulir: `page.click`
 * bawaan kadang memakai titik yang ketutup kolom ketik, jadi kliknya tidak
 * sampai ke tujuannya. */
const front = (page) => page.bringToFront();

/**
 * Pindah panel lewat menu yang benar-benar dipakai orang: rail di desktop,
 * navbar bawah di hp. Yang diklik adalah tombol yang memang terlihat, jadi
 * jalur ini juga berlaku kalau layarnya sedang sempit.
 */
const goView = async (page, view) => {
  await front(page);
  const clicked = await page.evaluate((name) => {
    const button = [...document.querySelectorAll(`[data-view="${name}"]`)].find(
      (node) => node.getBoundingClientRect().width > 0
    );
    button?.click();
    return Boolean(button);
  }, view);
  if (!clicked) throw new Error(`menu ${view} nggak ketemu di layar ini`);
  await page.waitForFunction(
    (name) => document.querySelector(`.panel[data-panel="${name}"]`)?.hidden === false,
    { timeout: 5000 },
    view
  );
};

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

/**
 * Notifikasi: sakelar di Pengaturan, service worker, dan balasan dari
 * notifikasi. `roomId` DM dihitung dengan rumus yang sama seperti crypto.js.
 */
async function checkNotifications(andi, budi) {
  const roomId = `dm:${[devUid('andi'), devUid('budi')].sort().join(':')}`;

  await front(andi.page);
  await goView(andi.page, 'settings');
  const row = await andi.page.evaluate(() => ({
    hasToggle: Boolean(document.querySelector('[data-notify-toggle]')),
    pressed: document.querySelector('[data-notify-toggle]')?.getAttribute('aria-pressed'),
    note: document.querySelector('[data-notify-note]')?.textContent || '',
  }));
  check(
    'Panel Pengaturan punya sakelar notifikasi yang jelas keadaannya',
    row.hasToggle && row.pressed === 'false' && row.note.length > 10,
    JSON.stringify(row)
  );

  await andi.page.click('[data-notify-toggle]');
  await andi.page.waitForFunction(
    () => document.querySelector('[data-notify-toggle]')?.getAttribute('aria-pressed') === 'true',
    { timeout: 10000 }
  );
  const grant = await andi.page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return { permission: Notification.permission, active: Boolean(registration.active), scope: registration.scope };
  });
  check(
    'Menyalakan notifikasi memasang service worker di scope aplikasi',
    grant.permission === 'granted' && grant.active && grant.scope === `${BASE_URL}/`,
    JSON.stringify(grant)
  );

  await goView(andi.page, 'chats');

  // Andi pindah ke percakapan lain (grup kecil dengan Budi), jadi pesan yang
  // masuk ke DM-nya datang saat DM itu memang tidak sedang dibaca.
  await andi.page.click('#btn-new-group');
  await andi.page.waitForSelector('#group-name', { timeout: 10000 });
  await andi.page.type('#group-name', 'Rapat Tim');
  await andi.page.click('.picker input[type="checkbox"]');
  await andi.page.click('.modal-card [data-create]');
  await andi.page.waitForSelector('#modal[hidden]', { timeout: 5000 });
  const opened = await andi.page.evaluate(() => ({
    name: document.querySelector('#peer-name')?.textContent || '',
    visible: document.querySelector('#chat-view')?.hidden === false,
  }));
  check(
    'Andi sedang membuka percakapan lain saat pesannya datang',
    opened.name === 'Rapat Tim' && opened.visible,
    JSON.stringify(opened)
  );

  // Pastikan sisi Budi memang ada di percakapan DM-nya sebelum menulis.
  await budi.page.evaluate(() => {
    const row = [...document.querySelectorAll('.chat-item')].find((node) => node.textContent.includes('andi'));
    row?.click();
  });
  await budi.page.waitForSelector('#chat-view:not([hidden])', { timeout: 10000 });

  const notifText = 'kabar buat notifikasi andi';
  await budi.page.type('#composer-input', notifText);
  await budi.page.click('.send');

  const shown = await andi.page.evaluate(async (text) => {
    const registration = await navigator.serviceWorker.ready;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const notes = await registration.getNotifications();
      const hit = notes.find((note) => String(note.body || '').includes(text));
      if (hit) {
        return {
          title: hit.title,
          body: hit.body,
          tag: hit.tag,
          roomId: hit.data?.roomId || null,
          uid: hit.data?.uid || null,
          actions: (hit.actions || []).map((action) => action.action),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }, notifText);
  check('Pesan masuk muncul sebagai notifikasi di luar jendela', Boolean(shown), JSON.stringify(shown));
  check(
    'Notifikasi menyebut pengirim dan isi pesannya',
    shown?.title === 'budi' && /kabar buat notifikasi/.test(shown?.body || ''),
    JSON.stringify(shown)
  );
  check('Notifikasi membawa id percakapan buat dibuka', shown?.roomId === roomId, JSON.stringify(shown));
  check(
    'Notifikasi ditandai milik akun Andi, bukan akun lain di browser yang sama',
    shown?.uid === devUid('andi'),
    JSON.stringify(shown?.uid)
  );
  check(
    'Notifikasi menawarkan tombol balas, bukan cuma buka',
    (shown?.actions || []).includes('reply'),
    JSON.stringify(shown?.actions)
  );

  // Jalur balas yang sama seperti saat notifikasi benar-benar diklik: dipanggil
  // di service worker yang sedang jalan, bukan tiruan di dalam halaman.
  const swTarget = () =>
    andi.context.targets().find((target) => target.type() === 'service_worker' && target.url().includes('/sw.js'));
  let worker = null;
  for (let i = 0; i < 20 && !worker; i++) {
    const target = swTarget();
    if (target) worker = await target.worker();
    if (!worker) await sleep(250);
  }
  check('Service worker notifikasi bisa dipanggil dari luar', Boolean(worker));

  const replyText = 'balasan langsung dari notifikasi';
  const handled = await worker.evaluate(
    (payload) => self.bychatNotificationClick(payload).then(() => 'ok'),
    { action: 'reply', reply: replyText, roomId, uid: devUid('andi') }
  );
  check('Aksi balas diproses service worker', handled === 'ok', String(handled));

  // Yang dikirim harus benar-benar balasan Andi (gelembung keluar di sisinya),
  // bukan cuma "ada pesan dengan teks itu" di salah satu layar.
  await andi.page.waitForFunction(
    (text) => [...document.querySelectorAll('.msg.out')].some((node) => node.textContent.includes(text)),
    { timeout: 20000 },
    replyText
  );
  await budi.page.waitForFunction(
    (text) => [...document.querySelectorAll('.msg:not(.out)')].some((node) => node.textContent.includes(text)),
    { timeout: 20000 },
    replyText
  );
  const sentByBudi = await budi.page.$$eval('.msg.out', (nodes) =>
    nodes.some((node) => node.textContent.includes('balasan langsung dari notifikasi'))
  );
  check('Balasan dari notifikasi terkirim sebagai pesan Andi', sentByBudi === false);
  check('Balasan itu sampai ke Budi sebagai pesan masuk di gelembung putih', true);

  // Balasan tadi membuka DM-nya, jadi sekarang Andi memang sedang membaca
  // percakapan itu: pesan berikutnya tidak boleh lagi jadi notifikasi.
  const quietText = 'pesan yang lagi dibaca andi';
  await budi.page.type('#composer-input', quietText);
  await budi.page.click('.send');
  await andi.page.waitForFunction(
    (text) => [...document.querySelectorAll('.msg')].some((node) => node.textContent.includes(text)),
    { timeout: 20000 },
    quietText
  );
  await sleep(1200);
  const quiet = await andi.page.evaluate(async (text) => {
    const registration = await navigator.serviceWorker.ready;
    const notes = await registration.getNotifications();
    return notes.filter((note) => String(note.body || '').includes(text)).length;
  }, quietText);
  check('Tidak ada notifikasi untuk pesan yang sedang dibaca', quiet === 0, `${quiet} notifikasi`);
}


/**
 * Shell-nya ala WhatsApp: menu utama memindahkan panel di kolom daftar, dan
 * tiap perpindahan memang dianimasikan — bukan cuma ganti isi DOM.
 */
async function checkShell(andi) {
  const start = await andi.page.evaluate(() => ({
    view: document.querySelector('.panel:not([hidden])')?.dataset.panel,
    panels: document.querySelectorAll('.panel[data-panel]').length,
    railWidth: document.querySelector('#rail').getBoundingClientRect().width,
    railTabs: [...document.querySelectorAll('#rail [data-view]')].map((node) => node.dataset.view),
  }));
  check(
    'Aplikasi mulai di panel Chat, dengan rail lengkap di kolom kiri',
    start.view === 'chats' &&
      start.panels === 4 &&
      start.railWidth > 0 &&
      ['chats', 'status', 'calls', 'settings'].every((view) => start.railTabs.includes(view)),
    JSON.stringify(start)
  );

  for (const view of ['status', 'calls', 'settings', 'chats']) {
    await goView(andi.page, view);
    const seen = await andi.page.evaluate((name) => {
      const panel = document.querySelector(`.panel[data-panel="${name}"]`);
      const active = [...document.querySelectorAll('[data-view]')].filter(
        (node) => node.classList.contains('active') && node.getBoundingClientRect().width > 0
      );
      const others = [...document.querySelectorAll('.panel[data-panel]')].filter((node) => node.hidden === false);
      return {
        hidden: panel.hidden,
        animation: getComputedStyle(panel).animationName,
        activeViews: active.map((node) => node.dataset.view),
        visiblePanels: others.map((node) => node.dataset.panel),
      };
    }, view);
    check(
      `Menu ${view}: panelnya terbuka, cuma dia yang tampil, aktif, dan pakai animasi masuk`,
      seen.hidden === false &&
        seen.animation === 'view-in' &&
        seen.activeViews.includes(view) &&
        seen.visiblePanels.length === 1 &&
        seen.visiblePanels[0] === view,
      JSON.stringify(seen)
    );
  }

  const motion = await andi.page.evaluate(() => {
    const button = document.querySelector('#rail [data-view="chats"]');
    const style = getComputedStyle(button);
    return { transition: style.transitionProperty, duration: style.transitionDuration };
  });
  check(
    'Tombol menu punya transisi, jadi pergantiannya terasa halus',
    /background|color|transform/.test(motion.transition) && parseFloat(motion.duration) > 0,
    JSON.stringify(motion)
  );
}

/** Berapa status yang benar-benar tampil di panel Status halaman ini. */
const statusItemsIn = (page) => page.$$eval('.status-item', (nodes) => nodes.length);

/**
 * Sebelum pernah chat, status Andi cuma boleh ada di perangkatnya sendiri. Dua
 * sisi diperiksa: daftar penerima yang benar-benar diteruskan server, dan
 * panel Status Budi yang harus tetap kosong. Ditambah satu klien mentah yang sengaja
 * mengirim status ke Budi dari akun asing — sisi penerima harus mengabaikannya
 * juga, bukan cuma mengandalkan pengirimnya.
 */
async function checkStatusBeforeChat(andi, budi) {
  const beforeChat = `status sebelum kenal ${Date.now()}`;
  await goView(andi.page, 'status');
  await andi.page.click('#status-me-add');
  await andi.page.waitForSelector('#status-text', { timeout: 10000 });
  await andi.page.type('#status-text', beforeChat);
  await andi.page.click('.modal-card [data-publish]');
  await andi.page.waitForFunction(
    (text) => document.querySelector('#status-stage .status-text')?.textContent.includes(text),
    { timeout: 15000 },
    beforeChat
  );
  check('Status sendiri tetap bisa dilihat di perangkat sendiri', true);
  await andi.page.click('#status-viewer-close');
  await andi.page.waitForSelector('#status-viewer[hidden]', { timeout: 10000 });
  await goView(andi.page, 'chats');

  const audience = [...statuses.values()].filter((entry) => entry.from === devUid('andi')).at(-1)?.members || [];
  check(
    'Daftar penerima status cuma berisi diri sendiri saat belum ada chat',
    audience.includes(devUid('andi')) && !audience.includes(devUid('budi')),
    JSON.stringify(audience)
  );

  await sleep(1000);
  check(
    'Panel Status Budi tetap kosong sebelum mereka pernah chat',
    (await statusItemsIn(budi.page)) === 0,
    `${await statusItemsIn(budi.page)} item`
  );

  const stranger = await publishStatusFromStranger('cici', [devUid('budi')]);
  check(
    'Klien asing tetap bisa mengirim status ke Budi (jadi tesnya bukan tes kosong)',
    stranger.members.includes(devUid('budi')),
    JSON.stringify(stranger)
  );
  await sleep(1200);
  check(
    'Status dari orang yang belum pernah chat diabaikan di sisi penerima',
    (await statusItemsIn(budi.page)) === 0,
    `${await statusItemsIn(budi.page)} item`
  );
}

/**
 * Klien mentah (tanpa UI) yang memakai token dev yang sama dengan browser:
 * pembuktian bahwa sisi penerima memang menghadapi status dari orang asing, dan
 * tetap nggak menampilkannya.
 */
async function publishStatusFromStranger(name, members) {
  const uid = devUid(name);
  const socket = ioClient(BASE_URL, {
    transports: ['websocket'],
    forceNew: true,
    auth: {
      token: makeDevToken({ uid, displayName: name }),
      // Kunci publik dummy: yang diuji cuma siapa yang boleh menerima, dan isi
      // statusnya memang nggak pernah dibuka di sini.
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) },
    },
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      setTimeout(() => reject(new Error('timeout menyambung klien asing')), 5000);
    });
    const claimed = await new Promise((resolve) => socket.emit('username:claim', name, resolve));
    if (!claimed?.ok) throw new Error(`klien asing gagal klaim username: ${claimed?.error}`);
    const published = await new Promise((resolve) =>
      socket.emit('status:publish', { payload: { ct: 'blob-palsu' }, members }, resolve)
    );
    if (!published?.ok) throw new Error(`klien asing gagal menerbitkan status: ${published?.error}`);
    return { id: published.id, members: statuses.get(published.id)?.members || [] };
  } finally {
    socket.close();
  }
}

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
  // Notifikasi: dialog izin memang nggak bisa diklik otomatis, jadi izinnya
  // diberikan di level browser — sakelarnya sendiri tetap dinyalakan dari
  // panel Pengaturan seperti yang orang lakukan.
  await context.overridePermissions(BASE_URL, ['notifications']);
  const page = await context.newPage();
  page.on('pageerror', (err) => {
    console.error(`[${username}] page error:`, err.message);
    CONSOLE_LOG.push(`${username} pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    // Peringatan ikut dicatat: jalur yang menelan error (mis. notifikasi yang
    // ditolak platform) cuma meninggalkan jejak di sini.
    if (msg.type() === 'error') CONSOLE_LOG.push(`${username} console: ${msg.text()}`);
    else if (msg.type() === 'warning') CONSOLE_LOG.push(`${username} warn: ${msg.text()}`);
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

  // Login nomor HP sudah dibuang seluruhnya — bukan cuma disembunyikan: elemen
  // dan penanganannya nggak ada lagi di DOM, jadi nggak ada jalur yang bisa
  // menghidupkannya kembali tanpa mengubah kode.
  const loginPaths = await page.evaluate(() => ({
    phone: document.querySelector('#phone-number') !== null,
    otp: document.querySelector('#otp-code') !== null,
    send: document.querySelector('#btn-send-code') !== null,
    recaptcha: document.querySelector('#recaptcha-container') !== null,
    google: document.querySelector('#btn-google') !== null,
  }));
  check(
    `${username}: login cuma lewat Google, jalur nomor HP benar-benar hilang`,
    !loginPaths.phone && !loginPaths.otp && !loginPaths.send && !loginPaths.recaptcha && loginPaths.google,
    JSON.stringify(loginPaths)
  );

  // Halaman pertama yang dilihat orang juga ikut DESIGN.md baru: kartu putih di
  // atas kanvas cloud, tanpa hiasan hero (strip gelap / chevron) dan tanpa
  // label tombol kapital.
  const loginDesign = await page.evaluate(() => {
    const card = getComputedStyle(document.querySelector('.login-card'));
    return {
      cardBg: card.backgroundColor,
      cardRadius: card.borderRadius,
      cardShadow: card.boxShadow,
      pageBg: getComputedStyle(document.querySelector('#login')).backgroundColor,
      decorations: document.querySelectorAll('.site-strip, .chevrons').length,
      buttonCase: getComputedStyle(document.querySelector('#login-submit')).textTransform,
    };
  });
  check(
    `${username}: kartu login putih 16px di atas kanvas {colors.cloud}`,
    loginDesign.cardBg === 'rgb(255, 255, 255)' &&
      loginDesign.cardRadius === '16px' &&
      loginDesign.cardShadow !== 'none' &&
      loginDesign.pageBg === 'rgb(247, 248, 250)',
    JSON.stringify(loginDesign)
  );
  check(
    `${username}: tanpa hiasan hero dan label tombol tidak kapital`,
    loginDesign.decorations === 0 && loginDesign.buttonCase === 'none',
    JSON.stringify(loginDesign)
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
  // Shell-nya sekarang seperti WhatsApp: menu utama di rail (desktop) dan
  // navbar bawah (hp), sementara keluar + pengaturan pindah ke panelnya sendiri.
  const nav = await page.evaluate(() => ({
    railTabs: [...document.querySelectorAll('#rail [data-view]')].map((node) => node.dataset.view),
    tabTabs: [...document.querySelectorAll('#tabbar [data-view]')].map((node) => node.dataset.view),
    logoutPanel: document.querySelector('#btn-logout')?.closest('.panel')?.dataset.panel || null,
    logoutInChatList: Boolean(document.querySelector('#panel-chats #btn-logout')),
    settingsInHeader: Boolean(document.querySelector('#panel-chats [data-view="settings"]')),
  }));
  const views = ['chats', 'status', 'calls', 'settings'];
  check(
    `${username}: menu utamanya chat, status, panggilan, pengaturan`,
    views.every((view) => nav.railTabs.includes(view)) && views.every((view) => nav.tabTabs.includes(view)),
    JSON.stringify(nav)
  );
  check(
    `${username}: pengaturan & keluar pindah dari header chat ke panel Pengaturan`,
    nav.logoutPanel === 'settings' && nav.logoutInChatList === false && nav.settingsInHeader === false,
    JSON.stringify(nav)
  );
  await goView(page, 'settings');
  check(
    `${username}: panel Pengaturan terbuka dengan tombol keluar di dalamnya`,
    (await display(page, '#btn-logout')) !== 'none' &&
      (await page.$eval('#panel-settings', (node) => node.hidden === false))
  );
  await goView(page, 'chats');
  check(
    `${username}: pindah balik ke chat menutup lagi panel Pengaturan`,
    (await display(page, '#panel-settings')) === 'none' && (await display(page, '#chat-list')) !== 'none'
  );
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
      rail: box('#rail'),
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  check(
    `${username}: rail dan daftar chat benar-benar punya ukuran`,
    [layout.chatList, layout.rail].every((rect) => rect && rect.w > 0 && rect.h > 0),
    JSON.stringify(layout)
  );
  check(`${username}: halaman nggak meluber ke samping`, layout.overflowX <= 1, `overflow ${layout.overflowX}px`);

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
 * Dipanggil setelah Andi dan Budi pernah chat: status cuma sampai ke orang yang
 * sudah pernah chat, jadi jalur ini memang baru masuk akal setelah ada
 * percakapan. Aturan sebelum chat-nya diuji di checkStatusBeforeChat.
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
  await goView(andi.page, 'settings');
  await andi.page.waitForSelector('#me-avatar', { timeout: 10000 });

  // Panel Pengaturan sengaja nggak lagi memampangkan uid, driver penyimpanan,
  // relay panggilan, atau peringatan private key.
  const settingsText = await andi.page.$eval('#panel-settings', (node) => node.textContent);
  check(
    'Pengaturan nggak lagi menampilkan info akun/penyimpanan/relay',
    !/Akun:|Penyimpanan file|Relay panggilan|Private key kamu/i.test(settingsText),
    settingsText.slice(0, 160).replace(/\s+/g, ' ')
  );
  const avatarInput = await andi.page.$('#avatar-input');
  await avatarInput.uploadFile(png);
  await andi.page.waitForFunction(
    () => (document.querySelector('#me-avatar')?.style.backgroundImage || '').includes('/api/avatar/'),
    { timeout: 15000 }
  );
  check('Foto profil terpasang dari panel Pengaturan', true);

  await goView(andi.page, 'chats');
  await andi.page.waitForFunction(
    () => (document.querySelector('#rail-avatar')?.style.backgroundImage || '').includes('/api/avatar/'),
    { timeout: 10000 }
  );
  check('Avatar di rail ikut memakai foto yang baru diunggah', true);

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
  await goView(andi.page, 'status');
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

  await goView(budi.page, 'status');
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
  await goView(budi.page, 'chats');
  await budi.page.waitForFunction(
    () => document.querySelector('.status-item')?.textContent.includes('Sudah dilihat'),
    { timeout: 10000 }
  );
  check('Sesudah dibaca, status ditandai sudah dilihat', true);

  /* ---- Status foto: jalur lampiran terenkripsi lewat status ---- */
  await goView(andi.page, 'status');
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

  await goView(budi.page, 'status');
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
  // Shell-nya dulu: menu, panel, dan animasinya.
  await checkShell(andi);
  // Aturan status diuji dari dua sisi: sebelum ada chat, lalu sesudahnya.
  await checkStatusBeforeChat(andi, budi);

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
    'Daftar chat tetap punya ukuran selama halaman itu terbuka',
    await andi.page.$eval('#chat-list', (node) => node.getBoundingClientRect().width > 0)
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

  /* ---- 2. Pesan teks ------------------------------------------- */
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
  // Merekam ulang sampai tiga kali kalau hasilnya cuma header WebM. Ini murni
  // keandalan alat rekamnya, bukan aplikasinya: `captureStream()` di Chrome
  // headless kadang cuma mengirim satu frame saat mesin sedang sibuk, dan
  // ukurannya beda jauh (ratusan vs ribuan byte). Syarat lulusnya tetap sama,
  // dan kalau ketiga percobaan tetap kosong, cek ini gagal seperti biasa.
  const videoAttempts = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    videoAttempts.push(
      await andi.page.evaluate(async () => {
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
        const base64 = btoa(binary);
        return { base64, chunks: chunks.length, bytes: bytes.byteLength };
      })
    );
    if (videoAttempts.at(-1).base64.length > 2000) break;
    await sleep(500);
  }
  const videoBase64 = videoAttempts.find((entry) => entry.base64.length > 2000)?.base64 || '';
  check(
    'Video contoh benar-benar terbentuk',
    videoBase64.length > 2000,
    JSON.stringify(videoAttempts.map((entry) => ({ chars: entry.base64.length, chunks: entry.chunks, bytes: entry.bytes })))
  );

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
      listBlurred: getComputedStyle(document.querySelector('#lists')).filter !== 'none',
      railBlurred: getComputedStyle(document.querySelector('#rail')).filter !== 'none',
    };
  });
  check('Ada pesan lain yang ikut diblur', blurState.others > 0, JSON.stringify(blurState));
  check('Pesan lain diblur saat pilihan terbuka', blurState.othersBlurred, JSON.stringify(blurState));
  check('Pesan yang dipilih tetap tajam', blurState.targetSharp, JSON.stringify(blurState));
  check(
    'Kolom daftar dan rail ikut diblur',
    blurState.listBlurred && blurState.railBlurred,
    JSON.stringify(blurState)
  );

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

  /* ---- 3d. Tampilan mengikuti DESIGN.md -------------------------
     Diukur dari gaya yang dihitung, bukan dari kode CSS-nya: yang diuji
     adalah apa yang benar-benar tampil di layar. Dua halaman sekaligus,
     supaya gelembung kirim dan gelembung terima dua-duanya kena. */
  await verifyDesignSystem(andi.page, 'Andi', 'out');
  await verifyDesignSystem(budi.page, 'Budi', 'in');

  /* ---- 3e. Notifikasi pesan + balas dari notifikasi -------------
     Diuji dengan Chrome asli: izin notifikasi, service worker, sampai balasan
     yang diketik di notifikasi benar-benar terkirim ke lawan bicara. */
  await checkNotifications(andi, budi);

  /* ---- 4. Real WebRTC call -------------------------------------- */
  await andi.page.click('#btn-call-audio');
  await budi.page.waitForSelector('#incoming:not([hidden])', { timeout: 15000 });
  const incomingName = await budi.page.$eval('#incoming-name', (e) => e.textContent);
  check('Budi menerima notifikasi panggilan masuk', incomingName === 'andi', incomingName);

  await budi.page.click('#btn-accept');

  await Promise.all([
    andi.page.waitForFunction(
      () =>
        document.querySelector('#call-placeholder')?.hidden === true &&
        window.__bychatCallState?.localStream?.getAudioTracks().length > 0,
      { timeout: 30000 }
    ),
    budi.page.waitForFunction(
      () =>
        document.querySelector('#call-placeholder')?.hidden === true &&
        window.__bychatCallState?.localStream?.getAudioTracks().length > 0,
      { timeout: 30000 }
    ),
  ]);
  // Media baru benar-benar mengalir setelah negosiasi SDP/ICE selesai; tunggu
  // sampai track lawan bicara muncul, bukan cuma sampai overlay terbuka.
  const waitRemote = (page) =>
    page.waitForFunction(
      () => (window.__bychatCallState?.participants?.[0]?.stream?.getTracks().length || 0) >= 2,
      { timeout: 30000 }
    );
  await Promise.all([waitRemote(andi.page), waitRemote(budi.page)]);
  check('Panggilan tersambung dan media mengalir kedua arah', true);

  const readCall = (page) =>
    page.evaluate(() => {
      const remote = document.querySelector('#call-grid video')?.srcObject;
      const local = document.querySelector('#local-video').srcObject;
      return {
        remoteTracks: remote ? remote.getTracks().map((t) => t.kind) : [],
        localTracks: local ? local.getTracks().map((t) => t.kind) : [],
        overlayVisible: getComputedStyle(document.querySelector('#call-overlay')).display !== 'none',
        peerLabel: document.querySelector('#call-name').textContent,
        remoteVideoWidth: document.querySelector('#call-grid video')?.videoWidth || 0,
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

      const remote = document.querySelector('#call-grid video');
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
  await budi.page.waitForFunction(() => (document.querySelector('#call-grid video')?.videoWidth || 0) > 0, {
    timeout: 20000,
  });
  const budiSeesVideo = await budi.page.evaluate(() => document.querySelector('#call-grid video')?.videoWidth || 0);
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

  /* ---- 4b. Tambah orang ke panggilan yang sedang berjalan --------
     Dua peserta sudah tersambung; orang ketiga diundang dari tombol +, dan
     setiap pasangan harus punya koneksi sendiri (mesh). */
  const carol = await login(browser, 'carol');
  activeClients.carol = carol;
  await sleep(600);

  await andi.page.bringToFront();
  await andi.page.click('#ctl-add');
  await andi.page.waitForSelector('.add-person-row', { timeout: 15000 });
  const offered = await andi.page.$$eval('.add-person-row', (nodes) =>
    nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim())
  );
  const pickedCarol = await andi.page.evaluate(() => {
    const row = [...document.querySelectorAll('.add-person-row')].find((node) => /carol/i.test(node.textContent));
    row?.click();
    return Boolean(row);
  });
  check('Tombol tambah orang menawarkan kontak lain', pickedCarol === true, JSON.stringify(offered.slice(0, 4)));

  await carol.page.waitForSelector('#incoming:not([hidden])', { timeout: 15000 });
  check('Orang yang ditambahkan menerima undangan panggilan', true);
  await carol.page.click('#btn-accept');

  const rosterIsThree = (page) =>
    page.waitForFunction(() => window.__bychatCallState?.participants?.length === 2, { timeout: 30000 });
  await Promise.all([rosterIsThree(andi.page), rosterIsThree(budi.page), rosterIsThree(carol.page)]);

  // Media harus sampai di semua pasangan, bukan cuma ke pemanggil pertama.
  const meshMedia = (page) =>
    page.waitForFunction(
      () =>
        (window.__bychatCallState?.participants || []).every(
          (person) => (person.stream?.getTracks().length || 0) >= 2
        ),
      { timeout: 30000 }
    );
  await Promise.all([meshMedia(andi.page), meshMedia(budi.page), meshMedia(carol.page)]);
  check('Panggilan grup: tiga orang saling terhubung dengan media', true);

  // Keluar dari grup tidak boleh memutus panggilan dua orang yang tersisa.
  await carol.page.click('#ctl-hangup');
  await andi.page.waitForFunction(() => window.__bychatCallState?.participants?.length === 1, {
    timeout: 15000,
  });
  check('Peserta bisa keluar tanpa memutus panggilan yang lain', true);
  await carol.context.close();
  await andi.page.bringToFront();

  await andi.page.click('#ctl-hangup');
  await andi.page.waitForFunction(() => document.querySelector('#call-overlay').hidden === true, { timeout: 15000 });
  await budi.page.waitForFunction(() => document.querySelector('#call-overlay').hidden === true, { timeout: 15000 });
  check('Menutup panggilan mengembalikan kedua sisi ke chat', true);

  // Riwayat panggilan ala WhatsApp: tercatat di perangkat pemanggilnya.
  await goView(andi.page, 'calls');
  const callRows = await andi.page.$$eval('#call-list .call-item', (nodes) =>
    nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim())
  );
  check(
    'Panggilan yang barusan tercatat di panel Panggilan',
    callRows.length > 0 && /budi|grup/i.test(callRows[0]),
    JSON.stringify(callRows.slice(0, 2))
  );
  const callEntry = await andi.page.evaluate(() => {
    const row = document.querySelector('#call-list .call-item');
    return { text: row?.textContent.replace(/\s+/g, ' ').trim(), uid: row?.dataset.uid };
  });
  check(
    'Entri panggilan menyebut arah dan durasinya',
    /keluar/i.test(callEntry.text || '') && /dtk|mnt/i.test(callEntry.text || ''),
    JSON.stringify(callEntry)
  );

  // Catatan panggilan juga harus ada di dalam percakapan, bukan cuma di panel.
  await goView(andi.page, 'chats');
  await andi.page.evaluate(() => {
    const row = [...document.querySelectorAll('.chat-item')].find((node) => /budi/i.test(node.textContent));
    row?.click();
  });
  await andi.page.waitForSelector('.msg-call', { timeout: 10000 });
  const callBubble = await andi.page.$eval('.msg-call', (node) => node.textContent.replace(/\s+/g, ' ').trim());
  check(
    'Chat mencatat panggilan terjawab beserta durasinya',
    /panggilan terjawab/i.test(callBubble) && /dtk|mnt/i.test(callBubble),
    callBubble
  );

  // Baru sekarang mereka "pernah chat", jadi status harus bisa sampai ke Budi.
  const statusText = await checkPhotoAndStatus(andi, budi);

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
  // Jarumnya sengaja panjang (potongan asli dari SVG contoh): penanda pendek
  // seperti "a884" bisa kebetulan muncul di ciphertext base64, dan itu bikin
  // pemeriksaan ini gagal karena alasan yang salah.
  const filePlaintext = '<rect x="0" y="0" width="1" height="1" fill="#a8840"/>';
  const fileLeak = serverMemory.match(/.{0,40}a8840.{0,40}/);
  check(
    'Server tidak pernah memegang isi file',
    !serverMemory.includes(filePlaintext) && !fileLeak,
    fileLeak ? fileLeak[0] : ''
  );
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

  /* ---- 6a. Navbar bawah di hp: oval, melayang, berkaca ---------------- */
  const bar = await budi.page.evaluate(() => {
    const node = document.querySelector('#tabbar');
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return {
      display: style.display,
      radius: style.borderRadius,
      backdrop: style.backdropFilter || style.webkitBackdropFilter,
      position: style.position,
      shadow: style.boxShadow,
      background: style.backgroundColor,
      railHidden: getComputedStyle(document.querySelector('#rail')).display === 'none',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      centered: Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2) <= 2,
      floats: rect.bottom <= window.innerHeight && window.innerHeight - rect.bottom >= 8,
      innerWidth: window.innerWidth,
    };
  });
  check(
    'Di hp menu utamanya jadi navbar bawah, bukan rail',
    bar.display === 'flex' && bar.railHidden && bar.width > 0 && bar.height > 0,
    JSON.stringify(bar)
  );
  check(
    'Navbar bawahnya oval, bukan kotak',
    bar.radius === '9999px' || bar.radius === '999px',
    bar.radius
  );
  check(
    'Navbar bawahnya berkaca (blur di belakangnya, bukan putih mati)',
    /blur\(/.test(bar.backdrop) && /rgba\(255, 255, 255, 0\.7/.test(bar.background),
    JSON.stringify({ backdrop: bar.backdrop, background: bar.background })
  );
  check(
    'Navbar bawahnya melayang: nempel di bawah tengah dengan jarak dari tepi',
    bar.position === 'fixed' && bar.centered && bar.floats && bar.shadow !== 'none',
    JSON.stringify(bar)
  );

  // Menekan menu di navbar memindahkan panel, dan percakapan yang terbuka ikut
  // ditutup supaya kembali ke daftar (perilaku WhatsApp di hp).
  await goView(budi.page, 'settings');
  const afterTab = await budi.page.evaluate(() => ({
    panel: document.querySelector('.panel:not([hidden])')?.dataset.panel,
    tabActive: document.querySelector('#tabbar .tab-btn.active')?.dataset.view,
    chatVisible: getComputedStyle(document.querySelector('.chat')).display !== 'none',
  }));
  check(
    'Menekan menu di navbar membuka panelnya dan menutup percakapan',
    afterTab.panel === 'settings' && afterTab.tabActive === 'settings' && afterTab.chatVisible === false,
    JSON.stringify(afterTab)
  );
  await goView(budi.page, 'chats');

  if (await budi.page.$eval('#chat-view', (node) => node.hidden)) {
    await budi.page.click('.chat-item');
    await budi.page.waitForSelector('#chat-view:not([hidden])', { timeout: 10000 });
  }
  const chatDocked = await budi.page.evaluate(() => ({
    tabbar: getComputedStyle(document.querySelector('#tabbar')).display,
    chatVisible: getComputedStyle(document.querySelector('.chat')).display !== 'none',
  }));
  check(
    'Di dalam percakapan, navbar bawah menghilang dan chatnya penuh layar',
    chatDocked.tabbar === 'none' && chatDocked.chatVisible,
    JSON.stringify(chatDocked)
  );

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
        remoteTracks: document.querySelector('#call-grid video')?.srcObject?.getTracks().length ?? 0,
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
