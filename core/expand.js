import { assertWithinLimit, layoutBarrier } from './util.js';
import { zoomOf } from './geometry.js';
import { callOn, forceExpand, measureHidden, restoreState, scanScrollers, waitStable } from './scripts.js';

const MAX_PASSES = 6;
const MAX_ROUNDS = 3;
const PROBE_PX = 200; // first growth: small, only to learn which scrollers respond and how fast
const LAYOUT_WAIT_MAX_MS = 300; // upper bound of one layoutWait (a height that keeps animating)

/**
 * Layout wait: after the page was changed for the shot, wait only until the heights that drive the
 * unfolding stopped changing (two frames in a row; usually ~35ms), at most LAYOUT_WAIT_MAX_MS.
 * The one fixed delay (`settleMs`) is paid once, right before the shot (util.settle).
 */
async function layoutWait(cdp, opts, stateId) {
  if (opts.hiddenWindow) return;
  const r = stateId
    ? await callOn(cdp, stateId, waitStable, [LAYOUT_WAIT_MAX_MS])
    : (await cdp.send('Runtime.evaluate', {
      expression: `(${waitStable.toString()}).call(null, ${LAYOUT_WAIT_MAX_MS})`,
      awaitPromise: true,
      returnByValue: true,
    }))?.result?.value;
  if (r?.hidden) opts.hiddenWindow = true;
}

/**
 * Set the viewport to a CSS-pixel size. With a browser zoom other than 100% the size passed to
 * Emulation.setDeviceMetricsOverride is not interpreted as CSS px (observed at 90% and 125%), so
 * the first call is used to measure how many CSS px one override px gives, and the size is
 * corrected by that ratio from then on (kept on `opts` for the rest of this capture).
 */
async function applyViewport(cdp, opts, cssW, cssH, stateId) {
  let ratio = opts.viewportRatio ?? 1; // css px per override px
  for (let attempt = 0; attempt < 2; attempt++) {
    const height = Math.max(1, Math.round(cssH / ratio));
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: Math.max(1, Math.round(cssW / ratio)),
      height,
      deviceScaleFactor: 0, // keep the original scale
      mobile: false,
    });
    await layoutWait(cdp, opts, stateId);
    if (opts.viewportRatio) return;
    const m = await cdp.send('Page.getLayoutMetrics');
    const v = m.cssLayoutViewport ?? m.layoutViewport;
    const measured = v?.clientHeight / height;
    if (!(measured > 0.4 && measured < 2.5)) return; // not plausible: keep css px
    opts.viewportRatio = measured;
    if (Math.abs(measured / ratio - 1) < 0.02) return; // already on target
    ratio = measured; // once more with the corrected ratio
  }
}

async function layoutViewport(cdp) {
  const m = await cdp.send('Page.getLayoutMetrics');
  const v = m.cssLayoutViewport ?? m.layoutViewport;
  return { width: v.clientWidth, height: v.clientHeight };
}

const itemsOf = (m) => m.items ?? [m.max];

/**
 * Unfold scroll containers found within `opts.depth` of the root element.
 *
 * Strategy (handoff §6), judged per scroller:
 *  1. Grow the viewport by a small probe and re-measure each scroller.
 *  2. A scroller whose hidden amount did not shrink is "stuck" (fixed height): it will be
 *     handled by the style fallback and no longer drives the growth.
 *  3. For responsive scrollers the rate (hidden px removed per px grown) gives the extra
 *     height they still need; grow by the largest need and repeat until they are unfolded.
 *     Side-by-side scrollers (rate 1) and stacked ones sharing the height (rate < 1) both
 *     converge without a blind sum or max.
 *  4. If nothing responded, the probe is undone. Stuck scrollers get their size styles
 *     overridden (originals saved).
 *
 * Everything is registered with `defer` so the page is restored in `finally`.
 *
 * @returns {Promise<{expanded: boolean, hidden: number}>}
 */
export async function expandScrollers(cdp, rootObjectId, opts, defer, dpr) {
  const stateId = await callOn(cdp, rootObjectId, scanScrollers, [opts.depth], false);
  const m0 = await callOn(cdp, stateId, measureHidden);
  if (m0.max <= 1) {
    await cdp.send('Runtime.releaseObject', { objectId: stateId }).catch(() => {});
    return { expanded: false, hidden: 0 };
  }

  const view = await layoutViewport(cdp);
  // m0.max is a lower bound of the height a responsive scroller needs: reject early if even that is too big.
  assertWithinLimit(view.width * dpr, (view.height + m0.max) * dpr, opts.maxSidePixels);

  // Cleanup order (reverse of registration): clear override -> layout barrier -> restore state.
  defer(async () => {
    try {
      await layoutBarrier(cdp);
      await callOn(cdp, stateId, restoreState);
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId: stateId }).catch(() => {});
    }
  });
  defer(() => cdp.send('Emulation.clearDeviceMetricsOverride'));

  let height = view.height;
  const setHeight = async (h) => {
    assertWithinLimit(view.width * dpr, h * dpr, opts.maxSidePixels);
    height = h;
    await applyViewport(cdp, opts, view.width, h, stateId);
  };

  // One round: grow for the scrollers that follow the viewport. Returns when none still does.
  const growLoop = async () => {
    const startHeight = height;
    let items = itemsOf(await callOn(cdp, stateId, measureHidden));
    const maxHidden = Math.max(0, ...items);
    if (maxHidden <= 1) return;
    const stuck = new Set();
    let grow = Math.min(Math.ceil(maxHidden), PROBE_PX);
    let anyResponded = false;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      await setHeight(height + grow);
      const now = itemsOf(await callOn(cdp, stateId, measureHidden));
      let need = 0;
      for (let i = 0; i < items.length; i++) {
        if (stuck.has(i) || items[i] <= 1) continue;
        const reduced = items[i] - now[i];
        if (reduced <= 1) { stuck.add(i); continue; }
        anyResponded = true;
        if (now[i] > 1) need = Math.max(need, Math.ceil((now[i] * grow) / reduced));
      }
      items = now;
      if (!anyResponded) {
        await setHeight(startHeight); // nothing reacts to the viewport: drop the probe
        return;
      }
      if (need <= 0) return;
      grow = need;
    }
  };

  // Forcing a fixed-height scroller open makes its ancestors' content taller, which can
  // clip them again: so grow -> force -> grow ... until nothing is hidden (bounded).
  for (let round = 0; round < MAX_ROUNDS; round++) {
    await growLoop();
    const m = await callOn(cdp, stateId, measureHidden);
    if (m.max <= 1) break;
    await callOn(cdp, stateId, forceExpand);
    await layoutWait(cdp, opts, stateId);
  }
  return { expanded: true, hidden: m0.max };
}

