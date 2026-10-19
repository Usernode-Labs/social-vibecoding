'use strict';

// Server errors, counted (platform signals, wave 2): each process's
// per-minute counts of the /api/ responses it answered and the 5xx among
// them (services/server-error-counts.js), the middleware that records each
// response as it finishes (middleware/request-counts.js) with what the
// error handler caught (middleware/error-handler.js), the flush and prune
// against a stub pool, and the `server_errors` observer that reads the
// counts back (services/signal-observers/server-errors.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const counts = require('../src/services/server-error-counts');
const { requestCounts } = require('../src/middleware/request-counts');
const { errorHandler } = require('../src/middleware/error-handler');
const observer = require('../src/services/signal-observers/server-errors');
const signals = require('../src/services/platform-signals');
const observers = require('../src/services/platform-signal-observers');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-19T10:00:00Z');

// ── Pure parts ──────────────────────────────────────────────────────────

test('a minute is its UTC start, and a process is its hostname cut to the column', () => {
  assert.equal(counts.minuteOf(T0 + 59_999), T0);
  assert.equal(counts.minuteOf(T0 + MIN), T0 + MIN);
  assert.equal(new Date(counts.minuteOf(Date.parse('2026-10-19T12:34:56.789+02:00'))).toISOString(), '2026-10-19T10:34:00.000Z');
  assert.equal(counts.podName({ HOSTNAME: 'homeroom-web-7c9f' }, () => 'mac'), 'homeroom-web-7c9f');
  assert.equal(counts.podName({}, () => 'mac'), 'mac');
  assert.equal(counts.podName({ HOSTNAME: 'x'.repeat(100) }).length, 64);
});

test('the route is the template Express declared, never the path requested', () => {
  const req = (route, baseUrl = '', extra = {}) => ({ route: route && { path: route }, baseUrl, ...extra });
  assert.equal(counts.routeTemplate(req('/api/apps/:slug/topics/:key/signals')), '/api/apps/:slug/topics/:key/signals');
  assert.equal(counts.routeTemplate(req('/turns/next', '/api/cli/agent')), '/api/cli/agent/turns/next');
  assert.equal(counts.routeTemplate(req(null)), '(unmatched)', 'no route matched');
  assert.equal(counts.routeTemplate({}), '(unmatched)');
  assert.equal(counts.routeTemplate(req(['/api/a', '/api/b'])), '/api/a|/api/b');
  // A mount path with a parameter would put the raw value in the base.
  assert.equal(counts.routeTemplate(req('/x', '/api/things/12345')), '/api/things/:id/x');
  assert.equal(counts.routeTemplate(req('/x', '/api/u/0b5e2a64-8c1f-4f7e-9d2a-0c3b6e1f2a7d')), '/api/u/:id/x');
  assert.equal(counts.routeTemplate(req('/api/v4/apps/:slug')), '/api/v4/apps/:slug', 'a named segment stays');
  assert.equal(counts.routeTemplate(req(`/api/${'z'.repeat(300)}`)).length, 160);
  // What the middleware kept as Express matched the route wins over a base
  // Express has restored since.
  assert.equal(counts.routeTemplate(req('/x/:n', '', { [counts.ROUTE_BASE]: '/api/mounted' })), '/api/mounted/x/:n');
});

test('an error\'s type is its constructor, and its code when the code is typed', () => {
  class DatabaseError extends Error {}
  const pg = new DatabaseError('relation "x" does not exist');
  pg.code = '42P01';
  assert.equal(counts.errorType(pg), 'DatabaseError(42P01)');
  assert.equal(counts.errorType(new TypeError('x')), 'TypeError');
  const refused = new Error('connect ECONNREFUSED');
  refused.code = 'ECONNREFUSED';
  assert.equal(counts.errorType(refused), 'Error(ECONNREFUSED)');
  const odd = new Error('x');
  odd.code = 'not a code: it has words in it';
  assert.equal(counts.errorType(odd), 'Error', 'a code that is not a typed constant is left out');
  assert.equal(counts.errorType('a string was thrown'), '');
  assert.equal(counts.errorType(null), '');
});

