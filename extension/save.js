// Saving a screenshot to a directory. Runs in the service worker (no DOM, no object URLs: the download
// goes through a data URL). The result handling lives in the host (here: the extension), never in core.

import { t } from './i18n.js';

// Until a directory is chosen: Chrome's download directory itself ('' = no subdirectory; the downloads API
// cannot take an absolute path).
export const DEFAULT_SUBDIR = '';
const inDownloads = (filename) => (DEFAULT_SUBDIR ? `${DEFAULT_SUBDIR}/${filename}` : filename);

export function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${blob.type || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`;
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function buildFilename(kind, mime, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `screenshot-${kind}-${stamp}.${EXT[mime] ?? 'png'}`;
}

async function writeToDir(dirHandle, blob, filename) {
  const file = await dirHandle.getFileHandle(filename, { create: true });
  const w = await file.createWritable();
  try { await w.write(blob); } finally { await w.close(); }
}

/**
 * Save into the chosen directory when there is one and it may be written, otherwise into
 * Chrome's download directory. A directory whose permission was lost (e.g. after a browser restart) is not
 * asked again here: asking needs a click, which the service worker does not have.
 * @returns {Promise<{where: 'dir'|'downloads', path: string, note?: string}>}
 */
export async function saveBlob(blob, filename, { dirHandle, chromeApi = globalThis.chrome } = {}) {
  let note;
  if (dirHandle) {
    try {
      const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        await writeToDir(dirHandle, blob, filename);
        return { where: 'dir', path: `${dirHandle.name}/${filename}` };
      }
      note = t('save.noPermission');
    } catch (e) {
      console.warn('[cdp-screenshot] save to dir:', e);
      note = t('save.fallback');
    }
  }
  await chromeApi.downloads.download({
    url: await blobToDataUrl(blob),
    filename: inDownloads(filename),
    conflictAction: 'uniquify',
    saveAs: false,
  });
  return { where: 'downloads', path: inDownloads(filename), ...(note ? { note } : {}) };
}
