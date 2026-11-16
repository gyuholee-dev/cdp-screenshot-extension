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
const en = messages('en'); // the default locale: the complete set the other languages are compared with
const ko = messages('ko');
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const id = (key) => key.replace(/\./g, '_');

// chrome.i18n stand-in: the table of one language, the default locale (en) behind it
const use = (table) => { globalThis.chrome = { i18n: { getMessage: (k) => (table[k] ?? en[k])?.message ?? '', getUILanguage: () => 'ko' } }; };

test('the default locale exists, and every other language under _locales has the same keys and {placeholders}', () => {
  assert.equal(manifest.default_locale, 'en');
  for (const [k, v] of Object.entries(en)) assert.ok(v.message, `${k}: empty`);
  for (const lang of readdirSync(new URL('_locales/', root)).filter((l) => l !== 'en')) {
    const other = messages(lang);
    assert.deepEqual(Object.keys(other).sort(), Object.keys(en).sort(), lang);
    for (const k of Object.keys(en)) assert.deepEqual(params(other[k].message), params(en[k].message), `${lang} ${k}`);
  }
});

test('every key used by panel.html, t(...) calls and the manifest exists', () => {
  const keys = new Set();
  for (const m of read('panel.html').matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) keys.add(id(m[1]));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    for (const m of read(f).matchAll(/\bt\('([\w.]+)'/g)) keys.add(id(m[1]));
  }
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) keys.add(m[1]);
  for (const k of keys) assert.ok(k in en, `missing key: ${k}`);
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
  use({ act_copy: { message: '복사' } }); // another language that has only some of the keys
  assert.equal(t('act.copy'), '복사');
  assert.equal(t('act.save'), 'Save'); // missing there: the default locale
  assert.equal(t('no.such.key'), 'no.such.key');
  use({});
  assert.equal(t('done.took', { sec: '1.5' }), ' · 1.5s');
  assert.equal(t('note.saved', { path: 'a/b' }), 'Saved: a/b');
});

test('errors: every code shown to the user has a description with what to do, the raw message is never shown', () => {
  const codes = [...Object.values(ErrorCode).filter((c) => c !== 'CANCELED'), /* a cancel is silent */'NO_TAB', 'BUSY', 'NO_RESPONSE', 'UNKNOWN', 'SAVE', 'COPY', 'DELETE', 'DIR'];
  use({});
  for (const c of codes) assert.ok(`error_${c}` in en, `no description for ${c}`);
  assert.equal(describeError('NO_TAB'), en.error_NO_TAB.message);
  assert.equal(describeError('SOMETHING_ELSE'), en.error_UNKNOWN.message); // an unknown code: the general one
  assert.equal(describeError(undefined), en.error_UNKNOWN.message);
});

test('errors: the too-large description shows the limit from the error details', () => {
  use({});
  assert.match(describeError('TOO_LARGE', { maxSide: 8000 }), /\(8000px\)/);
  assert.match(describeError('TOO_LARGE'), /\(16384px\)/); // no details: the default limit
});

test('errors: the timeout description shows the seconds from the error details', () => {
  use({});
  assert.match(describeError('TIMEOUT', { pickTimeoutMs: 30000 }), /within 30 seconds/);
  assert.match(describeError('TIMEOUT'), /within 60 seconds/); // no details: the default
});
