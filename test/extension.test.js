import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { normalizeSettings, SETTING_DEFAULTS, AFTER_ACTIONS, loadSettings, saveSettings } from '../extension/settings.js';
import { buildFilename, saveBlob, DEFAULT_SUBFOLDER } from '../extension/save.js';
import { expiredIds } from '../extension/history.js';
import { captureFlow } from '../extension/capture-flow.js';
import { CaptureError, ErrorCode } from '../core/index.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));

test('manifest: MV3, side panel + context menu, required permissions, referenced files exist', () => {
  assert.equal(manifest.manifest_version, 3);
  for (const p of ['debugger', 'downloads', 'storage', 'unlimitedStorage', 'sidePanel', 'contextMenus', 'activeTab', 'scripting']) {
    assert.ok(manifest.permissions.includes(p), p);
  }
  assert.ok(!manifest.permissions.includes('clipboardWrite'), 'copying is a click in the panel: no extra permission');
  assert.equal(manifest.background.type, 'module');
  assert.ok(existsSync(new URL(manifest.background.service_worker, root)));
  assert.ok(existsSync(new URL(manifest.side_panel.default_path, root)));
  assert.equal(manifest.options_ui, undefined); // settings live in the panel
  assert.equal(manifest.action.default_popup, undefined); // the icon opens/closes the panel
  assert.deepEqual(Object.keys(manifest.commands).sort(), ['element', 'full', 'toggle-panel', 'viewport']);
  assert.ok(Number(manifest.minimum_chrome_version) >= 141); // sidePanel.close
});

test('manifest: no network listening surface', () => {
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.host_permissions, undefined);
});

test('normalizeSettings: defaults and coercion', () => {
  assert.deepEqual(normalizeSettings(), SETTING_DEFAULTS);
  assert.deepEqual(
    normalizeSettings({ depth: '2', format: 'jpeg', settleMs: '500', afterAction: 'save', retentionDays: '7' }),
    { depth: 2, format: 'jpeg', settleMs: 500, afterAction: 'save', retentionDays: 7, effects: SETTING_DEFAULTS.effects },
  );
  assert.deepEqual(normalizeSettings({ depth: -1, format: 'gif', settleMs: 'x', afterAction: 'cloud', retentionDays: -3 }), SETTING_DEFAULTS);
  assert.equal(normalizeSettings({ depth: 1.5 }).depth, SETTING_DEFAULTS.depth);
  assert.equal(normalizeSettings({ retentionDays: 0 }).retentionDays, 0); // 0 = keep until cleared
  assert.equal(normalizeSettings(null).format, 'png');
  assert.equal(SETTING_DEFAULTS.afterAction, 'history');
  assert.equal(SETTING_DEFAULTS.depth, 5);
  assert.equal(SETTING_DEFAULTS.settleMs, 250);
});

test('normalizeSettings: effects can be switched off and restyled; bad values fall back', () => {
  assert.equal(SETTING_DEFAULTS.effects.flash.enabled, true);
  assert.match(SETTING_DEFAULTS.effects.edge.css, /41, 121, 255/); // blue
  const n = normalizeSettings({ effects: { flash: { enabled: false, css: ' background: #fff; ' }, edge: { enabled: 'yes', css: '' } } });
  assert.deepEqual(n.effects.flash, { enabled: false, css: 'background: #fff;' });
  assert.deepEqual(n.effects.edge, SETTING_DEFAULTS.effects.edge); // not a boolean / empty -> default
  assert.equal(normalizeSettings({ effects: { edge: { css: 'x'.repeat(5000) } } }).effects.edge.css, SETTING_DEFAULTS.effects.edge.css);
});

test('normalizeSettings: values of earlier builds are converted (copying is no longer automatic)', () => {
  assert.equal(normalizeSettings({ afterAction: 'copy' }).afterAction, 'history');
  assert.equal(normalizeSettings({ afterAction: 'both' }).afterAction, 'save');
  assert.deepEqual(AFTER_ACTIONS, ['save', 'history']);
});

test('load/save settings through chrome.storage.local', async () => {
  const store = {};
  const chrome = { storage: { local: {
    get: async (k) => ({ [k]: store[k] }),
    set: async (o) => Object.assign(store, o),
  } } };
  assert.deepEqual(await loadSettings(chrome), SETTING_DEFAULTS);
  await saveSettings({ depth: '4' }, chrome);
  assert.equal((await loadSettings(chrome)).depth, 4);
});

test('buildFilename', () => {
  assert.equal(buildFilename('full', 'image/jpeg', new Date(2026, 10, 15, 9, 5, 3)), 'screenshot-full-20261115-090503.jpg');
  assert.equal(buildFilename('viewport', 'image/png', new Date(2026, 10, 15, 9, 5, 3)), 'screenshot-viewport-20261115-090503.png');
});

