import { CaptureError, ErrorCode } from './errors.js';

/**
 * Build a Page.captureScreenshot clip like DevTools' "Capture node screenshot".
 * The border quad is viewport-relative, so add the page offset, multiply by zoom,
 * floor the top-left and ceil the bottom-right so the clip covers the element.
 * @param {{border:number[]}} boxModel DOM.getBoxModel `model`
 * @param {object} metrics Page.getLayoutMetrics result
 */
export function computeClip(boxModel, metrics) {
  const q = boxModel.border;
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const vv = metrics.cssVisualViewport ?? metrics.visualViewport ?? {};
  const pageX = vv.pageX ?? 0;
  const pageY = vv.pageY ?? 0;
  const zoom = vv.zoom ?? 1;
  const x0 = (Math.min(...xs) + pageX) * zoom;
  const y0 = (Math.min(...ys) + pageY) * zoom;
  const x1 = (Math.max(...xs) + pageX) * zoom;
  const y1 = (Math.max(...ys) + pageY) * zoom;
  const x = Math.floor(x0);
  const y = Math.floor(y0);
  const width = Math.ceil(x1) - x;
  const height = Math.ceil(y1) - y;
  if (!(width > 0 && height > 0)) {
    throw new CaptureError(ErrorCode.NO_ELEMENT, 'The element has no size, so it cannot be captured.');
  }
  return { x, y, width, height, scale: 1 };
}

/**
 * Browser (page) zoom factor from Page.getLayoutMetrics. Screenshot clips are in device-independent
 * pixels, layout sizes are in CSS pixels: dip = css * zoom, and device px = css * devicePixelRatio
 * (window.devicePixelRatio already includes the zoom).
 */
export function zoomOf(metrics) {
  const vv = metrics.cssVisualViewport ?? metrics.visualViewport ?? {};
  return vv.zoom > 0 ? vv.zoom : 1;
}
