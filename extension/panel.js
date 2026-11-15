// Side panel: history of the screenshots (from the panel's buttons, the context menu and the
// shortcuts alike) and the settings. Copying to the clipboard happens only here, on the Copy button
// of an entry: the click gives the panel focus and a user gesture, so it behaves the same whatever
// page the shot is from and however the capture was started.
import { AFTER_ACTIONS, EFFECT_DEFAULTS, SETTING_DEFAULTS, loadSettings, saveSettings } from './settings.js';
import { clearEntries, deleteEntry, kvDelete, kvGet, kvSet, listEntries, pruneExpired, updateEntry } from './history.js';
import { buildFilename, saveBlob } from './save.js';
import { copyImage } from './clipboard.js';

const $ = (id) => document.getElementById(id);
const KINDS = { viewport: '화면 캡처', full: '전체 캡처', element: '요소 캡처' };
const STAGES = { pick: '요소를 클릭하세요 (Esc로 취소)', expand: '스크롤 영역을 펼치는 중…', capture: '촬영 중…' };

let settings;
let windowId;
let running = false;
let urls = [];
const fresh = new Set(); // entries added since the last render: highlighted once
const flash = new Map(); // entry id -> {text, cls}: result of a click in this panel (copy, save), shown over the stored note

// --- connection to the service worker (it needs to know this panel is open) --------------------
function connect() {
  const port = chrome.runtime.connect({ name: 'panel' });
  port.postMessage({ type: 'hello', windowId });
  port.onDisconnect.addListener(() => setTimeout(connect, 500)); // the worker was restarted
}

// --- status -----------------------------------------------------------------------------------
function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = cls;
}

function setRunning(value) {
  running = value;
  for (const b of document.querySelectorAll('.tools button')) b.disabled = value;
}

// --- history list ------------------------------------------------------------------------------
function noteFor(id, text, cls = '') {
  flash.set(id, { text, cls });
  const el = document.querySelector(`li[data-id="${CSS.escape(id)}"] .note`);
  if (el) { el.textContent = text; el.className = `note ${cls}`; }
}

function pageLabel(e) {
  try { return new URL(e.pageUrl).host || e.pageTitle; } catch { return e.pageTitle || ''; }
}

function renderItem(e, index) {
  const li = document.createElement('li');
  li.dataset.id = e.id;
  li.className = [index === 0 ? 'latest' : '', fresh.has(e.id) ? 'new' : ''].filter(Boolean).join(' ');

  const img = document.createElement('img');
  const url = URL.createObjectURL(e.blob);
  urls.push(url);
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const left = document.createElement('span');
  left.textContent = `${KINDS[e.kind] ?? e.kind} · ${e.width}×${e.height}px · ${new Date(e.createdAt).toLocaleString()}`;
  const page = document.createElement('span');
  page.className = 'page';
  page.textContent = pageLabel(e);
  page.title = e.pageUrl;
  meta.append(left, page);

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
  actions.append(mk('복사', doCopy, index === 0 ? 'primary' : ''), mk('저장', doSave), spacer, mk('삭제', doDelete, 'danger'));

  const note = document.createElement('div');
  const n = flash.get(e.id);
  note.className = `note ${n?.cls ?? ''}`;
  note.textContent = n?.text ?? e.note ?? '';

  li.append(img, meta, actions, note);
  return li;
}

async function refresh() {
  const entries = await listEntries();
  for (const u of urls) URL.revokeObjectURL(u);
  urls = [];
  $('list').replaceChildren(...entries.map((e, i) => renderItem(e, i)));
  $('empty').hidden = entries.length > 0;
  if (fresh.size) window.scrollTo({ top: 0 }); // the new entry is at the top
  fresh.clear();
}

// --- actions on one entry ---------------------------------------------------------------------
async function doCopy(entry) {
  try {
    await copyImage(entry.blob); // the click that got us here gives focus
    noteFor(entry.id, '클립보드에 복사됨', 'ok');
    return true;
  } catch (e) {
    noteFor(entry.id, `복사 실패: ${e?.name ?? 'Error'}: ${e?.message ?? e}`, 'err');
    return false;
  }
}

