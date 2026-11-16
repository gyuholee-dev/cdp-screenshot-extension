// The extension's texts live in the standard Chrome places: _locales/<lang>/messages.json (key ->
// message; the dots of a key become underscores there, `{name}` marks a value) read through
// chrome.i18n, so the panel, the service worker and the manifest all follow Chrome's own UI language,
// with Korean (default_locale) as the fallback.

/** The text for `key` in Chrome's language (the key itself when missing), `{name}` filled from `params`. */
export function t(key, params = {}) {
  const text = globalThis.chrome?.i18n?.getMessage(key.replace(/\./g, '_')) || key;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

/** Fills every `data-i18n*` element under `root`: text, HTML (for texts holding <code>), title, aria-label, placeholder. */
export function applyDom(root = document) {
  document.documentElement.lang = globalThis.chrome?.i18n?.getUILanguage?.() ?? 'ko';
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const attr of ['title', 'aria-label', 'placeholder']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
  }
}
