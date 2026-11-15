import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureViewport, captureFull, captureNode, pickNode, CaptureError, ErrorCode } from 'cdp-screenshot-extension/core';
import { computeClip } from '../core/geometry.js';
import { imageSize, base64ToBytes, settle, DEFAULTS } from '../core/util.js';
import * as scripts from '../core/scripts.js';
import { makeFakeCdp, makePng, pageFns } from './helpers/fake-cdp.js';

const fast = { settleMs: 0 };
const rejectsWith = (p, code) => assert.rejects(p, (e) => e instanceof CaptureError && e.code === code);

test('page scripts are syntactically valid function sources', () => {
  for (const fn of [scripts.scanScrollers, scripts.measureHidden, scripts.forceExpand, scripts.restoreState, scripts.waitStable]) {
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
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 1, max: 1, remaining: 0, total: 0 } }),
  });
  await captureFull(cdp, fast);
  assert.ok(!cdp.names().includes('Emulation.setDeviceMetricsOverride'));
  const shot = cdp.calls.find((c) => c.method === 'Page.captureScreenshot');
  assert.equal(shot.params.clip, undefined);
});

test('captureFull: unfolds scroller, captures content, restores in order', async () => {
  let cdp;
  cdp = makeFakeCdp({
    'Runtime.callFunctionOn': pageFns({
      scanScrollers: null,
      measureHidden: () => {
        const sets = cdp.calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride');
        const h = Math.max(0, 1400 - (sets.length ? sets.at(-1).params.height - 600 : 0));
        return { hidden: h, max: h, remaining: 1, total: 1, items: [h] };
      },
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
  const set = cdp.calls.findLast((c) => c.method === 'Emulation.setDeviceMetricsOverride');
  assert.equal(set.params.height, 2000); // 600 viewport + 1400 hidden (probe 200, then the rest)
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
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 500, max: 500, remaining: 1, total: 1 }, restoreState: true }),
    'Page.getLayoutMetrics': () => ({ cssLayoutViewport: { clientWidth: 800, clientHeight: 1100 }, cssContentSize: { width: 800, height: 1100 } }),
    'Page.captureScreenshot': () => { throw new Error('boom'); },
  });
  await assert.rejects(captureFull(cdp, fast), /boom/);
  assert.ok(cdp.names().includes('Emulation.clearDeviceMetricsOverride'));
  assert.ok(cdp.calls.some((c) => c.params.functionDeclaration?.includes('restoreState')));
});

test('captureFull: too tall -> TOO_LARGE before any emulation', async () => {
  const cdp = makeFakeCdp({
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 20000, max: 20000, remaining: 1, total: 1 } }),
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
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 0, max: 0, remaining: 0, total: 0 } }),
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
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 0, max: 0 } }),
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
  assert.deepEqual(names.slice(-3), ['Overlay.hideHighlight', 'Overlay.setShowViewportSizeOnResize', 'Overlay.disable']);
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

// --- unfolding strategy -------------------------------------------------------------

function unfoldCdp(measureFn, extra = {}) {
  return makeFakeCdp({
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: measureFn, forceExpand: 1, restoreState: true }),
    'Page.getLayoutMetrics': (_, calls) => {
      const set = calls.findLast((c) => c.method === 'Emulation.setDeviceMetricsOverride');
      const h = set ? set.params.height : 600;
      return { cssLayoutViewport: { clientWidth: 800, clientHeight: h }, cssContentSize: { width: 800, height: h } };
    },
    ...extra,
  });
}
const heights = (cdp) => cdp.calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride').map((c) => c.params.height);
const ran = (cdp, name) => cdp.calls.some((c) => c.params.functionDeclaration?.includes(name));