const MAX_DOC_PASSES = 2;

/**
 * Document (html/body) scroll: `captureBeyondViewport` repeated the first screen in real
 * Chrome (see test/fixtures/doc-scroll.html), so the viewport is grown to the content
 * height instead, like for scrollers, and the shot is taken inside the viewport.
 * Layouts that follow the viewport (100vh) grow together with it and never converge, so the
 * passes are bounded; the caller then captures what fits the viewport.
 * The window scroll position is restored in `finally`.
 *
 * @returns {Promise<{contentH: number, viewW: number, viewH: number, grown: boolean}>}
 */
export async function expandDocument(cdp, opts, defer, dpr) {
  const read = async () => {
    const m = await cdp.send('Page.getLayoutMetrics');
    const content = m.cssContentSize ?? m.contentSize;
    const view = m.cssLayoutViewport ?? m.layoutViewport;
    return { contentH: Math.ceil(content.height), viewW: view.clientWidth, viewH: view.clientHeight, zoom: zoomOf(m) };
  };
  let s = await read();
  if (s.contentH - s.viewH <= 1) return { ...s, grown: false };

  const pos = await cdp.send('Runtime.evaluate', { expression: '[window.scrollX, window.scrollY]', returnByValue: true });
  const [sx, sy] = pos?.result?.value ?? [0, 0];
  // Cleanup order (reverse): clear override -> layout barrier -> restore scroll position.
  defer(async () => {
    await layoutBarrier(cdp);
    await cdp.send('Runtime.evaluate', { expression: `window.scrollTo(${Number(sx)}, ${Number(sy)})` });
  });
  defer(() => cdp.send('Emulation.clearDeviceMetricsOverride'));

  for (let pass = 0; pass < MAX_DOC_PASSES; pass++) {
    assertWithinLimit(s.viewW * dpr, s.contentH * dpr, opts.maxSidePixels);
    await applyViewport(cdp, opts, s.viewW, s.contentH);
    s = await read();
    if (s.contentH - s.viewH <= 1) break;
  }
  return { ...s, grown: true };
}

// clip is in device-independent px (css * zoom); the visual viewport is in css px.
const clipFits = (clip, vv) => {
  const z = vv.zoom > 0 ? vv.zoom : 1;
  const top = vv.pageY ?? 0;
  const h = vv.clientHeight ?? Infinity;
  return clip.y / z >= top - 1 && (clip.y + clip.height) / z <= top + h + 1;
};

/**
 * An element taller than the viewport cannot be shot with `captureBeyondViewport` (the part
 * outside the viewport comes out blank in real Chrome). Grow the viewport to the element's
 * height and scroll its top to the viewport top, then measure again. Only the element's
 * height is needed, not the page's. Scroll position is restored in `finally`.
 *
 * @param {() => Promise<object>} measure re-reads the clip (box model + layout metrics)
 * @returns {Promise<object>} clip that fits the viewport (best effort: bounded, 100vh etc.)
 */
export async function fitViewportToClip(cdp, clip, metrics, measure, opts, defer, dpr) {
  const vv = metrics.cssVisualViewport ?? metrics.visualViewport ?? {};
  if (clipFits(clip, vv)) return clip;

  const view = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? { clientWidth: vv.clientWidth };
  const z = zoomOf(metrics);
  assertWithinLimit(view.clientWidth * dpr, (clip.height / z) * dpr, opts.maxSidePixels);

  const pos = await cdp.send('Runtime.evaluate', { expression: '[window.scrollX, window.scrollY]', returnByValue: true });
  const [sx, sy] = pos?.result?.value ?? [0, 0];
  // Cleanup order (reverse): clear override -> layout barrier -> restore scroll position.
  defer(async () => {
    await layoutBarrier(cdp);
    await cdp.send('Runtime.evaluate', { expression: `window.scrollTo(${Number(sx)}, ${Number(sy)})` });
  });
  defer(() => cdp.send('Emulation.clearDeviceMetricsOverride'));

  let current = clip;
  for (let pass = 0; pass < MAX_DOC_PASSES; pass++) {
    await applyViewport(cdp, opts, view.clientWidth, Math.ceil(current.height / z));
    await cdp.send('Runtime.evaluate', { expression: `window.scrollTo(${Number(sx)}, ${Math.floor(current.y / z)})` });
    await layoutWait(cdp, opts);
    const next = await measure();
    current = next.clip;
    if (clipFits(current, next.metrics.cssVisualViewport ?? next.metrics.visualViewport ?? {})) break;
    assertWithinLimit(view.clientWidth * dpr, (current.height / z) * dpr, opts.maxSidePixels);
  }
  return current;
}
