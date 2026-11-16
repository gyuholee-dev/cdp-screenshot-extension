// Ends an element pick when the user leaves the page. The same set of events whatever started the
// capture and wherever the keyboard focus was: Esc, another tab, another window or app (Chrome lost
// the focus), a click in this extension's own panel, a navigation. Not the page's own focus state:
// it reacts differently depending on where the focus was (a click in the address bar ended a pick
// started with the page focused but not one started with the panel focused), so it is not used.
// A short grace period after the pick starts ignores the focus changes that the start itself
// causes (bringing the window forward, the debugging bar, the panel click that started it).

/**
 * @param {{graceMs?: number, now?: () => number}} [opts]
 */
export function createPickGuard({ graceMs = 400, now = () => Date.now() } = {}) {
  const recs = new Map(); // tabId -> {tabId, windowId, controller, pickAt}
  return {
    /** A capture starts on a tab: returns its AbortController (its signal ends the pick). */
    add(tabId, windowId) {
      const controller = new AbortController();
      recs.set(tabId, { tabId, windowId, controller, pickAt: null });
      return controller;
    },
    remove(tabId) { recs.delete(tabId); },
    /** The pick of that tab is now waiting for the user. */
    picking(tabId) {
      const r = recs.get(tabId);
      if (r) r.pickAt = now();
    },
    /** Cancel the picks the predicate selects, once past the grace period. Returns how many. */
    cancelWhere(predicate) {
      let n = 0;
      for (const r of recs.values()) {
        if (r.pickAt != null && now() - r.pickAt >= graceMs && predicate(r)) { r.controller.abort(); n++; }
      }
      return n;
    },
    /** An explicit cancel (the panel's button or Esc): no grace period. */
    cancelWindow(windowId) {
      let n = 0;
      for (const r of recs.values()) if (r.windowId === windowId) { r.controller.abort(); n++; }
      return n;
    },
  };
}
