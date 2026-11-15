import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureViewport, captureFull, captureNode, pickNode, CaptureError, ErrorCode } from 'cdp-screenshot-extension/core';
import { computeClip } from '../core/geometry.js';
import { imageSize, base64ToBytes } from '../core/util.js';
import * as scripts from '../core/scripts.js';
import { makeFakeCdp, makePng, pageFns } from './helpers/fake-cdp.js';

const fast = { settleMs: 0 };
const rejectsWith = (p, code) => assert.rejects(p, (e) => e instanceof CaptureError && e.code === code);

test('page scripts are syntactically valid function sources', () => {
  for (const fn of [scripts.scanScrollers, scripts.measureHidden, scripts.forceExpand, scripts.restoreState]) {
    assert.doesNotThrow(() => new Function(`return (${fn.toString()})`), fn.name);
  }
});

test('imageSize reads PNG header', () => {
  assert.deepEqual(imageSize(base64ToBytes(makePng(123, 4567))), { width: 123, height: 4567 });
});

test('computeClip: page offset, zoom, floor/ceil', () => {
  const clip = computeClip(
    { border: [10.4, 20.6, 110.2, 20.6, 110.2, 70.1, 10.4, 70.1] },
    { cssVisualViewport: { pageX: 5, pageY: 100, zoom: 1 } },
  );
  assert.deepEqual(clip, { x: 15, y: 120, width: 101, height: 51, scale: 1 });
  const z = computeClip({ border: [0, 0, 10, 0, 10, 10, 0, 10] }, { cssVisualViewport: { pageX: 0, pageY: 0, zoom: 2 } });
  assert.deepEqual([z.width, z.height], [20, 20]);
});

test('computeClip: zero size -> NO_ELEMENT', () => {
  assert.throws(
    () => computeClip({ border: [5, 5, 5, 5, 5, 5, 5, 5] }, { cssVisualViewport: {} }),
    (e) => e.code === ErrorCode.NO_ELEMENT,
  );
});

test('captureViewport: one screenshot, result shape', async () => {
  const cdp = makeFakeCdp();
  const r = await captureViewport(cdp, fast);
  assert.deepEqual(cdp.names(), ['Page.captureScreenshot']);
  assert.equal(r.mime, 'image/png');
  assert.equal(r.bytes.constructor, Uint8Array);
  assert.deepEqual([r.width, r.height], [800, 600]);
});

test('captureViewport: invalid depth -> INVALID_OPTION', async () => {
  await rejectsWith(captureViewport(makeFakeCdp(), { depth: -1 }), ErrorCode.INVALID_OPTION);
});

test('captureFull: no hidden amount -> plain viewport shot, no emulation', async () => {
  const cdp = makeFakeCdp({
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 1, remaining: 0, total: 0 } }),
  });
  await captureFull(cdp, fast);
  assert.ok(!cdp.names().includes('Emulation.setDeviceMetricsOverride'));
  const shot = cdp.calls.find((c) => c.method === 'Page.captureScreenshot');
  assert.equal(shot.params.clip, undefined);
});

test('captureFull: unfolds scroller, captures content, restores in order', async () => {
  let measured = 0;
  const cdp = makeFakeCdp({
    'Runtime.callFunctionOn': pageFns({
      scanScrollers: null,
      measureHidden: () => ({ hidden: measured++ === 0 ? 1400 : 0, remaining: 1, total: 1 }),
      restoreState: true,
    }),
    // viewport follows the emulation override like a real page; content = viewport once unfolded
    'Page.getLayoutMetrics': (_, calls) => {
      const set = calls.findLast((c) => c.method === 'Emulation.setDeviceMetricsOverride');
      const h = set ? set.params.height : 600;
      return { cssLayoutViewport: { clientWidth: 800, clientHeight: h }, cssContentSize: { width: 800, height: h } };
    },
    'Page.captureScreenshot': () => ({ data: makePng(800, 2000) }),
  });
  const r = await captureFull(cdp, fast);
  const names = cdp.names();
  assert.deepEqual([r.width, r.height], [800, 2000]);
  const set = cdp.calls.find((c) => c.method === 'Emulation.setDeviceMetricsOverride');
  assert.equal(set.params.height, 2000); // 600 viewport + 1400 hidden
  assert.equal(set.params.deviceScaleFactor, 0);
  const shot = cdp.calls.find((c) => c.method === 'Page.captureScreenshot');
  assert.equal(shot.params.captureBeyondViewport, true);
  assert.deepEqual(shot.params.clip, { x: 0, y: 0, width: 800, height: 2000, scale: 1 });
  // override cleared after the shot, then page state restored
  const iShot = names.indexOf('Page.captureScreenshot');
  const iClear = names.indexOf('Emulation.clearDeviceMetricsOverride');
  const restore = cdp.calls.findIndex((c) => c.method === 'Runtime.callFunctionOn' && c.params.functionDeclaration.includes('restoreState'));
  assert.ok(iShot < iClear && iClear < restore, names.join(','));
});