test('side-by-side scrollers: each gets the whole extra height, so grow by the largest need', async () => {
  let cdp;
  const need = [1000, 600];
  cdp = unfoldCdp(() => {
    const grown = heights(cdp).length ? heights(cdp).at(-1) - 600 : 0;
    const items = need.map((n) => Math.max(0, n - grown));
    return { hidden: items.reduce((a, b) => a + b, 0), max: Math.max(...items), remaining: 2, total: 2, items };
  });
  await captureFull(cdp, fast);
  assert.deepEqual(heights(cdp), [800, 1600]); // probe 200, then up to 600 + 1000; never 600 + 1600
  assert.ok(!ran(cdp, 'forceExpand'));
});

test('stacked scrollers splitting the extra height converge via the measured rate', async () => {
  let cdp;
  cdp = unfoldCdp(() => {
    const grown = heights(cdp).length ? heights(cdp).at(-1) - 600 : 0;
    const left = Math.max(0, 1000 - grown / 2);
    return { hidden: left * 2, max: left, remaining: 2, total: 2, items: [left, left] };
  });
  await captureFull(cdp, fast);
  const hs = heights(cdp);
  assert.equal(hs[0], 800);
  assert.ok(hs.at(-1) >= 2600 && hs.at(-1) <= 2602, hs.join(','));
  assert.ok(!ran(cdp, 'forceExpand'));
});

test('fixed-height scroller only: probe is undone and styles are forced', async () => {
  let forced = false;
  const cdp = unfoldCdp(null, {
    'Runtime.callFunctionOn': (p) => {
      if (p.functionDeclaration.includes('forceExpand')) forced = true;
      const h = forced ? 0 : 500;
      return pageFns({ scanScrollers: null, measureHidden: { hidden: h, max: h, remaining: 1, total: 1, items: [h] }, forceExpand: 1, restoreState: true })(p);
    },
  });
  await captureFull(cdp, fast);
  assert.deepEqual(heights(cdp), [800, 600]); // probed once, saw no progress, went back
  assert.ok(ran(cdp, 'forceExpand'));
});

test('mixed: a stuck scroller with the largest hidden amount does not hide the responsive ones', async () => {
  // column hidden 950 (follows the viewport 1:1), nested hidden 1000 (fixed height) - the bug seen on multi-scroll depth 3
  let cdp;
  let forced = false;
  cdp = unfoldCdp(null, {
    'Runtime.callFunctionOn': (p) => {
      if (p.functionDeclaration.includes('forceExpand')) forced = true;
      const grown = heights(cdp).length ? heights(cdp).at(-1) - 600 : 0;
      const col = Math.max(0, 950 - grown);
      const nested = forced ? 0 : 1000;
      const items = [col, nested];
      return pageFns({ scanScrollers: null, measureHidden: { hidden: col + nested, max: Math.max(col, nested), remaining: 2, total: 2, items }, forceExpand: 1, restoreState: true })(p);
    },
  });
  await captureFull(cdp, fast);
  const hs = heights(cdp);
  assert.equal(hs.at(-1), 1550); // 600 + 950: the column's height is kept, not rolled back
  assert.ok(hs.every((h) => h >= 800), hs.join(','));
  assert.ok(ran(cdp, 'forceExpand'));
});

test('forcing a stuck scroller re-clips its parent: grow again after the force', async () => {
  // column follows the viewport; its need rises by 1000 once the nested scroller is forced open
  let cdp;
  let forced = false;
  cdp = unfoldCdp(null, {
    'Runtime.callFunctionOn': (p) => {
      if (p.functionDeclaration.includes('forceExpand')) forced = true;
      const grown = heights(cdp).length ? heights(cdp).at(-1) - 600 : 0;
      const col = Math.max(0, 950 + (forced ? 1000 : 0) - grown);
      const nested = forced ? 0 : 1000;
      const items = [col, nested];
      return pageFns({ scanScrollers: null, measureHidden: { hidden: col + nested, max: Math.max(col, nested), remaining: 2, total: 2, items }, forceExpand: 1, restoreState: true })(p);
    },
  });
  await captureFull(cdp, fast);
  assert.equal(heights(cdp).at(-1), 2550); // 600 + 950 + 1000
});

