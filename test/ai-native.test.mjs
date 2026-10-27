import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `securechat-ai-native-test-${process.pid}`);

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    upstream.lastRequest = { url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Halo dari Gemini ' }, { text: 'palsu.' }] } }],
      })
    );
  });
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

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
process.env.AI_API_KEY = 'AQ.kunci-baru';
process.env.AI_BASE_URL = `${upstreamBase}/v1beta/openai`;
process.env.AI_MODEL = 'model-uji';
process.env.AI_GEMINI_NATIVE = 'true';

const { server } = await import('../src/server.js');
const { makeDevToken } = await import('../src/auth.js');
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  await fs.rm(TMP, { recursive: true, force: true });
});

test('kunci AQ. memakai endpoint native Gemini dengan x-goog-api-key', async () => {
  const token = makeDevToken({ uid: 'u-ai-native', displayName: 'Penguji' });
  const response = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'user', content: 'Halo' },
        { role: 'assistant', content: 'Hai' },
      ],
    }),
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.reply, 'Halo dari Gemini palsu.');
  assert.equal(upstream.lastRequest.url, '/v1beta/models/model-uji:generateContent');
  assert.equal(upstream.lastRequest.key, 'AQ.kunci-baru');
  assert.equal(upstream.lastRequest.body.systemInstruction.parts[0].role, undefined);
  assert.deepEqual(
    upstream.lastRequest.body.contents.map((entry) => entry.role),
    ['user', 'model']
  );
  assert.equal(upstream.lastRequest.body.generationConfig.maxOutputTokens, 800);
  assert.deepEqual(upstream.lastRequest.body.tools, [{ google_search: {} }, { url_context: {} }]);
});

test('foto dan file teks ikut dikirim ke model', async () => {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const photo = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${makeDevToken({ uid: 'u-ai-foto' })}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Apa isi foto ini?' }],
      attachments: [{ name: 'satu.png', mime: 'image/png', data: image.toString('base64') }],
    }),
  });
  assert.equal(photo.status, 200);
  const photoParts = upstream.lastRequest.body.contents.at(-1).parts;
  assert.deepEqual(photoParts[1], { inlineData: { mimeType: 'image/png', data: image.toString('base64') } });

  const note = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${makeDevToken({ uid: 'u-ai-teks' })}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Ringkas file ini' }],
      attachments: [
        { name: 'catatan.txt', mime: 'text/plain', data: Buffer.from('halo dari file').toString('base64') },
      ],
    }),
  });
  assert.equal(note.status, 200);
  const noteParts = upstream.lastRequest.body.contents.at(-1).parts;
  assert.match(noteParts[1].text, /halo dari file/);
});

test('menolak lampiran yang tidak didukung', async () => {
  const token = makeDevToken({ uid: 'u-ai-tolak' });
  const response = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Buka file ini' }],
      attachments: [{ name: 'aplikasi.exe', mime: 'application/x-msdownload', data: 'AAAA' }],
    }),
  });
  assert.equal(response.status, 400);
});

