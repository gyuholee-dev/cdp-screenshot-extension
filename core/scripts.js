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

/** this = state. Hidden height (px) per tracked scroller, plus sum and largest. */
export function measureHidden() {
  let hidden = 0;
  let max = 0;
  let remaining = 0;
  const items = [];
  for (const el of this.scrollers) {
    const h = el.isConnected ? el.scrollHeight - el.clientHeight : 0;
    const v = h > 1 ? h : 0;
    items.push(v);
    if (v > 0) { hidden += v; remaining++; if (v > max) max = v; }
  }
  return { hidden, max, remaining, total: this.scrollers.length, items };
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

/**
 * this = the state (tracked scrollers) or nothing. Resolves once the heights that drive the
 * unfolding stopped changing for two frames in a row, or after `maxMs`. {hidden: true} when the
 * window renders no frames at all.
 */
export function waitStable(maxMs) {
  const list = this && this.scrollers;
  const read = () => {
    let s = `${innerWidth}x${innerHeight}|${document.documentElement.scrollHeight}|${document.body ? document.body.scrollHeight : 0}`;
    if (list) for (const el of list) s += `|${el.isConnected ? `${el.scrollHeight}:${el.clientHeight}` : 'x'}`;
    return s;
  };
  return new Promise((resolve) => {
    const t0 = performance.now();
    let prev = read();
    let same = 0;
    let frames = 0;
    let seen = false;
    const stall = setTimeout(() => { if (!seen) resolve({ hidden: true }); }, 150);
    const tick = () => {
      seen = true;
      clearTimeout(stall);
      frames++;
      const cur = read();
      same = cur === prev ? same + 1 : 0;
      prev = cur;
      if ((same >= 2 && frames >= 2) || performance.now() - t0 > maxMs) { resolve({ hidden: false, frames }); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * this = the element to shoot. Ancestors that clip it (the app scrolls an inner container, not the
 * document: body{overflow:hidden} + .dbody{overflow:auto}) would cut the shot at their edge, so their
 * overflow is set to visible (originals and scroll positions saved in the returned state).
 * Innermost first; rects are re-read after each change because layout moves.
 */
export function unclipAncestors() {
  const html = document.documentElement;
  const body = document.body;
  const clips = (v) => v === 'hidden' || v === 'auto' || v === 'scroll' || v === 'clip';
  const state = { saved: [] };
  for (let a = this.parentElement; a && a !== body && a !== html; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (!clips(cs.overflowY) && !clips(cs.overflowX)) continue;
    const r = this.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    const top = ar.top + a.clientTop;
    const bottom = top + a.clientHeight;
    if (r.bottom <= bottom + 1 && r.top >= top - 1) continue; // fully inside: nothing is cut
    state.saved.push([a, a.scrollTop, a.scrollLeft, a.style.getPropertyValue('overflow'), a.style.getPropertyPriority('overflow')]);
    a.style.setProperty('overflow', 'visible', 'important');
  }
  return state;
}

/** this = state from unclipAncestors. */
export function restoreAncestors() {
  for (let i = this.saved.length - 1; i >= 0; i--) {
    const [a, st, sl, v, prio] = this.saved[i];
    if (v) a.style.setProperty('overflow', v, prio); else a.style.removeProperty('overflow');
    a.scrollTop = st;
    a.scrollLeft = sl;
  }
  this.saved.length = 0;
  return true;
}

/** Call a page function on a remote object. byValue=false returns the result's objectId. */
export async function callOn(cdp, objectId, fn, args = [], byValue = true) {
  const r = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn.toString(),
    arguments: args.map((value) => ({ value })),
    returnByValue: byValue,
    awaitPromise: true,
  });
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new CaptureError(ErrorCode.CDP_ERROR, d.exception?.description ?? d.text ?? 'page script failed');
  }
  return byValue ? r.result.value : r.result.objectId;
}
