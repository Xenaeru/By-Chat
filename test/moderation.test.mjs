import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createModeration, createModerationStore, REPORT_REASONS } from '../src/moderation.js';
import {
  createAccountIndex,
  createAccountStore,
  looksLikeEmail,
  normalizeEmail,
  phoneMatches,
} from '../src/accounts.js';

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'securechat-moderation-'));
test.after(() => fs.rm(TMP, { recursive: true, force: true }));

let counter = 0;
/** Setiap kasus dapat file sendiri, jadi urutan tes nggak bisa saling ganggu. */
const fileConfig = () => {
  const stamp = `${process.pid}-${counter++}`;
  return {
    storage: { driver: 'local', bucket: 'attachments' },
    moderation: {
      file: path.join(TMP, `moderation-${stamp}.json`),
      object: 'registry/moderation.json',
    },
    accounts: {
      file: path.join(TMP, `accounts-${stamp}.json`),
      object: 'registry/accounts.json',
    },
    secrets: { supabaseUrl: '', supabaseServiceKey: '' },
  };
};

const freshModeration = async () => {
  const config = fileConfig();
  const store = await createModerationStore(config);
  const moderation = await createModeration({ store });
  await moderation.load();
  return { moderation, store, config };
};

const freshAccounts = async () => {
  const config = fileConfig();
  const store = await createAccountStore(config);
  const index = await createAccountIndex({ store });
  await index.load();
  return { index, store, config };
};

/* ------------------------------------------------------------------ *
 * Nomor HP
 * ------------------------------------------------------------------ */

test('a phone number is matched by its last nine digits, whatever the format', () => {
  // Cara orang menulis nomor yang sama berbeda-beda; yang penting orangnya sama.
  assert.equal(phoneMatches('+62 812-3456-789', '08123456789'), true);
  assert.equal(phoneMatches('08123456789', '+628123456789'), true);
  assert.equal(phoneMatches('+628123456789', '628123456789'), true);

  // Yang beda harus tetap beda.
  assert.equal(phoneMatches('+628123456789', '08123456780'), false);
  assert.equal(phoneMatches('+628123456789', ''), false);
  assert.equal(phoneMatches('', '08123456789'), false);
  // Potongan yang terlalu pendek bukan pencocokan, cuma tebakan.
  assert.equal(phoneMatches('+628123456789', '812'), false);
  assert.equal(phoneMatches('0812', '0812'), true, 'sama persis tetap cocok');
});

test('an email is only a match when it is exactly the same address', () => {
  assert.equal(looksLikeEmail('budi@contoh.id'), true);
  assert.equal(looksLikeEmail('  Budi@Contoh.ID '), true);
  assert.equal(looksLikeEmail('budi'), false);
  assert.equal(looksLikeEmail('budi@contoh'), false);
  assert.equal(normalizeEmail(' Budi@CONTOH.id '), 'budi@contoh.id');
});

/* ------------------------------------------------------------------ *
 * Indeks akun
 * ------------------------------------------------------------------ */

test('the account index finds people by email or phone, and never clears what it has', async () => {
  const { index } = await freshAccounts();

  await index.upsert({ uid: 'u-budi', email: 'Budi@Contoh.id', phone: '+628111222333' });
  assert.equal((await index.findByEmail('budi@contoh.id')).map((e) => e.uid).join(), 'u-budi');
  assert.equal((await index.findByPhone('08111222333')).map((e) => e.uid).join(), 'u-budi');

  // Masuk lagi pakai nomor saja: emailnya tetap tersimpan.
  assert.equal(await index.upsert({ uid: 'u-budi', phone: '+628111222333' }), false, 'tidak ada yang berubah');
  assert.equal(index.get('u-budi').email, 'budi@contoh.id');

  // Ada yang benar-benar berubah → true, supaya pemanggilnya tahu kapan menulis.
  assert.equal(await index.upsert({ uid: 'u-budi', phone: '+628999888777' }), true);
  assert.equal(index.get('u-budi').phone, '+628999888777');

  // Akun tanpa apa-apa tidak dicatat, dan email kosong bukan email orang lain.
  assert.equal(await index.upsert({ uid: 'u-sepi' }), false);
  assert.equal(index.size(), 1);
  assert.deepEqual(await index.findByEmail(''), []);
});

