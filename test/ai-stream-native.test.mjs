import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Jalur streaming native Gemini memakai bentuk event yang berbeda
// (`candidates[].content.parts[]`), dan proses berpikirnya datang sebagai part
// bertanda `thought` yang tidak boleh ikut tampil sebagai jawaban.

const TMP = path.join(os.tmpdir(), `securechat-ai-stream-native-test-${process.pid}`);

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    upstream.lastRequest = { url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { candidates: [{ content: { parts: [{ text: 'Menimbang dulu…', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'Jawaban ' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'pertama.' }] }, finishReason: 'STOP' }] },
    ];
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\r\n\r\n`);
    res.end();
  });
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

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
process.env.AI_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1beta/openai`;
process.env.AI_MODEL = 'gemini-3.8-flash';
// Base URL di sini server palsu, jadi jalur native harus dipaksa seperti di
// .env sungguhan (AI_GEMINI_NATIVE=true untuk Gemini di balik proxy).
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

test('Gemini mengalir lewat streamGenerateContent tanpa membocorkan proses berpikir', async () => {
  const response = await fetch(`${baseUrl}/api/ai/stream`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${makeDevToken({ uid: 'u-native-stream' })}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Halo' }] }),
  });

  assert.equal(response.status, 200);
  const events = (await response.text())
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data:')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(5).trim()));

  assert.deepEqual(
    events.filter((event) => event.delta).map((event) => event.delta),
    ['Jawaban ', 'pertama.']
  );
  assert.equal(events.at(-1).done, true);
  assert.equal(upstream.lastRequest.url, '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
  assert.equal(upstream.lastRequest.key, 'AQ.kunci-uji');
  // Sama seperti jalur sekali-jalan: thinking diminta rendah untuk Gemini 3.
  assert.deepEqual(upstream.lastRequest.body.generationConfig.thinkingConfig, {
    thinkingLevel: 'LOW',
  });
});
