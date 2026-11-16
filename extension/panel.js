// Side panel: history of the screenshots (from the panel's buttons, the context menu and the
// shortcuts alike) and the settings. Copying to the clipboard happens only here, on the Copy button
// of an entry: the click gives the panel focus and a user gesture, so it behaves the same whatever
// page the shot is from and however the capture was started.
import { AFTER_ACTIONS, EFFECT_DEFAULTS, SETTING_DEFAULTS, loadSettings, saveSettings } from './settings.js';
import { clearEntries, deleteEntry, kvDelete, kvGet, kvSet, listEntries, pruneExpired } from './history.js';
import { buildFilename, saveBlob } from './save.js';
import { copyImage } from './clipboard.js';
import { formatDate } from './format.js';

const $ = (id) => document.getElementById(id);
const KINDS = { viewport: '화면 캡처', full: '전체 캡처', element: '요소 캡처' };
const KIND_SHORT = { viewport: '화면', full: '전체', element: '요소' }; // the kind in front of the size on a card
const STAGES = { pick: '요소를 클릭하세요 (Esc로 취소)', expand: '스크롤 영역을 펼치는 중…', capture: '촬영 중…' };

let settings;
let windowId;
let running = false;
let pickActive = false; // an element pick waits in this window, started from anywhere (panel, menu, shortcut)
let urls = [];
const fresh = new Set(); // entries added since the last render: highlighted once

// --- platform and scrollbar width (the stylesheet draws the scrollbars like the app's) ------------
function setPlatformAndScrollbar() {
  const name = `${navigator.userAgentData?.platform ?? navigator.platform ?? ''}`.toLowerCase();
  document.documentElement.dataset.platform = name.includes('win') ? 'win' : name.includes('linux') ? 'linux' : 'mac';
  // the room a bar takes beside the content: 0 where bars float (macOS), about 10px where always shown
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow-y:scroll';
  document.body.append(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  document.documentElement.style.setProperty('--sbw', `${width}px`);
}

// --- connection to the service worker (it needs to know this panel is open) --------------------
function connect() {
  const port = chrome.runtime.connect({ name: 'panel' });
  port.postMessage({ type: 'hello', windowId });
  port.onMessage.addListener(handleMessage); // the worker replays a running pick to a panel opened meanwhile
  port.onDisconnect.addListener(() => setTimeout(connect, 500)); // the worker was restarted
}

// --- status -----------------------------------------------------------------------------------
/** The same words for a finished capture, whoever started it. */
function doneMessage({ kind, width, height, ms, saveError }) {
  const took = typeof ms === 'number' ? ` · ${(ms / 1000).toFixed(1)}초` : '';
  return `${KINDS[kind]} · ${width}×${height}px 촬영됨${took} · 아래 기록의 복사 버튼으로 복사하세요${saveError ? `\n저장 실패: ${saveError}` : ''}`;
}

const ALERT_SHOW_MS = { ok: 3000, err: 3000 }; // how long a finished capture's message stays
let alertTimer;
let alertCls = ''; // the state of the message now shown

/** Show a message in the alert area (it slides in). A finished one (ok, err) goes away by itself; a running one stays. */
function setStatus(text, cls = '') {
  clearTimeout(alertTimer);
  alertCls = cls;
  $('status').textContent = text;
  $('status').className = cls;
  $('status').parentElement.className = `statusrow ${cls}`.trim(); // the area takes the state too (a failure is red)
  $('alert').classList.add('show');
  $('alert').inert = false;
  if (ALERT_SHOW_MS[cls]) alertTimer = setTimeout(hideStatus, ALERT_SHOW_MS[cls]);
}

/** Nothing to say (idle, cancelled): the area slides away; its text stays until it is gone. */
function hideStatus() {
  clearTimeout(alertTimer);
  $('alert').classList.remove('show');
  $('alert').inert = true;
}

function updateBusy() {
  for (const b of document.querySelectorAll('.tools button')) b.disabled = running || pickActive;
  $('cancel').hidden = !pickActive;
}

function setRunning(value) {
  running = value;
  updateBusy();
}

// --- history list ------------------------------------------------------------------------------
/** Only web and file addresses become links (never javascript: and the like). */
function isLinkable(url) {
  try { return ['http:', 'https:', 'file:'].includes(new URL(url).protocol); } catch { return false; }
}

/** Material Icons "open_in_new": the mark of a link to another page. */
function externalIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z');
  svg.append(path);
  return svg;
}

function pageLabel(e) {
  try { return new URL(e.pageUrl).host || e.pageTitle; } catch { return e.pageTitle || ''; }
}

