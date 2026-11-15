// One capture, whatever started it (panel button, context menu, shortcut):
// capture -> history entry -> optional save per setting -> note on the entry -> tell the panel.
// Never copies to the clipboard: that is the Copy button of a history entry (see settings.js).
// Dependencies are injected so the flow can be tested without a browser.
import { ErrorCode } from '../core/index.js';
import { buildFilename } from './save.js';

const KIND_LABEL = { viewport: '화면 캡처', full: '전체 캡처', element: '요소 캡처' };

/**
 * @param {{kind: 'viewport'|'full'|'element', tab: {id: number, url?: string, title?: string}, origin: 'panel'|'menu'}} req
 * @param {object} deps runCapture, loadSettings, focusTab, history{addEntry,updateEntry,pruneExpired},
 *   getDirHandle, saveBlob, notifyPanel, showToast
 * @returns {Promise<{id: string, note: string, ms: number}>} ms = time from the request to the saved entry
 */
export async function captureFlow({ kind, tab, origin }, deps) {
  const { runCapture, loadSettings, focusTab, history, getDirHandle, saveBlob, notifyPanel, showToast } = deps;
  const now = deps.now ?? (() => Date.now());
  const started = now();
  try {
    if (kind === 'element') await focusTab(tab); // picking needs the page window in front
    const settings = await loadSettings();
    const result = await runCapture(tab.id, kind, {
      depth: settings.depth,
      format: settings.format,
      settleMs: settings.settleMs,
      reportProgress: ({ stage }) => notifyPanel({ type: 'progress', stage }),
    });

    const blob = new Blob([result.bytes], { type: result.mime });
    const entry = await history.addEntry({
      kind,
      width: result.width,
      height: result.height,
      mime: result.mime,
      blob,
      pageUrl: tab.url ?? '',
      pageTitle: tab.title ?? '',
    });

    let note = '';
    if (settings.afterAction === 'save') {
      try {
        const saved = await saveBlob(blob, buildFilename(kind, result.mime, new Date(entry.createdAt)), { dirHandle: await getDirHandle() });
        note = `저장됨: ${saved.path}${saved.note ? `\n${saved.note}` : ''}`;
      } catch (e) {
        note = `저장 실패: ${e?.message ?? e}`;
      }
      await history.updateEntry(entry.id, { note });
    }
    await history.pruneExpired(settings.retentionDays);
    notifyPanel({ type: 'history-changed', id: entry.id });
    const ms = now() - started;

    if (origin === 'menu') {
      await showToast(
        tab.id,
        `${KIND_LABEL[kind]} 완료 · ${result.width}×${result.height}px · ${(ms / 1000).toFixed(1)}초 · 기록에 저장됨${note ? `\n${note}` : ''}\n복사는 패널 기록의 복사 버튼으로`,
        false,
      );
    }
    return { id: entry.id, note, ms };
  } catch (e) {
    if (origin === 'menu' && e?.code !== ErrorCode.CANCELED) {
      await showToast(tab.id, `캡처 실패 · ${e?.message ?? e}`, true);
    }
    throw e;
  }
}