// --- document scroll (html/body) ----------------------------------------------------

function docCdp(contentOf, extra = {}) {
  let cdp;
  cdp = makeFakeCdp({
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 0, max: 0, remaining: 0, total: 0, items: [] } }),
    'Runtime.evaluate': (p) => {
      if (p.expression === 'window.devicePixelRatio') return { result: { value: 1 } };
      if (p.expression.startsWith('[window.scrollX')) return { result: { value: [0, 420] } };
      return { result: { objectId: 'body-obj' } };
    },
    'Page.getLayoutMetrics': () => {
      const set = cdp.calls.findLast((c) => c.method === 'Emulation.setDeviceMetricsOverride');
      const view = set ? set.params.height : 600;
      return { cssLayoutViewport: { clientWidth: 800, clientHeight: view }, cssContentSize: { width: 800, height: contentOf(view) } };
    },
    ...extra,
  });
  return cdp;
}

test('document scroll: grow viewport to the content height, shoot inside it, restore scroll', async () => {
  const cdp = docCdp((view) => Math.max(view, 3000));
  await captureFull(cdp, fast);
  assert.deepEqual(heights(cdp), [3000]);
  const shot = cdp.calls.find((c) => c.method === 'Page.captureScreenshot');
  assert.deepEqual(shot.params.clip, { x: 0, y: 0, width: 800, height: 3000, scale: 1 });
  const names = cdp.names();
  const iShot = names.indexOf('Page.captureScreenshot');
  const iClear = names.indexOf('Emulation.clearDeviceMetricsOverride');
  const iScroll = cdp.calls.findIndex((c) => c.method === 'Runtime.evaluate' && c.params.expression === 'window.scrollTo(0, 420)');
  assert.ok(iShot < iClear && iClear < iScroll, names.join(','));
});

test('document scroll: layouts that follow the viewport (100vh) stop after bounded passes', async () => {
  const cdp = docCdp((view) => view + 2000); // never converges
  await captureFull(cdp, fast);
  assert.equal(heights(cdp).length, 2);
  const shot = cdp.calls.find((c) => c.method === 'Page.captureScreenshot');
  assert.equal(shot.params.clip.height, heights(cdp).at(-1)); // what fits the viewport, never beyond it
  assert.ok(cdp.names().includes('Emulation.clearDeviceMetricsOverride'));
});

test('document scroll: too tall -> TOO_LARGE before any emulation', async () => {
  const cdp = docCdp((view) => Math.max(view, 30000));
  await rejectsWith(captureFull(cdp, fast), ErrorCode.TOO_LARGE);
  assert.ok(!cdp.names().includes('Emulation.setDeviceMetricsOverride'));
});

test('document scroll: a page that already fits is a plain viewport shot', async () => {
  const cdp = docCdp((view) => view);
  await captureFull(cdp, fast);
  assert.ok(!cdp.names().includes('Emulation.setDeviceMetricsOverride'));
  assert.equal(cdp.calls.find((c) => c.method === 'Page.captureScreenshot').params.clip, undefined);
});

// --- element taller than the viewport ------------------------------------------------

