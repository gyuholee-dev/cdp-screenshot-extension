import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { t } from '../extension/i18n.js';
import { describeError } from '../extension/errors.js';
import { ErrorCode } from '../core/index.js';

const root = new URL('../', import.meta.url);
const dir = new URL('extension/', root);
const read = (f) => readFileSync(new URL(f, dir), 'utf8');
const messages = (lang) => JSON.parse(readFileSync(new URL(`_locales/${lang}/messages.json`, root), 'utf8'));
const ko = messages('ko');
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const id = (key) => key.replace(/\./g, '_');

// chrome.i18n stand-in: the table of one language, the default locale (ko) behind it
const use = (table) => { globalThis.chrome = { i18n: { getMessage: (k) => (table[k] ?? ko[k])?.message ?? '', getUILanguage: () => 'ko' } }; };

test('the default locale exists, and every other language under _locales has the same keys and {placeholders}', () => {
  assert.equal(manifest.default_locale, 'ko');
  for (const [k, v] of Object.entries(ko)) assert.ok(v.message, `${k}: empty`);
  for (const lang of readdirSync(new URL('_locales/', root)).filter((l) => l !== 'ko')) {
    const other = messages(lang);
    assert.deepEqual(Object.keys(other).sort(), Object.keys(ko).sort(), lang);
    for (const k of Object.keys(ko)) assert.deepEqual(params(other[k].message), params(ko[k].message), `${lang} ${k}`);
  }
});

test('every key used by panel.html, t(...) calls and the manifest exists', () => {
  const keys = new Set();
  for (const m of read('panel.html').matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) keys.add(id(m[1]));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    for (const m of read(f).matchAll(/\bt\('([\w.]+)'/g)) keys.add(id(m[1]));
  }
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) keys.add(m[1]);
  for (const k of keys) assert.ok(k in ko, `missing key: ${k}`);
});

test('no Korean text is left in the code or panel.html (core errors aside)', () => {
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const code = read(f).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n').replace(/\s\/\/.*$/gm, '');
    assert.ok(!/[가-힣]/.test(code), `${f} has Korean text`);
  }
  assert.ok(!/[가-힣]/.test(read('panel.html')), 'panel.html has Korean text');
  assert.ok(!/[가-힣]/.test(JSON.stringify(manifest)), 'manifest.json has Korean text');
});

test('t(): message lookup, default-locale fallback, the key itself when missing, {param} filling', () => {
  use({ act_copy: { message: 'Copy' } }); // another language that has only some of the keys
  assert.equal(t('act.copy'), 'Copy');
  assert.equal(t('act.save'), '저장'); // missing there: the default locale
  assert.equal(t('no.such.key'), 'no.such.key');
  use({});
  assert.equal(t('done.took', { sec: '1.5' }), ' · 1.5초');
  assert.equal(t('note.saved', { path: 'a/b' }), '저장했습니다: a/b');
});

test('errors: every code shown to the user has a description with what to do, the raw message is never shown', () => {
  const codes = [...Object.values(ErrorCode).filter((c) => c !== 'CANCELED'), /* a cancel is silent */'NO_TAB', 'BUSY', 'NO_RESPONSE', 'UNKNOWN', 'SAVE', 'COPY', 'DELETE', 'EFFECT_TEST', 'FOLDER'];
  use({});
  for (const c of codes) assert.ok(`error_${c}` in ko, `no description for ${c}`);
  assert.equal(describeError('TOO_LARGE'), ko.error_TOO_LARGE.message);
  assert.equal(describeError('SOMETHING_ELSE'), ko.error_UNKNOWN.message); // an unknown code: the general one
  assert.equal(describeError(undefined), ko.error_UNKNOWN.message);
});
