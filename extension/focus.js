// Host-side concern: core never touches window focus.
// On macOS a context-menu click does not focus the Chrome window, and an unfocused window gets
// no hover events, so the inspect-mode highlight never shows. Bring the tab's window forward
// before element picking starts.

const SETTLE_MS = 100;

/** Best effort: focusing must never block or fail a capture. */
export async function focusTab(tab, chromeApi = globalThis.chrome, wait = SETTLE_MS) {
  try {
    if (tab?.windowId != null) await chromeApi.windows.update(tab.windowId, { focused: true });
    if (tab?.id != null) await chromeApi.tabs.update(tab.id, { active: true });
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return true;
  } catch {
    return false;
  }
}
