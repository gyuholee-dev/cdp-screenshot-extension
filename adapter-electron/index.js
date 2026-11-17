// Electron adapter: fills core's `cdp` contract with webContents.debugger.
// It takes a webContents as an argument and never imports 'electron', so apps can load it with
// a dynamic import() from either CommonJS or ESM main-process code.
//
// Window selection, focus, hiding screen updates, saving files and the clipboard are the host
// app's job (handoff §11); this adapter only talks CDP.
import { CaptureError, ErrorCode, fromCdpError } from '../core/errors.js';
import { captureByKind, captureNode } from '../core/index.js';

const PROTOCOL_VERSION = '1.3';

/**
 * @param {import('electron').WebContents} webContents
 * @returns {{attach(): Promise<void>, detach(): Promise<void>, send: Function, on: Function}}
 */
export function createElectronCdp(webContents) {
  const dbg = webContents.debugger;
  const handlers = new Map();
  let attachedByUs = false;
  let listening = false;

  const emit = (event, params) => {
    for (const h of [...(handlers.get(event) ?? [])]) {
      try { h(params); } catch { /* a handler must not break event delivery */ }
    }
  };
  // Electron passes (event, method, params, sessionId) / (event, reason)
  const onMessage = (_event, method, params) => emit(method, params);
  const onDetach = (_event, reason) => {
    attachedByUs = false;
    emit('detach', reason);
  };
  const unlisten = () => {
    if (!listening) return;
    listening = false;
    dbg.removeListener('message', onMessage);
    dbg.removeListener('detach', onDetach);
  };

  return {
    /** Does not take over a debugger someone else attached (e.g. DevTools): reports it instead. */
    async attach() {
      if (dbg.isAttached()) {
        throw new CaptureError(
          ErrorCode.NOT_ATTACHABLE,
          'Another debugger is already attached.',
        );
      }
      try {
        dbg.attach(PROTOCOL_VERSION);
      } catch (e) {
        throw fromCdpError(e);
      }
      attachedByUs = true;
      listening = true;
      dbg.on('message', onMessage);
      dbg.on('detach', onDetach);
    },
    /** Detach only what we attached; safe to call twice or after Electron detached us. */
    async detach() {
      unlisten();
      if (!attachedByUs) return;
      attachedByUs = false;
      try { if (dbg.isAttached()) dbg.detach(); } catch { /* already gone */ }
    },
    send: (method, params) => dbg.sendCommand(method, params),
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
  };
}

async function withCdp(webContents, fn) {
  const cdp = createElectronCdp(webContents);
  await cdp.attach();
  try {
    return await fn(cdp);
  } finally {
    await cdp.detach();
  }
}

/**
 * Attach, run one capture, always detach.
 * @param {import('electron').WebContents} webContents
 * @param {'viewport'|'full'|'element'} kind
 * @param {object} [options] core options (depth, format, settleMs, reportProgress, ...)
 * @returns {Promise<{bytes: Uint8Array, mime: string, width: number, height: number}>}
 */
export async function runCapture(webContents, kind, options = {}) {
  const capture = captureByKind[kind];
  if (!capture) throw new CaptureError(ErrorCode.INVALID_OPTION, `Unknown capture kind: ${kind}`);
  return withCdp(webContents, (cdp) => capture(cdp, options));
}

/**
 * Capture a known element (CSS selector or backendNodeId), e.g. for callers that cannot click.
 * @param {import('electron').WebContents} webContents
 * @param {string|number|{selector?: string, backendNodeId?: number}} target
 */
export async function runCaptureNode(webContents, target, options = {}) {
  return withCdp(webContents, (cdp) => captureNode(cdp, target, options));
}
