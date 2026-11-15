import { DEFAULTS } from '../core/index.js';

export const FORMATS = ['png', 'jpeg', 'webp'];
export const SAVE_MODES = ['download', 'clipboard'];

export const SETTING_DEFAULTS = Object.freeze({
  depth: DEFAULTS.depth,
  format: DEFAULTS.format,
  settleMs: DEFAULTS.settleMs,
  saveMode: 'download',
});

/** Coerce stored/untrusted values; anything invalid falls back to the default. */
export function normalizeSettings(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const depth = Number(r.depth);
  const settleMs = Number(r.settleMs);
  return {
    depth: Number.isInteger(depth) && depth >= 0 ? depth : SETTING_DEFAULTS.depth,
    format: FORMATS.includes(r.format) ? r.format : SETTING_DEFAULTS.format,
    settleMs: Number.isFinite(settleMs) && settleMs >= 0 ? Math.round(settleMs) : SETTING_DEFAULTS.settleMs,
    saveMode: SAVE_MODES.includes(r.saveMode) ? r.saveMode : SETTING_DEFAULTS.saveMode,
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
