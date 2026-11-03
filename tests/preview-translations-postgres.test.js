'use strict';

// SEC-06: a platform preview's database starts empty, so its translation
// cache is filled once from production's public export (GET
// /api/languages/cache, services/language-cache.js exportEntries; db/migrate.js
// seedStagingTranslations). The export carries the English each translation
// was made from, so a reworded message is not shown in its old translation,
// and only the running English's, so the never-pruned cache does not
// multiply it; an import keeps what is already cached and skips anything
// malformed; and the preview boot asks production only in a preview, only
// once, and never fails over it. Against the real schema.
//
// Run with: TEST_DATABASE_URL=... node --test tests/preview-translations-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Client, Pool } = require('pg');

const cache = require('../src/services/language-cache');
const { seedStagingTranslations } = require('../src/db/migrate');

const HASH = (c) => c.repeat(64);
const SHA = (text) => crypto.createHash('sha256').update(text).digest('hex');
// The running build's catalogs (public/locales/.source.json), as served.
const SOURCE = {
  files: {
    'config.json': { sourceLanguage: 'en', languages: { en: 'English', es: 'Español', ar: 'العربية' } },
    'en/shell.json': {
      'nav.home': { text: 'Home', description: 'The home tab' },
      'nav.items_one': { text: '{{count}} item', description: 'A count' },
      'nav.items_other': { text: '{{count}} items', description: 'A count' },
    },
    'en/settings.json': { title: { text: 'Settings', description: 'The settings title' } },
  },
};

