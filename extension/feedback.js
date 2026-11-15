// On-screen feedback for a finished capture: the whole page flashes (a shutter) and its edge glows,
// so "it was taken" is noticed at once, wherever the user is looking and however the page scrolls.
// Shown only after the capture is over and the page restored, so it can never be in the screenshot.

/**
 * Runs inside the page (via CDP Runtime.evaluate): must be self-contained.
 * Uses the Web Animations API and CSSOM only (no <style> element), which page CSP does not block.
 * @param {'ok'|'error'} variant ok: the user's flash and edge; error: a red edge, longer
 * @param {{flash: {enabled: boolean, css: string}, edge: {enabled: boolean, css: string}}} config
 *   the user's settings for the ok variant (CSS declarations for a full-screen layer)
 */
export function renderEffect(variant, config) {
  const ID = 'cdp-screenshot-effect';
  document.getElementById(ID)?.remove();
  const ok = variant === 'ok';
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const host = document.createElement('div');
  host.id = ID;
  Object.assign(host.style, { all: 'initial', position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none' });
  const root = host.attachShadow({ mode: 'closed' });
  // The user's CSS first, then what keeps it a click-through, full-screen layer.
  const layer = (css) => {
    const el = document.createElement('div');
    el.style.cssText = `${css};position:fixed !important;inset:0 !important;pointer-events:none !important;`;
    root.appendChild(el);
    return el;
  };

  let longest = 0;
  const edgeCss = ok ? config?.edge?.css : 'box-shadow: inset 0 0 0 5px rgba(229,56,61,0.95), inset 0 0 36px 8px rgba(229,56,61,0.55);';
  if ((ok ? config?.edge?.enabled : true) && edgeCss) {
    const ms = ok ? 650 : 1300;
    longest = Math.max(longest, ms);
    layer(edgeCss).animate([{ opacity: 1 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], { duration: ms, easing: 'ease-out', fill: 'forwards' });
  }
  if (ok && config?.flash?.enabled && config.flash.css && !reduced) {
    longest = Math.max(longest, 240);
    layer(config.flash.css).animate([{ opacity: 0.5 }, { opacity: 0 }], { duration: 240, easing: 'ease-out', fill: 'forwards' });
  }

  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), longest + 100);
  return true;
}
