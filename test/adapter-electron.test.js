import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createElectronCdp, runCapture, runCaptureNode } from '../adapter-electron/index.js';
import { CaptureError, ErrorCode } from '../core/index.js';
import { makePng } from './helpers/fake-cdp.js';

/** webContents.debugger stand-in: an EventEmitter with attach/detach/isAttached/sendCommand. */
function makeWebContents({ attached = false, attachError, sendHandler } = {}) {
  const calls = [];
  const dbg = new EventEmitter();
  let isAttached = attached;
  dbg.isAttached = () => isAttached;
  dbg.attach = (version) => {
    calls.push(['attach', version]);
    if (attachError) throw new Error(attachError);
    isAttached = true;
  };
  dbg.detach = () => { calls.push(['detach']); isAttached = false; };
  dbg.sendCommand = async (method, params) => {
    calls.push(['send', method]);
    return sendHandler ? sendHandler(method, params) : {};
  };
  return { debugger: dbg, calls, dbg };
}

test('send forwards to webContents.debugger.sendCommand', async () => {
  const wc = makeWebContents({ sendHandler: () => ({ ok: 1 }) });
  const cdp = createElectronCdp(wc);
  await cdp.attach();
  assert.deepEqual(await cdp.send('Page.enable', {}), { ok: 1 });
  assert.deepEqual(wc.calls, [['attach', '1.3'], ['send', 'Page.enable']]);
});

test('message events become cdp.on(method) with params; detach carries the reason', async () => {
  const wc = makeWebContents();
  const cdp = createElectronCdp(wc);
  await cdp.attach();
  const got = [];
  cdp.on('Overlay.inspectNodeRequested', (p) => got.push(p));
  const reasons = [];
  cdp.on('detach', (r) => reasons.push(r));
  wc.dbg.emit('message', {}, 'Overlay.inspectNodeRequested', { backendNodeId: 2 }, '');
  wc.dbg.emit('message', {}, 'Other.event', { x: 1 }, '');
  wc.dbg.emit('detach', {}, 'target closed');
  assert.deepEqual(got, [{ backendNodeId: 2 }]);
  assert.deepEqual(reasons, ['target closed']);
});

test('on() returns an unsubscribe function', async () => {
  const wc = makeWebContents();
  const cdp = createElectronCdp(wc);
  await cdp.attach();
  let n = 0;
  const off = cdp.on('X', () => n++);
  wc.dbg.emit('message', {}, 'X', {});
  off();
  wc.dbg.emit('message', {}, 'X', {});
  assert.equal(n, 1);
});

test('an already attached debugger is reported, not taken over, and never detached', async () => {
  const wc = makeWebContents({ attached: true });
  const cdp = createElectronCdp(wc);
  await assert.rejects(cdp.attach(), (e) => e instanceof CaptureError && e.code === ErrorCode.NOT_ATTACHABLE);
  await cdp.detach();
  assert.equal(wc.calls.length, 0);
  assert.equal(wc.dbg.listenerCount('message'), 0);
});

test('attach failure maps to a CaptureError', async () => {
  const wc = makeWebContents({ attachError: 'Another debugger is already attached to the target' });
  await assert.rejects(createElectronCdp(wc).attach(), (e) => e instanceof CaptureError && e.code === ErrorCode.NOT_ATTACHABLE);
});

test('detach removes listeners, detaches once, and skips after the host detached us', async () => {
  let wc = makeWebContents();
  let cdp = createElectronCdp(wc);
  await cdp.attach();
  await cdp.detach();
  await cdp.detach();
  assert.equal(wc.calls.filter((c) => c[0] === 'detach').length, 1);
  assert.equal(wc.dbg.listenerCount('message') + wc.dbg.listenerCount('detach'), 0);

  wc = makeWebContents();
  cdp = createElectronCdp(wc);
  await cdp.attach();
  wc.dbg.emit('detach', {}, 'target closed');
  await cdp.detach();
  assert.ok(!wc.calls.some((c) => c[0] === 'detach'));
});

test('runCapture: unknown kind fails before attaching', async () => {
  const wc = makeWebContents();
  await assert.rejects(runCapture(wc, 'nope'), (e) => e.code === ErrorCode.INVALID_OPTION);
  assert.equal(wc.calls.length, 0);
});

test('runCapture viewport: attach -> screenshot -> detach, returns the contract shape', async () => {
  const wc = makeWebContents({
    sendHandler: (method) => (method === 'Page.captureScreenshot' ? { data: makePng(10, 20) } : {}),
  });
  const r = await runCapture(wc, 'viewport');
  assert.deepEqual([r.width, r.height, r.mime], [10, 20, 'image/png']);
  assert.equal(r.bytes.constructor, Uint8Array);
  assert.deepEqual(wc.calls.map((c) => c[0]), ['attach', 'send', 'detach']);
});

test('runCapture: detaches even when the capture fails', async () => {
  const wc = makeWebContents({ sendHandler: () => { throw new Error('boom'); } });
  await assert.rejects(runCapture(wc, 'viewport'), /boom/);
  assert.equal(wc.calls.at(-1)[0], 'detach');
  assert.equal(wc.dbg.listenerCount('message'), 0);
});

test('runCaptureNode: a selector reaches DOM.querySelector (callers that cannot click)', async () => {
  const wc = makeWebContents({
    sendHandler: (method) => ({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 7 },
      'DOM.describeNode': { node: { backendNodeId: 42 } },
      'DOM.resolveNode': { object: { objectId: 'el' } },
      'DOM.getBoxModel': { model: { border: [0, 0, 100, 0, 100, 50, 0, 50] } },
      'Runtime.callFunctionOn': { result: { value: { hidden: 0, max: 0, remaining: 0, total: 0, items: [] }, objectId: 's' } },
      'Page.getLayoutMetrics': { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600, zoom: 1 } },
      'Page.captureScreenshot': { data: makePng(100, 50) },
      'Runtime.evaluate': { result: { value: 1 } },
    })[method] ?? {},
  });
  const r = await runCaptureNode(wc, '#target', { settleMs: 0 });
  assert.deepEqual([r.width, r.height], [100, 50]);
  assert.ok(wc.calls.some((c) => c[1] === 'DOM.querySelector'));
  assert.equal(wc.calls.at(-1)[0], 'detach');
});

test('the adapter never imports electron', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../adapter-electron/index.js', import.meta.url), 'utf8');
  assert.ok(!/from ['"]electron['"]|require\(['"]electron['"]\)/.test(src));
});
