import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SECURECHAT_SKIP_DOTENV = '1';

const { newBlobPath, isSafePath, createStorage } = await import('../src/storage.js');

test('generated blob paths are random, dated and accepted by the validator', () => {
  const a = newBlobPath('u-abc');
  const b = newBlobPath('u-abc');

  assert.match(a, /^att\/\d{4}\/\d{2}\/u-abc\/[a-f0-9]{32}$/);
  assert.equal(isSafePath(a), true);
  assert.notEqual(a, b, 'path harus unik biar nggak bisa ditebak');
});

test('a uid full of hostile characters cannot escape the storage tree', () => {
  const generated = newBlobPath('../../etc');
  assert.equal(isSafePath(generated), true, generated);
  // Everything that is not [A-Za-z0-9_-] is stripped, so the relative hops and
  // slashes in the uid are gone before the path is assembled.
  assert.equal(generated.includes('..'), false);
  assert.match(generated, /^att\/\d{4}\/\d{2}\/etc\/[a-f0-9]{32}$/);

  const withSlashes = newBlobPath('a/../../b');
  assert.equal(isSafePath(withSlashes), true);
  assert.equal(withSlashes.split('/').length, 5); // att/yyyy/mm/uid/id
});

test('hand-written paths are rejected', () => {
  const rejected = [
    '../../../etc/passwd',
    'att/2026/01/u/../../../../root/.ssh/id_rsa',
    'att/2026/01/u/short',
    'att/2026/01/u/UPPERCASE0000000000000000000000000',
    '/etc/passwd',
    '',
    null,
    undefined,
    42,
    'att/2026/01/u/' + 'z'.repeat(32), // not hex
    'att/2026/01/u/' + 'a'.repeat(31), // too short
  ];

  for (const value of rejected) {
    assert.equal(isSafePath(value), false, `harusnya ditolak: ${value}`);
  }
});

test('the local driver writes and reads back inside its own directory', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'securechat-store-'));
  try {
    const storage = await createStorage({ storage: { driver: 'local', localDir: dir, bucket: 'x' } });
    assert.equal(storage.driver, 'local');

    const blobPath = newBlobPath('u-test');
    await storage.save(blobPath, Buffer.from('ciphertext'));

    assert.equal((await storage.read(blobPath)).toString(), 'ciphertext');
    assert.equal(await storage.createDownloadUrl(blobPath), `/api/blob/${blobPath}`);

    await storage.remove(blobPath);
    await assert.rejects(() => storage.read(blobPath));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