function renderItem(e, index) {
  const li = document.createElement('li');
  li.dataset.id = e.id;
  li.className = fresh.has(e.id) ? 'new' : '';

  const img = document.createElement('img');
  const url = URL.createObjectURL(e.blob);
  urls.push(url);
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';

  const meta = document.createElement('div');
  meta.className = 'meta';
  // the site address at the left, the size and the date at the right
  // the address links to the page the shot was taken of, with its whole path and parameters
  const page = document.createElement(isLinkable(e.pageUrl) ? 'a' : 'span');
  page.className = 'page';
  page.title = e.pageUrl;
  const label = document.createElement('span');
  label.className = 'page__label';
  label.textContent = pageLabel(e);
  if (page.tagName === 'A') {
    page.href = e.pageUrl;
    page.target = '_blank';
    page.rel = 'noreferrer';
    page.append(externalIcon(), label); // the icon in front says it opens the page
  } else {
    page.append(label);
  }
  const info = document.createElement('span');
  info.className = 'info';
  // at the right: the kind and size on the first line (they alone set the width of this column, so
  // the address is cut by them), the date on the second line, placed by position (it takes no width)
  const size = document.createElement('span');
  size.textContent = `${KIND_SHORT[e.kind] ?? e.kind} · ${e.width}×${e.height}px`;
  const date = document.createElement('span');
  date.className = 'date';
  date.textContent = formatDate(e.createdAt);
  info.append(size, date);
  meta.append(page, info);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const mk = (label, handler, cls = '') => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = () => handler(e, b);
    return b;
  };
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  actions.append(mk('복사', doCopy, 'act-accent'), mk('저장', doSave, 'act-accent'), spacer, mk('삭제', doDelete, 'act-delete'));

  li.append(img, meta, actions);
  return li;
}

async function refresh() {
  const entries = await listEntries();
  for (const u of urls) URL.revokeObjectURL(u);
  urls = [];
  $('list').replaceChildren(...entries.map((e, i) => renderItem(e, i)));
  $('empty').hidden = entries.length > 0;
  if (fresh.size) $('mainBody').scrollTo({ top: 0 }); // the new entry is at the top
  fresh.clear();
}

// --- actions on one entry ---------------------------------------------------------------------
const DELETE_DELAY_MS = 250; // a delete waits this long so the red is seen (the card's border was already red under the pointer)
const DONE_MS = 500; // how long a card keeps its accent border and glow, and the clicked button its blue (copy, delete)

/** A failed action of a card: told in the alert area (red), the same for every action. */
function fail(what, e) {
  console.warn(`[cdp-screenshot] ${what} failed:`, e);
  setStatus(`${what} 실패: ${e?.message ?? e}`, 'err');
  return false;
}

/** The clicked button and the card light up for a moment, the same way for each action: blue for Copy, red for Delete. */
function markDone(button, tone = 'done') {
  const marked = [button, button?.closest('li')].filter(Boolean);
  for (const el of marked) el.classList.add(tone);
  setTimeout(() => { for (const el of marked) el.classList.remove(tone); }, DONE_MS);
}

async function doCopy(entry, button) {
  try {
    await copyImage(entry.blob); // the click that got us here gives focus
    markDone(button);
    return true;
  } catch (e) {
    return fail('복사', e);
  }
}

