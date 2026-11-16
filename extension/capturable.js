// Pages the debugger cannot be attached to: Chrome's own pages and the Chrome Web Store (known ones
// only; any other page that refuses is still told by the error of the capture).

const BLOCKED_PROTOCOLS = ['chrome:', 'chrome-extension:', 'chrome-search:', 'chrome-untrusted:', 'chrome-error:', 'devtools:', 'view-source:'];

export function isCapturableUrl(url) {
  let u;
  try { u = new URL(url); } catch { return true; } // unknown or empty: let the capture decide
  if (BLOCKED_PROTOCOLS.includes(u.protocol)) return false;
  if (u.hostname === 'chromewebstore.google.com') return false;
  if (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return false;
  return true;
}

/**
 * Whether the tab shows a page that can be captured. The address comes from the debugger's target
 * list (the `debugger` permission already allows it; the tabs API would need another permission).
 */
export async function isTabCapturable(tabId, chromeApi = globalThis.chrome) {
  if (tabId == null) return true;
  try {
    const targets = await chromeApi.debugger.getTargets();
    const page = targets.find((t) => t.tabId === tabId && t.type === 'page');
    return page ? isCapturableUrl(page.url) : true;
  } catch {
    return true;
  }
}
