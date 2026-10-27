import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import express from 'express';

import { createFirebaseAuthProxy, firebaseAuthUpstream } from '../src/firebase-auth-proxy.js';

const closeServer = (server) => new Promise((resolve) => server.close(resolve));

/* ---- upstream palsu: mencatat apa yang diterimanya ------------------ */

async function startUpstream() {
  const seen = [];

  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });

      if (req.url.startsWith('/__/auth/gzip')) {
        // Disimpan seperti Firebase menyimpannya: gzip + header content-length
        // dari bentuk terkompresinya.
        const gz = zlib.gzipSync('isi halaman login');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-encoding': 'gzip',
          'content-length': String(gz.length),
        });
        return res.end(gz);
      }

      if (req.url.startsWith('/__/auth/move')) {
        res.writeHead(302, {
          location: `http://${req.headers.host}/__/auth/moved?x=1`,
          'set-cookie': 'a=1; Domain=.firebaseapp.com; Path=/; Secure',
        });
        return res.end();
      }

      if (req.url.startsWith('/__/auth/teapot')) {
        res.writeHead(418, { 'content-type': 'text/plain' });
        return res.end('pendek');
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: req.url, method: req.method, body }));
    });
  });

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  return { upstream, seen, base: `http://127.0.0.1:${port}` };
}

async function startProxy(upstreamBase) {
  const app = express();
  app.use('/__/auth', createFirebaseAuthProxy({ upstream: upstreamBase }));
  app.use((_req, res) => res.status(404).type('text/plain').send('bukan jalur login'));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

test('jalur selain /__/auth dibiarkan lewat', async () => {
  const { upstream, base: upstreamBase } = await startUpstream();
  const { server, base } = await startProxy(upstreamBase);

  try {
    const response = await fetch(`${base}/config.json`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'bukan jalur login');
  } finally {
    await closeServer(server);
    await closeServer(upstream);
  }
});

test('permintaan diteruskan apa adanya, termasuk query dan body', async () => {
  const { upstream, seen, base: upstreamBase } = await startUpstream();
  const { server, base } = await startProxy(upstreamBase);

  try {
    const post = await fetch(`${base}/__/auth/handler?apiKey=abc&authType=signInViaRedirect`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'state=xyz&code=123',
    });
    assert.equal(post.status, 200);
    const echoed = await post.json();
    assert.equal(echoed.url, '/__/auth/handler?apiKey=abc&authType=signInViaRedirect');
    assert.equal(echoed.method, 'POST');
    assert.equal(echoed.body, 'state=xyz&code=123');

    // Header milik domain ini tidak boleh ikut menyeberang.
    assert.equal(typeof seen[0].headers.host, 'string');
    assert.equal(seen[0].headers.cookie, undefined);
  } finally {
    await closeServer(server);
    await closeServer(upstream);
  }
});

test('isi yang sudah dibuka fetch tidak dikirim sebagai gzip', async () => {
  const { upstream, base: upstreamBase } = await startUpstream();
  const { server, base } = await startProxy(upstreamBase);

  try {
    const response = await fetch(`${base}/__/auth/gzip`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('content-length'), null);
    // Tanpa header itu, isinya harus teks biasa — bukan byte gzip.
    assert.equal(await response.text(), 'isi halaman login');
  } finally {
    await closeServer(server);
    await closeServer(upstream);
  }
});

test('tujuan internal jadi jalur relatif, cookie tanpa domain asing', async () => {
  const { upstream, base: upstreamBase } = await startUpstream();
  const { server, base } = await startProxy(upstreamBase);

  try {
    const response = await fetch(`${base}/__/auth/move`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/__/auth/moved?x=1');
    const cookie = response.headers.getSetCookie().join(';');
    assert.match(cookie, /a=1/);
    assert.equal(/domain=/i.test(cookie), false);
  } finally {
    await closeServer(server);
    await closeServer(upstream);
  }
});

test('kode status lain juga diteruskan', async () => {
  const { upstream, base: upstreamBase } = await startUpstream();
  const { server, base } = await startProxy(upstreamBase);

  try {
    const response = await fetch(`${base}/__/auth/teapot`);
    assert.equal(response.status, 418);
    assert.equal(await response.text(), 'pendek');
  } finally {
    await closeServer(server);
    await closeServer(upstream);
  }
});

test('upstream yang mati dijawab 502, bukan menggantung', async () => {
  // Port yang tidak ada yang mendengarkan.
  const { server, base } = await startProxy('http://127.0.0.1:1');

  try {
    const response = await fetch(`${base}/__/auth/handler`);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /tidak bisa dihubungi/);
  } finally {
    await closeServer(server);
  }
});

test('alamat upstream hanya dibentuk dari project id yang wajar', () => {
  assert.equal(firebaseAuthUpstream('by-chat-a6521'), 'https://by-chat-a6521.firebaseapp.com');
  for (const bad of ['', null, undefined, '../evil.com', 'a', 'proj/../x', 'proj?x=1']) {
    assert.equal(firebaseAuthUpstream(bad), null, `harus ditolak: ${bad}`);
  }
});
