'use strict';

// A server error in the reader's language: `error_message`, beside an `error`
// that stays exactly as the handler wrote it. The catalog is
// frontend/locales/en/errors.json, the lookup is the push's
// (src/services/push-language.js), the hook is src/middleware/error-language.js,
// and frontend/locales/README.md, "A server's error", says what it is for.
//
// test:changed: always (client sources that may read error_message)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { hash, isServerNamespace, parameters } = require('../scripts/language-packs');
const { errorLanguage } = require('../src/middleware/error-language');
const { errorHandler } = require('../src/middleware/error-handler');
const pushLanguage = require('../src/services/push-language');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const ENGLISH = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/errors.json'), 'utf8'));
const SPANISH = 'Error interno del servidor';
const INTERNAL = 'Internal server error';
const KEY = 'general.internal';

function sourceWith(committed = {}) {
  return {
    files: {
      'config.json': { sourceLanguage: 'en', languages: { en: 'English', es: 'Español', ru: 'Русский' } },
      'glossary.json': { doNotTranslate: ['Homeroom'] },
      'en/errors.json': ENGLISH,
      'es/errors.json': committed,
    },
  };
}
const translatedSource = () => sourceWith({ [KEY]: { text: SPANISH, source: hash(INTERNAL) } });

/** A pool whose language_translations holds `rows`; counts the reads. */
function poolWith(rows = [], { fail = null, hang = false } = {}) {
  const pool = {
    reads: 0,
    query: async () => {
      pool.reads += 1;
      if (hang) return new Promise(() => {});
      if (fail) throw fail;
      return { rows };
    },
  };
  return pool;
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 5); });

/** Serves `routes(app)` behind the hook, as server.js mounts it, with `user` set after the hook as auth does. */
async function serve(t, routes, { pool = poolWith(), source = translatedSource(), user, hook = true, now } = {}) {
  pushLanguage.reset();
  const readSource = typeof source === 'function' ? source : () => source;
  const app = express();
  if (hook) app.use(errorLanguage(() => pool, { readSource, now }));
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  routes(app);
  app.use(errorHandler);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    pool,
    get: async (where = '/', language = 'es') => {
      const res = await fetch(url + where, { headers: language ? { 'Accept-Language': language } : { 'Accept-Language': '' } });
      return { status: res.status, text: await res.text(), vary: res.headers.get('vary') };
    },
  };
}

const answers = (status, body) => (app) => app.get('/', (_req, res) => res.status(status).json(body));

/** Asks twice: the first question for a language starts the read and is answered in English. */
async function warmed(served, where, language) {
  await served.get(where, language);
  await settle();
  return served.get(where, language);
}

// ── The catalog ─────────────────────────────────────────────────────────

test('the catalog is the allowlist: whole, fixed, people-facing sentences the server really says', () => {
  const entries = Object.values(ENGLISH);
  assert.ok(entries.length >= 15 && entries.length <= 40, `about 15 to 40 entries, found ${entries.length}`);
  assert.equal(new Set(entries.map((entry) => entry.text)).size, entries.length, 'one entry per sentence');
  assert.ok(isServerNamespace('errors'), 'no screen reads it, so it has no pack');
  const sources = [];
  const walk = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) walk(file);
      else if (/\.(js|ts)$/.test(item.name)) sources.push(fs.readFileSync(file, 'utf8'));
    }
  };
  walk(path.join(ROOT, 'src'));
  const all = sources.join('\n');
  for (const { text } of entries) {
    assert.deepEqual(parameters(text), [], `no dynamic data: ${text}`);
    assert.doesNotMatch(text, /^[a-z]+(_[a-z]+)+$/, `a code is not a sentence: ${text}`);
    assert.doesNotMatch(text, /\badmin\b/i, `an admin's sentence stays English: ${text}`);
    assert.ok(all.includes(text), `nothing in src/ says: ${text}`);
  }
});

// ── error_message beside error ──────────────────────────────────────────

test('a listed error gets error_message beside an unchanged error, with every other field and the status', async (t) => {
  const served = await serve(t, answers(500, { error: INTERNAL, code: 'x', n: 1 }));
  const res = await warmed(served);
  assert.equal(res.status, 500);
  assert.equal(res.text, JSON.stringify({ error: INTERNAL, code: 'x', n: 1, error_message: SPANISH }));
  assert.match(res.vary, /Accept-Language/);
});