async function doSave(entry) {
  try {
    const dirHandle = await kvGet('saveDir');
    if (dirHandle && (await dirHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      await dirHandle.requestPermission({ mode: 'readwrite' }); // allowed here: this is a click
    }
    const r = await saveBlob(entry.blob, buildFilename(entry.kind, entry.mime, new Date(entry.createdAt)), { dirHandle });
    const note = `저장됨: ${r.path}${r.note ? `\n${r.note}` : ''}`;
    await updateEntry(entry.id, { note });
    flash.delete(entry.id);
    noteFor(entry.id, note, r.note ? '' : 'ok');
    return true;
  } catch (e) {
    noteFor(entry.id, `저장 실패: ${e?.message ?? e}`, 'err');
    return false;
  }
}

async function doDelete(entry) {
  await deleteEntry(entry.id);
  flash.delete(entry.id);
  await refresh();
}

// --- capture ----------------------------------------------------------------------------------
async function startCapture(kind) {
  if (running) return;
  setRunning(true);
  setStatus('촬영 중…');
  try {
    const res = await chrome.runtime.sendMessage({ target: 'worker', type: 'capture', kind, windowId });
    if (!res?.ok) {
      if (res?.code === 'CANCELED') setStatus('취소했습니다.');
      else setStatus(`촬영 실패: ${res?.message ?? '응답 없음'}`, 'err');
      return;
    }
    fresh.add(res.id);
    await refresh();
    const entry = (await listEntries()).find((e) => e.id === res.id);
    const took = typeof res.ms === 'number' ? ` · ${(res.ms / 1000).toFixed(1)}초` : '';
    setStatus(`${KINDS[kind]} · ${entry ? `${entry.width}×${entry.height}px ` : ''}촬영됨${took} · 아래 기록의 복사 버튼으로 복사하세요`, 'ok');
  } catch (e) {
    setStatus(`촬영 실패: ${e?.message ?? e}`, 'err');
  } finally {
    setRunning(false);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'panel') return;
  if (msg.type === 'progress' && running && STAGES[msg.stage]) setStatus(STAGES[msg.stage]);
  if (msg.type === 'history-changed') { // captured elsewhere (context menu, shortcut)
    if (msg.id) fresh.add(msg.id);
    refresh();
  }
});

// --- settings view ----------------------------------------------------------------------------
function showView(name) {
  $('mainView').hidden = name !== 'main';
  $('mainHeader').hidden = name !== 'main';
  $('settingsView').hidden = name !== 'settings';
}

async function renderFolder() {
  const handle = await kvGet('saveDir');
  $('folderName').textContent = handle ? `선택한 폴더: ${handle.name}` : '기본: 다운로드 폴더';
  $('resetFolder').disabled = !handle;
  // after a browser restart the folder must be allowed again, and only a click here can do that
  const granted = handle ? (await handle.queryPermission({ mode: 'readwrite' })) === 'granted' : true;
  $('allowFolder').hidden = granted;
}

function fillSettings(values = settings) {
  $('depth').value = values.depth;
  $('format').value = values.format;
  $('settleMs').value = values.settleMs;
  $('retentionDays').value = values.retentionDays;
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
    effects: {
      flash: { enabled: $('flashOn').checked, css: $('flashCss').value },
      edge: { enabled: $('edgeOn').checked, css: $('edgeCss').value },
    },
  });
  fillSettings();
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
    flash.clear();
    await refresh();
    $('saved').textContent = '기록을 비웠습니다';
  });
}

// --- start ------------------------------------------------------------------------------------
async function init() {
  windowId = (await chrome.windows.getCurrent()).id;
  connect();
  settings = await loadSettings();
  fillSettings();
  bindSettings();
  await renderFolder();
  for (const b of document.querySelectorAll('.tools button')) b.addEventListener('click', () => startCapture(b.dataset.kind));
  $('toSettings').addEventListener('click', () => showView('settings'));
  $('toMain').addEventListener('click', () => showView('main'));
  showView('main');
  await pruneExpired(settings.retentionDays);
  await refresh();
}

init();
