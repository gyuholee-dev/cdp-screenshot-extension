import { CaptureError, ErrorCode } from './errors.js';
import { computeClip } from './geometry.js';
import { expandScrollers } from './expand.js';
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

    const m = await cdp.send('Page.getLayoutMetrics');
    const content = m.cssContentSize ?? m.contentSize;
    const view = m.cssLayoutViewport ?? m.layoutViewport;
    const docHidden = content.height - view.clientHeight;
    opts.progress({ stage: 'capture' });
    if (!exp.expanded && docHidden <= 1) return screenshot(cdp, opts);

    // Horizontal scroll is out of scope for now: width = viewport width.
    const clip = { x: 0, y: 0, width: view.clientWidth, height: Math.ceil(content.height), scale: 1 };
    assertWithinLimit(clip.width * dpr, clip.height * dpr, opts.maxSidePixels);
    return screenshot(cdp, opts, { captureBeyondViewport: true, clip }, {
      width: Math.round(clip.width * dpr),
      height: Math.round(clip.height * dpr),
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

    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId });
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const clip = computeClip(model, metrics);
    assertWithinLimit(clip.width * dpr, clip.height * dpr, opts.maxSidePixels);

    opts.progress({ stage: 'capture' });
    return screenshot(cdp, opts, { captureBeyondViewport: true, clip }, {
      width: Math.round(clip.width * dpr),
      height: Math.round(clip.height * dpr),
    });
  });
}

/** Let the user pick an element, then capture it. */
export async function captureElement(cdp, options = {}) {
  const picked = await pickNode(cdp, options);
  return captureNode(cdp, picked, options);
}
