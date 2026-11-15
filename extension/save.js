// Result handling lives in the host (here: the extension), never in core.

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function bytesToDataUrl(bytes, mime) {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

export function buildFilename(kind, mime, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `screenshot-${kind}-${stamp}.${EXT[mime] ?? 'png'}`;
}

/** Runs inside the page (via chrome.scripting): must be self-contained. */
export async function writeImageToClipboard(base64, mime) {
  const bin = atob(base64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  let blob = new Blob([u8], { type: mime });
  if (mime !== 'image/png') { // the async clipboard only takes PNG for images
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    blob = await canvas.convertToBlob({ type: 'image/png' });
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  return true;
}

async function download(result, kind, chromeApi) {
  const filename = buildFilename(kind, result.mime);
  await chromeApi.downloads.download({ url: bytesToDataUrl(result.bytes, result.mime), filename, saveAs: false });
  return filename;
}

/**
 * Save a capture result per settings.saveMode.
 * @returns {Promise<{mode: 'download'|'clipboard', filename?: string, note?: string}>}
 */
export async function saveResult(result, kind, settings, tabId, chromeApi = globalThis.chrome) {
  if (settings.saveMode === 'clipboard') {
    try {
      const [res] = await chromeApi.scripting.executeScript({
        target: { tabId },
        func: writeImageToClipboard,
        args: [bytesToBase64(result.bytes), result.mime],
      });
      if (res?.result === true) return { mode: 'clipboard' };
      throw new Error('clipboard write returned no result');
    } catch (e) {
      const filename = await download(result, kind, chromeApi);
      return { mode: 'download', filename, note: `클립보드 복사에 실패해 다운로드로 저장했습니다: ${e?.message ?? e}` };
    }
  }
  return { mode: 'download', filename: await download(result, kind, chromeApi) };
}
