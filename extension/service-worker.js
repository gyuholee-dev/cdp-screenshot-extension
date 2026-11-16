import { createChromeCdp, runCapture } from '../adapter-chrome/index.js';
import { ErrorCode } from '../core/index.js';
import { loadSettings } from './settings.js';
import { t } from './i18n.js';
import { isTabCapturable } from './capturable.js';
import * as history from './history.js';
import { saveBlob } from './save.js';
import { focusTab } from './focus.js';
import { captureFlow } from './capture-flow.js';
import { renderEffect } from './feedback.js';
import { readElementBox } from './element-box.js';
import { createPickGuard } from './pick-guard.js';

const MENU = [
  { id: 'viewport', title: 'kind.viewport' },
  { id: 'full', title: 'kind.full' },
  { id: 'element', title: 'kind.element' },
];
// Where the menu shows: web pages only. Not in this extension's own pages (the side panel is a page
// too, and a right click there must not offer a capture), nor on chrome:// pages that cannot be captured.
const MENU_PAGES = ['http://*/*', 'https://*/*', 'file:///*'];
const busy = new Set(); // one capture per tab at a time
const guard = createPickGuard(); // ends an element pick when the user leaves the page
const picking = new Set(); // windowIds whose element pick waits for the user: every panel of that window shows it
const openPanels = new Map(); // windowId -> number of connected panel instances

// --- context menu (also works in popup windows, which have no side panel) ----------------------
function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const log = () => { if (chrome.runtime.lastError) console.error('[cdp-screenshot] menu:', chrome.runtime.lastError.message); };
    for (const m of MENU) chrome.contextMenus.create({ id: m.id, title: t(m.title), contexts: ['all'], documentUrlPatterns: MENU_PAGES }, log);
  });
}
chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

// --- side panel open/close ---------------------------------------------------------------------
// The panel connects a port while it is open, so the worker knows which windows show it.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  let windowId;
  port.onMessage.addListener((msg) => {
    if (msg?.type !== 'hello') return;
    windowId = msg.windowId;
    openPanels.set(windowId, (openPanels.get(windowId) ?? 0) + 1);
    if (picking.has(windowId)) port.postMessage({ type: 'progress', stage: 'pick', windowId }); // a panel opened meanwhile
  });
  port.onDisconnect.addListener(() => {
    if (windowId == null) return;
    const n = (openPanels.get(windowId) ?? 1) - 1;
    if (n > 0) openPanels.set(windowId, n); else openPanels.delete(windowId);
  });
});

// Must run synchronously inside the click / shortcut: the user gesture is needed to open a panel.
function togglePanel(windowId) {
  if (windowId == null) return;
  if (openPanels.has(windowId)) chrome.sidePanel.close({ windowId }).catch(() => {});
  else chrome.sidePanel.open({ windowId }).catch((e) => console.error('[cdp-screenshot] open panel:', e?.message));
}

chrome.action.onClicked.addListener((tab) => togglePanel(tab.windowId));

// --- capture -----------------------------------------------------------------------------------
/** The flash and edge on the page, through the connection the capture used (no extra permission). */
async function playEffect(cdp, variant, effects, edgeBox) {
  const box = edgeBox === undefined ? 'undefined' : JSON.stringify(edgeBox);
  await cdp.send('Runtime.evaluate', {
    expression: `(${renderEffect.toString()})(${JSON.stringify(variant)}, ${JSON.stringify(effects)}, ${box})`,
    returnByValue: true,
  });
}

/**
 * Which page was shot, read through the capture's own connection: the tab object has no address
 * (or title) without a tabs permission, except for a tab the user just invoked the extension on, so
 * it would be there for a shot started from the menu and missing for one started from the panel.
 */
async function readPage(cdp) {
  const r = await cdp.send('Runtime.evaluate', { expression: '({ url: location.href, title: document.title })', returnByValue: true });
  return r?.result?.value;
}

async function showEffect({ cdp, ok, error, result }) {
  if (ok && result) { try { result.page = await readPage(cdp); } catch { /* the entry then has no address */ } }
  if (!ok && error?.code === ErrorCode.CANCELED) return; // an Esc is not an event worth flashing
  // An element capture: the edge goes on that element only (or nowhere when it is off the screen now).
  const edgeBox = ok && result?.target ? await readElementBox(cdp, result.target.backendNodeId) : undefined;
  await playEffect(cdp, ok ? 'ok' : 'error', (await loadSettings()).effects, edgeBox);
}

