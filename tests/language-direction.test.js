'use strict';

// Reading direction (frontend/src/lib/i18n/direction.ts, the head's first
// paint). Arabic is the only right-to-left language the shell offers today,
// so these tests pin the direction table, the activation that writes `dir`
// on <html>, and the head's literal copy of the table — the copy that has to
// agree or a reload in Arabic flashes left to right.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx } = require('./lib/render-tsx');
const { browser, catalogFixture, from, runtimeFor } = require('./lib/language-fixture');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const ARABIC = {
  hello: from('Hello {{name}}', 'مرحبا {{name}}'),
};

function directionModule() {
  return loadTsx('frontend/src/lib/i18n/direction.ts');
}

function headScript() {
  const head = read('frontend/src/head.html');
  const scripts = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const script = scripts.find((text) => text.includes('homeroom:language:shown'));
  assert.ok(script, 'the head has a first-paint language script');
  return { head, script };
}

test('directionFor: the right-to-left languages, and every other one is left to right', () => {
  const { directionFor } = directionModule();
  for (const tag of ['ar', 'ar-EG', 'ar_EG', 'he', 'fa', 'ur', 'ps', 'dv', 'ckb', 'yi', 'sd', 'ug']) {
    assert.equal(directionFor(tag), 'rtl', `${tag} is right to left`);
  }
  for (const tag of ['en', 'en-GB', 'fr', 'es', 'zh-CN', 'ja', '', null, undefined]) {
    assert.equal(directionFor(tag), 'ltr', `${tag || 'nothing'} is left to right`);
  }
});

test('dirSign reads the document direction now, not at module load', () => {
  const { dirSign, currentDirection } = directionModule();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const root = { dir: 'ltr' };
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { documentElement: root } });
  try {
    assert.equal(currentDirection(), 'ltr');
    assert.equal(dirSign(), 1);
    root.dir = 'rtl';
    assert.equal(currentDirection(), 'rtl');
    assert.equal(dirSign(), -1);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete globalThis.document;
  }
});

test('the head carries the same right-to-left list as direction.ts', () => {
  const { RTL_LANGUAGES } = directionModule();
  const { script } = headScript();
  const match = script.match(/var RTL = \[([^\]]*)\];/);
  assert.ok(match, 'the head script declares its literal list');
  const headList = match[1].split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.deepEqual(headList, [...RTL_LANGUAGES], 'the head and the runtime agree on what is right to left');
});

test('the first paint sets dir and lang from homeroom:language:shown', () => {
  const { script } = headScript();
  const run = (shown) => {
    const classes = [];
    const root = { lang: 'en', dir: 'ltr', classList: { add: (name) => classes.push(name), remove() {} } };
    vm.runInNewContext(script, {
      localStorage: { getItem: (key) => (key === 'homeroom:language:shown' ? shown : null) },
      document: { documentElement: root },
      setTimeout() {},
    });
    return { root, classes };
  };

  const arabic = run('ar');
  assert.equal(arabic.root.dir, 'rtl', 'Arabic paints right to left before its pack loads');
  assert.equal(arabic.root.lang, 'ar');
  assert.deepEqual(arabic.classes, ['language-pending'], 'the page is held until Arabic is on screen');

  const regional = run('ar-EG');
  assert.equal(regional.root.dir, 'rtl', 'a regional Arabic tag is still right to left');
  assert.equal(regional.root.lang, 'ar-EG');

  const english = run('en');
  assert.equal(english.root.dir, 'ltr');
  assert.equal(english.root.lang, 'en');
  assert.deepEqual(english.classes, [], 'English is not held');

  const french = run('fr');
  assert.equal(french.root.dir, 'ltr', 'a left-to-right language is never mirrored');
  assert.deepEqual(french.classes, ['language-pending'], 'another language is still held');
});

test('activating Arabic writes dir="rtl" on <html>, and English puts it back', async (t) => {
  const fixture = catalogFixture(t, {
    languages: { en: 'English', ar: 'العربية' },
    translations: { ar: ARABIC },
  });
  const { catalogs } = fixture.build();
  browser(t, { root: fixture.root });
  const runtime = runtimeFor(catalogs);

  assert.equal(await runtime.changeLanguage('ar'), true);
  assert.equal(runtime.getLanguage(), 'ar');
  assert.equal(globalThis.document.documentElement.lang, 'ar');
  assert.equal(globalThis.document.documentElement.dir, 'rtl', 'the shell lays out right to left');

  await runtime.changeLanguage('en');
  assert.equal(globalThis.document.documentElement.lang, 'en');
  assert.equal(globalThis.document.documentElement.dir, 'ltr', 'choosing another language puts it back');
});
