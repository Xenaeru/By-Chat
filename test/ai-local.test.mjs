import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// AI lokal (Ollama) tidak punya API key. Skenario ini memastikan server tetap
// menyalakan fiturnya, tidak mengirim header Authorization kosong ke Ollama,
// dan memakai jalur OpenAI-compat — bukan jalur native Gemini.

const TMP = path.join(os.tmpdir(), `securechat-ai-local-test-${process.pid}`);

const ollama = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    ollama.lastRequest = {
      url: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(body),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Halo dari llama lokal.' } }] })
    );
  });
});
await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));

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
// AI_ENABLED sengaja tidak diisi: server harus menyimpulkannya sendiri.
delete process.env.AI_ENABLED;
process.env.AI_API_KEY = '';
process.env.AI_BASE_URL = `http://127.0.0.1:${ollama.address().port}/v1`;
process.env.AI_MODEL = 'llama3.2';

const { server } = await import('../src/server.js');
const { makeDevToken } = await import('../src/auth.js');
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => ollama.close(resolve));
  await fs.rm(TMP, { recursive: true, force: true });
});

test('base URL lokal menyalakan By AI walau tanpa API key', async () => {
  const config = await (await fetch(`${baseUrl}/config.json`)).json();
  assert.equal(config.ai.enabled, true);
});

test('permintaan ke Ollama tidak membawa header Authorization', async () => {
  const response = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${makeDevToken({ uid: 'u-lokal' })}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Halo' }] }),
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.reply, 'Halo dari llama lokal.');
  assert.equal(ollama.lastRequest.url, '/v1/chat/completions');
  assert.equal(ollama.lastRequest.auth, undefined);
  assert.equal(ollama.lastRequest.body.model, 'llama3.2');
  // Jalur native Gemini tidak boleh ikut aktif hanya karena Thinking diisi.
  assert.equal(ollama.lastRequest.body.contents, undefined);
});
