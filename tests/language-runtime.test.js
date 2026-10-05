'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');
const ROOT = path.join(__dirname, '..');
const actualFetch = global.fetch;
const descriptor = Object.getOwnPropertyDescriptor(global, 'navigator');

function runtime(t) {
  const calls = [];
  const memory = new Map();
  const originalStorage = global.localStorage;
  global.localStorage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  Object.defineProperty(global, 'navigator', { configurable: true, value: { languages: ['en-US'] } });
  global.fetch = async url => {
    calls.push(url);
    return new Response(fs.readFileSync(path.join(ROOT, 'public', url)));
  };
  t.after(() => {
    global.fetch = actualFetch;
    if (descriptor) Object.defineProperty(global, 'navigator', descriptor); else delete global.navigator;
    if (originalStorage) global.localStorage = originalStorage; else delete global.localStorage;
  });
  return { api: loadTsx('frontend/src/lib/i18n/runtime.ts'), calls, memory };
}

test('English initializes without requests and Spanish downloads once without fetching other locales', async t => {
  const { api, calls } = runtime(t);
  assert.equal(api.t('language.title'), 'Language');
  assert.equal(calls.length, 0);
  assert.equal(await api.changeLanguage('es'), true);
  assert.equal(api.t('language.title'), 'Idioma');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^\/locales\/es\.core\./);
  await api.changeLanguage('en');
  await api.changeLanguage('es-MX');
  assert.equal(calls.length, 1);
});

test('failed download and failed save retain working language and preference', async t => {
  const { api, memory } = runtime(t);
  await api.changeLanguage('es');
  const before = [...memory];
  global.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(api.changeLanguage('fr'), /offline/);
  assert.equal(api.getLanguage(), 'es');
  assert.deepEqual([...memory], before);
  await assert.rejects(api.changeLanguage('en', async () => { throw new Error('save rejected'); }), /save rejected/);
  assert.equal(api.getLanguage(), 'es');
  assert.deepEqual([...memory], before);
});

test('corrupt or wrong-release resources are rejected before activation', async t => {
  const { api } = runtime(t);
  global.fetch = async () => new Response('{"language.title":"wrong release"}');
  await assert.rejects(api.changeLanguage('es'), /version mismatch/);
  assert.equal(api.getLanguage(), 'en');
});

test('HTTP contexts without SubtleCrypto still load verified packs and reject corrupt ones', async t => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(global, 'crypto');
  Object.defineProperty(global, 'crypto', { configurable: true, value: {} });
  t.after(() => {
    if (cryptoDescriptor) Object.defineProperty(global, 'crypto', cryptoDescriptor);
    else delete global.crypto;
  });
  const { api } = runtime(t);
  assert.equal(await api.changeLanguage('es'), true);
  assert.equal(api.t('language.title'), 'Idioma');
  assert.equal(await api.changeLanguage('ar'), true);
  assert.equal(api.getLanguage(), 'ar');
  global.fetch = async () => new Response('{"language.title":"wrong release"}');
  await assert.rejects(api.changeLanguage('fr'), /version mismatch/);
  assert.equal(api.getLanguage(), 'ar');
});

test('a slow earlier selection cannot replace the latest language or save it late', async t => {
  const { api } = runtime(t);
  let release;
  const writes = [];
  const old = api.changeLanguage('es', async value => {
    writes.push(value);
    await new Promise(resolve => { release = resolve; });
  });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const current = api.changeLanguage('en', async value => { writes.push(value); });
  release();
  assert.equal(await old, false);
  assert.equal(await current, true);
  assert.deepEqual(writes, ['es', 'en']);
  assert.equal(api.getLanguage(), 'en');
});

test('account language does not overwrite signed-out device preference', async t => {
  const { api, memory } = runtime(t);
  await api.changeLanguage('es');
  await api.useAccountLanguage({ locale: 'fr' });
  assert.equal(api.getLanguage(), 'fr');
  assert.equal(memory.get('homeroom:language:device'), 'es');
  await api.useAccountLanguage(null);
  assert.equal(api.getLanguage(), 'es');
  assert.equal(memory.has('homeroom:language:account'), false);
});

test('legacy HTML interpolation escapes user values while ordinary text remains plain', async t => {
  const { api } = runtime(t);
  api.i18n.addResource('en', 'core', 'test.greeting', 'Hello {{name}}');
  assert.equal(api.t('test.greeting', { name: '<img onerror=alert(1)>' }), 'Hello <img onerror=alert(1)>');
  assert.equal(api.htmlText('test.greeting', { name: '<img onerror=alert(1)>' }), 'Hello &lt;img onerror=alert(1)&gt;');
});
