// On-screen feedback for a finished capture: the whole page flashes (a shutter) and its edge glows,
// so "it was taken" is noticed at once, wherever the user is looking and however the page scrolls.
// Shown only after the capture is over and the page restored, so it can never be in the screenshot.

/**
 * Runs inside the page (via CDP Runtime.evaluate): must be self-contained.
 * Uses the Web Animations API and CSSOM only (no <style> element), which page CSP does not block.
 * @param {'ok'|'error'} variant ok: the user's flash and edge; error: a red edge, longer
 * @param {{flash: {enabled: boolean, css: string}, edge: {enabled: boolean, css: string}}} config
 *   the user's settings for the ok variant (CSS declarations for a full-screen layer)
 * @param {{left: number, top: number, width: number, height: number, radius: string} | null} [edgeBox]
 *   an element capture: the element's box, the edge goes there (the flash stays on the whole screen);
 *   null: the element is not on the screen, no edge; omitted: the edge is on the whole screen
 */
export function renderEffect(variant, config, edgeBox) {
  const ID = 'cdp-screenshot-effect';
  document.getElementById(ID)?.remove();
  const ok = variant === 'ok';
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const host = document.createElement('div');
  host.id = ID;
  Object.assign(host.style, { all: 'initial', position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none' });
  const root = host.attachShadow({ mode: 'closed' });
  // The user's CSS first, then what keeps it a click-through layer: the whole screen, or `box`
  // (an element's rectangle in viewport px, with its rounded corners).
  const layer = (css, box) => {
    const el = document.createElement('div');
    const place = box
      ? `inset:auto !important;left:${box.left}px !important;top:${box.top}px !important;width:${box.width}px !important;height:${box.height}px !important;border-radius:${box.radius} !important;box-sizing:border-box !important;`
      : 'inset:0 !important;';
    el.style.cssText = `${css};position:fixed !important;${place}pointer-events:none !important;`;
    root.appendChild(el);
    return el;
  };

  let longest = 0;
  const edgeCss = ok ? config?.edge?.css : 'box-shadow: inset 0 0 0 2px rgba(229,56,61,0.95), inset 0 0 18px 4px rgba(229,56,61,0.55);';
  // edgeBox: undefined = the whole screen; an object = that element only; null = the element is not
  // on the screen, so no edge (it is not replaced by a screen-wide one)
  if ((ok ? config?.edge?.enabled : true) && edgeCss && edgeBox !== null) {
    const ms = ok ? 650 : 1300;
    longest = Math.max(longest, ms);
    layer(edgeCss, edgeBox).animate([{ opacity: 1 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], { duration: ms, easing: 'ease-out', fill: 'forwards' });
  }
  if (ok && config?.flash?.enabled && config.flash.css && !reduced) {
    longest = Math.max(longest, 240);
    layer(config.flash.css).animate([{ opacity: 0.5 }, { opacity: 0 }], { duration: 240, easing: 'ease-out', fill: 'forwards' });
  }

  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), longest + 100);
  return true;
}
