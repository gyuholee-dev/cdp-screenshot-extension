import { runCapture } from '../adapter-chrome/index.js';
import { ErrorCode } from '../core/index.js';
import { loadSettings } from './settings.js';
import { saveResult } from './save.js';
import { showToast } from './toast.js';
import { focusTab } from './focus.js';

const MENU = [
  { id: 'viewport', title: '스크린샷' },
  { id: 'full', title: '전체 스크린샷' },
  { id: 'element', title: '엘리먼트 스크린샷' },
];
const busy = new Set(); // one capture per tab at a time

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const m of MENU) chrome.contextMenus.create({ id: m.id, title: m.title, contexts: ['all'] });
  });
});

// No popup: the toolbar icon opens the settings page.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.contextMenus.onClicked.addListener((info, tab) => run(String(info.menuItemId), tab));

chrome.commands.onCommand.addListener(async (command, tab) => {
  const t = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  run(command, t);
});

async function setStatus(status) {
  await chrome.storage.local.set({ lastStatus: { ...status, at: Date.now() } });
}

function badge(text, color, title = 'CDP Screenshot') {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title });
}

async function run(kind, tab) {
  if (!tab?.id || busy.has(tab.id)) return;
  busy.add(tab.id);
  badge('…', '#666666');
  try {
    if (kind === 'element') await focusTab(tab); // picking needs a focused window (macOS context menu)
    const settings = await loadSettings();
    const result = await runCapture(tab.id, kind, {
      depth: settings.depth,
      format: settings.format,
      settleMs: settings.settleMs,
      reportProgress: ({ stage }) => badge(stage === 'pick' ? '선택' : '…', '#666666'),
    });
    const saved = await saveResult(result, kind, settings, tab.id);
    await setStatus({ ok: true, kind, width: result.width, height: result.height, ...saved });
    const where = saved.mode === 'clipboard' ? '클립보드에 복사됨' : `저장됨: ${saved.filename}`;
    badge('✓', '#2e7d32', '스크린샷 완료');
    setTimeout(() => { if (!busy.size) badge(''); }, 3000);
    await showToast(tab.id, `스크린샷 완료 · ${result.width}×${result.height}px · ${where}${saved.note ? `\n${saved.note}` : ''}`);
  } catch (e) {
    if (e?.code === ErrorCode.CANCELED) {
      await setStatus({ ok: false, kind, code: e.code, message: e.message });
      badge('');
    } else {
      const message = e?.message ?? String(e);
      console.error('[cdp-screenshot]', e);
      await setStatus({ ok: false, kind, code: e?.code ?? 'UNKNOWN', message });
      badge('!', '#b00020', `실패: ${message}`);
      await showToast(tab.id, `스크린샷 실패 · ${message}`, true);
    }
  } finally {
    busy.delete(tab.id);
  }
}
