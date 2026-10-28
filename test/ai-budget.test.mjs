import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Satu permintaan punya satu anggaran waktu. Kalau penyedia utama memakai
// hampir seluruhnya, cadangan tidak boleh dicoba: totalnya akan melewati batas
// proxy dan pengguna melihat 502 dari Cloudflare, bukan pesan dari aplikasi.

const TMP = path.join(os.tmpdir(), `securechat-ai-budget-test-${process.pid}`);

/** Penyedia utama: lambat, tidak pernah sempat menjawab dalam anggaran. */
const primary = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    primary.calls = (primary.calls || 0) + 1;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Terlambat.' }] } }] }));
    }, 3_000).unref();
  });
});
await new Promise((resolve) => primary.listen(0, '127.0.0.1', resolve));

/** Cadangan: cepat, tapi tidak boleh dipanggil pada kasus ini. */
const backup = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    backup.calls = (backup.calls || 0) + 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Jawaban cadangan.' } }] }));
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
process.env.AI_MODEL = 'gemini-3.8-flash';
process.env.AI_GEMINI_NATIVE = 'true';
process.env.AI_TIMEOUT_MS = '1000';
process.env.AI_FALLBACK_BASE_URL = `http://127.0.0.1:${backup.address().port}/v1`;
process.env.AI_FALLBACK_MODEL = 'llama3.2';

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

test('cadangan dilewati kalau anggaran waktunya sudah habis, bukan ditembus', async () => {
  const response = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${makeDevToken({ uid: 'u-anggaran' })}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Halo' }] }),
  });
  const data = await response.json();

  assert.equal(response.status, 502);
  // Yang tampil adalah penyebab aslinya (waktu habis), bukan kegagalan
  // cadangan yang menyesatkan.
  assert.match(data.error, /terlalu lama/);
  assert.equal(primary.calls, 1);
  assert.equal(backup.calls, undefined);
});
