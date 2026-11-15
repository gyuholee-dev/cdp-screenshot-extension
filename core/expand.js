import { assertWithinLimit, settle } from './util.js';
import { callOn, forceExpand, measureHidden, restoreState, scanScrollers } from './scripts.js';

const MAX_PASSES = 3;

async function layoutViewport(cdp) {
  const m = await cdp.send('Page.getLayoutMetrics');
  const v = m.cssLayoutViewport ?? m.layoutViewport;
  return { width: v.clientWidth, height: v.clientHeight };
}

/**
 * Unfold scroll containers found within `opts.depth` of the root element.
 * Strategy (handoff §6): grow the viewport by the hidden height, re-measure, and only
 * as a fallback override the size styles of scrollers that are still clipped.
 * Everything is registered with `defer` so the page is restored in `finally`.
 *
 * @returns {Promise<{expanded: boolean, hidden: number}>}
 */
export async function expandScrollers(cdp, rootObjectId, opts, defer, dpr) {
  const stateId = await callOn(cdp, rootObjectId, scanScrollers, [opts.depth], false);
  const m0 = await callOn(cdp, stateId, measureHidden);
  if (m0.hidden <= 1) {
    await cdp.send('Runtime.releaseObject', { objectId: stateId }).catch(() => {});
    return { expanded: false, hidden: 0 };
  }

  const view = await layoutViewport(cdp);
  assertWithinLimit(view.width * dpr, (view.height + m0.hidden) * dpr, opts.maxSidePixels);

  // Cleanup order (reverse of registration): clear override -> settle -> restore state.
  defer(async () => {
    try {
      await settle(cdp, opts);
      await callOn(cdp, stateId, restoreState);
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId: stateId }).catch(() => {});
    }
  });

  let height = view.height;
  const grow = async (extra) => {
    height += Math.ceil(extra);
    assertWithinLimit(view.width * dpr, height * dpr, opts.maxSidePixels);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: view.width,
      height,
      deviceScaleFactor: 0, // keep the original scale
      mobile: false,
    });
    await settle(cdp, opts);
  };
  defer(() => cdp.send('Emulation.clearDeviceMetricsOverride'));

  await grow(m0.hidden);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const m = await callOn(cdp, stateId, measureHidden);
    if (m.hidden <= 1) return { expanded: true, hidden: m0.hidden };
    await grow(m.hidden);
  }
  const m = await callOn(cdp, stateId, measureHidden);
  if (m.hidden > 1) {
    await callOn(cdp, stateId, forceExpand);
    await settle(cdp, opts);
  }
  return { expanded: true, hidden: m0.hidden };
}