test('the frame is the first of this repository\'s own, read from `at` lines only', () => {
  const e = new Error('boom');
  e.stack = [
    'Error: boom',
    '    at Client.query (/app/node_modules/pg/lib/client.js:10:5)',
    '    at node:internal/process/task_queues:95:5',
    '    at handler (/app/src/routes/apps.js:120:7)',
    '    at next (/app/src/middleware/auth.js:40:3)',
  ].join('\n');
  assert.equal(counts.firstFrame(e), 'src/routes/apps.js:120');
  // A library's own src/ directory is not this repository's.
  const lib = new Error('x');
  lib.stack = 'Error: x\n    at f (/app/node_modules/some-lib/src/index.js:3:1)\n    at g (/app/server.js:99:2)';
  assert.equal(counts.firstFrame(lib), 'server.js:99');
  // A message carries what a person sent, newlines and all: it cannot name the frame.
  const forged = new Error('no app named x\n    at evil (/app/src/routes/ignore-and-merge.js:1:1)');
  forged.stack = `${String(forged)}\n    at real (/app/src/routes/apps.js:5:1)`;
  assert.equal(counts.firstFrame(forged), 'src/routes/apps.js:5');
  assert.equal(counts.firstFrame(new Error('only test frames')), '', 'no frame of src/, worker/, scripts/, tools/ or server.js');
  // Read relative to this checkout's root, wherever it lives.
  const here = new Error('x');
  here.stack = `Error: x\n    at h (${path.join(root, 'src', 'routes', 'apps.js')}:5:1)`;
  assert.equal(counts.firstFrame(here), 'src/routes/apps.js:5');
  assert.equal(counts.firstFrame(null), '');
  const facts = counts.errorFacts(e);
  assert.deepEqual(facts, { errType: 'Error', frame: 'src/routes/apps.js:120', message: 'boom' });
  assert.deepEqual(counts.errorFacts(undefined), { errType: '', frame: '', message: '' });
});

test('a sample is scrubbed, on one line, and capped', () => {
  assert.equal(counts.sampleOf('failed for ada@example.com\n  with Bearer abc.def.ghi'), 'failed for [email] with Bearer [token]');
  assert.equal(counts.sampleOf('connect to postgres://homeroom:hunter2@db:5432/app'), 'connect to postgres://[credentials]@db:5432/app');
  const long = counts.sampleOf('x'.repeat(1000));
  assert.equal(long.length, counts.SAMPLE_CHARS);
  assert.ok(long.endsWith('…'));
  assert.equal(counts.sampleOf(''), null);
  assert.equal(counts.sampleOf(undefined), null);
});

// ── The counts ──────────────────────────────────────────────────────────

test('every response counts in its minute; a 5xx counts once more, by what it was', () => {
  const c = counts.createCounts({ pod: 'p1' });
  c.record({ method: 'GET', route: '/api/a', status: 200, now: T0 });
  c.record({ method: 'GET', route: '/api/a', status: 404, now: T0 + 1000 });
  c.record({ method: 'get', route: '/api/a', status: 500, now: T0 + 2000, error: { errType: 'TypeError', frame: 'src/a.js:1', message: 'x is undefined for a@b.co' } });
  c.record({ method: 'GET', route: '/api/a', status: 500, now: T0 + 3000, error: { errType: 'TypeError', frame: 'src/a.js:1', message: 'second' } });
  c.record({ method: 'POST', route: '/api/b', status: 503, now: T0 + 4000 });
  c.record({ method: 'GET', route: '/api/a', status: 200, now: T0 + MIN });
  const [first, second] = c.snapshot();
  assert.equal(first.minute, T0);
  assert.equal(first.requests, 5);
  assert.equal(first.errors, 3);
  assert.deepEqual(first.details, [
    { method: 'GET', route: '/api/a', status: 500, errType: 'TypeError', frame: 'src/a.js:1', count: 2, sample: 'x is undefined for [email]' },
    { method: 'POST', route: '/api/b', status: 503, errType: '', frame: '', count: 1, sample: null },
  ], 'one row per method, route, status, type and frame; the first sample kept, scrubbed');
  assert.deepEqual([second.minute, second.requests, second.errors], [T0 + MIN, 1, 0]);
});

