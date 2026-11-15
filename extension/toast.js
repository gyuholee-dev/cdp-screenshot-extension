// On-screen details (size, where it was saved), at the top centre: a corner toast was too easy to
// miss, so the flash from feedback.js is the main signal and this one only carries the text.
// Shown only after the capture has finished (debugger detached, page
// restored), so it can never appear in the screenshot itself.

/** Runs inside the page (via chrome.scripting): must be self-contained. */
export function renderToast(text, isError) {
  const ID = 'cdp-screenshot-toast';
  document.getElementById(ID)?.remove();
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  box.textContent = text;
  box.style.cssText = 'font:14px/1.4 system-ui,sans-serif;color:#ffffff;padding:12px 16px;border-radius:4px;max-width:360px;'
    + 'box-shadow:0 2px 8px rgba(0,0,0,0.4);opacity:0;transition:opacity 150ms;white-space:pre-line;'
    + `background:${isError ? '#b00020' : '#222222'};`;
  root.appendChild(box);
  document.documentElement.appendChild(host);
  requestAnimationFrame(() => { box.style.opacity = '1'; });
  setTimeout(() => {
    box.style.opacity = '0';
    setTimeout(() => host.remove(), 200);
  }, isError ? 4000 : 2000);
  return true;
}

/** Best effort: pages that cannot be scripted (chrome://, store) simply get no toast. */
export async function showToast(tabId, text, isError = false, chromeApi = globalThis.chrome) {
  try {
    await chromeApi.scripting.executeScript({ target: { tabId }, func: renderToast, args: [text, isError] });
    return true;
  } catch {
    return false;
  }
}
