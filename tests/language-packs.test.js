'use strict';

// The catalog builder (scripts/language-packs.js): what it demands of the
// English source, what it forgives a translation, and how the packs it writes
// are named, served and cached. frontend/locales/README.md is the contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PACK_NAME, buildLanguagePacks, collectCatalogs, formatReport, hash,
} = require('../scripts/language-packs');
const { shellAssetCacheControl, IMMUTABLE } = require('../src/services/static-cache');
const { classifyRequest } = require('../public/sw');
const { fixture, harness } = require('./lib/shell-release-fixture');
const { loadTsx } = require('./lib/render-tsx');
const { ENGLISH, SPANISH, catalogFixture, from, says } = require('./lib/language-fixture');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('Homeroom ships English only, and its English source is valid', () => {
  const { config, namespaces, catalogs, report } = collectCatalogs(ROOT);
  assert.deepEqual(config.languages, { en: 'English' });
  assert.ok(namespaces.includes('core'));
  assert.deepEqual(catalogs, {}, 'no other language has a pack');
  assert.equal(formatReport(report), 'Only English is shipped; there is no translation coverage to report.');
  for (const namespace of namespaces) {
    for (const [key, entry] of Object.entries(JSON.parse(read(`frontend/locales/en/${namespace}.json`)))) {
      assert.ok(entry.description.trim(), `${namespace}:${key} says where it appears`);
    }
  }
});