test('memory is capped: distinct errors per minute, and minutes held', () => {
  const c = counts.createCounts({ pod: 'p1', maxErrorKeys: 2, maxMinutes: 3 });
  for (const route of ['/api/a', '/api/b', '/api/c', '/api/d']) {
    c.record({ method: 'GET', route, status: 500, now: T0 });
  }
  c.record({ method: 'GET', route: '/api/a', status: 500, now: T0 });
  const [m] = c.snapshot();
  assert.equal(m.errors, 5, 'every error counts in the minute');
  assert.equal(m.details.length, 2, 'but only the first two distinct ones are kept');
  assert.equal(m.dropped, 2);
  assert.equal(m.details[0].count, 2, 'a kept one still counts');
  for (let i = 1; i <= 3; i += 1) c.record({ method: 'GET', route: '/api/a', status: 200, now: T0 + i * MIN });
  assert.deepEqual(c.snapshot().map((b) => b.minute), [T0 + MIN, T0 + 2 * MIN, T0 + 3 * MIN], 'the oldest minute goes');
});

function stubPool({ fail = () => null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const err = fail(sql, calls.length);
      if (err) throw err;
      return { rows: [], rowCount: 7 };
    },
  };
}

test('flush upserts the minutes that ended, adding to what is there, and keeps the current one', async () => {
  const c = counts.createCounts({ pod: 'homeroom-web-1' });
  c.record({ method: 'GET', route: '/api/a', status: 200, now: T0 });
  c.record({ method: 'GET', route: '/api/a', status: 500, now: T0 + 5000, error: { errType: 'TypeError', frame: 'src/a.js:1', message: 'm' } });
  c.record({ method: 'GET', route: '/api/a', status: 200, now: T0 + MIN + 1 });
  const pool = stubPool();
  const sent = await c.flush(pool, { now: T0 + MIN + 30_000 });
  assert.deepEqual(sent, { minutes: 1, errorRows: 1 });
  assert.equal(pool.calls.length, 2);
  const [totals, errors] = pool.calls;
  assert.equal(totals.sql, counts.REQUESTS_UPSERT_SQL);
  assert.match(totals.sql, /INSERT INTO server_request_minutes \(minute, pod, requests, errors\)/);
  assert.match(totals.sql, /ON CONFLICT \(minute, pod\) DO UPDATE\s+SET requests = server_request_minutes\.requests \+ EXCLUDED\.requests,\s+errors = server_request_minutes\.errors \+ EXCLUDED\.errors/);
  assert.deepEqual(totals.params, [['2026-10-19T10:00:00.000Z'], 'homeroom-web-1', [2], [1]]);
  assert.equal(errors.sql, counts.ERRORS_UPSERT_SQL);
  assert.match(errors.sql, /ON CONFLICT \(minute, pod, method, route, status, err_type, frame\) DO UPDATE\s+SET count = server_error_minutes\.count \+ EXCLUDED\.count/);
  assert.deepEqual(errors.params, [
    ['2026-10-19T10:00:00.000Z'], 'homeroom-web-1', ['GET'], ['/api/a'], [500], ['TypeError'], ['src/a.js:1'], [1], ['m'],
  ]);
  assert.deepEqual(c.snapshot().map((b) => b.minute), [T0 + MIN], 'the minute still going stays in memory');

  const idle = stubPool();
  assert.deepEqual(await c.flush(idle, { now: T0 + MIN + 40_000 }), { minutes: 0, errorRows: 0 });
  assert.equal(idle.calls.length, 0, 'nothing ended: no query');
  await c.flush(idle, { now: T0 + MIN + 40_000, all: true });
  assert.equal(idle.calls.length, 1, '`all` sends the current minute too (it had no errors: totals only)');
  assert.deepEqual(c.snapshot(), []);
});

