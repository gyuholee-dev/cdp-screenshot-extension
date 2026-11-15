import { CaptureError, ErrorCode } from './errors.js';
import { computeClip, zoomOf } from './geometry.js';
import { expandDocument, expandScrollers, fitViewportToClip } from './expand.js';
import { pickNode } from './pick.js';
import { assertWithinLimit, devicePixelRatio, normalizeOptions, runSession, screenshot } from './util.js';

/** Visible part of the page, as is. */
export async function captureViewport(cdp, options = {}) {
  const opts = normalizeOptions(options);
  return runSession(cdp, async () => {
    opts.progress({ stage: 'capture' });
    return screenshot(cdp, opts);
  });
}

/** Whole page: unfold scrollers within `depth` of <body>, then capture the full content. */
export async function captureFull(cdp, options = {}) {
  const opts = normalizeOptions(options);
  return runSession(cdp, async (defer) => {
    const dpr = await devicePixelRatio(cdp);
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.body' });
    if (!result?.objectId) throw new CaptureError(ErrorCode.NO_ELEMENT, 'document.body를 찾을 수 없습니다.');
    defer(() => cdp.send('Runtime.releaseObject', { objectId: result.objectId }));

    opts.progress({ stage: 'expand' });
    const exp = await expandScrollers(cdp, result.objectId, opts, defer, dpr);

    const doc = await expandDocument(cdp, opts, defer, dpr);
    opts.progress({ stage: 'capture' });
    if (!exp.expanded && !doc.grown) return screenshot(cdp, opts);

    // Horizontal scroll is out of scope for now: width = viewport width.
    // Stay inside the viewport: captureBeyondViewport repeats the first screen (doc-scroll fixture).
    // Sizes are CSS px; the clip wants device-independent px (css * browser zoom).
    const cssW = doc.viewW;
    const cssH = Math.min(doc.contentH, doc.viewH);
    assertWithinLimit(cssW * dpr, cssH * dpr, opts.maxSidePixels);
    const clip = { x: 0, y: 0, width: Math.round(cssW * doc.zoom), height: Math.round(cssH * doc.zoom), scale: 1 };
    return screenshot(cdp, opts, { captureBeyondViewport: true, clip }, {
      width: Math.round(cssW * dpr),
      height: Math.round(cssH * dpr),
    });
  });
}

async function resolveBackendNodeId(cdp, target) {
  if (typeof target === 'number') return target;
  if (target && typeof target === 'object' && Number.isInteger(target.backendNodeId)) return target.backendNodeId;
  const selector = typeof target === 'string' ? target : target?.selector;
  if (typeof selector !== 'string' || !selector) {
    throw new CaptureError(ErrorCode.INVALID_OPTION, 'target은 backendNodeId 또는 CSS 선택자여야 합니다.');
  }
  await cdp.send('DOM.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new CaptureError(ErrorCode.NO_ELEMENT, `선택자와 일치하는 요소가 없습니다: ${selector}`);
  const { node } = await cdp.send('DOM.describeNode', { nodeId });
  return node.backendNodeId;
}

/**
 * Capture a known element (backendNodeId or CSS selector).
 * Scrollers inside it (within `depth`, the element itself being depth 0) are unfolded.
 */
export async function captureNode(cdp, target, options = {}) {
  const opts = normalizeOptions(options);
  return runSession(cdp, async (defer) => {
    const dpr = await devicePixelRatio(cdp);
    await cdp.send('DOM.enable');
    const backendNodeId = await resolveBackendNodeId(cdp, target);
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });

    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
    defer(() => cdp.send('Runtime.releaseObject', { objectId: object.objectId }));

    opts.progress({ stage: 'expand' });
    const exp = await expandScrollers(cdp, object.objectId, opts, defer, dpr);
    if (exp.expanded) await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });

    const measure = async () => {
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId });
      const metrics = await cdp.send('Page.getLayoutMetrics');
      return { metrics, clip: computeClip(model, metrics) };
    };
    const first = await measure();
    const z = zoomOf(first.metrics);
    // clip is in device-independent px; the limit is in device px = css * dpr
    assertWithinLimit((first.clip.width / z) * dpr, (first.clip.height / z) * dpr, opts.maxSidePixels);
    const clip = await fitViewportToClip(cdp, first.clip, first.metrics, measure, opts, defer, dpr);

    opts.progress({ stage: 'capture' });
    return screenshot(cdp, opts, { captureBeyondViewport: true, clip }, {
      width: Math.round((clip.width / z) * dpr),
      height: Math.round((clip.height / z) * dpr),
    });
  });
}

/** Let the user pick an element, then capture it. */
export async function captureElement(cdp, options = {}) {
  const picked = await pickNode(cdp, options);
  return captureNode(cdp, picked, options);
}

/** Capture kinds hosts can request by name (used by the adapters). */
export const captureByKind = Object.freeze({
  viewport: captureViewport,
  full: captureFull,
  element: captureElement,
});
