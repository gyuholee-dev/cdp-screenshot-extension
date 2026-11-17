import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { normalizeSettings, SETTING_DEFAULTS, AFTER_ACTIONS, loadSettings, saveSettings } from '../extension/settings.js';
import { buildFilename, saveBlob, DEFAULT_SUBDIR } from '../extension/save.js';
import { expiredIds } from '../extension/history.js';
import { captureFlow } from '../extension/capture-flow.js';
import { createPickGuard } from '../extension/pick-guard.js';
import { CaptureError, ErrorCode } from '../core/index.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
// chrome.i18n stand-in: the texts of the default locale (the tests below match the Korean words)
const koMessages = JSON.parse(readFileSync(new URL('_locales/ko/messages.json', root), 'utf8'));
globalThis.chrome ??= {};
globalThis.chrome.i18n = { getMessage: (k) => koMessages[k]?.message ?? '', getUILanguage: () => 'ko' };

test('manifest: MV3, side panel + context menu, required permissions, referenced files exist', () => {
  assert.equal(manifest.manifest_version, 3);
  for (const p of ['debugger', 'downloads', 'storage', 'unlimitedStorage', 'sidePanel', 'contextMenus']) {
    assert.ok(manifest.permissions.includes(p), p);
  }
  assert.ok(!manifest.permissions.includes('clipboardWrite'), 'copying is a click in the panel: no extra permission');
  for (const p of ['scripting', 'activeTab']) assert.ok(!manifest.permissions.includes(p), `${p}: nothing is injected into pages any more (the effect goes through the debugger)`);
  assert.equal(manifest.background.type, 'module');
  assert.ok(existsSync(new URL(manifest.background.service_worker, root)));
  assert.ok(existsSync(new URL(manifest.side_panel.default_path, root)));
  assert.equal(manifest.options_ui, undefined); // settings live in the panel
  assert.equal(manifest.action.default_popup, undefined); // the icon opens/closes the panel
  assert.deepEqual(Object.keys(manifest.commands).sort(), ['element', 'full', 'toggle-panel', 'viewport']);
  assert.ok(Number(manifest.minimum_chrome_version) >= 141); // sidePanel.close
});

test('manifest: the camera icon files exist in every size', () => {
  for (const size of ['16', '32', '48', '128']) {
    assert.ok(existsSync(new URL(manifest.icons[size], root)), `icons.${size}`);
  }
  for (const size of ['16', '32']) assert.ok(existsSync(new URL(manifest.action.default_icon[size], root)), `default_icon.${size}`);
  assert.ok(existsSync(new URL('extension/icons/camera.svg', root))); // the source the PNGs are drawn from
});

test('manifest: no network listening surface', () => {
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.host_permissions, undefined);
});