async function doSave(entry, button) {
  try {
    const dirHandle = await kvGet('saveDir');
    if (dirHandle && (await dirHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      await dirHandle.requestPermission({ mode: 'readwrite' }); // allowed here: this is a click
    }
    const r = await saveBlob(entry.blob, buildFilename(entry.kind, entry.mime, new Date(entry.createdAt)), { dirHandle });
    if (r.note) console.info('[cdp-screenshot]', r.note); // saved elsewhere than meant: kept for diagnosis
    markDone(button); // the same as a copy
    return true;
  } catch (e) {
    return fail('저장', e);
  }
}

async function doDelete(entry, button) {
  const li = button?.closest('li');
  if (li?.dataset.deleting) return; // already on its way out
  try {
    if (li) li.dataset.deleting = '1';
    markDone(button, 'removing'); // red: the card is going away
    await new Promise((r) => setTimeout(r, DELETE_DELAY_MS)); // the emphasis is seen before the card goes
    await deleteEntry(entry.id);
    await refresh();
  } catch (e) {
    if (li) delete li.dataset.deleting;
    fail('삭제', e);
  }
}

// --- capture ----------------------------------------------------------------------------------
/** The button of a capture in progress turns blue (any start path: the panel, the menu, a shortcut) and stays so a moment after it. */
const toolTimers = new Map();
function lightTool(kind) {
  clearTimeout(toolTimers.get(kind));
  $(kind)?.classList.add('done');
}
function unlightTool(kind) {
  clearTimeout(toolTimers.get(kind));
  toolTimers.set(kind, setTimeout(() => $(kind)?.classList.remove('done'), DONE_MS));
}

async function startCapture(kind) {
  if (running) return;
  setRunning(true);
  lightTool(kind);
  setStatus('촬영 중…', 'busy');
  try {
    const res = await chrome.runtime.sendMessage({ target: 'worker', type: 'capture', kind, windowId });
    if (!res?.ok) {
      if (res?.code === 'CANCELED') hideStatus(); // a cancel needs no message
      else setStatus(`촬영 실패: ${res?.message ?? '응답 없음'}`, 'err');
      return;
    }
    fresh.add(res.id);
    await refresh();
    const entry = (await listEntries()).find((e) => e.id === res.id);
    setStatus(doneMessage({ kind, width: entry?.width, height: entry?.height, ms: res.ms, saveError: res.saveError }), res.saveError ? 'err' : 'ok');
  } catch (e) {
    setStatus(`촬영 실패: ${e?.message ?? e}`, 'err');
  } finally {
    setRunning(false);
    unlightTool(kind);
  }
}

function handleMessage(msg) {
  if (msg?.target && msg.target !== 'panel') return; // (a port message has no target)
  if (msg.windowId != null && msg.windowId !== windowId) return; // another window's capture
  if (msg.type === 'progress' && STAGES[msg.stage]) {
    // Shown for any capture, wherever it was started: the pick waits on the page, but the user may
    // take the panel's focus, and must be able to cancel from here.
    if (msg.kind) lightTool(msg.kind);
    if (running || msg.stage === 'pick') setStatus(STAGES[msg.stage], 'busy');
    pickActive = msg.stage === 'pick';
    updateBusy();
  }
  if (msg.type === 'capture-ended') {
    if (msg.kind) unlightTool(msg.kind);
    pickActive = false;
    updateBusy();
    if (!running && alertCls === 'busy') hideStatus(); // the pick message goes; a finished one stays its time
  }
  if (msg.type === 'capture-failed' && !running) setStatus(`촬영 실패: ${msg.message}`, 'err'); // started elsewhere
  if (msg.type === 'history-changed') { // captured elsewhere (context menu, shortcut)
    if (msg.id) fresh.add(msg.id);
    if (!running) setStatus(doneMessage(msg), msg.saveError ? 'err' : 'ok');
    refresh();
  }
}
chrome.runtime.onMessage.addListener(handleMessage);

// --- settings view ----------------------------------------------------------------------------
const SLIDE_MS = 320; // a little more than the .3s of the slide in panel.css
let slideTimer;

/** Slide to a view (animate) or just set it (the start). The one out of sight is inert: no focus, no clicks, not read aloud. */
function showView(name, animate = true) {
  const views = $('views');
  const page = name === 'settings';
  clearTimeout(slideTimer);
  views.classList.toggle('views--slide', animate);
  views.classList.toggle('views--page', page);
  $('mainView').inert = page;
  $('settingsView').inert = !page;
  if (animate) {
    // the control that was clicked went out of reach with its view: keep the keyboard focus in the new one
    ($(page ? 'toMain' : 'toSettings')).focus({ preventScroll: true });
    slideTimer = setTimeout(() => views.classList.remove('views--slide'), SLIDE_MS);
  }
}

async function renderFolder() {
  const handle = await kvGet('saveDir');
  $('folderName').textContent = handle ? `선택한 폴더: ${handle.name}` : '기본: 다운로드 폴더';
  $('resetFolder').disabled = !handle;
  // after a browser restart the folder must be allowed again, and only a click here can do that
  const granted = handle ? (await handle.queryPermission({ mode: 'readwrite' })) === 'granted' : true;
  $('allowFolder').hidden = granted;
}

/** The image width of a history card; its maximum width follows (panel.css: --history-img + the card's padding and border). */
function applyHistoryImageSize() {
  document.documentElement.style.setProperty('--history-img', `${settings.historyImageSize}px`);
}

function fillSettings(values = settings) {
  $('depth').value = values.depth;
  $('format').value = values.format;
  $('settleMs').value = values.settleMs;
  $('retentionDays').value = values.retentionDays;
  $('historyImageSize').value = values.historyImageSize;
  $('flashOn').checked = values.effects.flash.enabled;
  $('flashCss').value = values.effects.flash.css;
  $('edgeOn').checked = values.effects.edge.enabled;
  $('edgeCss').value = values.effects.edge.css;
  $('afterAction').value = values.afterAction;
}

async function persistSettings() {
  settings = await saveSettings({
    depth: $('depth').value,
    format: $('format').value,
    settleMs: $('settleMs').value,
    afterAction: AFTER_ACTIONS.includes($('afterAction').value) ? $('afterAction').value : settings.afterAction,
    retentionDays: $('retentionDays').value,
    historyImageSize: $('historyImageSize').value,
    effects: {
      flash: { enabled: $('flashOn').checked, css: $('flashCss').value },
      edge: { enabled: $('edgeOn').checked, css: $('edgeCss').value },
    },
  });
  fillSettings();
  applyHistoryImageSize();
  $('saved').textContent = '저장됨';
  setTimeout(() => { $('saved').textContent = ''; }, 1500);
  await pruneExpired(settings.retentionDays);
}

function bindSettings() {
  // like the app's settings: edit, then Save (the test buttons use what is typed, saved or not)
  $('save').addEventListener('click', persistSettings);
  $('resetAll').addEventListener('click', () => {
    fillSettings(SETTING_DEFAULTS);
    $('saved').textContent = '기본값을 채웠습니다. 저장을 눌러야 적용됩니다';
  });

  // test buttons play the effect with what is typed now (saved or not) on the page being viewed
  const testEffect = (which) => async () => {
    $('effectMsg').textContent = '';
    const res = await chrome.runtime.sendMessage({ target: 'worker', type: 'effect-test', windowId, which, css: $(`${which}Css`).value });
    if (!res?.ok) $('effectMsg').textContent = `테스트 실패: ${res?.message ?? '응답 없음'}`;
  };
  $('flashTest').addEventListener('click', testEffect('flash'));
  $('edgeTest').addEventListener('click', testEffect('edge'));
  $('flashReset').addEventListener('click', () => { $('flashCss').value = EFFECT_DEFAULTS.flash.css; });
  $('edgeReset').addEventListener('click', () => { $('edgeCss').value = EFFECT_DEFAULTS.edge.css; });

  $('pickFolder').addEventListener('click', async () => {
    try {
      const handle = await showDirectoryPicker({ id: 'cdp-screenshot', mode: 'readwrite', startIn: 'documents' });
      await kvSet('saveDir', handle);
      await renderFolder();
    } catch (e) {
      if (e?.name !== 'AbortError') $('saved').textContent = `폴더 선택 실패: ${e?.message ?? e}`;
    }
  });
  $('allowFolder').addEventListener('click', async () => {
    const handle = await kvGet('saveDir');
    if (handle) await handle.requestPermission({ mode: 'readwrite' });
    await renderFolder();
  });
  $('resetFolder').addEventListener('click', async () => { await kvDelete('saveDir'); await renderFolder(); });
  $('clearAll').addEventListener('click', async () => {
    if (!confirm('촬영 기록을 모두 지웁니다. 계속할까요?')) return;
    await clearEntries();
    await refresh();
    $('saved').textContent = '기록을 비웠습니다';
  });
}

// --- start ------------------------------------------------------------------------------------
async function init() {
  setPlatformAndScrollbar();
  windowId = (await chrome.windows.getCurrent()).id;
  connect();
  settings = await loadSettings();
  applyHistoryImageSize();
  fillSettings();
  bindSettings();
  await renderFolder();
  for (const b of document.querySelectorAll('.tools button')) b.addEventListener('click', () => startCapture(b.dataset.kind));
  // Esc or the Cancel button: the page does not get the key (the panel has the focus), so cancel through the worker
  const cancelPick = () => { if (pickActive) chrome.runtime.sendMessage({ target: 'worker', type: 'cancel', windowId }); };
  $('cancel').addEventListener('click', cancelPick);
  // Clicking into the panel while an element pick waits on the page ends the pick (the worker ignores
  // this while the panel's own click that started the pick is still settling)
  window.addEventListener('focus', () => chrome.runtime.sendMessage({ target: 'worker', type: 'panel-focused', windowId }).catch(() => {}));
  // a click anywhere in the panel is leaving the page too, whether or not the panel's focus event fires
  document.addEventListener('pointerdown', () => { if (pickActive) chrome.runtime.sendMessage({ target: 'worker', type: 'panel-activity', windowId }).catch(() => {}); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelPick(); });
  $('toSettings').addEventListener('click', () => showView('settings'));
  $('toMain').addEventListener('click', () => showView('main'));
  showView('main', false);
  await pruneExpired(settings.retentionDays);
  await refresh();
}

init();