test('captureNode: element taller than the viewport -> grow viewport to its height, scroll to it', async () => {
  let cdp;
  cdp = makeFakeCdp({
    'DOM.resolveNode': { object: { objectId: 'el-obj' } },
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 0, max: 0, remaining: 0, total: 0, items: [] } }),
    'Runtime.evaluate': (p) => {
      if (p.expression === 'window.devicePixelRatio') return { result: { value: 1 } };
      if (p.expression.startsWith('[window.scrollX')) return { result: { value: [0, 300] } };
      return { result: {} };
    },
    'DOM.getBoxModel': () => {
      const set = cdp.calls.findLast((c) => c.method === 'Emulation.setDeviceMetricsOverride');
      const top = set ? 0 : 20; // after the move the element top sits at the viewport top
      return { model: { border: [10, top, 110, top, 110, top + 1500, 10, top + 1500] } };
    },
    'Page.getLayoutMetrics': () => {
      const set = cdp.calls.findLast((c) => c.method === 'Emulation.setDeviceMetricsOverride');
      const scroll = cdp.calls.findLast((c) => c.method === 'Runtime.evaluate' && c.params.expression.startsWith('window.scrollTo(0'));
      const pageY = set && scroll ? Number(/, (\d+)\)/.exec(scroll.params.expression)[1]) : 300;
      return {
        cssLayoutViewport: { clientWidth: 800, clientHeight: set ? set.params.height : 600 },
        cssVisualViewport: { pageX: 0, pageY, clientWidth: 800, clientHeight: set ? set.params.height : 600, zoom: 1 },
        cssContentSize: { width: 800, height: 5000 },
      };
    },
    'Page.captureScreenshot': () => ({ data: makePng(100, 1500) }),
  });
  const r = await captureNode(cdp, 7, fast);
  assert.equal(heights(cdp).at(-1), 1500);
  const shot = cdp.calls.find((c) => c.method === 'Page.captureScreenshot');
  assert.deepEqual([shot.params.clip.height, shot.params.clip.width], [1500, 100]);
  assert.deepEqual([r.width, r.height], [100, 1500]);
  const names = cdp.names();
  assert.ok(names.indexOf('Page.captureScreenshot') < names.indexOf('Emulation.clearDeviceMetricsOverride'));
  const restore = cdp.calls.findLast((c) => c.method === 'Runtime.evaluate' && c.params.expression.startsWith('window.scrollTo'));
  assert.equal(restore.params.expression, 'window.scrollTo(0, 300)'); // original position back
});

test('captureNode: element that already fits the viewport does not touch the viewport', async () => {
  const cdp = makeFakeCdp({
    'DOM.resolveNode': { object: { objectId: 'el-obj' } },
    'DOM.getBoxModel': { model: { border: [0, 10, 100, 10, 100, 60, 0, 60] } },
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 0, max: 0, remaining: 0, total: 0, items: [] } }),
    'Page.getLayoutMetrics': { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600, zoom: 1 } },
    'Page.captureScreenshot': () => ({ data: makePng(100, 50) }),
  });
  await captureNode(cdp, 7, fast);
  assert.ok(!cdp.names().includes('Emulation.setDeviceMetricsOverride'));
});

test('captureNode: element taller than the limit -> TOO_LARGE', async () => {
  const cdp = makeFakeCdp({
    'DOM.resolveNode': { object: { objectId: 'el-obj' } },
    'DOM.getBoxModel': { model: { border: [0, 0, 100, 0, 100, 30000, 0, 30000] } },
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 0, max: 0, remaining: 0, total: 0, items: [] } }),
  });
  await rejectsWith(captureNode(cdp, 7, fast), ErrorCode.TOO_LARGE);
  assert.ok(!cdp.names().includes('Emulation.setDeviceMetricsOverride'));
});

test('pickNode: turns the viewport-size label off before inspect mode starts', async () => {
  const cdp = makeFakeCdp();
  const p = pickNode(cdp, { pickTimeoutMs: 1000 });
  await new Promise((r) => setTimeout(r, 5));
  cdp.emit('Overlay.inspectNodeRequested', { backendNodeId: 1 });
  await p;
  const names = cdp.names();
  const off = cdp.calls.findIndex((c) => c.method === 'Overlay.setShowViewportSizeOnResize' && c.params.show === false);
  assert.ok(off > names.indexOf('Overlay.enable') && off < names.indexOf('Overlay.setInspectMode'), names.join(','));
});

// --- browser zoom: clips are device-independent px (css * zoom) ----------------------

