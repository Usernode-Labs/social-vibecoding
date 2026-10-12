'use strict';

// The English `PlatformI18n` for a test that runs a legacy module on its own.
//
// A module under public/js, or an import-free one under frontend/src, reads
// its text through the global the language runtime publishes
// (frontend/src/lib/i18n/runtime.ts). A test that evaluates such a module in
// a vm sandbox has no shell around it, so it hands the sandbox this instead:
//
//   const sandbox = { window: {}, PlatformI18n: englishPlatformI18n() };
//
// It is the real runtime (lib/i18n/core.ts) over the real English catalogs
// (frontend/locales/en), not a stand-in that echoes keys: an assertion on
// rendered text keeps checking the words a person reads, and an id that no
// catalog defines shows up as the id itself.
//
// `message(id, values)` is the same English for an assertion that names the
// text by its id.

const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./render-tsx');

const LOCALES = path.join(__dirname, '..', '..', 'frontend', 'locales');
let runtime = null;

function englishRuntime() {
  if (runtime) return runtime;
  const english = {};
  for (const name of fs.readdirSync(path.join(LOCALES, 'en')).filter((file) => file.endsWith('.json')).sort()) {
    const entries = JSON.parse(fs.readFileSync(path.join(LOCALES, 'en', name), 'utf8'));
    english[name.slice(0, -5)] = Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.text]));
  }
  runtime = loadTsx('frontend/src/lib/i18n/core.ts').createLanguageRuntime({
    languages: { en: 'English' }, namespaces: Object.keys(english), english, manifest: {},
  });
  return runtime;
}

/** What `window.PlatformI18n` holds in the shell, in English. */
function englishPlatformI18n(overrides = {}) {
  const { t, htmlText, htmlRich, listText, languageName, getLanguage, getPreference } = englishRuntime();
  return { t, htmlText, htmlRich, listText, languageName, getLanguage, getPreference, ...overrides };
}

/** The English text of `namespace:key`, with its parameters filled in. */
function message(id, values) {
  const text = englishRuntime().t(id, values);
  if (text === id || text === id.slice(id.indexOf(':') + 1)) throw new Error(`No English catalog entry for ${id}`);
  return text;
}

module.exports = { englishPlatformI18n, message };