test('an authoring mistake in the English source fails the build', (t) => {
  const { put, root } = catalogFixture(t);
  const rejects = (entries, pattern) => {
    put('en/core.json', { ...ENGLISH, ...entries });
    assert.throws(() => collectCatalogs(root), pattern);
    assert.throws(() => buildLanguagePacks(root), pattern);
  };
  rejects({ plain: 'Just a string' }, /core:plain: an entry is \{ "text"/);
  rejects({ noWhere: { text: 'Save' } }, /core:noWhere: description is missing/);
  rejects({ generic: says('Message @{{value1}}') }, /core:generic: parameter \{\{value1\}\} must say what it holds/);
  rejects({ fragment: says(' allowance is used up. ') }, /core:fragment: text starts or ends with a space/);
  rejects({ markup: says('Read <b>this</b>') }, /core:markup: only numbered tags/);
  rejects({ unclosed: says('Read <0>this') }, /core:unclosed: a tag is not closed/);
  rejects({ unsafe: says('Hello {{- name}}') }, /core:unsafe: parameter \{\{- name\}\} must be a plain name/);
  rejects({ apples_one: says('{{count}} apple') }, /core:apples_one: a plural needs apples_other too/);
  rejects({ extra: { ...says('Save'), source: 'x' } }, /core:extra: unknown field "source"/);
  put('en/core.json', '{ not json');
  assert.throws(() => collectCatalogs(root), /en\/core\.json:/);
});

test('a translation never fails the build: what cannot be used falls back to English and is reported', (t) => {
  const { put, build } = catalogFixture(t, {
    translations: {
      es: {
        ...SPANISH,
        hello: from('Hello {{name}}', 'Hola {{nombre}}'),
        legal: from('Read <0>the terms</0>, {{name}}.', 'Lee <b>los términos</b>, {{name}}.'),
        retired: from('Gone', 'Ya no'),
      },
    },
  });
  const { report, manifest } = build();
  assert.deepEqual(report.es.missing, ['core:onlyEnglish']);
  assert.deepEqual(report.es.stale, ['core:bye'], 'English changed since this was translated');
  assert.deepEqual(report.es.invalid.sort(), ['core:hello', 'core:legal'], 'a renamed parameter, and markup');
  assert.deepEqual(report.es.unknown, ['core:retired']);
  assert.equal(report.es.total, 7, 'six messages, and Spanish counts in three forms');
  assert.equal(report.es.translated, 3);
  assert.match(manifest.es.core.url, /^\/locales\/es\.core\.[a-f0-9]{64}\.json$/);
  assert.match(formatReport(report), /^es: 3 of 7 translated \(42%\), 1 missing, 1 stale, 2 invalid, 1 no longer in English$/m);
  assert.match(formatReport(report), /^ {2}stale {2}core:bye$/m);
  // A catalog that is not there, or is not JSON, is every message missing.
  put('es/core.json', '{ not json');
  const broken = build().report.es;
  assert.deepEqual(broken.invalid, ['core:*']);
  assert.equal(broken.translated, 0);
});

test('a pack carries only usable text, and a hand-corrected entry may be locked', (t) => {
  const { root, build } = catalogFixture(t, {
    translations: { es: { ...SPANISH, hello: { ...from('Hello {{name}}', '¡Hola, {{name}}!'), locked: true } } },
  });
  const { manifest } = build();
  const pack = JSON.parse(fs.readFileSync(path.join(root, 'public', manifest.es.core.url), 'utf8'));
  assert.deepEqual(pack, {
    hello: '¡Hola, {{name}}!',
    legal: 'Lee <0>los términos</0>, {{name}}.',
    items_one: '{{count}} elemento',
    items_many: '{{count}} de elementos',
    items_other: '{{count}} elementos',
  }, 'no source digests, no descriptions, and nothing stale or missing');
});

test('a counted message is used whole or not at all', (t) => {
  const russian = {
    items_one: from('{{count}} item', '{{count}} предмет'),
    items_few: from('{{count}} items', '{{count}} предмета'),
    // items_many is missing: Russian needs it.
    items_other: from('{{count}} items', '{{count}} предмета'),
    bye: from('Goodbye', 'Пока'),
  };
  const { root, build } = catalogFixture(t, {
    languages: { en: 'English', ru: 'Русский' }, translations: { ru: russian },
  });
  const { manifest, report } = build();
  assert.ok(report.ru.missing.includes('core:items_many'));
  const pack = JSON.parse(fs.readFileSync(path.join(root, 'public', manifest.ru.core.url), 'utf8'));
  assert.deepEqual(pack, { bye: 'Пока' }, 'half a plural set would mix Russian and English forms');
});

test('each pack is named by the hash of its bytes, served immutable, and replaced when it changes', (t) => {
  const { root, put, build } = catalogFixture(t, {
    languages: { en: 'English', es: 'Español', fr: 'Français' },
    translations: { es: SPANISH, fr: { bye: from('Goodbye', 'Au revoir') } },
  });
  const before = build().manifest;
  assert.equal(before.en, undefined, 'English is bundled, never a pack');
  put('es/core.json', { ...SPANISH, hello: from('Hello {{name}}', '¡Hola {{name}}!') });
  const after = build().manifest;
  assert.notEqual(after.es.core.url, before.es.core.url);
  assert.deepEqual(after.fr, before.fr, 'an edit to Spanish leaves the French URL alone');
  const file = path.join(root, 'public', after.es.core.url);
  assert.equal(hash(fs.readFileSync(file)), after.es.core.hash);
  assert.equal(fs.existsSync(path.join(root, 'public', before.es.core.url)), false, 'the superseded pack is removed');
  assert.ok(PACK_NAME.test(path.basename(file)));
  assert.equal(shellAssetCacheControl(file), IMMUTABLE);
  assert.equal(shellAssetCacheControl('/app/public/locales/es.core.json'), null, 'only a hashed name is immutable');
});

test('the worker never downloads a language on install, and keeps a requested pack for offline use', async (t) => {
  const es = JSON.stringify({ greeting: 'Hola' });
  const fr = JSON.stringify({ greeting: 'Bonjour' });
  const esUrl = `/locales/es.core.${hash(es)}.json`;
  const frUrl = `/locales/fr.core.${hash(fr)}.json`;
  assert.equal(classifyRequest('GET', `https://homeroom.test${esUrl}`, '*/*', 'cors', 'https://homeroom.test'), 'shell');
  const overrides = { [esUrl]: es, [frUrl]: fr };
  const a = fixture(t, 'a', overrides);
  const packs = a.manifest.assets.filter((asset) => asset.path.startsWith('/locales/'));
  assert.deepEqual(packs.map((asset) => asset.path).sort(), [esUrl, frUrl].sort());
  for (const entry of packs) assert.equal(entry.precache, false);
  const env = harness(a);
  const first = env.worker(a);
  await first.install(); await first.activate();
  assert.equal(env.requests.some((url) => url.startsWith('/locales/')), false);
  assert.equal(await (await first.get(esUrl)).text(), es);
  assert.equal(env.requests.includes(frUrl), false);
  env.offline(true);
  assert.equal(await (await first.get(esUrl)).text(), es);
  env.offline(false);
  const b = fixture(t, 'b', overrides);
  env.serve(b); env.requests.length = 0;
  const second = env.worker(b);
  await second.install(); await second.activate();
  assert.equal(env.requests.some((url) => url.startsWith('/locales/')), false);
  assert.equal(await (await second.get(esUrl)).text(), es);
  assert.equal(env.requests.includes(esUrl), false, 'an unchanged pack is reused across a release');
});

test('a device language is matched to a shipped one before anything is fetched', () => {
  const { matchLanguage, resolveLanguage } = loadTsx('frontend/src/lib/i18n/locale.ts');
  const shipped = ['en', 'es', 'pt-BR', 'zh-CN', 'zh-TW'];
  for (const [tag, expected] of [['es-MX', 'es'], ['pt-PT', 'pt-BR'], ['zh-Hant-HK', 'zh-TW'],
    ['zh-Hans-TW', 'zh-CN'], ['zh-HK', 'zh-TW'], ['zh', 'zh-CN'], ['EN_us', 'en'], ['ja', null], ['bad!', null], ['', null]]) {
    assert.equal(matchLanguage(tag, shipped), expected, tag);
  }
  assert.equal(matchLanguage('zh-TW', ['en', 'zh-CN']), null, 'a Traditional reader is not handed Simplified');
  assert.deepEqual(resolveLanguage('pt-BR', ['es-MX'], shipped), { language: 'pt-BR', auto: false });
  assert.deepEqual(resolveLanguage(null, ['xx', 'es-MX'], shipped), { language: 'es', auto: true });
  assert.deepEqual(resolveLanguage('ja', ['es-MX'], shipped), { language: 'es', auto: true },
    'a saved language Homeroom does not ship falls to the device');
  assert.deepEqual(resolveLanguage(null, ['xx'], shipped), { language: 'en', auto: true });
  assert.deepEqual(resolveLanguage(null, ['es-MX'], ['en']), { language: 'en', auto: true },
    'English only: every device gets English');
});

test('the build, the images and the server all know where the catalogs and packs are', () => {
  assert.match(read('frontend/scripts/build-shell.mjs'), /scripts\/language-packs\.js'\)\)\.buildLanguagePacks\(ROOT\)/);
  const stamp = read('scripts/shell-stamp.js');
  assert.match(stamp, /'frontend\/locales',/);
  assert.match(stamp, /'scripts\/language-packs\.js',/);
  assert.match(stamp, /if \(rel === GENERATED_CATALOGS\) return;/, 'an output is not a stamp input');
  for (const ignore of ['.gitignore', '.dockerignore']) {
    assert.match(read(ignore), /^public\/locales\/$/m, ignore);
    assert.match(read(ignore), /^frontend\/src\/lib\/i18n\/catalogs\.generated\.json$/m, ignore);
  }
  for (const dockerfile of ['Dockerfile', 'Dockerfile.kubernetes']) {
    const text = read(dockerfile);
    const copy = text.indexOf('COPY scripts/language-packs.js ./scripts/language-packs.js');
    assert.ok(copy > -1 && copy < text.indexOf('node frontend/scripts/build-shell.mjs'),
      `${dockerfile} gives the shell stage the builder before it runs`);
  }
  const image = read('Dockerfile');
  assert.ok(image.indexOf('COPY --from=shell /build/public/locales/ ./public/locales/')
    < image.indexOf('RUN node scripts/build-shell-release.js'), 'packs are in place before the release records them');
  assert.match(image, /COPY --from=shell \/build\/public\/locales\/ \/opt\/usernode-shell-assets\/locales\//);
  assert.match(read('scripts/restore-image-assets.js'), /\.\.\.emittedLanguagePacks\(\)/);
  assert.match(read('src/middleware/auth.js'), /^ {2}'\/locales\/',$/m, 'packs are readable on the sign-in screens');
});
