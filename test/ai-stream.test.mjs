import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Jalur streaming bersama penyedia OpenAI-compat (Ollama, Groq, ...): jawaban
// harus sampai sepotong-sepotong, bukan setelah semuanya selesai.

const TMP = path.join(os.tmpdir(), `securechat-ai-stream-test-${process.pid}`);

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    upstream.lastRequest = { url: req.url, body: parsed };
    const last = parsed.messages?.at(-1)?.content || '';

    if (last.includes('gagal')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Kuota penyedia habis.' } }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of ['Halo', ' dari', ' llama.']) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
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
process.env.AI_API_KEY = '';
process.env.AI_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
process.env.AI_MODEL = 'llama3.2:1b';
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

function ask(uid, content) {
  return fetch(`${baseUrl}/api/ai/stream`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${makeDevToken({ uid })}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content }] }),
  });
}

/** Pisahkan balasan SSE jadi daftar payload JSON. */
function parseSse(text) {
  return text
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data:')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(5).trim()));
}

test('jawaban dikirim sepotong-sepotong lalu ditutup penanda selesai', async () => {
  const response = await ask('u-stream', 'Halo');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const events = parseSse(await response.text());
  const deltas = events.filter((event) => event.delta).map((event) => event.delta);
  assert.deepEqual(deltas, ['Halo', ' dari', ' llama.']);

  const done = events.at(-1);
  assert.equal(done.done, true);
  assert.equal(done.remaining, 1);
  // Penyedia memang diminta mengalir, bukan menjawab utuh.
  assert.equal(upstream.lastRequest.url, '/v1/chat/completions');
  assert.equal(upstream.lastRequest.body.stream, true);
});

test('kuota dihitung sekali per balasan yang selesai', async () => {
  const first = await ask('u-stream-kuota', 'Halo');
  assert.equal(parseSse(await first.text()).at(-1).remaining, 1);

  const second = await ask('u-stream-kuota', 'Halo lagi');
  assert.equal(parseSse(await second.text()).at(-1).remaining, 0);

  // Permintaan ketiga ditolak sebelum aliran dibuka, jadi balasannya JSON biasa.
  const blocked = await ask('u-stream-kuota', 'Halo sekali lagi');
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).error, /Kuota/);
});

test('kegagalan penyedia dilaporkan sebagai pesan, bukan koneksi mati', async () => {
  const response = await ask('u-stream-gagal', 'tolong gagal');
  assert.equal(response.status, 200);

  const events = parseSse(await response.text());
  assert.equal(events.length, 1);
  assert.match(events[0].error, /Kuota penyedia habis/);
});
