import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `securechat-ai-thinking-test-${process.pid}`);

/**
 * Penyedia palsu yang menjawab sesuai kata kunci di pesan terakhir, supaya
 * satu server bisa memerankan beberapa kondisi Gemini sekaligus.
 */
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    const parts = parsed.contents?.at(-1)?.parts || [];
    const text = parts.map((part) => part.text || '').join(' ');
    upstream.lastRequest = { url: req.url, body: parsed };

    const send = (payload, delay = 0) => {
      if (delay) {
        // unref: timer yang tidak terpakai tidak boleh menahan proses tes.
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        }, delay).unref();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (text.includes('lambat')) {
      send({ candidates: [{ content: { parts: [{ text: 'Terlambat.' }] } }] }, 3000);
      return;
    }
    if (text.includes('kepotong')) {
      // Persis yang terjadi kalau jatah token habis dipakai berpikir.
      send({ candidates: [{ finishReason: 'MAX_TOKENS' }] });
      return;
    }
    if (text.includes('pikir')) {
      send({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Menimbang pilihan...', thought: true },
                { text: 'Ini jawaban.' },
              ],
            },
          },
        ],
      });
      return;
    }
    send({ candidates: [{ content: { parts: [{ text: 'Halo dari Gemini palsu.' }] } }] });
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
process.env.AI_API_KEY = 'AQ.kunci-uji';
process.env.AI_BASE_URL = `${upstreamBase}/v1beta/openai`;
// Model Gemini 3: satu-satunya keluarga yang menerima thinkingLevel.
process.env.AI_MODEL = 'gemini-3.8-flash';
process.env.AI_GEMINI_NATIVE = 'true';
process.env.AI_TIMEOUT_MS = '1500';

const { server } = await import('../src/server.js');
const { makeDevToken } = await import('../src/auth.js');
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  await fs.rm(TMP, { recursive: true, force: true });
});

async function ask(content) {
  const response = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: {
      // uid harus lolos UID_RE server: hanya huruf/angka/tanda hubung.
      Authorization: `Bearer ${makeDevToken({ uid: `u-${content.replace(/[^a-z0-9]/gi, '')}` })}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content }] }),
  });
  return { status: response.status, body: await response.json() };
}

test('Gemini 3 diminta berpikir seperlunya, bukan setinggi mungkin', async () => {
  const result = await ask('halo');
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'Halo dari Gemini palsu.');
  assert.deepEqual(upstream.lastRequest.body.generationConfig.thinkingConfig, {
    // Enum REST-nya huruf besar; klien lain mengirim huruf kecil, keduanya
    // diterima, tapi yang dikirim di sini harus bentuk kanoniknya.
    thinkingLevel: 'LOW',
  });
  // Default 2048: token thinking ikut dihitung, jadi 800 terlalu sempit.
  assert.equal(upstream.lastRequest.body.generationConfig.maxOutputTokens, 2048);
});

test('proses berpikir model tidak ikut jadi jawaban', async () => {
  const result = await ask('pikir dulu');
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'Ini jawaban.');
});

test('jawaban yang kepotong dijelaskan sebagai batas token, bukan "kosong"', async () => {
  const result = await ask('kepotong');
  assert.equal(result.status, 502);
  assert.match(result.body.error, /kepotong/);
  assert.match(result.body.error, /AI_MAX_TOKENS/);
});

test('batas waktu mengikuti AI_TIMEOUT_MS dan menyebut detiknya', async () => {
  const started = Date.now();
  const result = await ask('lambat');
  const elapsed = Date.now() - started;
  assert.equal(result.status, 502);
  assert.match(result.body.error, /terlalu lama/);
  // Dipotong di ~1,5 detik, bukan menunggu 3 detik jawaban upstream.
  assert.ok(elapsed < 2600, `butuh ${elapsed}ms`);
});
