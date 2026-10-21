/**
 * files.js — sending and receiving attachments.
 *
 * The file is encrypted *before* it leaves the browser. The storage service
 * only ever holds ciphertext under a randomly generated path. The key lives
 * inside the encrypted chat message, so it reaches the recipient through the
 * same end-to-end channel as the text — the server and the storage provider
 * both never see it.
 */

import { encryptFile, decryptFile } from './crypto.js';

const authHeaders = (token) => ({ authorization: `Bearer ${token}` });

/** The blob URL is served by our own server, so it needs our token. */
const isLocalUrl = (url) => url.startsWith('/');

function request(method, url, { token, body, headers = {}, onProgress, responseType = '' }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    // Without this the download arrives as a string, and decryptFile would be
    // handed text instead of bytes.
    xhr.responseType = responseType;
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    if (isLocalUrl(url)) xhr.setRequestHeader('authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr);
      else reject(new Error(`Upload/gagal (${xhr.status}): ${xhr.responseText?.slice(0, 200) || ''}`));
    };
    xhr.onerror = () => reject(new Error('Koneksi ke penyimpanan gagal'));
    xhr.send(body ?? null);
  });
}

async function postJson(path, token, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request gagal (${res.status})`);
  return data;
}

/**
 * Encrypt + upload. `onStage` reports (stage, fraction) so the UI can show
 * "mengenkripsi 40%" then "mengunggah 70%".
 */
export async function uploadAttachment({ file, getIdToken, onStage, maxBytes }) {
  if (maxBytes && file.size > maxBytes) {
    throw new Error(`File terlalu besar. Maksimal ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }

  const token = await getIdToken();
  if (!token) throw new Error('Belum login');

  onStage?.('encrypt', 0);
  const { blob, meta } = await encryptFile(file, (fraction) => onStage?.('encrypt', fraction));

  const target = await postJson('/api/attachments/request-upload', token, { size: blob.size });

  onStage?.('upload', 0);
  await request(target.method || 'PUT', target.url, {
    token,
    body: blob,
    headers: target.headers || {},
    onProgress: (fraction) => onStage?.('upload', fraction),
  });

  // Everything the recipient needs to decrypt, minus the key itself which
  // travels inside the encrypted message.
  return {
    path: target.path,
    fileId: meta.fileId,
    totalChunks: meta.totalChunks,
    key: meta.key,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
  };
}

/** Fetch the ciphertext, then decrypt it locally into a blob URL. */
export async function fetchAttachment({ attachment, getIdToken, onStage }) {
  const token = await getIdToken();
  if (!token) throw new Error('Belum login');

  const { url } = await postJson('/api/attachments/link', token, { path: attachment.path });

  onStage?.('download', 0);
  const xhr = await request('GET', url, {
    token,
    responseType: 'blob',
    onProgress: (fraction) => onStage?.('download', fraction),
  });

  onStage?.('decrypt', 0);
  const plain = await decryptFile(xhr.response, {
    fileId: attachment.fileId,
    totalChunks: attachment.totalChunks,
    key: attachment.key,
  });
  // Hasil dekripsi tidak membawa tipe mime, dan tanpa itu <video>/<audio> di
  // penampil ragu-ragu memutar isinya. Tipe aslinya sudah ikut di attachment.
  return URL.createObjectURL(new Blob([plain], { type: attachment.mime || 'application/octet-stream' }));
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