test('the cache\'s translation of exactly this English is used, and of older English is not', async (t) => {
  const rows = [{ key: KEY, source: hash(INTERNAL), text: 'De la caché' }];
  const fresh = await serve(t, answers(500, { error: INTERNAL }), { pool: poolWith(rows), source: sourceWith() });
  assert.equal(JSON.parse((await warmed(fresh)).text).error_message, 'De la caché');
  const old = [{ key: KEY, source: hash('Older words'), text: 'Vieja' }];
  const stale = await serve(t, answers(500, { error: INTERNAL }), { pool: poolWith(old), source: sourceWith() });
  assert.equal((await warmed(stale)).text, JSON.stringify({ error: INTERNAL }));
});

test('an error the error handler answers from a throw gets it too', async (t) => {
  const served = await serve(t, (app) => app.get('/', () => { throw new Error('boom'); }));
  const res = await warmed(served);
  assert.equal(res.status, 500);
  assert.equal(res.text, JSON.stringify({ error: INTERNAL, error_message: SPANISH }));
});

test('res.send of an object passes through res.json, so it gets it too', async (t) => {
  const served = await serve(t, (app) => app.get('/', (_req, res) => res.status(500).send({ error: INTERNAL })));
  assert.equal(JSON.parse((await warmed(served)).text).error_message, SPANISH);
});

test('Settings wins over the browser, and the hook sees the req.user auth set after it was mounted', async (t) => {
  const settings = await serve(t, answers(500, { error: INTERNAL }), { user: { id: 1, locale: 'es' } });
  assert.equal(JSON.parse((await warmed(settings, '/', 'ru')).text).error_message, SPANISH);
  const english = await serve(t, answers(500, { error: INTERNAL }), { user: { id: 1, locale: 'en' } });
  assert.equal((await warmed(english, '/', 'es')).text, JSON.stringify({ error: INTERNAL }));
  const unset = await serve(t, answers(500, { error: INTERNAL }), { user: { id: 1, locale: null } });
  assert.equal(JSON.parse((await warmed(unset, '/', 'es')).text).error_message, SPANISH);
});

// ── No key ──────────────────────────────────────────────────────────────

test('no key at all in English, with no language, or where the language has none', async (t) => {
  const body = JSON.stringify({ error: INTERNAL });
  const pool = poolWith();
  const served = await serve(t, answers(500, { error: INTERNAL }), { pool });
  for (const language of ['en', 'en-GB,es;q=0.5', null, 'xx']) {
    const res = await warmed(served, '/', language);
    assert.equal(res.text, body, String(language));
    assert.equal(res.vary, null, 'no change to the headers either');
  }
  assert.equal(pool.reads, 0, 'English reads nothing');
  const noTranslation = await serve(t, answers(500, { error: INTERNAL }), { source: sourceWith() });
  assert.equal((await warmed(noTranslation, '/', 'es')).text, body);
  const other = await serve(t, answers(500, { error: INTERNAL }));
  assert.equal((await warmed(other, '/', 'ru')).text, body, 'Russian has no translation in this source');
});

test('a sentence not on the list goes out byte for byte, and looks nothing up', async (t) => {
  const reads = { source: 0 };
  const pool = poolWith();
  const served = await serve(t, (app) => {
    app.get('/near', (_req, res) => res.status(404).json({ error: 'internal server error' }));
    app.get('/code', (_req, res) => res.status(400).json({ error: 'not_found' }));
    app.get('/first', (_req, res) => res.status(400).json({ error: 'Nope' }));
    app.get('/object', (_req, res) => res.status(400).json({ error: { message: INTERNAL } }));
  }, { pool, source: () => { reads.source += 1; return translatedSource(); } });
  await served.get('/first');
  const after = reads.source;
  assert.equal((await served.get('/near')).text, JSON.stringify({ error: 'internal server error' }));
  assert.equal((await served.get('/code')).text, JSON.stringify({ error: 'not_found' }));
  assert.equal((await served.get('/object')).text, JSON.stringify({ error: { message: INTERNAL } }));
  await settle();
  assert.equal(pool.reads, 0);
  assert.equal(reads.source, after, 'the English is read once, and a miss costs only the Map');
});

test('a route\'s own error_message is left as it wrote it', async (t) => {
  const served = await serve(t, answers(500, { error: INTERNAL, error_message: 'mine' }));
  assert.equal((await warmed(served)).text, JSON.stringify({ error: INTERNAL, error_message: 'mine' }));
});