test('the account index survives a restart', async () => {
  const first = await freshAccounts();
  await first.index.upsert({ uid: 'u-rita', email: 'rita@contoh.id', phone: '081234567890' });

  const reopened = await createAccountIndex({ store: await createAccountStore(first.config) });
  assert.equal(await reopened.load(), 1);
  assert.equal((await reopened.findByEmail('RITA@contoh.id')).length, 1);
  assert.equal((await reopened.findByPhone('+62 812 3456 7890')).length, 1);
});

/* ------------------------------------------------------------------ *
 * Laporan
 * ------------------------------------------------------------------ */

const reasons = () => REPORT_REASONS.map((reason) => reason.id);

test('a report is stored with who, why and when — and nothing else', async () => {
  const { moderation } = await freshModeration();

  const result = await moderation.report({
    from: 'u-pelapor',
    fromName: 'pelapor',
    about: 'u-nakal',
    aboutName: 'nakal',
    reason: 'spam',
    detail: 'kirim   iklan\nberulang-ulang',
    context: 'dm:uji',
  });

  assert.equal(result.ok, true);
  assert.equal(result.report.status, 'open');
  assert.equal(result.report.reasonLabel, 'Spam atau iklan');
  assert.equal(result.report.from, 'u-pelapor');
  assert.equal(result.report.about, 'u-nakal');
  // Detail dirapikan: karakter kontrol jadi spasi, jadi tidak ada baris yang
  // bisa menyamarkan isinya di halaman admin.
  assert.equal(result.report.detail, 'kirim iklan berulang-ulang');

  assert.equal(moderation.openReportCount(), 1);
  // Laporan tidak memblokir siapa pun.
  assert.equal(moderation.isBanned('u-nakal'), false);
});

test('reports that make no sense are refused with a message a person can act on', async () => {
  const { moderation } = await freshModeration();

  const base = { from: 'u-aku', fromName: 'aku', about: 'u-dia', aboutName: 'dia' };
  assert.equal((await moderation.report({ ...base, reason: 'entah' })).ok, false);
  assert.equal((await moderation.report({ ...base, reason: 'spam', about: 'u-aku' })).ok, false, 'diri sendiri');
  assert.equal((await moderation.report({ ...base, reason: 'spam', from: '' })).ok, false, 'pelapor kosong');

  // Laporan yang belum ditangani tidak perlu ditumpuk untuk orang yang sama.
  assert.equal((await moderation.report({ ...base, reason: 'spam' })).ok, true);
  const duplicate = await moderation.report({ ...base, reason: 'kasar' });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /masih diproses/i);

  // Setelah ditangani, laporan baru soal orang yang sama diterima lagi.
  const first = moderation.reports()[0];
  await moderation.setReportStatus(first.id, 'resolved', { by: 'admin' });
  assert.equal((await moderation.report({ ...base, reason: 'kasar' })).ok, true);
});

test('one account cannot flood the admin page with reports', async () => {
  const { moderation } = await freshModeration();

  let accepted = 0;
  let refused = null;
  for (let i = 0; i < 14; i++) {
    const result = await moderation.report({
      from: 'u-spam',
      fromName: 'spam',
      about: `u-korban${i}`,
      aboutName: `korban${i}`,
      reason: 'lain',
    });
    if (result.ok) accepted++;
    else refused = result.error;
  }

  assert.equal(accepted, 10, 'harus berhenti di batas per jam');
  assert.match(refused, /banyak laporan/i);
});

