import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `securechat-ai-test-${process.pid}`);

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    upstream.lastRequest = { url: req.url, auth: req.headers.authorization, body: parsed };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Halo dari AI palsu.' } }] }));
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
process.env.AI_API_KEY = 'kunci-uji';
process.env.AI_BASE_URL = upstreamBase;
process.env.AI_MODEL = 'model-uji';
process.env.AI_DAILY_LIMIT = '2';

const { server } = await import('../src/server.js');
const { makeDevToken } = await import('../src/auth.js');
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  await fs.rm(TMP, { recursive: true, force: true });
});

const token = makeDevToken({ uid: 'u-ai', displayName: 'Penguji' });

async function ask(messages) {
  const response = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  return { status: response.status, body: await response.json() };
}

test('meneruskan percakapan ke penyedia dan mengembalikan jawaban', async () => {
  const result = await ask([{ role: 'user', content: 'Halo' }]);
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'Halo dari AI palsu.');
  assert.equal(upstream.lastRequest.auth, 'Bearer kunci-uji');
  assert.equal(upstream.lastRequest.body.model, 'model-uji');
  assert.equal(upstream.lastRequest.body.messages[0].role, 'system');
  assert.deepEqual(upstream.lastRequest.body.messages.at(-1), { role: 'user', content: 'Halo' });
});

test('menolak permintaan tanpa pesan pengguna', async () => {
  const result = await ask([{ role: 'assistant', content: 'Halo' }]);
  assert.equal(result.status, 400);
});

test('kuota harian per akun ditegakkan', async () => {
  // Satu permintaan sukses sudah memakai kuota di tes pertama.
  assert.equal((await ask([{ role: 'user', content: 'Kedua' }])).status, 200);
  const third = await ask([{ role: 'user', content: 'Ketiga' }]);
  assert.equal(third.status, 429);
  assert.match(third.body.error, /Kuota/);
});