test('success looks nothing up, even with an error field on the list', async (t) => {
  const reads = { source: 0 };
  const pool = poolWith();
  const served = await serve(t, (app) => {
    app.get('/ok', (_req, res) => res.json({ ok: true }));
    app.get('/listed', (_req, res) => res.json({ error: INTERNAL }));
    app.get('/redirect', (_req, res) => res.status(304).json({ error: INTERNAL }));
  }, { pool, source: () => { reads.source += 1; return translatedSource(); } });
  assert.equal((await served.get('/ok')).text, JSON.stringify({ ok: true }));
  assert.equal((await served.get('/listed')).text, JSON.stringify({ error: INTERNAL }));
  await served.get('/redirect');
  await settle();
  assert.equal(pool.reads, 0);
  assert.equal(reads.source, 0, 'the source is not even looked at');
});

test('a body that is not a plain object goes out as it is', async (t) => {
  class Oops { constructor() { this.error = INTERNAL; } }
  const named = Object.assign([1], { error: INTERNAL });
  const bodies = { string: 'text', number: 5, nothing: null, list: [INTERNAL], named, instance: new Oops(), oops: new Error(INTERNAL) };
  const pool = poolWith();
  const with_ = await serve(t, (app) => {
    for (const [name, body] of Object.entries(bodies)) app.get(`/${name}`, (_req, res) => res.status(500).json(body));
  }, { pool });
  const without = await serve(t, (app) => {
    for (const [name, body] of Object.entries(bodies)) app.get(`/${name}`, (_req, res) => res.status(500).json(body));
  }, { hook: false });
  for (const name of Object.keys(bodies)) {
    assert.equal((await with_.get(`/${name}`)).text, (await without.get(`/${name}`)).text, name);
  }
  assert.equal(pool.reads, 0);
});

// ── It can never cost the answer ────────────────────────────────────────

test('a failed lookup sends the original body with its status', async (t) => {
  const body = JSON.stringify({ error: INTERNAL });
  const failed = await serve(t, answers(503, { error: INTERNAL }), { pool: poolWith([], { fail: new Error('down') }), source: sourceWith() });
  let res = await warmed(failed);
  assert.equal(res.status, 503);
  assert.equal(res.text, body);

  const noPool = errorLanguage(() => { throw new Error('no pool'); }, { readSource: translatedSource });
  const app = express();
  app.use(noPool);
  app.get('/', (_req, res_) => res_.status(500).json({ error: INTERNAL }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  res = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { 'Accept-Language': 'es' } });
  assert.equal(res.status, 500);
  assert.equal(await res.text(), body);

  const broken = await serve(t, answers(500, { error: INTERNAL }), { source: () => { throw new Error('no source'); } });
  assert.equal((await broken.get()).text, body);

  const throwing = await serve(t, (app_) => app_.get('/', (_req, res_) => res_.status(500).json({
    get error() { throw new Error('getter'); },
    toJSON() { return { error: INTERNAL }; },
  })));
  assert.equal((await throwing.get()).text, body, 'a body that throws when read is not this hook\'s to break');
});

test('a database that does not answer does not hold the response', async (t) => {
  const pool = poolWith([], { hang: true });
  const served = await serve(t, answers(500, { error: INTERNAL }), { pool, source: sourceWith() });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await served.get()).text, JSON.stringify({ error: INTERNAL }));
  }
  assert.equal(pool.reads, 1, 'and one read at a time');
});

test('res.json stays synchronous: the headers are out when it returns, and a second call fails as it always did', async (t) => {
  const seen = {};
  const served = await serve(t, (app) => app.get('/', (_req, res) => {
    const returned = res.status(500).json({ error: INTERNAL });
    seen.headersSent = res.headersSent;
    seen.same = returned === res;
    try { res.status(502).json({ error: 'second' }); } catch (err) { seen.second = err.code; }
  }));
  const first = await served.get();
  await settle();
  const second = await served.get();
  assert.equal(seen.headersSent, true);
  assert.equal(seen.same, true);
  assert.equal(seen.second, 'ERR_HTTP_HEADERS_SENT');
  assert.equal(first.status, 500);
  assert.equal(second.status, 500);
  assert.equal(JSON.parse(second.text).error_message, SPANISH);
});

