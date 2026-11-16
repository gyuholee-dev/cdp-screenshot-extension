import { CaptureError, ErrorCode, fromCdpError } from './errors.js';
import { normalizeOptions } from './util.js';

const HIGHLIGHT = {
  showInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
};

/**
 * Let the user pick an element with the mouse (DevTools inspect mode).
 * Resolves with `{ backendNodeId }`. Rejects CANCELED (Escape in the page, or `options.signal` aborted:
 * for hosts whose own UI has the keyboard focus, e.g. a side panel), TIMEOUT, DETACHED.
 * The highlight is always removed so it never appears in the screenshot.
 */
export async function pickNode(cdp, options = {}) {
  const opts = normalizeOptions(options);
  const offs = [];
  let timer;
  const signal = options.signal;
  let onAbort;
  try {
    await cdp.send('DOM.enable');
    await cdp.send('Overlay.enable');
    // The overlay also paints a "WxH" viewport-size label on resize; it would end up in the shot.
    try { await cdp.send('Overlay.setShowViewportSizeOnResize', { show: false }); } catch { /* older Chrome */ }
    const picked = new Promise((resolve, reject) => {
      offs.push(cdp.on('Overlay.inspectNodeRequested', (p) => resolve({ backendNodeId: p.backendNodeId })));
      offs.push(cdp.on('Overlay.inspectModeCanceled', () => reject(new CaptureError(ErrorCode.CANCELED, 'The element pick was canceled.'))));
      offs.push(cdp.on('detach', () => reject(new CaptureError(ErrorCode.DETACHED, 'The debugger connection was lost during the element pick.'))));
      onAbort = () => reject(new CaptureError(ErrorCode.CANCELED, 'The element pick was canceled.'));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.('abort', onAbort, { once: true });
      timer = setTimeout(
        () => reject(new CaptureError(ErrorCode.TIMEOUT, 'The element pick timed out.', { details: { pickTimeoutMs: opts.pickTimeoutMs } })),
        opts.pickTimeoutMs,
      );
    });
    picked.catch(() => {}); // the awaited copy below still rejects; this avoids an early unhandled rejection
    opts.progress({ stage: 'pick' });
    await cdp.send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: HIGHLIGHT });
    return await picked;
  } catch (e) {
    throw fromCdpError(e);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener?.('abort', onAbort);
    for (const off of offs) { try { off?.(); } catch { /* ignore */ } }
    for (const [m, p] of [
      ['Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }],
      ['Overlay.hideHighlight', {}],
      ['Overlay.setShowViewportSizeOnResize', { show: true }],
      ['Overlay.disable', {}],
    ]) {
      try { await cdp.send(m, p); } catch { /* best effort */ }
    }
  }
}
