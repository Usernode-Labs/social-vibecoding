'use strict';

// A throwaway checkout with its own frontend/locales, for the language tests.
//
// Homeroom ships English only, so the real catalogs cannot exercise a second
// language. These tests build one here with the real builder
// (scripts/language-packs.js) and hand the result to the real runtime
// (frontend/src/lib/i18n/core.ts), with `fetch` answering from the fixture's
// own public/locales.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildLanguagePacks, hash } = require('../../scripts/language-packs');
const { loadTsx } = require('./render-tsx');

const says = (text) => ({ text, description: 'Fixture message.' });
const from = (english, text) => ({ text, source: hash(english) });

const ENGLISH = {
  hello: says('Hello {{name}}'),
  bye: says('Goodbye'),
  onlyEnglish: says('Not translated yet'),
  legal: says('Read <0>the terms</0>, {{name}}.'),
  items_one: says('{{count}} item'),
  items_other: says('{{count}} items'),
};
const SPANISH = {
  hello: from('Hello {{name}}', 'Hola {{name}}'),
  // Translated from wording English no longer uses.
  bye: from('Bye', 'Adiós'),
  legal: from('Read <0>the terms</0>, {{name}}.', 'Lee <0>los términos</0>, {{name}}.'),
  items_one: from('{{count}} item', '{{count}} elemento'),
  items_many: from('{{count}} items', '{{count}} de elementos'),
  items_other: from('{{count}} items', '{{count}} elementos'),
};

function catalogFixture(t, { languages = { en: 'English', es: 'Español' }, english = ENGLISH, translations = { es: SPANISH } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'language-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, data) => {
    const target = path.join(root, 'frontend/locales', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data));
  };
  put('config.json', { sourceLanguage: 'en', languages });
  put('en/core.json', english);
  for (const [language, catalog] of Object.entries(translations)) put(`${language}/core.json`, catalog);
  const build = () => {
    const built = buildLanguagePacks(root);
    const catalogs = JSON.parse(fs.readFileSync(path.join(root, 'frontend/src/lib/i18n/catalogs.generated.json'), 'utf8'));
    return { ...built, catalogs };
  };
  return { root, put, build };
}

/**
 * The browser the runtime sees: storage, the device's languages, a document
 * and a `fetch` that serves the fixture's packs. Restored after the test.
 */
function browser(t, { root, deviceLanguages = ['en-US'], storage = new Map() } = {}) {
  const saved = {};
  for (const name of ['localStorage', 'navigator', 'document', 'fetch']) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  }
  const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const state = { requests: [], events: [], tamper: null, storage };
  define('localStorage', {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
  });
  define('navigator', { languages: deviceLanguages, language: deviceLanguages[0] });
  define('document', {
    documentElement: { lang: 'en' },
    dispatchEvent: (event) => { state.events.push(event); return true; },
  });
  define('fetch', async (url) => {
    state.requests.push(url);
    const bytes = fs.readFileSync(path.join(root, 'public', url));
    return new Response(state.tamper ? state.tamper(bytes) : bytes);
  });
  t.after(() => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  return state;
}

/** A fresh runtime over `catalogs`: a new page load in the same browser. */
function runtimeFor(catalogs) {
  return loadTsx('frontend/src/lib/i18n/core.ts').createLanguageRuntime(catalogs);
}

module.exports = { ENGLISH, SPANISH, browser, catalogFixture, from, runtimeFor, says };