test('saveBlob: no chosen folder -> the download folder itself', async () => {
  const downloads = [];
  const chrome = { downloads: { download: async (o) => { downloads.push(o); return 1; } } };
  const r = await saveBlob(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'a.png', { chromeApi: chrome });
  assert.deepEqual([r.where, r.path, r.note], ['downloads', 'a.png', undefined]);
  assert.equal(downloads[0].filename, 'a.png');
  assert.match(downloads[0].url, /^data:image\/png;base64,AQID$/); // no object URLs in a service worker
  assert.equal(DEFAULT_SUBFOLDER, '');
  assert.equal(downloads[0].saveAs, false);
  assert.equal(downloads[0].conflictAction, 'uniquify');
});

function fakeDir({ permission = 'granted', requested = 'denied', failWrite = false } = {}) {
  const written = [];
  return {
    name: 'Shots',
    written,
    queryPermission: async () => permission,
    requestPermission: async () => requested,
    getFileHandle: async (name) => ({
      createWritable: async () => ({
        write: async (b) => { if (failWrite) throw new Error('disk full'); written.push([name, b]); },
        close: async () => {},
      }),
    }),
  };
}

test('saveBlob: a chosen folder is written to directly', async () => {
  const dir = fakeDir();
  const chrome = { downloads: { download: async () => { throw new Error('should not download'); } } };
  const r = await saveBlob(new Blob(['x']), 'a.png', { dirHandle: dir, chromeApi: chrome });
  assert.deepEqual([r.where, r.path], ['folder', 'Shots/a.png']);
  assert.equal(dir.written[0][0], 'a.png');
});

test('saveBlob: a chosen folder that cannot be written falls back to downloads with a note', async () => {
  const downloads = [];
  const chrome = { downloads: { download: async (o) => { downloads.push(o); } } };
  const denied = await saveBlob(new Blob(['x']), 'a.png', { dirHandle: fakeDir({ permission: 'prompt' }), chromeApi: chrome });
  assert.equal(denied.where, 'downloads');
  assert.match(denied.note, /권한/);
  const failed = await saveBlob(new Blob(['x']), 'b.png', { dirHandle: fakeDir({ failWrite: true }), chromeApi: chrome });
  assert.equal(failed.where, 'downloads');
  assert.match(failed.note, /disk full/);
  assert.equal(downloads.length, 2);
});

test('expiredIds: keeps everything when retention is 0', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 10, 15);
  const entries = [
    { id: 'new', createdAt: now - DAY },
    { id: 'edge', createdAt: now - 30 * DAY },
    { id: 'old', createdAt: now - 31 * DAY },
  ];
  assert.deepEqual(expiredIds(entries, 30, now), ['old']);
  assert.deepEqual(expiredIds(entries, 0, now), []);
  assert.deepEqual(expiredIds(entries, 1, now), ['edge', 'old']);
});

