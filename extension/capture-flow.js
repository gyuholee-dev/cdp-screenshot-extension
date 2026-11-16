// One capture, whatever started it (panel button, context menu, shortcut):
// capture -> history entry -> optional save per setting -> note on the entry -> tell the panel.
// Never copies to the clipboard: that is the Copy button of a history entry (see settings.js).
// Dependencies are injected so the flow can be tested without a browser.
import { ErrorCode } from '../core/index.js';
import { buildFilename } from './save.js';
import { t } from './i18n.js';
import { describeError } from './errors.js';


/**
 * @param {{kind: 'viewport'|'full'|'element', tab: {id: number, url?: string, title?: string}, origin: 'panel'|'menu', signal?: AbortSignal}} req
 * @param {object} deps runCapture, loadSettings, focusTab, history{addEntry,updateEntry,pruneExpired},
 *   getDirHandle, saveBlob, notifyPanel
 * @returns {Promise<{id: string, note: string, ms: number}>} ms = time from the request to the saved entry
 */
export async function captureFlow({ kind, tab, origin, signal }, deps) {
  const { runCapture, loadSettings, focusTab, history, getDirHandle, saveBlob, notifyPanel } = deps;
  const now = deps.now ?? (() => Date.now());
  const started = now();
  try {
    if (kind === 'element') await focusTab(tab); // picking needs the page window in front
    const settings = await loadSettings();
    const result = await runCapture(tab.id, kind, {
      depth: settings.depth,
      format: settings.format,
      settleMs: settings.settleMs,
      signal, // lets the host cancel an element pick (the key press may go to the host's UI, not to the page)
      reportProgress: ({ stage }) => notifyPanel({ type: 'progress', stage, kind, windowId: tab.windowId }),
    });

    const blob = new Blob([result.bytes], { type: result.mime });
    const entry = await history.addEntry({
      kind,
      width: result.width,
      height: result.height,
      mime: result.mime,
      blob,
      // the same whoever started it: the page as read through the capture's connection
      pageUrl: result.page?.url ?? tab.url ?? '',
      pageTitle: result.page?.title ?? tab.title ?? '',
    });

    let note = '';
    let saveError; // set when the automatic save failed: the panel tells it
    if (settings.afterAction === 'save') {
      try {
        const saved = await saveBlob(blob, buildFilename(kind, result.mime, new Date(entry.createdAt)), { dirHandle: await getDirHandle() });
        note = t('note.saved', { path: saved.path }) + (saved.note ? `\n${saved.note}` : '');
      } catch (e) {
        console.error('[cdp-screenshot] save:', e);
        saveError = describeError('SAVE');
        note = saveError;
      }
      await history.updateEntry(entry.id, { note });
    }
    await history.pruneExpired(settings.retentionDays);
    const ms = now() - started;
    // The same details whatever started the capture: the panel words its message from them.
    notifyPanel({ type: 'history-changed', id: entry.id, kind, width: result.width, height: result.height, ms, saveError });
    return { id: entry.id, note, ms, saveError };
  } catch (e) {
    // A capture that was not started from the panel has no one waiting for an answer: tell the panel
    // (the panel's own button gets the error as its answer). A cancel is not a failure.
    if (origin !== 'panel' && e?.code !== ErrorCode.CANCELED) {
      notifyPanel({ type: 'capture-failed', message: describeError(e?.code), windowId: tab.windowId });
    }
    throw e;
  }
}