test('handling a report records who did it, and rejects what it cannot do', async () => {
  const { moderation } = await freshModeration();
  const { report } = await moderation.report({
    from: 'u-a',
    fromName: 'a',
    about: 'u-b',
    aboutName: 'b',
    reason: 'palsu',
  });

  const bad = await moderation.setReportStatus(report.id, 'selesai', { by: 'admin' });
  assert.equal(bad.ok, false);

  const done = await moderation.setReportStatus(report.id, 'dismissed', { by: 'petugas', note: 'sudah dicek' });
  assert.equal(done.ok, true);
  assert.equal(done.report.status, 'dismissed');
  assert.equal(done.report.handledBy, 'petugas');
  assert.ok(done.report.handledAt);
  assert.equal(moderation.openReportCount(), 0);

  assert.equal((await moderation.setReportStatus('rep-tidak-ada', 'resolved')).ok, false);
});

/* ------------------------------------------------------------------ *
 * Blokir
 * ------------------------------------------------------------------ */

test('a ban keeps its reason, can be lifted, and survives a restart', async () => {
  const { moderation, config } = await freshModeration();

  const ban = await moderation.ban('u-nakal', { reason: 'nyebar link', by: 'admin@contoh.id', username: 'nakal' });
  assert.equal(ban.reason, 'nyebar link');
  assert.equal(moderation.isBanned('u-nakal'), true);
  assert.equal(moderation.banInfo('u-nakal').by, 'admin@contoh.id');

  // Id yang tidak masuk akal tidak boleh jadi kunci di daftar blokir.
  assert.equal(await moderation.ban(''), null);
  assert.equal(moderation.bannedCount(), 1);

  const reopened = await createModeration({ store: await createModerationStore(config) });
  const restored = await reopened.load();
  assert.equal(restored.bans, 1);
  assert.equal(reopened.isBanned('u-nakal'), true);
  assert.equal(reopened.banInfo('u-nakal').username, 'nakal');
  assert.equal(reopened.banInfo('u-nakal').reason, 'nyebar link');

  assert.equal(await reopened.unban('u-nakal'), true);
  assert.equal(await reopened.unban('u-nakal'), false, 'membuka dua kali harus bilang tidak ada');
  assert.equal(reopened.isBanned('u-nakal'), false);
});

test('a damaged file cannot crash the boot or invent a ban', async () => {
  const config = fileConfig();
  await fs.writeFile(config.moderation.file, '{ ini bukan json');

  const moderation = await createModeration({ store: await createModerationStore(config) });
  await moderation.load();
  assert.equal(moderation.bannedCount(), 0);
  assert.equal(moderation.reports().length, 0);

  // Barang yang ditulis tangan pun disaring: uid aneh dan alasan kepanjangan.
  await fs.writeFile(
    config.moderation.file,
    JSON.stringify({
      bans: { '': { reason: 'x' }, 'u-ok': { reason: 'y'.repeat(500), username: 'ok' } },
      reports: [{ from: '', about: 'u-x', reason: 'spam' }],
    })
  );
  const second = await createModeration({ store: await createModerationStore(config) });
  await second.load();
  assert.equal(second.bannedCount(), 1);
  assert.equal(second.banInfo('u-ok').reason.length, 200);
  assert.equal(second.reports().length, 0, 'laporan tanpa pelapor harus dibuang');
});

test('saving failures are reported, not hidden', async () => {
  const moderation = await createModeration({
    store: {
      kind: 'rusak',
      async read() {
        return null;
      },
      async write() {
        throw new Error('Gagal simpan data moderasi: bucket penuh');
      },
    },
  });

  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await moderation.ban('u-x', { reason: 'coba' });
  } finally {
    console.warn = original;
  }

  // Blokirnya tetap berlaku di memori, tapi pengguna diberi tahu risikonya.
  assert.equal(moderation.isBanned('u-x'), true);
  assert.match(warnings.join('\n'), /bucket penuh/);
});