function flowDeps(overrides = {}) {
  const calls = [];
  const entries = new Map();
  const deps = {
    calls,
    entries,
    runCapture: async (tabId, kind, opts) => {
      calls.push(['capture', tabId, kind, opts.depth]);
      opts.reportProgress?.({ stage: 'capture' });
      return { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', width: 30, height: 20 };
    },
    loadSettings: async () => ({ ...SETTING_DEFAULTS, ...(overrides.settings ?? {}) }),
    focusTab: async (tab) => { calls.push(['focus', tab.id]); },
    history: {
      addEntry: async (e) => { const item = { id: 'e1', createdAt: Date.UTC(2026, 10, 15), ...e }; entries.set('e1', item); return item; },
      updateEntry: async (id, patch) => { Object.assign(entries.get(id), patch); },
      pruneExpired: async (days) => { calls.push(['prune', days]); },
    },
    getDirHandle: async () => undefined,
    saveBlob: async (blob, filename) => { calls.push(['save', filename]); return { where: 'downloads', path: filename }; },
    notifyPanel: (m) => calls.push(['notify', m.type]),
    showToast: async (tabId, text, isError) => { calls.push(['toast', tabId, text, isError]); return true; },
    ...overrides.deps,
  };
  return deps;
}

test('captureFlow (panel): history only by default; never touches the clipboard', async () => {
  const d = flowDeps();
  const r = await captureFlow({ kind: 'viewport', tab: { id: 5, url: 'http://192.168.50.22:9100/', title: 'app' }, origin: 'panel' }, d);
  assert.equal(r.id, 'e1');
  assert.deepEqual(d.calls.map((c) => c[0]), ['capture', 'notify', 'prune', 'notify']); // progress, then history-changed
  assert.equal(d.entries.get('e1').pageUrl, 'http://192.168.50.22:9100/');
  assert.equal(d.entries.get('e1').blob.type, 'image/png');
  assert.ok(!d.calls.some((c) => c[0] === 'toast' || c[0] === 'save'));
});

test('captureFlow: "save" stores the shot and writes the result onto the entry', async () => {
  const d = flowDeps({ settings: { afterAction: 'save' } });
  const r = await captureFlow({ kind: 'full', tab: { id: 5 }, origin: 'panel' }, d);
  assert.match(r.note, /^저장됨: screenshot-full-/);
  assert.equal(d.entries.get('e1').note, r.note);
  assert.ok(d.calls.some((c) => c[0] === 'save'));

  const failing = flowDeps({ settings: { afterAction: 'save' }, deps: { saveBlob: async () => { throw new Error('disk full'); } } });
  const f = await captureFlow({ kind: 'full', tab: { id: 5 }, origin: 'panel' }, failing);
  assert.match(f.note, /저장 실패: disk full/); // the shot is kept in the history anyway
  assert.equal(failing.entries.get('e1').note, f.note);
});

test('captureFlow (menu): the page gets a toast; element shots bring the page window forward first', async () => {
  const d = flowDeps();
  await captureFlow({ kind: 'element', tab: { id: 9 }, origin: 'menu' }, d);
  assert.deepEqual(d.calls[0], ['focus', 9]);
  const toast = d.calls.find((c) => c[0] === 'toast');
  assert.equal(toast[1], 9);
  assert.match(toast[2], /요소 캡처 완료 · 30×20px · \d+\.\d초 · 기록에 저장됨/);
  assert.match(toast[2], /복사 버튼/);
  assert.equal(toast[3], false);
});

test('captureFlow: failures toast on the page (menu) but not a cancel; errors still propagate', async () => {
  const boom = flowDeps({ deps: { runCapture: async () => { throw new Error('attach failed'); } } });
  await assert.rejects(captureFlow({ kind: 'viewport', tab: { id: 1 }, origin: 'menu' }, boom), /attach failed/);
  assert.deepEqual(boom.calls.find((c) => c[0] === 'toast').slice(2), ['캡처 실패 · attach failed', true]);

  const canceled = flowDeps({ deps: { runCapture: async () => { throw new CaptureError(ErrorCode.CANCELED, 'canceled'); } } });
  await assert.rejects(captureFlow({ kind: 'element', tab: { id: 1 }, origin: 'menu' }, canceled), /canceled/);
  assert.ok(!canceled.calls.some((c) => c[0] === 'toast'));

  const fromPanel = flowDeps({ deps: { runCapture: async () => { throw new Error('x'); } } });
  await assert.rejects(captureFlow({ kind: 'viewport', tab: { id: 1 }, origin: 'panel' }, fromPanel), /x/);
  assert.ok(!fromPanel.calls.some((c) => c[0] === 'toast')); // the panel shows the error itself
});

test('captureFlow reports how long the capture took', async () => {
  let clock = 1000;
  const d = flowDeps({ deps: { now: () => clock, runCapture: async () => { clock += 1234; return { bytes: new Uint8Array([1]), mime: 'image/png', width: 1, height: 1 }; } } });
  const r = await captureFlow({ kind: 'full', tab: { id: 1 }, origin: 'panel' }, d);
  assert.equal(r.ms, 1234);
});

test('feedback: the effect function is self-contained and only uses CSP-safe APIs', async () => {
  const { renderEffect } = await import('../extension/feedback.js');
  assert.doesNotThrow(() => new Function(`return (${renderEffect.toString()})`));
  assert.ok(!/createElement\(['"]style['"]\)/.test(renderEffect.toString()));
  // the manifest and menus use the agreed terms
  assert.deepEqual(manifest.commands.viewport.description, '화면 캡처'); // a <style> element can be blocked by the page's CSP
});

test('toast: render function is self-contained; showToast is best effort', async () => {
  const { renderToast, showToast } = await import('../extension/toast.js');
  assert.doesNotThrow(() => new Function(`return (${renderToast.toString()})`));
  const calls = [];
  const ok = { scripting: { executeScript: async (o) => { calls.push(o); return [{ result: true }]; } } };
  assert.equal(await showToast(3, 'hi', false, ok), true);
  assert.deepEqual([calls[0].target.tabId, calls[0].args], [3, ['hi', false]]);
  const blocked = { scripting: { executeScript: async () => { throw new Error('Cannot access a chrome:// URL'); } } };
  assert.equal(await showToast(3, 'hi', true, blocked), false);
});

test('focusTab: focuses the window, activates the tab, never throws', async () => {
  const { focusTab } = await import('../extension/focus.js');
  const calls = [];
  const chrome = {
    windows: { update: async (id, info) => { calls.push(['windows', id, info]); } },
    tabs: { update: async (id, info) => { calls.push(['tabs', id, info]); } },
  };
  assert.equal(await focusTab({ id: 4, windowId: 9 }, chrome, 0), true);
  assert.deepEqual(calls, [['windows', 9, { focused: true }], ['tabs', 4, { active: true }]]);

  const broken = { windows: { update: async () => { throw new Error('no window'); } }, tabs: { update: async () => {} } };
  assert.equal(await focusTab({ id: 4, windowId: 9 }, broken, 0), false);
  assert.equal(await focusTab(undefined, chrome, 0), true); // nothing to focus is not an error
});