const deps = {
  runCapture: (tabId, kind, opts) => runCapture(tabId, kind, {
    ...opts,
    reportProgress: (info) => { if (info.stage === 'pick') guard.picking(tabId); opts.reportProgress?.(info); },
  }, chrome, { afterCapture: showEffect }),
  loadSettings,
  focusTab,
  history,
  getDirHandle: () => history.kvGet('saveDir'),
  saveBlob,
  notifyPanel: (message) => {
    if (message.type === 'progress' && message.stage === 'pick') picking.add(message.windowId);
    if (message.type === 'capture-ended') picking.delete(message.windowId);
    return chrome.runtime.sendMessage({ target: 'panel', ...message }).catch(() => { /* panel closed */ });
  },
};

/** Guard: one capture per tab. */
async function capture(kind, tab, origin) {
  if (!tab?.id) throw Object.assign(new Error('No tab to capture.'), { code: 'NO_TAB' });
  if (busy.has(tab.id)) throw Object.assign(new Error('This tab is already being captured.'), { code: 'BUSY' });
  if (!(await isTabCapturable(tab.id))) {
    // Chrome's own pages: the shortcut and the menu do nothing, without a word (the panel's buttons are off there)
    if (origin !== 'panel') return undefined;
    throw Object.assign(new Error('This page cannot be captured.'), { code: ErrorCode.NOT_ATTACHABLE });
  }
  busy.add(tab.id);
  const controller = guard.add(tab.id, tab.windowId);
  try {
    return await captureFlow({ kind, tab, origin, signal: controller.signal }, deps);
  } finally {
    busy.delete(tab.id);
    guard.remove(tab.id);
    deps.notifyPanel({ type: 'capture-ended', kind, windowId: tab.windowId }); // done, failed or cancelled: drop "pick an element"
  }
}

const logFailure = (e) => { if (e?.code !== ErrorCode.CANCELED) console.error('[cdp-screenshot]', e); };

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.pageUrl?.startsWith('chrome-extension://')) return; // (never offered there; a stale menu is ignored)
  capture(String(info.menuItemId), tab, 'menu').catch(logFailure);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'toggle-panel') {
    if (tab?.windowId != null) togglePanel(tab.windowId);
    else chrome.windows.getLastFocused().then((w) => togglePanel(w.id)).catch(() => {});
    return;
  }
  if (!MENU.some((m) => m.id === command)) return;
  const t = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  capture(command, t, 'menu').catch(logFailure);
});

// Leaving the page ends an element pick: another tab, another window or app, a navigation, or a
// click into this extension's own panel (it tells the worker when it gets the focus).
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => guard.cancelWhere((r) => r.windowId === windowId && r.tabId !== tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => { if (changeInfo.status === 'loading') guard.cancelWhere((r) => r.tabId === tabId); });
chrome.windows.onFocusChanged.addListener((windowId) => guard.cancelWhere((r) => r.windowId !== windowId)); // (WINDOW_ID_NONE: another app)

// The settings view's test buttons: play one effect on the page now (it attaches for a moment).
async function testEffect(windowId, which, css) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab?.id) throw Object.assign(new Error('No tab to show the effect on.'), { code: 'NO_TAB' });
  const cdp = createChromeCdp(tab.id, chrome);
  await cdp.attach();
  try {
    const on = { enabled: true, css };
    const off = { enabled: false, css: '' };
    await playEffect(cdp, 'ok', which === 'flash' ? { flash: on, edge: off } : { flash: off, edge: on });
  } finally {
    await cdp.detach();
  }
}

// The panel's own buttons.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'worker' && msg.type === 'cancel') {
    guard.cancelWindow(msg.windowId); // the panel's own button or Esc
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.target === 'worker' && (msg.type === 'panel-focused' || msg.type === 'panel-activity')) {
    guard.cancelWhere((r) => r.windowId === msg.windowId);
    return false;
  }
  if (msg?.target === 'worker' && msg.type === 'effect-test') {
    testEffect(msg.windowId, msg.which, msg.css).then(
      () => sendResponse({ ok: true }),
      (e) => { console.error('[cdp-screenshot] effect test:', e); sendResponse({ ok: false, code: e?.code ?? 'EFFECT_TEST' }); },
    );
    return true;
  }
  if (msg?.target !== 'worker' || msg.type !== 'capture') return false;
  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, windowId: msg.windowId });
    return capture(msg.kind, tab, 'panel');
  })().then(
    ({ id, ms, saveError }) => sendResponse({ ok: true, id, ms, saveError }),
    (e) => {
      logFailure(e);
      sendResponse({ ok: false, code: e?.code ?? 'UNKNOWN', details: e?.details }); // the raw message stays in the console (above)
    },
  );
  return true; // answered asynchronously
});
