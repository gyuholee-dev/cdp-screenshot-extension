import { CaptureError, ErrorCode, fromCdpError } from './errors.js';

export const DEFAULTS = Object.freeze({
  depth: 5, // default: apps often nest the scrolling area ~4 levels below <body>
  format: 'png',
  quality: 90, // jpeg/webp only
  settleMs: 250, // delay right before the shot (late images, animations); not used between the steps before it (50 was too short for full-page unfolding)
  maxSidePixels: 16384, // the longest side (device pixels: CSS px × screen scale) Chromium renders; beyond it the image comes out blank
  pickTimeoutMs: 60000,
});

const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

export function normalizeOptions(o = {}) {
  const opts = { ...DEFAULTS, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) };
  if (!Number.isInteger(opts.depth) || opts.depth < 0) {
    throw new CaptureError(ErrorCode.INVALID_OPTION, 'depth must be an integer of 0 or more.');
  }
  if (!MIME[opts.format]) {
    throw new CaptureError(ErrorCode.INVALID_OPTION, 'format must be one of png, jpeg, webp.');
  }
  for (const k of ['settleMs', 'maxSidePixels', 'pickTimeoutMs']) {
    if (!(opts[k] >= 0)) throw new CaptureError(ErrorCode.INVALID_OPTION, `${k} is invalid.`);
  }
  opts.mime = MIME[opts.format];
  opts.progress = (info) => {
    try { o.reportProgress?.(info); } catch { /* host callback must not break capture */ }
  };
  return opts;
}

/**
 * Run fn with a deferred-cleanup registry. Cleanups run in reverse order in `finally`,
 * even on error or detach; cleanup failures never mask the original error.
 * A 'detach' event from the host aborts with DETACHED.
 */
export async function runSession(cdp, fn) {
  const cleanups = [];
  const defer = (f) => { cleanups.push(f); };
  let reject;
  const detached = new Promise((_, rej) => { reject = rej; });
  detached.catch(() => {});
  const off = cdp.on?.('detach', () => {
    reject(new CaptureError(ErrorCode.DETACHED, 'The debugger connection was lost during the capture.'));
  });
  try {
    return await Promise.race([fn(defer), detached]);
  } catch (e) {
    throw fromCdpError(e);
  } finally {
    try { off?.(); } catch { /* ignore */ }
    for (const f of cleanups.reverse()) {
      try { await f(); } catch { /* best effort */ }
    }
  }
}

const FRAME_STALL_MS = 150; // no animation frame within this: the window is hidden and never paints

/**
 * The delay right before a shot (`settleMs`): two frames, then settleMs. Called once per shot, after
 * the page was changed for it. A window that never renders frames is detected here (and in
 * layoutWait) once; the rest of that capture then skips frame waits instead of paying a timeout each.
 */
export async function settle(cdp, opts) {
  if (opts.hiddenWindow) return;
  const expression = `new Promise((resolve) => {
    let seen = false;
    const stall = setTimeout(() => { if (!seen) resolve(false); }, ${FRAME_STALL_MS});
    requestAnimationFrame(() => {
      seen = true;
      clearTimeout(stall);
      requestAnimationFrame(() => setTimeout(() => resolve(true), ${Math.max(0, Number(opts.settleMs) || 0)}));
    });
  })`;
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.result?.value === false) opts.hiddenWindow = true;
}

/** Make the page lay out now (after clearing a viewport override etc.) without waiting for a frame. */
export async function layoutBarrier(cdp) {
  await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.offsetHeight', returnByValue: true });
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Read pixel size from an image header. Returns null if unknown. */
export function imageSize(bytes) {
  const b = bytes;
  const u32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  // PNG
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: u32(16), height: u32(20) };
  }
  // JPEG: scan for SOFn
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return null;
  }
  // WebP
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const t = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (t === 'VP8X') {
      return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    if (t === 'VP8L') {
      const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: 1 + (v & 0x3fff), height: 1 + ((v >>> 14) & 0x3fff) };
    }
    if (t === 'VP8 ') {
      return { width: ((b[26] | (b[27] << 8)) & 0x3fff), height: ((b[28] | (b[29] << 8)) & 0x3fff) };
    }
  }
  return null;
}

export function assertWithinLimit(widthPx, heightPx, maxSide) {
  if (widthPx > maxSide || heightPx > maxSide) {
    throw new CaptureError(
      ErrorCode.TOO_LARGE,
      `The result image (${Math.ceil(widthPx)}×${Math.ceil(heightPx)}px) exceeds the limit of ${maxSide}px on a side.`,
      { details: { maxSide } },
    );
  }
}

/** Page.captureScreenshot -> { bytes, mime, width, height } */
export async function screenshot(cdp, opts, params = {}, fallbackSize = { width: 0, height: 0 }) {
  const p = { format: opts.format, fromSurface: true, ...params };
  if (opts.format !== 'png') p.quality = opts.quality;
  const { data } = await cdp.send('Page.captureScreenshot', p);
  const bytes = base64ToBytes(data);
  const size = imageSize(bytes) ?? fallbackSize;
  return { bytes, mime: opts.mime, width: size.width, height: size.height };
}

export async function devicePixelRatio(cdp) {
  const r = await cdp.send('Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true });
  return r?.result?.value ?? 1;
}