test('a refused flush keeps its minutes for the next one, and never throws', async () => {
  const c = counts.createCounts({ pod: 'p1' });
  c.record({ method: 'GET', route: '/api/a', status: 500, now: T0 });
  const down = stubPool({ fail: () => new Error('connection refused') });
  assert.deepEqual(await c.flush(down, { now: T0 + 2 * MIN }), { minutes: 0, errorRows: 0 });
  assert.equal(down.calls.length, 1, 'the totals were refused, so the errors were not tried');
  assert.deepEqual(c.snapshot().map((b) => [b.requests, b.errors, b.details.length]), [[1, 1, 1]]);

  // The totals went in and the errors did not: next time only the errors go,
  // so the totals are not counted twice.
  const half = stubPool({ fail: (sql) => (sql === counts.ERRORS_UPSERT_SQL ? new Error('deadlock') : null) });
  assert.deepEqual(await c.flush(half, { now: T0 + 2 * MIN }), { minutes: 1, errorRows: 0 });
  assert.deepEqual(c.snapshot().map((b) => [b.requests, b.errors, b.details.length]), [[0, 0, 1]]);
  const up = stubPool();
  assert.deepEqual(await c.flush(up, { now: T0 + 2 * MIN }), { minutes: 0, errorRows: 1 });
  assert.deepEqual(up.calls.map((q) => q.sql), [counts.ERRORS_UPSERT_SQL]);
  assert.deepEqual(c.snapshot(), []);

  const throwsSync = { query() { throw new Error('pool ended'); } };
  c.record({ method: 'GET', route: '/api/a', status: 200, now: T0 });
  await assert.doesNotReject(c.flush(throwsSync, { now: T0 + 2 * MIN }));
  assert.deepEqual(await c.flush(null), { minutes: 0, errorRows: 0 });
});

test('prune removes rows older than 14 days from both tables, and never throws', async () => {
  const pool = stubPool();
  assert.deepEqual(await counts.prune(pool), { requests: 7, errors: 7 });
  assert.deepEqual(pool.calls.map((q) => q.sql), [counts.PRUNE_REQUESTS_SQL, counts.PRUNE_ERRORS_SQL]);
  assert.match(pool.calls[0].sql, /^DELETE FROM server_request_minutes WHERE minute < NOW\(\) - make_interval\(days => \$1\)$/);
  assert.match(pool.calls[1].sql, /^DELETE FROM server_error_minutes WHERE minute < NOW\(\) - make_interval\(days => \$1\)$/);
  assert.deepEqual(pool.calls.map((q) => q.params), [[14], [14]]);
  assert.equal(await counts.prune(stubPool({ fail: () => new Error('x') })), null);
});

// ── The middleware, in a real Express app ───────────────────────────────

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function buildApp(c) {
  const app = express();
  app.use(requestCounts({ counts: c }));
  app.use(express.json());
  app.get('/api/fine/:id', (_req, res) => res.json({ ok: true }));
  app.get('/api/apps/:slug/boom', () => {
    throw new TypeError('Cannot read properties of undefined (reading \'id\') for ada@example.com');
  });
  app.post('/api/answers-500', (_req, res) => res.status(500).json({ error: 'Could not save' }));
  const mounted = express.Router();
  mounted.get('/turns/:n', () => { throw new RangeError('no such turn'); });
  app.use('/api/mounted', mounted);
  app.use('/api/broken-middleware', () => { throw new Error('before any route'); });
  app.get('/page', (_req, res) => res.send('<p>not counted</p>'));
  app.use(errorHandler);
  return app;
}