test('captureFull: capture failure still clears override and restores', async () => {
  const cdp = makeFakeCdp({
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 500, remaining: 1, total: 1 }, restoreState: true }),
    'Page.getLayoutMetrics': () => ({ cssLayoutViewport: { clientWidth: 800, clientHeight: 1100 }, cssContentSize: { width: 800, height: 1100 } }),
    'Page.captureScreenshot': () => { throw new Error('boom'); },
  });
  await assert.rejects(captureFull(cdp, fast), /boom/);
  assert.ok(cdp.names().includes('Emulation.clearDeviceMetricsOverride'));
  assert.ok(cdp.calls.some((c) => c.params.functionDeclaration?.includes('restoreState')));
});

test('captureFull: too tall -> TOO_LARGE before any emulation', async () => {
  const cdp = makeFakeCdp({
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 20000, remaining: 1, total: 1 } }),
  });
  await rejectsWith(captureFull(cdp, fast), ErrorCode.TOO_LARGE);
  assert.ok(!cdp.names().includes('Emulation.setDeviceMetricsOverride'));
});

test('captureNode: selector -> querySelector, clip from box model', async () => {
  const cdp = makeFakeCdp({
    'DOM.getDocument': { root: { nodeId: 1 } },
    'DOM.querySelector': { nodeId: 7 },
    'DOM.describeNode': { node: { backendNodeId: 42 } },
    'DOM.resolveNode': { object: { objectId: 'el-obj' } },
    'DOM.getBoxModel': { model: { border: [10, 20, 110, 20, 110, 70, 10, 70] } },
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 0, remaining: 0, total: 0 } }),
    'Page.captureScreenshot': () => ({ data: makePng(100, 50) }),
  });
  const r = await captureNode(cdp, '#target', fast);
  const q = cdp.calls.find((c) => c.method === 'DOM.querySelector');
  assert.equal(q.params.selector, '#target');
  assert.ok(cdp.names().indexOf('DOM.scrollIntoViewIfNeeded') < cdp.names().indexOf('DOM.getBoxModel'));
  const shot = cdp.calls.find((c) => c.method === 'Page.captureScreenshot');
  assert.deepEqual(shot.params.clip, { x: 10, y: 20, width: 100, height: 50, scale: 1 });
  assert.equal(shot.params.captureBeyondViewport, true);
  assert.deepEqual([r.width, r.height], [100, 50]);
});

test('captureNode: selector without match -> NO_ELEMENT', async () => {
  const cdp = makeFakeCdp({ 'DOM.getDocument': { root: { nodeId: 1 } }, 'DOM.querySelector': { nodeId: 0 } });
  await rejectsWith(captureNode(cdp, '.nope', fast), ErrorCode.NO_ELEMENT);
});

test('captureNode: non-rendered node (getBoxModel error) -> NO_ELEMENT', async () => {
  const cdp = makeFakeCdp({
    'DOM.resolveNode': { object: { objectId: 'el-obj' } },
    'DOM.getBoxModel': () => { throw new Error('Could not compute box model.'); },
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 0 } }),
  });
  await assert.rejects(captureNode(cdp, 5, fast), (e) => e instanceof CaptureError);
});

test('detach during capture -> DETACHED', async () => {
  const cdp = makeFakeCdp({
    'Page.captureScreenshot': () => new Promise(() => {}), // never answers
  });
  const p = captureViewport(cdp, fast);
  setTimeout(() => cdp.emit('detach', 'target_closed'), 5);
  await rejectsWith(p, ErrorCode.DETACHED);
  assert.equal(cdp.listenerCount('detach'), 0);
});

test('pickNode: resolves on click and always cleans up the highlight', async () => {
  const cdp = makeFakeCdp();
  const p = pickNode(cdp, { pickTimeoutMs: 1000 });
  await new Promise((r) => setTimeout(r, 5));
  cdp.emit('Overlay.inspectNodeRequested', { backendNodeId: 99 });
  assert.deepEqual(await p, { backendNodeId: 99 });
  const names = cdp.names();
  assert.ok(names.indexOf('Overlay.setInspectMode') < names.lastIndexOf('Overlay.setInspectMode'));
  assert.deepEqual(names.slice(-2), ['Overlay.hideHighlight', 'Overlay.disable']);
  assert.equal(cdp.calls.findLast((c) => c.method === 'Overlay.setInspectMode').params.mode, 'none');
  assert.equal(cdp.listenerCount('Overlay.inspectNodeRequested'), 0);
});

test('pickNode: Escape -> CANCELED, timeout -> TIMEOUT, detach -> DETACHED', async () => {
  let cdp = makeFakeCdp();
  let p = pickNode(cdp);
  await new Promise((r) => setTimeout(r, 5));
  cdp.emit('Overlay.inspectModeCanceled');
  await rejectsWith(p, ErrorCode.CANCELED);

  cdp = makeFakeCdp();
  await rejectsWith(pickNode(cdp, { pickTimeoutMs: 10 }), ErrorCode.TIMEOUT);
  assert.ok(cdp.names().includes('Overlay.hideHighlight'));

  cdp = makeFakeCdp();
  p = pickNode(cdp);
  await new Promise((r) => setTimeout(r, 5));
  cdp.emit('detach', 'target_closed');
  await rejectsWith(p, ErrorCode.DETACHED);
});
