'use strict';

// SEC-06: a platform preview's database starts empty, so its translation
// cache is filled once from production's public export (GET
// /api/languages/cache, services/language-cache.js exportEntries; db/migrate.js
// seedStagingTranslations). The export carries the English each translation
// was made from, so a reworded message is not shown in its old translation;
// an import keeps what is already cached and skips anything malformed; and
// the preview boot asks production only in a preview, only once, and never
// fails over it. Against the real schema.
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
  await production.query(
    `INSERT INTO language_translations (language, namespace, key, source, text, model) VALUES
       ('es', 'shell', 'nav.home', $1, 'Inicio', 'model-a'),
       ('es', 'shell', 'nav.home', $2, 'Página principal', 'model-a'),
       ('ar', 'settings', 'title', $1, 'الإعدادات', 'model-b')`,
    [HASH('a'), HASH('b')]);

  const served = await cache.exportEntries(production);
  const exported = JSON.parse(served.body);
  assert.deepEqual(exported.entries, {
    es: { shell: { 'nav.home': { [HASH('a')]: 'Inicio', [HASH('b')]: 'Página principal' } } },
    ar: { settings: { title: { [HASH('a')]: 'الإعدادات' } } },
  }, 'every translation, under the English it was made from');
  assert.equal(await cache.exportEntries(production), served, 'served from memory again while the cache stands still');
  assert.deepEqual(JSON.parse(require('node:zlib').gunzipSync(served.gzip)), exported, 'kept gzipped too');
  // A moved cache is seen once the version is read again.
  await production.query(`INSERT INTO language_translations (language, namespace, key, source, text) VALUES ('es', 'shell', 'new', $1, 'Nuevo')`, [HASH('c')]);
  assert.equal(await cache.exportEntries(production), served, 'not before VERSION_TTL_MS');
  const moved = await cache.exportEntries(production, { now: Date.now() + cache.VERSION_TTL_MS + 1 });
  assert.equal(JSON.parse(moved.body).entries.es.shell.new[HASH('c')], 'Nuevo');
  await production.query(`DELETE FROM language_translations WHERE key = 'new'`);
  await cache.exportEntries(production, { now: Date.now() + 2 * (cache.VERSION_TTL_MS + 1) });

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
    [HASH('a')]);
  const added = await cache.importEntries(preview, {
    ...exported.entries,
    'not a tag; DROP TABLE x': { shell: { k: { [HASH('c')]: 'x' } } },
    fr: { shell: { k: { short: 'not a hash', [HASH('d')]: 42 } } },
  });
  assert.equal(added, 2);
  const rows = (await preview.query('SELECT language, key, source, text FROM language_translations ORDER BY language, source')).rows;
  assert.deepEqual(rows.map((r) => [r.language, r.key, r.source[0], r.text]), [
    ['ar', 'title', 'a', 'الإعدادات'], ['es', 'nav.home', 'a', 'Mine'], ['es', 'nav.home', 'b', 'Página principal'],
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
