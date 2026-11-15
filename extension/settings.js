import { DEFAULTS } from '../core/index.js';

export const FORMATS = ['png', 'jpeg', 'webp'];
/**
 * What happens right after a capture. The history entry is always made, whatever is chosen.
 * Copying to the clipboard is never automatic: it is the Copy button of a history entry (the
 * clipboard needs focus and, for the page's own copy, a secure context, which depend on how the
 * capture was started; one manual click behaves the same everywhere).
 */
export const AFTER_ACTIONS = ['save', 'history'];
// values stored by earlier builds
const LEGACY_AFTER_ACTIONS = { copy: 'history', both: 'save' };

export const SETTING_DEFAULTS = Object.freeze({
  depth: DEFAULTS.depth,
  format: DEFAULTS.format,
  settleMs: DEFAULTS.settleMs,
  afterAction: 'history',
  retentionDays: 30, // 0 = keep until cleared by hand
});

/** Coerce stored/untrusted values; anything invalid falls back to the default. */
export function normalizeSettings(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const depth = Number(r.depth);
  const settleMs = Number(r.settleMs);
  const retentionDays = Number(r.retentionDays);
  const afterAction = LEGACY_AFTER_ACTIONS[r.afterAction] ?? r.afterAction;
  return {
    depth: Number.isInteger(depth) && depth >= 0 ? depth : SETTING_DEFAULTS.depth,
    format: FORMATS.includes(r.format) ? r.format : SETTING_DEFAULTS.format,
    settleMs: Number.isFinite(settleMs) && settleMs >= 0 ? Math.round(settleMs) : SETTING_DEFAULTS.settleMs,
    afterAction: AFTER_ACTIONS.includes(afterAction) ? afterAction : SETTING_DEFAULTS.afterAction,
    retentionDays: Number.isInteger(retentionDays) && retentionDays >= 0 ? retentionDays : SETTING_DEFAULTS.retentionDays,
  };
}

export async function loadSettings(chromeApi = globalThis.chrome) {
  const { settings } = await chromeApi.storage.local.get('settings');
  return normalizeSettings(settings);
}

export async function saveSettings(settings, chromeApi = globalThis.chrome) {
  const normalized = normalizeSettings(settings);
  await chromeApi.storage.local.set({ settings: normalized });
  return normalized;
}
