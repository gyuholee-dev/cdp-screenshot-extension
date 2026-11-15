import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeCdp, runCapture } from '../adapter-chrome/index.js';
import { CaptureError, ErrorCode } from '../core/index.js';
import { makePng } from './helpers/fake-cdp.js';

function makeChrome({ attachError, sendHandler } = {}) {
  const calls = [];
  const mkEvent = () => {
    const set = new Set();
    return { addListener: (f) => set.add(f), removeListener: (f) => set.delete(f), fire: (...a) => set.forEach((f) => f(...a)), size: () => set.size };
  };
  const onEvent = mkEvent();
  const onDetach = mkEvent();
  const debuggerApi = {
    onEvent,
    onDetach,
    async attach(target, version) {
      calls.push(['attach', target.tabId, version]);
      if (attachError) throw new Error(attachError);
    },
    async detach(target) { calls.push(['detach', target.tabId]); },
    async sendCommand(target, method, params) {
      calls.push(['send', target.tabId, method]);
      if (sendHandler) return sendHandler(method, params);
      return {};
    },
  };
  return { debugger: debuggerApi, calls, onEvent, onDetach };
}

test('send forwards to chrome.debugger with the tab target', async () => {
  const chrome = makeChrome({ sendHandler: () => ({ ok: 1 }) });
  const cdp = createChromeCdp(5, chrome);
  await cdp.attach();
  assert.deepEqual(await cdp.send('Page.enable', {}), { ok: 1 });
  assert.deepEqual(chrome.calls.slice(0, 2), [['attach', 5, '1.3'], ['send', 5, 'Page.enable']]);
});

test('events are filtered by tabId; detach carries the reason', async () => {
  const chrome = makeChrome();
  const cdp = createChromeCdp(5, chrome);
  await cdp.attach();
  const got = [];
  cdp.on('Overlay.inspectNodeRequested', (p) => got.push(p));
  const reasons = [];
  cdp.on('detach', (r) => reasons.push(r));
  chrome.onEvent.fire({ tabId: 6 }, 'Overlay.inspectNodeRequested', { backendNodeId: 1 });
  chrome.onEvent.fire({ tabId: 5 }, 'Overlay.inspectNodeRequested', { backendNodeId: 2 });
  chrome.onDetach.fire({ tabId: 5 }, 'canceled_by_user');
  assert.deepEqual(got, [{ backendNodeId: 2 }]);
  assert.deepEqual(reasons, ['canceled_by_user']);
});

test('on() returns an unsubscribe function', async () => {
  const chrome = makeChrome();
  const cdp = createChromeCdp(1, chrome);
  await cdp.attach();
  let n = 0;
  const off = cdp.on('X', () => n++);
  chrome.onEvent.fire({ tabId: 1 }, 'X', {});
  off();
  chrome.onEvent.fire({ tabId: 1 }, 'X', {});
  assert.equal(n, 1);
});

test('attach failure maps to NOT_ATTACHABLE and nothing is detached', async () => {
  for (const msg of ['Another debugger is already attached to the tab with id: 1.', 'Cannot access a chrome:// URL']) {
    const chrome = makeChrome({ attachError: msg });
    const cdp = createChromeCdp(1, chrome);
    await assert.rejects(cdp.attach(), (e) => e instanceof CaptureError && e.code === ErrorCode.NOT_ATTACHABLE);
    await cdp.detach();
    assert.ok(!chrome.calls.some((c) => c[0] === 'detach'));
    assert.equal(chrome.onEvent.size(), 0);
  }
});

test('detach removes listeners, detaches once, and skips after browser-side detach', async () => {
  let chrome = makeChrome();
  let cdp = createChromeCdp(1, chrome);
  await cdp.attach();
  await cdp.detach();
  await cdp.detach();
  assert.equal(chrome.calls.filter((c) => c[0] === 'detach').length, 1);
  assert.equal(chrome.onEvent.size() + chrome.onDetach.size(), 0);

  chrome = makeChrome();
  cdp = createChromeCdp(1, chrome);
  await cdp.attach();
  chrome.onDetach.fire({ tabId: 1 }, 'target_closed');
  await cdp.detach();
  assert.ok(!chrome.calls.some((c) => c[0] === 'detach'));
});

test('runCapture: unknown kind fails before attaching', async () => {
  const chrome = makeChrome();
  await assert.rejects(runCapture(1, 'nope', {}, chrome), (e) => e.code === ErrorCode.INVALID_OPTION);
  assert.equal(chrome.calls.length, 0);
});

test('runCapture viewport: attach -> screenshot -> detach, returns result', async () => {
  const chrome = makeChrome({
    sendHandler: (method) => (method === 'Page.captureScreenshot' ? { data: makePng(10, 20) } : {}),
  });
  const r = await runCapture(9, 'viewport', {}, chrome);
  assert.deepEqual([r.width, r.height], [10, 20]);
  const kinds = chrome.calls.map((c) => c[0]);
  assert.deepEqual(kinds, ['attach', 'send', 'detach']);
});

test('runCapture: detaches even when the capture fails', async () => {
  const chrome = makeChrome({ sendHandler: () => { throw new Error('boom'); } });
  await assert.rejects(runCapture(9, 'viewport', {}, chrome), /boom/);
  assert.equal(chrome.calls.at(-1)[0], 'detach');
  assert.equal(chrome.onEvent.size(), 0);
});

test('runCapture: afterCapture runs once the capture is over, before detaching, with the outcome', async () => {
  const chrome = makeChrome({ sendHandler: (m) => (m === 'Page.captureScreenshot' ? { data: makePng(10, 20) } : {}) });
  const seen = [];
  const r = await runCapture(1, 'viewport', {}, chrome, {
    afterCapture: async ({ cdp, ok, result }) => { seen.push([ok, result.width, typeof cdp.send]); chrome.calls.push(['hook']); },
  });
  assert.equal(r.width, 10);
  assert.deepEqual(seen, [[true, 10, 'function']]);
  const names = chrome.calls.map((c) => c[0]);
  assert.ok(names.indexOf('hook') < names.lastIndexOf('detach'));
});

test('runCapture: afterCapture also runs on failure, and a throwing hook never breaks the capture or the detach', async () => {
  const chrome = makeChrome({ sendHandler: () => { throw new Error('boom'); } });
  let outcome;
  await assert.rejects(runCapture(1, 'viewport', {}, chrome, { afterCapture: ({ ok, error }) => { outcome = [ok, error.message]; throw new Error('hook failed'); } }), /boom/);
  assert.deepEqual(outcome, [false, 'boom']);
  assert.equal(chrome.calls.at(-1)[0], 'detach');

  const ok = makeChrome({ sendHandler: (m) => (m === 'Page.captureScreenshot' ? { data: makePng(2, 2) } : {}) });
  const r = await runCapture(1, 'viewport', {}, ok, { afterCapture: () => { throw new Error('hook failed'); } });
  assert.equal(r.width, 2);
  assert.equal(ok.calls.at(-1)[0], 'detach');
});