async function settled(c, n) {
  // `finish` fires as the response is handed to the socket, which is before
  // the client has read it on most runs, but not by contract.
  for (let i = 0; i < 50; i += 1) {
    const total = c.snapshot().reduce((s, b) => s + b.requests, 0);
    if (total >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('the middleware counts /api/ responses by route template, and each 5xx by what was thrown', async () => {
  const c = counts.createCounts({ pod: 'p1' });
  const server = await listen(buildApp(c));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const fine = await fetch(`${base}/api/fine/42`);
    assert.equal(fine.status, 200);
    const boom = await fetch(`${base}/api/apps/my-app/boom`);
    assert.equal(boom.status, 500);
    assert.deepEqual(await boom.json(), { error: 'Internal server error' }, 'the answer is unchanged');
    const own = await fetch(`${base}/api/answers-500`, { method: 'POST' });
    assert.deepEqual(await own.json(), { error: 'Could not save' }, 'a route\'s own 500 is unchanged');
    assert.equal((await fetch(`${base}/api/mounted/turns/7`)).status, 500);
    assert.equal((await fetch(`${base}/api/broken-middleware/x`)).status, 500);
    assert.equal((await fetch(`${base}/api/nothing-here`)).status, 404);
    assert.equal((await fetch(`${base}/page`)).status, 200);
    await settled(c, 6);
  } finally {
    server.close();
  }
  const [m] = c.snapshot();
  assert.equal(m.requests, 6, 'every /api/ response, and nothing else');
  assert.equal(m.errors, 4);
  const byRoute = Object.fromEntries(m.details.map((d) => [`${d.method} ${d.route}`, d]));
  assert.deepEqual(Object.keys(byRoute).sort(), [
    'GET (unmatched)',
    'GET /api/apps/:slug/boom',
    'GET /api/mounted/turns/:n',
    'POST /api/answers-500',
  ]);
  const boom = byRoute['GET /api/apps/:slug/boom'];
  assert.equal(boom.errType, 'TypeError');
  assert.equal(boom.status, 500);
  assert.equal(boom.sample, 'Cannot read properties of undefined (reading \'id\') for [email]');
  assert.ok(!JSON.stringify(m.details).includes('my-app'), 'the raw path is never kept');
  assert.equal(byRoute['GET /api/mounted/turns/:n'].errType, 'RangeError',
    'an error thrown out of a mounted router keeps its route\'s prefix');
  assert.deepEqual(
    [byRoute['POST /api/answers-500'].errType, byRoute['POST /api/answers-500'].frame, byRoute['POST /api/answers-500'].sample],
    ['', '', null], 'a route that answers its own 500 is counted with no type or frame');
  assert.equal(byRoute['GET (unmatched)'].errType, 'Error', 'a middleware\'s throw is counted, unmatched');
});

test('the error handler leaves what it caught for a 5xx only', () => {
  const run = (err) => {
    const res = {
      headersSent: false, locals: {}, statusCode: 200,
      status(s) { this.statusCode = s; return this; },
      json() { return this; },
    };
    errorHandler(err, { method: 'GET', path: '/api/x' }, res, () => {});
    return res;
  };
  const fivexx = run(new TypeError('x'));
  assert.equal(fivexx.statusCode, 500);
  assert.equal(fivexx.locals.serverError.errType, 'TypeError');
  assert.equal(fivexx.locals.serverError.message, 'x');
  const parse = Object.assign(new SyntaxError('Unexpected token'), { status: 400 });
  assert.equal(run(parse).locals.serverError, undefined, 'a client\'s 4xx is not a server error');
});

// ── The observer ────────────────────────────────────────────────────────

const row = (over) => ({
  method: 'GET', route: '/api/apps/:slug/topics/:key/figures', status: 500, err_type: 'TypeError',
  frame: 'src/services/server-error-counts.js:10', last_hour: 2, last_day: 9,
  first_minute: '2026-10-19T08:00:00Z', last_minute: '2026-10-19T09:58:00Z',
  pods: ['web-a'], samples: ['x is undefined'], ...over,
});

test('the observer folds statuses into a class and files a route with at least 3 in the hour', async () => {
  const pool = stubPool();
  pool.query = async (sql) => {
    pool.calls.push({ sql });
    return { rows: [
      row({}),
      row({ status: 503, last_hour: 1, last_day: 1, first_minute: '2026-10-19T07:00:00Z', pods: ['web-b'], samples: ['other'] }),
      row({ route: '/api/sessions/:id/vote', method: 'POST', err_type: '', frame: '', last_hour: 2 }),
      row({ route: '/api/auth/phone/verify', method: 'POST', err_type: 'Error(ECONNREFUSED)', frame: 'src/nope/never.js:1', last_hour: 12, samples: null }),
    ] };
  };
  const items = await observer.run(pool);
  assert.match(pool.calls[0].sql, /FROM server_error_minutes/);
  assert.match(pool.calls[0].sql, /minute >= NOW\(\) - interval '24 hours'/);
  assert.match(pool.calls[0].sql, /FILTER \(WHERE minute >= NOW\(\) - interval '1 hour'\)/);
  assert.equal(items.length, 2, 'the vote route had 2 in the hour: a blip');
  const [auth, figures] = items;
  assert.equal(auth.occurrences, 12, 'the busiest first');
  assert.equal(auth.topic, 'onboarding');
  assert.deepEqual(auth.evidence.where, ['src/routes/phone-auth.js'],
    'a frame this checkout does not have is not sent; the route\'s own file is');
  assert.equal(auth.evidencePrivate, null);

  assert.equal(figures.kind, 'server_errors');
  assert.equal(figures.key, 'GET /api/apps/:slug/topics/:key/figures:TypeError:src/services/server-error-counts.js',
    'the frame\'s file, not its line: an edit above the throw is the same problem');
  assert.equal(figures.title, 'Server errors on GET /api/apps/:slug/topics/:key/figures: TypeError');
  assert.equal(figures.topic, 'infra');
  assert.equal(figures.occurrences, 3, '500 and 503 are one problem');
  assert.deepEqual(figures.evidence.where, ['src/services/server-error-counts.js:10', 'src/routes/topic-figures.js']);
  assert.deepEqual(figures.evidencePrivate, { samples: ['x is undefined', 'other'] });
  const lines = figures.evidence.lines.join('\n');
  assert.match(lines, /3 server errors in the last hour, 10 in the last 24 hours\./);
  assert.match(lines, /Statuses: 500, 503\./);
  assert.match(lines, /First in the last 24 hours at 2026-10-19T07:00Z, the last at 2026-10-19T09:58Z/);
  assert.match(lines, /From 2 processes in the last hour\./);
  assert.match(lines, /Error type: TypeError, thrown at src\/services\/server-error-counts\.js:10\./);

  // As the sweep takes it: whole, and nothing private in the public tier.
  const it = signals.normalizeItem(figures);
  assert.equal(it.fingerprint, `server_errors:${figures.key}`);
  assert.equal(it.fixer, 'bot');
  assert.ok(!JSON.stringify(it.evidence).includes('x is undefined'), 'the samples stay private');
});

test('a frame\'s line moving (a release between) is still one problem; a middleware\'s throw says so', () => {
  const groups = observer.groupRows([
    row({ frame: 'src/services/server-error-counts.js:10', last_hour: 1 }),
    row({ frame: 'src/services/server-error-counts.js:14', last_hour: 3 }),
    row({ frame: 'src/routes/apps.js:10', last_hour: 3 }),
  ]);
  assert.equal(groups.length, 2);
  const [moved] = groups.filter((g) => g.file === 'src/services/server-error-counts.js');
  assert.equal(moved.lastHour, 4);
  assert.deepEqual(moved.frames, ['src/services/server-error-counts.js:14', 'src/services/server-error-counts.js:10'],
    'the line most of the hour threw at first');
  assert.match(observer.itemOf(moved).evidence.lines.join('\n'),
    /thrown at src\/services\/server-error-counts\.js:14, src\/services\/server-error-counts\.js:10\./);

  const [mw] = observer.groupRows([row({ route: '(unmatched)', method: 'POST', err_type: 'Error', frame: '', last_hour: 3 })]);
  const item = observer.itemOf(mw);
  assert.equal(item.title, 'Server errors on POST before any route answered: Error');
  assert.match(item.evidence.lines.join('\n'), /No route matched: a middleware threw before one could\./);
  assert.equal(item.topic, 'infra');
});

test('a route that answers its own 500 says so, and its group is still one problem', () => {
  const [g] = observer.groupRows([row({ err_type: '', frame: '', last_hour: 4, samples: null })]);
  const item = observer.itemOf(g);
  assert.equal(item.title, 'Server errors on GET /api/apps/:slug/topics/:key/figures: 500');
  assert.match(item.evidence.lines.join('\n'), /answered the error itself \(a catch block\)/);
  assert.deepEqual(item.evidence.where, ['src/routes/topic-figures.js']);
  assert.deepEqual(observer.groupRows([row({ last_hour: 2 })]), [], 'under the threshold');
  assert.equal(observer.groupRows([row({ last_hour: 2 })], { min: 2 }).length, 1);
});

test('a route\'s errors go to the topic its prefix names, by whole segments', () => {
  assert.equal(observer.topicOf('/api/auth/phone/verify'), 'onboarding');
  assert.equal(observer.topicOf('/api/authors'), 'infra', 'a prefix is whole segments');
  assert.equal(observer.topicOf('/api/apps/:slug/first-version/live'), 'onboarding');
  assert.equal(observer.topicOf('/api/sessions/:id/vote'), 'proposal-pipeline');
  assert.equal(observer.topicOf('/api/apps/:slug/proposals'), 'proposal-pipeline');
  assert.equal(observer.topicOf('/api/admin/homeroom-bot/bench/runs'), 'homeroom-bot');
  assert.equal(observer.topicOf('/api/apps/:slug/topics/:key/figures'), 'infra');
  assert.equal(observer.topicOf('(unmatched)'), 'infra');
  for (const [prefix, topic] of observer.TOPIC_PREFIXES) {
    assert.ok(signals.TOPICS.includes(topic), `${prefix}: a real topic`);
  }
});

test('a frame names a real file of this checkout or nothing', () => {
  assert.equal(observer.realFrame('src/services/server-error-counts.js:12'), 'src/services/server-error-counts.js:12');
  assert.equal(observer.realFrame('server.js:1'), 'server.js:1');
  assert.equal(observer.realFrame('src/services/not-a-file.js:1'), null);
  assert.equal(observer.realFrame('src/../package.json:1'), null);
  assert.equal(observer.realFrame('src/services'), null);
  assert.equal(observer.realFrame(''), null);
});

test('the sweep runs this observer for its kind', async () => {
  const entry = observers.OBSERVERS.find((o) => o.kinds.includes('server_errors'));
  const pool = { query: async () => ({ rows: [row({ last_hour: 5 })] }) };
  const { items, ok } = await observers.observeAll(pool, { observers: [entry] });
  assert.ok(ok.has('server_errors'));
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'server_errors');
});

// ── Where the platform runs it ──────────────────────────────────────────

test('server.js counts every request, flushes on every process and prunes on the leader', () => {
  const src = read('server.js');
  const mount = src.indexOf("app.use(require('./src/middleware/request-counts').requestCounts());");
  assert.ok(mount > 0, 'the middleware is mounted');
  assert.ok(src.indexOf('app.use(inflightRequests.inflightRequests());') < mount, 'after the in-flight count');
  for (const later of ['app.use(responseCompression());', 'app.use(authMiddleware(config));', 'app.use(appRoutes(config));', 'app.use(errorHandler);']) {
    assert.ok(mount < src.indexOf(later), `ahead of ${later}`);
  }
  const startBody = src.slice(src.indexOf('async function start()'), src.indexOf('// Boot only when run as the entry point'));
  assert.match(startBody, /require\('\.\/src\/services\/server-error-counts'\)\.start\(\{ pool: getPool\(config\) \}\);/,
    'every process flushes its own counts');
  const leader = src.slice(src.indexOf('async function becomeLeader()'), src.indexOf('async function start()'));
  assert.match(leader, /leaderTimers\.every\('server-error-prune', [\s\S]*?24 \* 60 \* 60 \* 1000, \{ durable: getPool\(config\) \}\);/,
    'the leader prunes daily on the durable clock');
  const handler = read('src/middleware/error-handler.js');
  assert.match(handler, /if \(status >= 500 && res\.locals\) res\.locals\.serverError = errorFacts\(err\);/);
});

test('the flush timer is unref\'d and starts once', () => {
  const real = global.setInterval;
  const made = [];
  global.setInterval = (fn, ms) => {
    const h = { fn, ms, unrefed: false, unref() { this.unrefed = true; return this; } };
    made.push(h);
    return h;
  };
  try {
    counts.start({ pool: stubPool() });
    counts.start({ pool: stubPool() });
  } finally {
    global.setInterval = real;
    counts.stop();
  }
  assert.equal(made.length, 1);
  assert.equal(made[0].ms, counts.FLUSH_INTERVAL_MS);
  assert.equal(made[0].unrefed, true);
});
