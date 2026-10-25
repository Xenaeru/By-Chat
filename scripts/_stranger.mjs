import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as ioClient } from 'socket.io-client';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bychat-stranger-'));
process.env.SECURECHAT_SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = path.join(TMP, 'attachments');
process.env.LOCAL_AVATAR_DIR = path.join(TMP, 'avatars');
process.env.USERNAME_STORE = path.join(TMP, 'usernames.json');
process.env.MODERATION_STORE = path.join(TMP, 'moderation.json');
process.env.ACCOUNT_STORE = path.join(TMP, 'accounts.json');
process.env.CREDENTIAL_STORE = path.join(TMP, 'credentials.json');
process.env.PROFILE_STORE = path.join(TMP, 'profiles.json');
process.env.CHANNEL_STORE = path.join(TMP, 'channels.json');
process.env.PORT = '4610';

const { server } = await import('../src/server.js');
const { makeDevToken } = await import('../src/auth.js');
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));

const socket = ioClient('http://127.0.0.1:4610', {
  transports: ['websocket'],
  forceNew: true,
  auth: {
    token: makeDevToken({ uid: 'u-cici', displayName: 'cici' }),
    publicKey: { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) },
  },
});

const withTimeout = (promise, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), 4000)),
  ]);

socket.on('connect', () => console.log('connected'));
socket.on('connect_error', (error) => console.log('connect_error', error.message));
socket.on('ready', (payload) => console.log('ready, me=', payload.me));

await withTimeout(new Promise((resolve) => socket.once('connect', resolve)), 'connect');
console.log('connected flag:', socket.connected, 'id:', socket.id);
const synced = await withTimeout(
  new Promise((resolve) => socket.emit('sync', {}, resolve)),
  'sync'
);
console.log('synced, users:', synced?.directory?.length);
const claimed = await withTimeout(
  new Promise((resolve) => socket.emit('username:claim', 'cici', resolve)),
  'claim'
);
console.log('claimed', claimed);

const published = await withTimeout(
  new Promise((resolve) => socket.emit('status:publish', { payload: { ct: 'blob-palsu' }, members: [] }, resolve)),
  'publish'
);
console.log('published', published);

socket.close();
server.close();
fs.rmSync(TMP, { recursive: true, force: true });
