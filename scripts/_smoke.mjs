import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bychat-smoke-'));
process.env.SECURECHAT_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = path.join(TMP, 'attachments');
process.env.LOCAL_AVATAR_DIR = path.join(TMP, 'avatars');
process.env.USERNAME_STORE = path.join(TMP, 'usernames.json');
process.env.MODERATION_STORE = path.join(TMP, 'moderation.json');
process.env.ACCOUNT_STORE = path.join(TMP, 'accounts.json');
process.env.CREDENTIAL_STORE = path.join(TMP, 'credentials.json');
process.env.PROFILE_STORE = path.join(TMP, 'profiles.json');
process.env.CHANNEL_STORE = path.join(TMP, 'channels.json');
process.env.PORT = '4600';

const { server } = await import('../src/server.js');
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));

const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

const fail = (message) => {
  console.error('GAGAL:', message);
  process.exitCode = 1;
};

try {
  await page.goto('http://127.0.0.1:4600', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login:not([hidden])', { timeout: 15000 });
  await page.type('#login-username', 'tester');
  await page.click('#login-submit');

  await page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
  await page.waitForSelector('#onboarding:not([hidden])', { timeout: 15000 });
  await page.type('#username-input', 'tester');
  await page.waitForFunction(() => !document.querySelector('#username-submit').disabled, { timeout: 10000 });
  await page.click('#username-submit');
  await page.waitForSelector('#onboarding[hidden]', { timeout: 15000 });
  console.log('login + username ok');

  await page.click('.rail [data-view="settings"]');
  await page.waitForSelector('#me-id');
  await page.waitForFunction(() => /ID \d{6,12}/.test(document.querySelector('#me-id')?.textContent || ''), {
    timeout: 15000,
  });
  const idText = await page.$eval('#me-id', (node) => node.textContent.trim());
  console.log('ID:', idText);

  await page.click('#public-profile-toggle');
  await page.waitForFunction(
    () => document.querySelector('#public-profile-toggle')?.getAttribute('aria-checked') === 'false',
    { timeout: 10000 }
  );
  console.log('toggle publik ok:', await page.$eval('[data-public-note]', (node) => node.textContent));

  await page.click('#btn-edit-profile');
  await page.waitForSelector('#edit-about');
  await page.type('#edit-about', 'Halo dari tes');
  await page.type('#edit-birth', '1999');
  await page.click('.modal-card [data-save]');
  await page.waitForFunction(
    () => document.querySelector('#me-about')?.textContent.includes('Halo dari tes'),
    { timeout: 15000 }
  );
  console.log('edit profil ok:', await page.$eval('#me-birth', (node) => node.textContent));

  await page.click('.rail [data-view="status"]');
  await page.waitForSelector('#btn-create-channel');
  await page.click('#btn-create-channel');
  await page.waitForSelector('#channel-name');
  await page.type('#channel-name', 'Kanal Uji');
  await page.type('#channel-desc', 'Deskripsi kanal uji');
  await page.click('.modal-card [data-create]');
  await page.waitForSelector('#chat-view:not([hidden])', { timeout: 15000 });
  console.log('saluran dibuat:', await page.$eval('#peer-name', (node) => node.textContent));

  await page.type('#composer-input', 'Pesan pertama saluran');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('.msg.channel .msg-text')?.textContent.includes('Pesan pertama'),
    { timeout: 15000 }
  );
  console.log('postingan saluran ok');

  await page.click('#peer-name');
  await page.waitForSelector('#info-panel:not([hidden])', { timeout: 10000 });
  const infoText = await page.$eval('#info-body', (node) => node.textContent.replace(/\s+/g, ' ').trim());
  console.log('panel info:', infoText.slice(0, 160));
  await page.click('#info-close');

  await page.click('.rail [data-view="chats"]');
  await page.click('#btn-new-chat');
  await page.waitForSelector('#contact-page:not([hidden])');
  await page.type('#contact-query', idText.replace('ID ', ''));
  await page.click('#contact-submit');
  await page.waitForFunction(() => !document.querySelector('#contact-note').hidden, { timeout: 10000 });
  console.log('cari ID sendiri:', await page.$eval('#contact-note', (node) => node.textContent));

  console.log('console errors:', errors.length ? errors : '(tidak ada)');
} catch (error) {
  fail(error.message);
  console.log('console errors:', errors);
  await page.screenshot({ path: '/tmp/bychat-smoke-fail.png' }).catch(() => {});
} finally {
  await browser.close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
