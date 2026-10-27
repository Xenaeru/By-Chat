import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `securechat-ai-fallback-test-${process.pid}`);

const primary = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    primary.calls = (primary.calls || 0) + 1;
    primary.lastRequest = { url: req.url, body: JSON.parse(body) };
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Kuota Gemini habis.' } }));
  });
});
await new Promise((resolve) => primary.listen(0, '127.0.0.1', resolve));

const backup = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    backup.calls = (backup.calls || 0) + 1;
    backup.lastRequest = { url: req.url, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Jawaban dari llama cadangan.' } }] }));
  });
});
await new Promise((resolve) => backup.listen(0, '127.0.0.1', resolve));

process.env.SECURECHAT_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = TMP;
process.env.LOCAL_AVATAR_DIR = path.join(TMP, 'avatars');
process.env.USERNAME_STORE = path.join(TMP, 'usernames.json');
process.env.MODERATION_STORE = path.join(TMP, 'moderation.json');
process.env.ACCOUNT_STORE = path.join(TMP, 'accounts.json');
process.env.PUSH_STORE = path.join(TMP, 'push.json');
process.env.CREDENTIAL_STORE = path.join(TMP, 'credentials.json');
process.env.PROFILE_STORE = path.join(TMP, 'profiles.json');
process.env.CHANNEL_STORE = path.join(TMP, 'channels.json');
process.env.PORT = '0';
process.env.AI_ENABLED = 'true';
process.env.AI_API_KEY = 'AQ.kunci-uji';
process.env.AI_BASE_URL = `http://127.0.0.1:${primary.address().port}/v1beta/openai`;
process.env.AI_MODEL = 'gemini-uji';
process.env.AI_GEMINI_NATIVE = 'true';
process.env.AI_DAILY_LIMIT = '0';
process.env.AI_FALLBACK_BASE_URL = `http://127.0.0.1:${backup.address().port}`;
process.env.AI_FALLBACK_MODEL = 'llama3.2';
process.env.AI_FALLBACK_API_KEY = '';

const { server } = await import('../src/server.js');
const { makeDevToken } = await import('../src/auth.js');
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => primary.close(resolve));
  await new Promise((resolve) => backup.close(resolve));
  await fs.rm(TMP, { recursive: true, force: true });
});

function ask(uid, extra = {}) {
  const token = makeDevToken({ uid, displayName: 'Penguji' });
  return fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Halo' }], ...extra }),
  });
}

test('429 dari Gemini otomatis pindah ke provider cadangan', async () => {
  const response = await ask('u-ai-fallback');
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.reply, 'Jawaban dari llama cadangan.');
  assert.equal(primary.calls, 1);
  assert.equal(backup.calls, 1);
  assert.equal(backup.lastRequest.body.model, 'llama3.2');
  assert.deepEqual(backup.lastRequest.body.messages.at(-1), { role: 'user', content: 'Halo' });
});

test('lampiran tidak diam-diam dibuang saat cadangan bukan Gemini', async () => {
  const before = backup.calls;
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const response = await ask('u-ai-fallback-foto', {
    attachments: [{ name: 'satu.png', mime: 'image/png', data: image.toString('base64') }],
  });
  const data = await response.json();

  assert.equal(response.status, 502);
  assert.match(data.error, /Kuota Gemini habis/);
  assert.equal(backup.calls, before);
});
