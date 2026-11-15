import { createChromeCdp, runCapture } from '../adapter-chrome/index.js';
import { ErrorCode } from '../core/index.js';
import { loadSettings } from './settings.js';
import * as history from './history.js';
import { saveBlob } from './save.js';
import { showToast } from './toast.js';
import { focusTab } from './focus.js';
import { captureFlow } from './capture-flow.js';
import { renderEffect } from './feedback.js';

const MENU = [
  { id: 'viewport', title: '화면 캡처' },
  { id: 'full', title: '전체 캡처' },
  { id: 'element', title: '요소 캡처' },
];
const busy = new Set(); // one capture per tab at a time
const openPanels = new Map(); // windowId -> number of connected panel instances

// --- context menu (also works in popup windows, which have no side panel) ----------------------
function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const log = () => { if (chrome.runtime.lastError) console.error('[cdp-screenshot] menu:', chrome.runtime.lastError.message); };
    for (const m of MENU) chrome.contextMenus.create({ id: m.id, title: m.title, contexts: ['all'] }, log);
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
async function playEffect(cdp, variant, effects) {
  await cdp.send('Runtime.evaluate', {
    expression: `(${renderEffect.toString()})(${JSON.stringify(variant)}, ${JSON.stringify(effects)})`,
    returnByValue: true,
  });
}

async function showEffect({ cdp, ok, error }) {
  if (!ok && error?.code === ErrorCode.CANCELED) return; // an Esc is not an event worth flashing
  await playEffect(cdp, ok ? 'ok' : 'error', (await loadSettings()).effects);
}

const deps = {
  runCapture: (tabId, kind, opts) => runCapture(tabId, kind, opts, chrome, { afterCapture: showEffect }),
  loadSettings,
  focusTab,
  history,
  getDirHandle: () => history.kvGet('saveDir'),
  saveBlob,
  showToast,
  notifyPanel: (message) => chrome.runtime.sendMessage({ target: 'panel', ...message }).catch(() => { /* panel closed */ }),
};

/** Guard: one capture per tab. */
async function capture(kind, tab, origin) {
  if (!tab?.id) throw Object.assign(new Error('촬영할 탭을 찾지 못했습니다.'), { code: 'NO_TAB' });
  if (busy.has(tab.id)) throw Object.assign(new Error('이 탭은 이미 촬영 중입니다.'), { code: 'BUSY' });
  busy.add(tab.id);
  try {
    return await captureFlow({ kind, tab, origin }, deps);
  } finally {
    busy.delete(tab.id);
  }
}

const logFailure = (e) => { if (e?.code !== ErrorCode.CANCELED) console.error('[cdp-screenshot]', e); };

chrome.contextMenus.onClicked.addListener((info, tab) => {
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

// The settings view's test buttons: play one effect on the page now (it attaches for a moment).
async function testEffect(windowId, which, css) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab?.id) throw new Error('효과를 보여 줄 탭을 찾지 못했습니다.');
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
  if (msg?.target === 'worker' && msg.type === 'effect-test') {
    testEffect(msg.windowId, msg.which, msg.css).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, message: e?.message ?? String(e) }),
    );
    return true;
  }
  if (msg?.target !== 'worker' || msg.type !== 'capture') return false;
  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, windowId: msg.windowId });
    return capture(msg.kind, tab, 'panel');
  })().then(
    ({ id, ms }) => sendResponse({ ok: true, id, ms }),
    (e) => {
      logFailure(e);
      sendResponse({ ok: false, code: e?.code ?? 'UNKNOWN', message: e?.message ?? String(e) });
    },
  );
  return true; // answered asynchronously
});
