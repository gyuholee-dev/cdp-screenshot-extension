// Where the shot element is on the screen now, for the edge effect of an element capture
// (the flash stays on the whole screen). Read after the capture, when the page is restored, so it is
// where the user sees it.

/**
 * @param {{send: Function}} cdp the capture's connection
 * @param {number} backendNodeId the element that was shot
 * @returns {Promise<{left: number, top: number, width: number, height: number, radius: string} | null>}
 *   its box in viewport CSS px, or null when it is not on the screen now (or is gone): then the
 *   edge effect is not shown at all (it is not replaced by a screen-wide one).
 */
export async function readElementBox(cdp, backendNodeId) {
  let objectId;
  try {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
    objectId = object?.objectId;
    if (!objectId) return null;
    const r = await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function () {
        const b = this.getBoundingClientRect();
        return { left: b.left, top: b.top, width: b.width, height: b.height, radius: getComputedStyle(this).borderRadius, vw: innerWidth, vh: innerHeight };
      }`,
      returnByValue: true,
    });
    const v = r?.result?.value;
    if (!v || !(v.width > 0 && v.height > 0)) return null;
    const onScreen = v.left < v.vw && v.top < v.vh && v.left + v.width > 0 && v.top + v.height > 0;
    if (!onScreen) return null;
    return { left: v.left, top: v.top, width: v.width, height: v.height, radius: v.radius || '0' };
  } catch {
    return null; // the element is gone or cannot be read
  } finally {
    if (objectId) { try { await cdp.send('Runtime.releaseObject', { objectId }); } catch { /* ignore */ } }
  }
}