test('captureFull at browser zoom 90%: clip = css size * zoom, override stays in css px', async () => {
  let cdp;
  cdp = makeFakeCdp({
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 0, max: 0, remaining: 0, total: 0, items: [] } }),
    'Runtime.evaluate': (p) => ({ result: { value: p.expression === 'window.devicePixelRatio' ? 1.8 : [0, 0], objectId: 'body-obj' } }),
    'Page.getLayoutMetrics': () => {
      const set = cdp.calls.findLast((c) => c.method === 'Emulation.setDeviceMetricsOverride');
      const view = set ? set.params.height : 1000;
      return {
        cssLayoutViewport: { clientWidth: 2133, clientHeight: view },
        cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 2133, clientHeight: view, zoom: 0.9 },
        cssContentSize: { width: 2133, height: Math.max(view, 2000) },
      };
    },
    'Page.captureScreenshot': () => ({ data: makePng(3839, 3600) }),
  });
  await captureFull(cdp, fast);
  assert.deepEqual(heights(cdp), [2000]); // css px
  const clip = cdp.calls.find((c) => c.method === 'Page.captureScreenshot').params.clip;
  assert.deepEqual([clip.width, clip.height], [1920, 1800]); // 2133 * 0.9, 2000 * 0.9
});

test('captureNode at zoom 90%: element taller than the viewport fits using css units', async () => {
  let cdp;
  cdp = makeFakeCdp({
    'DOM.resolveNode': { object: { objectId: 'el-obj' } },
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 0, max: 0, remaining: 0, total: 0, items: [] } }),
    'Runtime.evaluate': (p) => ({ result: { value: p.expression === 'window.devicePixelRatio' ? 1.8 : [0, 0] } }),
    'DOM.getBoxModel': () => {
      const set = cdp.calls.findLast((c) => c.method === 'Emulation.setDeviceMetricsOverride');
      const top = set ? 0 : 50; // css px
      return { model: { border: [0, top, 500, top, 500, top + 2000, 0, top + 2000] } }; // 2000 css px tall
    },
    'Page.getLayoutMetrics': () => {
      const set = cdp.calls.findLast((c) => c.method === 'Emulation.setDeviceMetricsOverride');
      const scroll = cdp.calls.findLast((c) => c.method === 'Runtime.evaluate' && c.params.expression.startsWith('window.scrollTo(0'));
      const pageY = set && scroll ? Number(/, (\d+)\)/.exec(scroll.params.expression)[1]) : 0;
      const h = set ? set.params.height : 1000;
      return {
        cssLayoutViewport: { clientWidth: 2133, clientHeight: h },
        cssVisualViewport: { pageX: 0, pageY, clientWidth: 2133, clientHeight: h, zoom: 0.9 },
      };
    },
    'Page.captureScreenshot': () => ({ data: makePng(900, 3240) }),
  });
  await captureNode(cdp, 7, fast);
  assert.equal(heights(cdp).at(-1), 2000); // css px (not 1800)
  const clip = cdp.calls.find((c) => c.method === 'Page.captureScreenshot').params.clip;
  assert.equal(clip.height, 1800); // 2000 css * 0.9 dip
});

// --- viewport override units differ from css px under browser zoom -------------------

function zoomedDocCdp(zoom, contentCss) {
  // Emulation.setDeviceMetricsOverride size is NOT css px here: css viewport = override / zoom
  let cdp;
  cdp = makeFakeCdp({
    'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 0, max: 0, remaining: 0, total: 0, items: [] } }),
    'Runtime.evaluate': (p) => ({ result: { value: p.expression === 'window.devicePixelRatio' ? 2 * zoom : [0, 0], objectId: 'b' } }),
    'Page.getLayoutMetrics': () => {
      const set = cdp.calls.findLast((c) => c.method === 'Emulation.setDeviceMetricsOverride');
      const w = set ? set.params.width / zoom : 1920 / zoom;
      const h = set ? set.params.height / zoom : 900 / zoom;
      return {
        cssLayoutViewport: { clientWidth: w, clientHeight: h },
        cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: w, clientHeight: h, zoom },
        cssContentSize: { width: w, height: Math.max(h, contentCss) },
      };
    },
    'Page.captureScreenshot': () => ({ data: makePng(10, 10) }),
  });
  return cdp;
}

