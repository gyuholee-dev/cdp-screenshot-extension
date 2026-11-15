// Functions that run INSIDE the page via Runtime.callFunctionOn (their source is sent as text).
// They are never called in Node; DOM globals are only referenced in their bodies.
// `this` is bound by CDP: the root element for scanScrollers, the state handle for the rest.
// State lives in a remote object handle, so nothing is written to page globals.

import { CaptureError, ErrorCode } from './errors.js';

/** this = root element. Returns a state object (kept remote). */
export function scanScrollers(depth) {
  const root = this;
  const html = document.documentElement;
  const body = document.body;
  const state = { scrollers: [], tops: [], saved: [], win: [window.scrollX, window.scrollY] };
  const walk = (el, d) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    if (el !== html && el !== body) {
      const oy = cs.overflowY;
      const rendered = cs.display !== 'contents' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
      if (rendered && (oy === 'auto' || oy === 'scroll') && el.clientHeight > 0 && el.scrollHeight - el.clientHeight > 1) {
        state.scrollers.push(el);
        state.tops.push(el.scrollTop);
      }
    }
    if (d >= depth) return;
    for (const c of el.children) walk(c, d + 1);
  };
  walk(root, 0);
  return state;
}

/** this = state. Remaining hidden height (px) over tracked scrollers. */
export function measureHidden() {
  let hidden = 0;
  let remaining = 0;
  for (const el of this.scrollers) {
    if (!el.isConnected) continue;
    const h = el.scrollHeight - el.clientHeight;
    if (h > 1) { hidden += h; remaining++; }
  }
  return { hidden, remaining, total: this.scrollers.length };
}

/** this = state. Fallback: unfix size of scrollers that are still clipped; originals are saved. */
export function forceExpand() {
  let n = 0;
  for (const el of this.scrollers) {
    if (!el.isConnected || el.scrollHeight - el.clientHeight <= 1) continue;
    const props = ['overflow', 'height', 'max-height'];
    this.saved.push([el, props.map((p) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)])]);
    el.style.setProperty('overflow', 'visible', 'important');
    el.style.setProperty('height', 'auto', 'important');
    el.style.setProperty('max-height', 'none', 'important');
    n++;
  }
  return n;
}

/** this = state. Restore styles, scroll positions. */
export function restoreState() {
  for (let i = this.saved.length - 1; i >= 0; i--) {
    const [el, props] = this.saved[i];
    for (const [p, v, prio] of props) {
      if (v) el.style.setProperty(p, v, prio);
      else el.style.removeProperty(p);
    }
  }
  this.saved.length = 0;
  this.scrollers.forEach((el, i) => { if (el.isConnected) el.scrollTop = this.tops[i]; });
  window.scrollTo(this.win[0], this.win[1]);
  return true;
}

/** Call a page function on a remote object. byValue=false returns the result's objectId. */
export async function callOn(cdp, objectId, fn, args = [], byValue = true) {
  const r = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn.toString(),
    arguments: args.map((value) => ({ value })),
    returnByValue: byValue,
  });
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new CaptureError(ErrorCode.CDP_ERROR, d.exception?.description ?? d.text ?? 'page script failed');
  }
  return byValue ? r.result.value : r.result.objectId;
}
