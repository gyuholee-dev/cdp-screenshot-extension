// Chrome adapter: fills core's `cdp` contract with chrome.debugger.
// `chromeApi` is injectable so the adapter can be tested without a browser.
import { CaptureError, ErrorCode, fromCdpError } from '../core/errors.js';
import { captureByKind } from '../core/index.js';

const PROTOCOL_VERSION = '1.3';

/**
 * @param {number} tabId
 * @param {typeof chrome} [chromeApi]
 * @returns {{attach(): Promise<void>, detach(): Promise<void>, send: Function, on: Function}}
 */
export function createChromeCdp(tabId, chromeApi = globalThis.chrome) {
  const dbg = chromeApi.debugger;
  const target = { tabId };
  const handlers = new Map();
  let attached = false;
  let listening = false;

  const emit = (event, params) => {
    for (const h of [...(handlers.get(event) ?? [])]) {
      try { h(params); } catch { /* a handler must not break event delivery */ }
    }
  };
  const onEvent = (source, method, params) => {
    if (source.tabId === tabId) emit(method, params);
  };
  const onDetach = (source, reason) => {
    if (source.tabId === tabId) {
      attached = false;
      emit('detach', reason);
    }
  };
  const unlisten = () => {
    if (!listening) return;
    listening = false;
    dbg.onEvent.removeListener(onEvent);
    dbg.onDetach.removeListener(onDetach);
  };

  return {
    /** Attach right before capturing: Chrome shows a "debugging" bar while attached. */
    async attach() {
      try {
        await dbg.attach(target, PROTOCOL_VERSION);
      } catch (e) {
        throw fromCdpError(e);
      }
      attached = true;
      listening = true;
      dbg.onEvent.addListener(onEvent);
      dbg.onDetach.addListener(onDetach);
    },
    /** Detach only what we attached; safe to call twice or after the browser detached us. */
    async detach() {
      unlisten();
      if (!attached) return;
      attached = false;
      try { await dbg.detach(target); } catch { /* already gone */ }
    },
    send: (method, params) => dbg.sendCommand(target, method, params),
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
  };
}

/**
 * Attach, run one capture, always detach.
 * `hooks.afterCapture({cdp, ok, result?, error?})` runs after the capture (best effort), before detaching.
 * @param {number} tabId
 * @param {'viewport'|'full'|'element'} kind
 * @param {object} [options] core options (depth, format, settleMs, reportProgress, ...)
 */
export async function runCapture(tabId, kind, options = {}, chromeApi = globalThis.chrome, hooks = {}) {
  const capture = captureByKind[kind];
  if (!capture) throw new CaptureError(ErrorCode.INVALID_OPTION, `알 수 없는 캡처 종류: ${kind}`);
  const cdp = createChromeCdp(tabId, chromeApi);
  await cdp.attach();
  let outcome = { ok: false, error: undefined };
  try {
    const result = await capture(cdp, options);
    outcome = { ok: true, result };
    return result;
  } catch (e) {
    outcome = { ok: false, error: e };
    throw e;
  } finally {
    // Host hook, run once the capture is over and the page is restored, while still attached
    // (e.g. on-screen feedback through this same connection). Best effort: never breaks the capture.
    try { await hooks.afterCapture?.({ cdp, ...outcome }); } catch { /* ignore */ }
    await cdp.detach();
  }
}