test('words past their minute are still used while one fresh read runs behind them', async (t) => {
  let now = 1_000_000;
  const rows = [{ key: KEY, source: hash(INTERNAL), text: 'Primera' }];
  const pool = poolWith(rows);
  const served = await serve(t, answers(500, { error: INTERNAL }), { pool, source: sourceWith(), now: () => now });
  assert.equal(JSON.parse((await warmed(served)).text).error_message, 'Primera');
  rows[0] = { ...rows[0], text: 'Segunda' };
  now += 61_000;
  assert.equal(JSON.parse((await served.get()).text).error_message, 'Primera');
  await settle();
  assert.equal(JSON.parse((await served.get()).text).error_message, 'Segunda');
  assert.equal(pool.reads, 2);
});

test('errors and pushes are kept apart in the shared lookup', async () => {
  pushLanguage.reset();
  const pool = poolWith([{ key: KEY, source: hash(INTERNAL), text: 'Error' }]);
  await pushLanguage.messagesFor(pool, 'es', sourceWith(), 1000, 'errors');
  const reads = pool.reads;
  await pushLanguage.pushTranslator(pool, 'es', { source: sourceWith(), now: 1000 });
  assert.equal(pool.reads, reads + 1, 'the push namespace has its own read');
  pushLanguage.reset();
});

// ── Where it is mounted ─────────────────────────────────────────────────

test('server.js mounts it once, ahead of every route and of auth', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const mounts = server.match(/app\.use\(require\('\.\/src\/middleware\/error-language'\)/g) || [];
  assert.equal(mounts.length, 1);
  const hook = server.indexOf("require('./src/middleware/error-language')");
  assert.ok(hook < server.indexOf('app.use(mobileAppLinkRoutes'), 'ahead of the first router');
  assert.ok(hook < server.indexOf('app.use(authMiddleware(config))'), 'ahead of auth');
  assert.ok(hook < server.indexOf('app.use(errorHandler)'), 'ahead of the error handler');
});

// ── The client ──────────────────────────────────────────────────────────

const clientFiles = () => {
  const found = [];
  const walk = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) { if (item.name !== 'node_modules') walk(file); } else if (/\.(js|jsx|ts|tsx)$/.test(item.name)) found.push(file);
    }
  };
  walk(path.join(ROOT, 'frontend/src'));
  walk(path.join(ROOT, 'public/js'));
  return found.filter((file) => !file.endsWith('.generated.json'));
};
const HELPER = 'frontend/src/lib/i18n/server-error.ts';

test('errorText prefers error_message, for showing, and is otherwise the error', () => {
  const { errorText } = loadTsx(HELPER);
  assert.equal(errorText({ error: 'English', error_message: 'Español' }), 'Español');
  assert.equal(errorText({ error: 'English' }), 'English');
  assert.equal(errorText({ error: 'English', error_message: '' }), 'English');
  assert.equal(errorText({ error: 'English', error_message: 5 }), 'English');
  for (const nothing of [null, undefined, {}, 'text', 5, { error: 5 }]) assert.equal(errorText(nothing), '');
});

test('only the helper reads error_message, and no client code compares what it returns', () => {
  const comparing = /errorText\([^)]*\)\s*(?:===|!==|==|!=|\.includes|\.match|\.startsWith|\.endsWith|\.test)|(?:===|!==)\s*(?:\w+\.)?errorText\(|\.test\(\s*(?:\w+\.)?errorText\(/;
  for (const file of clientFiles()) {
    const relative = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    if (relative !== HELPER) assert.doesNotMatch(text, /error_message/, `${relative} reads error_message itself`);
    assert.doesNotMatch(text, comparing, `${relative} compares a display string`);
  }
});

test('the admin console keeps its English', () => {
  for (const file of clientFiles()) {
    const relative = path.relative(ROOT, file);
    if (!/(^|\/)(admin|dev-console)[-/.]/.test(relative)) continue;
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\berrorText\(/, relative);
  }
});

test('the comparisons still read error', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/js/app-view.js'), 'utf8');
  assert.match(app, /data\.error === 'proposal_not_ready'/);
  const chat = fs.readFileSync(path.join(ROOT, 'frontend/src/features/dev-chat/dev-chat.js'), 'utf8');
  assert.match(chat, /\/active session not found\/i\.test\(peek\?\.error/);
  assert.match(chat, /\/busy\/i\.test\(String\(data\.error/);
});