test('normalizeSettings: defaults and coercion', () => {
  assert.deepEqual(normalizeSettings(), SETTING_DEFAULTS);
  assert.deepEqual(
    normalizeSettings({ depth: '2', format: 'jpeg', settleMs: '500', afterAction: 'save', retentionDays: '7' }),
    { depth: 2, format: 'jpeg', settleMs: 500, useDeviceScale: true, afterAction: 'save', retentionDays: 7, historyImageSize: 330, effects: SETTING_DEFAULTS.effects },
  );
  assert.deepEqual(normalizeSettings({ depth: -1, format: 'gif', settleMs: 'x', afterAction: 'cloud', retentionDays: -3 }), SETTING_DEFAULTS);
  assert.equal(normalizeSettings({ depth: 1.5 }).depth, SETTING_DEFAULTS.depth);
  assert.equal(SETTING_DEFAULTS.useDeviceScale, true);
  assert.equal(normalizeSettings({ useDeviceScale: false }).useDeviceScale, false);
  assert.equal(normalizeSettings({ useDeviceScale: 'no' }).useDeviceScale, true); // not a boolean: the default
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

test('normalizeSettings: a saved earlier default edge style follows the new default, a user style stays', () => {
  const old = 'box-shadow: inset 0 0 0 5px rgba(41, 121, 255, 0.95), inset 0 0 36px 8px rgba(41, 121, 255, 0.55);';
  assert.equal(normalizeSettings({ effects: { edge: { enabled: true, css: old } } }).effects.edge.css, SETTING_DEFAULTS.effects.edge.css);
  assert.match(SETTING_DEFAULTS.effects.edge.css, /inset 0 0 0 2px .* 18px 4px/);
  assert.equal(normalizeSettings({ effects: { edge: { css: 'outline: 3px solid red;' } } }).effects.edge.css, 'outline: 3px solid red;');
});

test('normalizeSettings: the history image size is a whole number from 256 to 1024', () => {
  assert.equal(SETTING_DEFAULTS.historyImageSize, 330);
  assert.equal(normalizeSettings().historyImageSize, 330);
  assert.equal(normalizeSettings({ historyImageSize: '512' }).historyImageSize, 512);
  assert.equal(normalizeSettings({ historyImageSize: 100 }).historyImageSize, 256); // below the range: the smallest
  assert.equal(normalizeSettings({ historyImageSize: 5000 }).historyImageSize, 1024); // above: the largest
  assert.equal(normalizeSettings({ historyImageSize: 300.6 }).historyImageSize, 301);
  assert.equal(normalizeSettings({ historyImageSize: 'x' }).historyImageSize, 330);
  assert.equal(normalizeSettings({ historyImageSize: '' }).historyImageSize, 330);
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

test('readElementBox: the element\'s box on the screen now; null when it is off the screen, empty or gone', async () => {
  const { readElementBox } = await import('../extension/element-box.js');
  const cdpWith = (value, failResolve = false) => {
    const calls = [];
    return {
      calls,
      send: async (method) => {
        calls.push(method);
        if (method === 'DOM.resolveNode') { if (failResolve) throw new Error('No node'); return { object: { objectId: 'o' } }; }
        if (method === 'Runtime.callFunctionOn') return { result: { value } };
        return {};
      },
    };
  };
  const vp = { vw: 400, vh: 600 };
  const inside = cdpWith({ left: 20, top: 100, width: 300, height: 80, radius: '8px', ...vp });
  assert.deepEqual(await readElementBox(inside, 5), { left: 20, top: 100, width: 300, height: 80, radius: '8px' });
  assert.ok(inside.calls.includes('Runtime.releaseObject')); // the handle is released
  // partly visible: still a box (the effect is clipped by the screen)
  assert.ok(await readElementBox(cdpWith({ left: -50, top: 550, width: 300, height: 200, radius: '0px', ...vp }), 5));
  // wholly below / above / beside the screen: no box, so no edge (not a screen-wide one in its place)
  assert.equal(await readElementBox(cdpWith({ left: 0, top: 700, width: 100, height: 50, radius: '0px', ...vp }), 5), null);
  assert.equal(await readElementBox(cdpWith({ left: 0, top: -80, width: 100, height: 50, radius: '0px', ...vp }), 5), null);
  assert.equal(await readElementBox(cdpWith({ left: 500, top: 10, width: 100, height: 50, radius: '0px', ...vp }), 5), null);
  assert.equal(await readElementBox(cdpWith({ left: 0, top: 0, width: 0, height: 0, radius: '0px', ...vp }), 5), null); // not rendered
  assert.equal(await readElementBox(cdpWith(null, true), 5), null); // gone
});

test('formatBytes: B, KB, MB, GB the short way', async () => {
  const { formatBytes } = await import('../extension/format.js');
  assert.deepEqual([0, 512, 2048, 1536 * 1024, 3 * 1024 ** 3].map(formatBytes), ['0 B', '512 B', '2 KB', '1.5 MB', '3.0 GB']);
  assert.equal(formatBytes(undefined), '0 B');
});

test('formatDate: 2026.11.16 16:42:30, 24 hours, padded, no spaces inside the date', async () => {
  const { formatDate } = await import('../extension/format.js');
  assert.equal(formatDate(new Date(2026, 10, 16, 16, 42, 30)), '2026.11.16 16:42:30');
  assert.equal(formatDate(new Date(2026, 0, 5, 9, 3, 7)), '2026.01.05 09:03:07');
  assert.equal(formatDate(new Date(2026, 11, 31, 0, 0, 0)), '2026.12.31 00:00:00');
});

test('buildFilename', () => {
  assert.equal(buildFilename('full', 'image/jpeg', new Date(2026, 10, 15, 9, 5, 3)), 'screenshot-full-20261115-090503.jpg');
  assert.equal(buildFilename('viewport', 'image/png', new Date(2026, 10, 15, 9, 5, 3)), 'screenshot-viewport-20261115-090503.png');
});

test('saveBlob: no chosen directory -> the download directory itself', async () => {
  const downloads = [];
  const chrome = { downloads: { download: async (o) => { downloads.push(o); return 1; } } };
  const r = await saveBlob(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'a.png', { chromeApi: chrome });
  assert.deepEqual([r.where, r.path, r.note], ['downloads', 'a.png', undefined]);
  assert.equal(downloads[0].filename, 'a.png');
  assert.match(downloads[0].url, /^data:image\/png;base64,AQID$/); // no object URLs in a service worker
  assert.equal(DEFAULT_SUBDIR, '');
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

test('saveBlob: a chosen directory is written to directly', async () => {
  const dir = fakeDir();
  const chrome = { downloads: { download: async () => { throw new Error('should not download'); } } };
  const r = await saveBlob(new Blob(['x']), 'a.png', { dirHandle: dir, chromeApi: chrome });
  assert.deepEqual([r.where, r.path], ['dir', 'Shots/a.png']);
  assert.equal(dir.written[0][0], 'a.png');
});

test('saveBlob: a chosen directory that cannot be written falls back to downloads with a note', async () => {
  const downloads = [];
  const chrome = { downloads: { download: async (o) => { downloads.push(o); } } };
  const denied = await saveBlob(new Blob(['x']), 'a.png', { dirHandle: fakeDir({ permission: 'prompt' }), chromeApi: chrome });
  assert.equal(denied.where, 'downloads');
  assert.match(denied.note, /권한/);
  const failed = await saveBlob(new Blob(['x']), 'b.png', { dirHandle: fakeDir({ failWrite: true }), chromeApi: chrome });
  assert.equal(failed.where, 'downloads');
  assert.ok(!/disk full/.test(failed.note), 'the raw message is not shown'); // (it goes to the console)
  assert.match(failed.note, /다운로드 경로/);
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
  assert.ok(!d.calls.some((c) => c[0] === 'save'));
});

test('captureFlow: "save" stores the shot and writes the result onto the entry', async () => {
  const d = flowDeps({ settings: { afterAction: 'save' } });
  const r = await captureFlow({ kind: 'full', tab: { id: 5 }, origin: 'panel' }, d);
  assert.match(r.note, /^저장했습니다: screenshot-full-/);
  assert.equal(d.entries.get('e1').note, r.note);
  assert.ok(d.calls.some((c) => c[0] === 'save'));

  const failing = flowDeps({ settings: { afterAction: 'save' }, deps: { saveBlob: async () => { throw new Error('disk full'); } } });
  const f = await captureFlow({ kind: 'full', tab: { id: 5 }, origin: 'panel' }, failing);
  assert.ok(!/disk full/.test(f.note), 'the raw message is not shown'); // the shot is kept in the history anyway
  assert.match(f.saveError, /저장에 실패하였습니다/); // and the panel is told, in words made for the user
  assert.equal(failing.entries.get('e1').note, f.note);
});

test('captureFlow: the same notification whoever started it; element shots bring the page window forward first', async () => {
  const seen = [];
  for (const origin of ['panel', 'menu']) {
    const d = flowDeps();
    d.notifyPanel = (m) => seen.push([origin, m]);
    await captureFlow({ kind: 'element', tab: { id: 9, windowId: 3 }, origin }, d);
    assert.deepEqual(d.calls[0], ['focus', 9]);
  }
  const done = seen.filter(([, m]) => m.type === 'history-changed');
  assert.equal(done.length, 2);
  const [a, b] = done.map(([, m]) => m);
  assert.deepEqual([a.kind, a.width, a.height, typeof a.ms], ['element', 30, 20, 'number']);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort()); // nothing differs by origin except the entry id
});

test('captureFlow: a failure of a capture not started from the panel is told to the panel; a cancel is not', async () => {
  const msgs = (origin, err) => {
    const sent = [];
    const d = flowDeps({ deps: { runCapture: async () => { throw err; } } });
    d.notifyPanel = (m) => sent.push(m);
    return captureFlow({ kind: 'viewport', tab: { id: 1, windowId: 4 }, origin }, d).catch(() => sent);
  };
  assert.deepEqual((await msgs('menu', new Error('attach failed'))).filter((m) => m.type === 'capture-failed'), [{ type: 'capture-failed', message: koMessages.error_UNKNOWN.message, windowId: 4 }]); // words for the user, not the raw message
  assert.equal((await msgs('menu', new CaptureError(ErrorCode.NOT_ATTACHABLE, 'raw'))).find((m) => m.type === 'capture-failed').message, koMessages.error_NOT_ATTACHABLE.message);
  assert.equal((await msgs('menu', new CaptureError(ErrorCode.CANCELED, 'c'))).filter((m) => m.type === 'capture-failed').length, 0);
  assert.equal((await msgs('panel', new Error('x'))).filter((m) => m.type === 'capture-failed').length, 0); // it gets the error as its answer
  await assert.rejects(captureFlow({ kind: 'viewport', tab: { id: 1 }, origin: 'menu' }, flowDeps({ deps: { runCapture: async () => { throw new Error('boom'); } } })), /boom/);
});

test('pick guard: leaving the page ends the pick, but not during the grace period or for other tabs', () => {
  let clock = 1000;
  const g = createPickGuard({ graceMs: 400, now: () => clock });
  const a = g.add(1, 10);
  const b = g.add(2, 10);
  assert.equal(g.cancelWhere(() => true), 0); // nobody is picking yet
  g.picking(1);
  clock += 100;
  assert.equal(g.cancelWhere((r) => r.windowId === 10), 0); // inside the grace period: the start's own focus changes
  assert.equal(a.signal.aborted, false);
  clock += 400;
  assert.equal(g.cancelWhere((r) => r.windowId === 10), 1); // only the tab that is picking
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);
  g.remove(1);
  assert.equal(g.cancelWhere(() => true), 0);
  // an explicit cancel is immediate and by window
  g.picking(2);
  assert.equal(g.cancelWindow(10), 1);
  assert.equal(b.signal.aborted, true);
});

test('captureFlow hands the cancel signal to the capture', async () => {
  const ctrl = new AbortController();
  let seen;
  const d = flowDeps({ deps: { runCapture: async (_id, _kind, opts) => { seen = opts.signal; return { bytes: new Uint8Array([1]), mime: 'image/png', width: 1, height: 1 }; } } });
  await captureFlow({ kind: 'element', tab: { id: 1 }, origin: 'panel', signal: ctrl.signal }, d);
  assert.equal(seen, ctrl.signal);
});

test('captureFlow: the page address comes from the capture whoever started it, not from the tab object', async () => {
  for (const tab of [{ id: 1 }, { id: 1, url: 'http://tab-object/' }]) { // (the tab has an address only after a menu click)
    const d = flowDeps({ deps: { runCapture: async () => ({ bytes: new Uint8Array([1]), mime: 'image/png', width: 1, height: 1, page: { url: 'http://192.168.50.22:9100/#monitor=1', title: 'worker-1 모니터' } }) } });
    await captureFlow({ kind: 'viewport', tab, origin: 'panel' }, d);
    assert.equal(d.entries.get('e1').pageUrl, 'http://192.168.50.22:9100/#monitor=1');
    assert.equal(d.entries.get('e1').pageTitle, 'worker-1 모니터');
  }
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
  // (a <style> element can be blocked by the page's CSP)
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

test('capturable: Chrome\'s own pages and the web store are blocked, web and file pages are not', async () => {
  const { isCapturableUrl, isTabCapturable } = await import('../extension/capturable.js');
  for (const u of ['chrome://extensions/', 'chrome://newtab/', 'chrome-extension://abc/panel.html', 'devtools://devtools/bundled/x.html', 'view-source:https://a.com/', 'chrome-error://chromewebdata/', 'https://chromewebstore.google.com/detail/x', 'https://chrome.google.com/webstore/detail/x']) {
    assert.equal(isCapturableUrl(u), false, u);
  }
  for (const u of ['http://192.168.50.22:9100/', 'https://example.com/', 'file:///tmp/a.html', 'about:blank', 'https://chrome.google.com/other', '', undefined]) {
    assert.equal(isCapturableUrl(u), true, String(u));
  }
  const api = (targets) => ({ debugger: { getTargets: async () => targets } });
  assert.equal(await isTabCapturable(3, api([{ type: 'page', tabId: 3, url: 'chrome://extensions/' }])), false);
  assert.equal(await isTabCapturable(3, api([{ type: 'page', tabId: 3, url: 'https://a.com/' }, { type: 'page', tabId: 4, url: 'chrome://x/' }])), true);
  assert.equal(await isTabCapturable(3, api([])), true); // unknown: let the capture decide
  assert.equal(await isTabCapturable(3, { debugger: { getTargets: async () => { throw new Error('x'); } } }), true);
});
