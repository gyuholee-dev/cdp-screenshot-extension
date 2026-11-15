import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { normalizeSettings, SETTING_DEFAULTS, loadSettings, saveSettings } from '../extension/settings.js';
import { bytesToDataUrl, buildFilename, saveResult } from '../extension/save.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));

test('manifest: MV3, required permissions, referenced files exist', () => {
  assert.equal(manifest.manifest_version, 3);
  for (const p of ['debugger', 'contextMenus', 'downloads', 'activeTab', 'scripting', 'storage']) {
    assert.ok(manifest.permissions.includes(p), p);
  }
  assert.equal(manifest.background.type, 'module');
  assert.ok(existsSync(new URL(manifest.background.service_worker, root)));
  assert.ok(existsSync(new URL(manifest.options_ui.page, root)));
  assert.equal(manifest.action.default_popup, undefined); // no popup: icon opens settings
  assert.deepEqual(Object.keys(manifest.commands).sort(), ['element', 'full', 'viewport']);
});

test('manifest: no network listening surface', () => {
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.host_permissions, undefined);
});

test('normalizeSettings: defaults and coercion', () => {
  assert.deepEqual(normalizeSettings(), SETTING_DEFAULTS);
  assert.deepEqual(normalizeSettings({ depth: '2', format: 'jpeg', settleMs: '500', saveMode: 'clipboard' }),
    { depth: 2, format: 'jpeg', settleMs: 500, saveMode: 'clipboard' });
  assert.deepEqual(normalizeSettings({ depth: -1, format: 'gif', settleMs: 'x', saveMode: 'cloud' }), SETTING_DEFAULTS);
  assert.equal(normalizeSettings({ depth: 1.5 }).depth, SETTING_DEFAULTS.depth);
  assert.equal(normalizeSettings(null).format, 'png');
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

test('bytesToDataUrl / buildFilename', () => {
  assert.equal(bytesToDataUrl(new Uint8Array([104, 105]), 'image/png'), 'data:image/png;base64,aGk=');
  const big = new Uint8Array(100000).fill(65);
  assert.ok(bytesToDataUrl(big, 'image/png').length > 100000);
  assert.equal(buildFilename('full', 'image/jpeg', new Date(2026, 10, 15, 9, 5, 3)), 'screenshot-full-20261115-090503.jpg');
  assert.equal(buildFilename('viewport', 'image/png', new Date(2026, 10, 15, 9, 5, 3)), 'screenshot-viewport-20261115-090503.png');
});

test('saveResult: download, and clipboard failure falls back to download with a note', async () => {
  const downloads = [];
  const chrome = {
    downloads: { download: async (o) => { downloads.push(o); return 1; } },
    scripting: { executeScript: async () => { throw new Error('not focused'); } },
  };
  const result = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', width: 1, height: 1 };
  const a = await saveResult(result, 'viewport', { saveMode: 'download' }, 1, chrome);
  assert.equal(a.mode, 'download');
  assert.match(downloads[0].url, /^data:image\/png;base64,/);
  assert.equal(downloads[0].saveAs, false);

  const b = await saveResult(result, 'viewport', { saveMode: 'clipboard' }, 1, chrome);
  assert.equal(b.mode, 'download');
  assert.match(b.note, /not focused/);

  chrome.scripting.executeScript = async () => [{ result: true }];
  const c = await saveResult(result, 'viewport', { saveMode: 'clipboard' }, 1, chrome);
  assert.deepEqual(c, { mode: 'clipboard' });
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
