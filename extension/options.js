import { loadSettings, saveSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
const KINDS = { viewport: '스크린샷', full: '전체 스크린샷', element: '엘리먼트 스크린샷' };

function renderStatus(s) {
  const el = $('status');
  if (!s) return;
  const when = new Date(s.at).toLocaleString();
  el.classList.toggle('error', !s.ok && s.code !== 'CANCELED');
  if (s.ok) {
    const where = s.mode === 'clipboard' ? '클립보드' : s.filename;
    el.textContent = `${when} · ${KINDS[s.kind] ?? s.kind} · ${s.width}×${s.height}px · ${where}${s.note ? ` (${s.note})` : ''}`;
  } else {
    el.textContent = `${when} · ${KINDS[s.kind] ?? s.kind} · ${s.code}: ${s.message}`;
  }
}

async function init() {
  const s = await loadSettings();
  $('depth').value = s.depth;
  $('format').value = s.format;
  $('settleMs').value = s.settleMs;
  $('saveMode').value = s.saveMode;

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const saved = await saveSettings({
      depth: $('depth').value,
      format: $('format').value,
      settleMs: $('settleMs').value,
      saveMode: $('saveMode').value,
    });
    $('depth').value = saved.depth;
    $('settleMs').value = saved.settleMs;
    $('saved').textContent = '저장했습니다.';
    setTimeout(() => { $('saved').textContent = ''; }, 2000);
  });

  const { lastStatus } = await chrome.storage.local.get('lastStatus');
  renderStatus(lastStatus);
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.lastStatus) renderStatus(changes.lastStatus.newValue);
  });
}

init();