for (const zoom of [0.9, 1.25]) {
  test(`document scroll at zoom ${zoom} where the override is not css px: viewport ends up exactly content-sized`, async () => {
    const cdp = zoomedDocCdp(zoom, 3000);
    await captureFull(cdp, fast);
    const last = heights(cdp).at(-1);
    assert.ok(Math.abs(last / zoom - 3000) <= 2, `override ${last} -> css ${last / zoom}`);
    const clip = cdp.calls.find((c) => c.method === 'Page.captureScreenshot').params.clip;
    assert.ok(Math.abs(clip.height - 3000 * zoom) <= 2, `clip ${clip.height}`); // dip = css * zoom, no blank
    assert.ok(cdp.names().includes('Emulation.clearDeviceMetricsOverride'));
  });
}

test('override units are calibrated once per capture (one extra override, not one per step)', async () => {
  const cdp = zoomedDocCdp(0.9, 3000);
  await captureFull(cdp, fast);
  assert.equal(heights(cdp).length, 2); // first call measures the ratio, second is on target
});

// --- waiting ----------------------------------------------------------------------------

const frameWaits = (cdp) => cdp.calls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('requestAnimationFrame'));
const layoutWaits = (cdp) => cdp.calls.filter((c) => c.params?.functionDeclaration?.includes('waitStable'));

test('the shot delay (settleMs) is paid once per shot, not once per step', async () => {
  let cdp;
  cdp = unfoldCdp(() => {
    const grown = heights(cdp).length ? heights(cdp).at(-1) - 600 : 0;
    const left = Math.max(0, 1000 - grown);
    return { hidden: left, max: left, remaining: left > 0 ? 1 : 0, total: 1, items: [left] };
  });
  await captureFull(cdp, { settleMs: 50 });
  assert.equal(frameWaits(cdp).length, 1);
  assert.ok(layoutWaits(cdp).length >= 1); // the steps before it only wait for the layout
  const shot = cdp.names().indexOf('Page.captureScreenshot');
  const delay = cdp.calls.findIndex((c) => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('requestAnimationFrame'));
  assert.ok(delay >= 0 && delay < shot);
});

test('no delay and no waiting when nothing was changed for the shot', async () => {
  const cdp = makeFakeCdp({ 'Runtime.callFunctionOn': pageFns({ scanScrollers: null, measureHidden: { hidden: 0, max: 0, remaining: 0, total: 0, items: [] } }) });
  await captureFull(cdp, { settleMs: 50 });
  assert.equal(frameWaits(cdp).length, 0);
});

test('restoring the page does not wait for frames', async () => {
  let cdp;
  cdp = unfoldCdp(() => {
    const grown = heights(cdp).length ? heights(cdp).at(-1) - 600 : 0;
    const left = Math.max(0, 500 - grown);
    return { hidden: left, max: left, remaining: left > 0 ? 1 : 0, total: 1, items: [left] };
  });
  await captureFull(cdp, { settleMs: 50 });
  const shot = cdp.names().indexOf('Page.captureScreenshot');
  const after = cdp.calls.slice(shot + 1);
  assert.ok(!after.some((c) => String(c.params?.expression ?? '').includes('requestAnimationFrame')));
  assert.ok(!after.some((c) => c.params?.functionDeclaration?.includes('waitStable')));
});

test('a window that renders no frames is detected once; later waits are skipped', async () => {
  const cdp = makeFakeCdp({ 'Runtime.evaluate': () => ({ result: { value: false } }) });
  const opts = { settleMs: 50 };
  await settle(cdp, opts);
  assert.equal(opts.hiddenWindow, true);
  const n = cdp.calls.length;
  await settle(cdp, opts);
  assert.equal(cdp.calls.length, n);
});

test('the default shot delay is 250 ms', () => {
  assert.equal(DEFAULTS.settleMs, 250);
});
