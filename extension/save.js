// Saving a screenshot to a folder. Runs in the service worker (no DOM, no object URLs: the download
// goes through a data URL). The result handling lives in the host (here: the extension), never in core.

// Until a folder is chosen: Chrome's download folder itself ('' = no subfolder; the downloads API
// cannot take an absolute path).
export const DEFAULT_SUBFOLDER = '';
const inDefaultFolder = (filename) => (DEFAULT_SUBFOLDER ? `${DEFAULT_SUBFOLDER}/${filename}` : filename);

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

async function writeToFolder(dirHandle, blob, filename) {
  const file = await dirHandle.getFileHandle(filename, { create: true });
  const w = await file.createWritable();
  try { await w.write(blob); } finally { await w.close(); }
}

/**
 * Save into the chosen folder when there is one and it may be written, otherwise into
 * Chrome's download folder. A folder whose permission was lost (e.g. after a browser restart) is not
 * asked again here: asking needs a click, which the service worker does not have.
 * @returns {Promise<{where: 'folder'|'downloads', path: string, note?: string}>}
 */
export async function saveBlob(blob, filename, { dirHandle, chromeApi = globalThis.chrome } = {}) {
  let note;
  if (dirHandle) {
    try {
      const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        await writeToFolder(dirHandle, blob, filename);
        return { where: 'folder', path: `${dirHandle.name}/${filename}` };
      }
      note = '선택한 폴더에 쓸 권한이 없어 다운로드 폴더에 저장했습니다(환경설정에서 폴더를 다시 허용하세요).';
    } catch (e) {
      note = `선택한 폴더에 저장하지 못해 다운로드 폴더에 저장했습니다: ${e?.message ?? e}`;
    }
  }
  await chromeApi.downloads.download({
    url: await blobToDataUrl(blob),
    filename: inDefaultFolder(filename),
    conflictAction: 'uniquify',
    saveAs: false,
  });
  return { where: 'downloads', path: inDefaultFolder(filename), ...(note ? { note } : {}) };
}
