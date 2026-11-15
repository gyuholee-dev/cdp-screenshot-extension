// Side panel: history of the screenshots (from the panel's buttons, the context menu and the
// shortcuts alike) and the settings. Copying to the clipboard happens only here, on the Copy button
// of an entry: the click gives the panel focus and a user gesture, so it behaves the same whatever
// page the shot is from and however the capture was started.
import { AFTER_ACTIONS, loadSettings, saveSettings } from './settings.js';
import { clearEntries, deleteEntry, kvDelete, kvGet, kvSet, listEntries, pruneExpired, updateEntry } from './history.js';
import { buildFilename, saveBlob } from './save.js';
import { copyImage } from './clipboard.js';

const $ = (id) => document.getElementById(id);
const KINDS = { viewport: '화면', full: '전체', element: '요소' };
const STAGES = { pick: '요소를 클릭하세요 (Esc로 취소)', expand: '스크롤 영역을 펼치는 중…', capture: '촬영 중…' };

let settings;
let windowId;
let running = false;
let urls = [];
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
  if (index === 0) li.className = 'latest';

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
    await refresh();
    const entry = (await listEntries()).find((e) => e.id === res.id);
    setStatus(`${KINDS[kind]} · ${entry ? `${entry.width}×${entry.height}px ` : ''}촬영됨 · 아래 기록의 복사 버튼으로 복사하세요`, 'ok');
  } catch (e) {
    setStatus(`촬영 실패: ${e?.message ?? e}`, 'err');
  } finally {
    setRunning(false);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'panel') return;
  if (msg.type === 'progress' && running && STAGES[msg.stage]) setStatus(STAGES[msg.stage]);
  if (msg.type === 'history-changed') refresh(); // captured elsewhere (context menu, shortcut)
});

// --- settings view ----------------------------------------------------------------------------
function showView(name) {
  $('mainView').hidden = name !== 'main';
  $('settingsView').hidden = name !== 'settings';
  $('toSettings').hidden = name !== 'main';
  document.querySelector('.tools').hidden = name !== 'main';
}

async function renderFolder() {
  const handle = await kvGet('saveDir');
  $('folderName').textContent = handle ? `선택한 폴더: ${handle.name}` : '기본: 다운로드 폴더';
  $('resetFolder').disabled = !handle;
  // after a browser restart the folder must be allowed again, and only a click here can do that
  const granted = handle ? (await handle.queryPermission({ mode: 'readwrite' })) === 'granted' : true;
  $('allowFolder').hidden = granted;
}

function fillSettings() {
  $('depth').value = settings.depth;
  $('format').value = settings.format;
  $('settleMs').value = settings.settleMs;
  $('retentionDays').value = settings.retentionDays;
  for (const r of document.querySelectorAll('input[name=afterAction]')) r.checked = r.value === settings.afterAction;
}

async function persistSettings() {
  const checked = document.querySelector('input[name=afterAction]:checked');
  settings = await saveSettings({
    depth: $('depth').value,
    format: $('format').value,
    settleMs: $('settleMs').value,
    afterAction: AFTER_ACTIONS.includes(checked?.value) ? checked.value : settings.afterAction,
    retentionDays: $('retentionDays').value,
  });
  fillSettings();
  $('saved').textContent = '저장됨';
  setTimeout(() => { $('saved').textContent = ''; }, 1500);
  await pruneExpired(settings.retentionDays);
}

function bindSettings() {
  for (const id of ['depth', 'format', 'settleMs', 'retentionDays']) $(id).addEventListener('change', persistSettings);
  for (const r of document.querySelectorAll('input[name=afterAction]')) r.addEventListener('change', persistSettings);

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
