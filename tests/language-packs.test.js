'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectCatalogs, buildLanguagePacks, hash } = require('../scripts/language-packs');
const { shellAssetCacheControl, IMMUTABLE } = require('../src/services/static-cache');
const { fixture, harness } = require('./lib/shell-release-fixture');
const { loadTsx } = require('./lib/render-tsx');
const ROOT = path.join(__dirname, '..');

function catalogFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'language-packs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, data) => {
    const target = path.join(root, 'frontend/locales', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(data));
  };
  fs.mkdirSync(path.join(root, 'frontend/src/lib/i18n'), { recursive: true });
  put('config.json', { sourceLanguage: 'en', languages: { en: 'English', es: 'Español', fr: 'Français' } });
  put('en/core.json', { hello: 'Hello {{name}}' });
  put('es/core.json', { hello: { text: 'Hola {{name}}', source: hash('Hello {{name}}') } });
  put('fr/core.json', { hello: { text: 'Bonjour {{name}}', source: hash('Hello {{name}}') } });
  return { root, put };
}

test('every declared locale has complete, source-current catalogs', () => {
  const { catalogs, config } = collectCatalogs(ROOT);
  assert.deepEqual(Object.keys(catalogs), Object.keys(config.languages));
});

test('missing entries, stale source and unsafe/mismatched interpolation fail validation', t => {
  const { root, put } = catalogFixture(t);
  put('es/core.json', {});
  assert.throws(() => collectCatalogs(root), /missing translation/);
  put('es/core.json', { hello: { text: 'Hola {{name}}', source: hash('Old source') } });
  assert.throws(() => collectCatalogs(root), /English changed/);
  put('es/core.json', { hello: { text: 'Hola {{other}}', source: hash('Hello {{name}}') } });
  assert.throws(() => collectCatalogs(root), /parameters differ/);
  put('es/core.json', { hello: { text: 'Hola {{- name}}', source: hash('Hello {{name}}') } });
  assert.throws(() => collectCatalogs(root), /unescaped interpolation/);
});

test('a translation edit changes only its pack and each URL hashes its actual bytes', t => {
  const { root, put } = catalogFixture(t);
  const before = buildLanguagePacks(root);
  put('es/core.json', { hello: { text: '¡Hola {{name}}!', source: hash('Hello {{name}}') } });
  const after = buildLanguagePacks(root);
  assert.notEqual(after.es.core.url, before.es.core.url);
  assert.deepEqual(after.en, before.en);
  assert.deepEqual(after.fr, before.fr);
  const bytes = fs.readFileSync(path.join(root, 'public', after.es.core.url));
  assert.equal(hash(bytes), after.es.core.hash);
  assert.equal(shellAssetCacheControl(path.join(root, 'public', after.es.core.url)), IMMUTABLE);
  assert.equal(shellAssetCacheControl('/public/locales/es.core.mutable.json'), null);
});

test('worker installation and upgrades never prefetch languages; requested packs work offline', async t => {
  const es = JSON.stringify({ greeting: 'Hola' });
  const fr = JSON.stringify({ greeting: 'Bonjour' });
  const esUrl = `/locales/es.core.${hash(es)}.json`;
  const frUrl = `/locales/fr.core.${hash(fr)}.json`;
  const overrides = { [esUrl]: es, [frUrl]: fr };
  const a = fixture(t, 'a', overrides);
  for (const entry of a.manifest.assets.filter(asset => asset.path.startsWith('/locales/'))) {
    assert.equal(entry.precache, false);
  }
  const env = harness(a);
  const first = env.worker(a);
  await first.install(); await first.activate();
  assert.equal(env.requests.some(url => url.startsWith('/locales/')), false);
  assert.equal(await (await first.get(esUrl)).text(), es);
  assert.equal(env.requests.includes(frUrl), false);
  env.offline(true);
  assert.equal(await (await first.get(esUrl)).text(), es);
  env.offline(false);
  const b = fixture(t, 'b', overrides);
  env.serve(b); env.requests.length = 0;
  const second = env.worker(b);
  await second.install(); await second.activate();
  assert.equal(env.requests.some(url => url.startsWith('/locales/')), false);
  assert.equal(await (await second.get(esUrl)).text(), es);
  assert.equal(env.requests.includes(esUrl), false, 'unchanged Spanish pack reused across release');
});

test('locale matching resolves variants once, respects preference and distinguishes Chinese scripts', () => {
  const { matchLanguage, resolveLanguage, languageDirection } = loadTsx('frontend/src/lib/i18n/locale.ts');
  for (const [tag, expected] of [['es-MX', 'es'], ['pt-PT', 'pt-BR'], ['zh-Hant-HK', 'zh-TW'],
    ['zh-Hans-TW', 'zh-CN'], ['zh-HK', 'zh-TW'], ['EN_us', 'en'], ['bad!', null]]) {
    assert.equal(matchLanguage(tag), expected, tag);
  }
  assert.equal(resolveLanguage('fr', ['es-MX']), 'fr');
  assert.equal(resolveLanguage(null, ['xx', 'es-MX']), 'es');
  assert.equal(resolveLanguage(null, ['xx']), 'en');
  assert.equal(languageDirection('ar'), 'rtl');
  assert.equal(languageDirection('es'), 'ltr');
});