test('a preview fills its translation cache from production\'s public export, once', {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  await admin.connect();
  const names = ['production', 'preview'].map((side) => `translations_${side}_${crypto.randomBytes(5).toString('hex')}`);
  const pools = [];
  t.after(async () => {
    for (const pool of pools) await pool.end();
    for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
  const [production, preview] = await Promise.all(names.map(async (name) => {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.href, max: 2 });
    pools.push(pool);
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
    return pool;
  }));
  const readSource = cache.readSource;
  cache.readSource = () => SOURCE;
  t.after(() => { cache.readSource = readSource; });
  await production.query(
    `INSERT INTO language_translations (language, namespace, key, source, text, model) VALUES
       ('es', 'shell', 'nav.home', $1, 'Inicio', 'model-a'),
       ('es', 'shell', 'nav.home', $2, 'Página principal', 'model-a'),
       ('es', 'shell', 'gone', $1, 'Ya no está', 'model-a'),
       ('es', 'shell', 'nav.items_many', $3, '{{count}} elementos', 'model-a'),
       ('ar', 'settings', 'title', $4, 'الإعدادات', 'model-b')`,
    [SHA('Home'), SHA('Start page'), SHA('{{count}} items'), SHA('Settings')]);

  const served = await cache.exportEntries(production);
  const exported = JSON.parse(served.body);
  assert.deepEqual(exported.entries, {
    es: { shell: { 'nav.home': { [SHA('Home')]: 'Inicio' }, 'nav.items_many': { [SHA('{{count}} items')]: '{{count}} elementos' } } },
    ar: { settings: { title: { [SHA('Settings')]: 'الإعدادات' } } },
  }, 'the running English\'s translations, under the English they were made from; an older wording and a retired key are left out');
  assert.equal(await cache.exportEntries(production), served, 'served from memory again while the cache stands still');
  assert.deepEqual(JSON.parse(require('node:zlib').gunzipSync(served.gzip)), exported, 'kept gzipped too');
  // A moved cache is seen once the version is read again, and built once.
  await production.query(`INSERT INTO language_translations (language, namespace, key, source, text) VALUES ('es', 'settings', 'title', $1, 'Ajustes')`, [SHA('Settings')]);
  assert.equal(await cache.exportEntries(production), served, 'not before VERSION_TTL_MS');
  const later = Date.now() + cache.VERSION_TTL_MS + 1;
  const [moved, again] = await Promise.all([1, 2].map(() => cache.exportEntries(production, { now: later })));
  assert.notEqual(moved, served);
  assert.equal(again, moved, 'one build at a time');
  assert.equal(JSON.parse(moved.body).entries.es.settings.title[SHA('Settings')], 'Ajustes');
  await production.query(`DELETE FROM language_translations WHERE language = 'es' AND namespace = 'settings'`);
  await cache.exportEntries(production, { now: later + cache.VERSION_TTL_MS + 1 });
  assert.deepEqual(cache.currentEntries({ es: { shell: { 'nav.home': { [SHA('Home')]: 'Inicio' } } } }, null), {},
    'a build without catalogs exports nothing');

  // Over HTTP: public, gzipped when the client takes it.
  const express = require('express');
  const poolPath = require.resolve('../src/db/pool');
  const savedPool = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => production } };
  delete require.cache[require.resolve('../src/routes/languages')];
  const app = express();
  app.use(require('../src/routes/languages').languageRoutes({}));
  if (savedPool) require.cache[poolPath] = savedPool; else delete require.cache[poolPath];
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/languages/cache`;
  const gz = await fetch(base, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.status, 200);
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  assert.deepEqual((await gz.json()).entries, exported.entries, 'fetch undoes the gzip');
  const plain = await fetch(base, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.deepEqual(JSON.parse(await plain.text()).entries, exported.entries);

  // What a preview already holds is kept; a malformed entry is skipped.
  await preview.query(
    `INSERT INTO language_translations (language, namespace, key, source, text) VALUES ('es', 'shell', 'nav.home', $1, 'Mine')`,
    [SHA('Home')]);
  const added = await cache.importEntries(preview, {
    ...exported.entries,
    'not a tag; DROP TABLE x': { shell: { k: { [HASH('c')]: 'x' } } },
    fr: { shell: { k: { short: 'not a hash', [HASH('d')]: 42 } } },
  });
  assert.equal(added, 2);
  const rows = (await preview.query('SELECT language, key, source, text FROM language_translations ORDER BY language, key')).rows;
  assert.deepEqual(rows.map((r) => [r.language, r.key, r.source, r.text]), [
    ['ar', 'title', SHA('Settings'), 'الإعدادات'], ['es', 'nav.home', SHA('Home'), 'Mine'],
    ['es', 'nav.items_many', SHA('{{count}} items'), '{{count}} elementos'],
  ]);

  // The boot's seed: only in a preview, only into an empty cache, from the
  // platform's public origin, and a failure only warns.
  const saved = { env: process.env.USERNODE_ENV, origin: process.env.USERNODE_PLATFORM_ORIGIN };
  t.after(() => {
    for (const [key, value] of [['USERNODE_ENV', saved.env], ['USERNODE_PLATFORM_ORIGIN', saved.origin]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const asked = [];
  const serve = (status = 200) => async (url, opts) => {
    asked.push({ url, redirect: opts?.redirect, bounded: !!opts?.signal });
    return { ok: status === 200, status, json: async () => exported };
  };
  await preview.query('TRUNCATE language_translations');
  process.env.USERNODE_PLATFORM_ORIGIN = 'https://platform.example';
  process.env.USERNODE_ENV = 'production';
  await seedStagingTranslations(preview, { fetchImpl: serve() });
  assert.deepEqual(asked, [], 'production never asks');
  process.env.USERNODE_ENV = 'staging';
  await seedStagingTranslations(preview, { fetchImpl: serve(503) });
  assert.equal((await preview.query('SELECT count(*)::int AS n FROM language_translations')).rows[0].n, 0, 'unreachable: English stands in');
  await seedStagingTranslations(preview, { fetchImpl: serve() });
  assert.deepEqual(asked.at(-1), { url: 'https://platform.example/api/languages/cache', redirect: 'error', bounded: true });
  assert.equal((await preview.query('SELECT count(*)::int AS n FROM language_translations')).rows[0].n, 3);
  const before = asked.length;
  await seedStagingTranslations(preview, { fetchImpl: serve() });
  assert.equal(asked.length, before, 'a cache already filled is not asked for again');
  process.env.USERNODE_PLATFORM_ORIGIN = 'http://platform.example/path';
  await preview.query('TRUNCATE language_translations');
  await seedStagingTranslations(preview, { fetchImpl: serve() });
  assert.equal(asked.length, before, 'only an https origin');
});
