'use strict';

// A topic's open problems: what the platform found wrong on its own and
// filed as requests, listed under the topic's figures
// (routes/topic-figures.js GET /api/apps/:slug/topics/:key/signals,
// topic-signals.tsx). Pinned here:
//
//   * the route: the app's own view rule, 404 for an unknown app or topic,
//     none for a retired topic (without asking the service), the service's
//     list for a live one, private and never cached, and the admin
//     console's section only for a full admin (is_admin and not
//     admin_readonly), whatever the service sends;
//   * the section as it renders: nothing for an empty list or before the
//     list arrives, otherwise the label over a card of rows, each saying who
//     has it and since when, opening its request, and a full admin's
//     Details link to the console;
//   * where it is mounted: after the figures, before the room, so the
//     channel's declared check still finds the figures beside the line;
//   * its words are catalog entries.
//
// The service is stubbed: services/platform-signals.js is pinned by its own
// suite, and the route is required here before any database exists.
//
// Run with: node --test tests/topic-signals.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const express = require('express');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ── The route, against stubs ─────────────────────────────────────────────

// The registry row each topic key answers with; a key not here is unknown.
const TOPICS = {
  infra: { topic_state: 'live', topic_figures: [] },
  old: { topic_state: 'archived', topic_figures: [] },
  gone: { topic_state: 'merged', topic_figures: [] },
};
const APP = { id: 77, slug: 'usernode-2d5619' };

const queries = [];
const fakePool = {
  async query(sql, params) {
    queries.push({ sql: String(sql), params });
    if (/FROM app_category_registry/.test(sql)) {
      const row = params[0] === APP.id ? TOPICS[params[1]] : null;
      return { rows: row ? [row] : [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
};

// The route destructures getPool when it loads, so the pool is swapped first.
require('../src/db/pool').getPool = () => fakePool;

const accessCalls = [];
const appAccess = require('../src/services/app-access');
appAccess.getAppForUser = async (_pool, slug, user, level) => {
  accessCalls.push({ slug, user, level });
  return slug === APP.slug ? { ...APP } : null;
};

// services/platform-signals.js, as the route requires it.
const serviceCalls = [];
let serviceAnswer = async () => ({ signals: [] });
const signalsStub = {
  openForTopic: async (pool, opts) => {
    serviceCalls.push({ pool, opts });
    return serviceAnswer(opts);
  },
};
const originalLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (request === '../services/platform-signals' && parent && /src[\\/]routes[\\/]topic-figures\.js$/.test(parent.filename)) {
    return signalsStub;
  }
  return originalLoad.call(this, request, parent, ...rest);
};

const { topicFiguresRoutes } = require('../src/routes/topic-figures');

const SIGNALS = [
  {
    id: 4,
    kind: 'release_stalled',
    title: 'Release stalled: the deploy workflow failed',
    whoText: 'Homeroom bot is on it',
    who: 'bot',
    state: 'open',
    since: '2026-10-19T08:00:00.000Z',
    lastSeen: '2026-10-19T10:00:00.000Z',
    occurrences: 4,
    issueNumber: 5512,
    adminSection: 'workflows',
  },
  {
    id: 9,
    kind: 'limits_filled',
    title: 'Project limits keep filling',
    whoText: 'Waiting on infra',
    who: 'infra',
    state: 'clearing',
    since: '2026-10-18T08:00:00.000Z',
    lastSeen: '2026-10-19T06:00:00.000Z',
    occurrences: 1,
    issueNumber: null,
    adminSection: 'limits',
  },
];

let server = null;
let viewer = null;

async function start() {
  if (server) return;
  const app = express();
  app.use((req, _res, next) => { req.user = viewer; next(); });
  app.use(topicFiguresRoutes({}));
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

async function get(p, user) {
  await start();
  viewer = user;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps${p}`);
  return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
}

test.after(() => {
  Module._load = originalLoad;
  if (server) server.close();
});

const MEMBER = { id: 3, username: 'maya', isAdmin: false, adminReadonly: false, canAdminWrite: false };
const VIEW_ONLY_ADMIN = { id: 4, username: 'ora', isAdmin: true, adminReadonly: true, canAdminWrite: false };
const FULL_ADMIN = { id: 5, username: 'evan', isAdmin: true, adminReadonly: false, canAdminWrite: true };

test('an unknown app or topic is not found, and the app is read by its view rule', async () => {
  serviceCalls.length = 0;
  accessCalls.length = 0;
  const app = await get('/nowhere/topics/infra/signals', MEMBER);
  assert.equal(app.status, 404);
  assert.deepEqual(app.body, { error: 'App not found' });
  assert.deepEqual(accessCalls.map((c) => [c.slug, c.level, c.user.id]), [['nowhere', 'view', 3]]);
  const topic = await get(`/${APP.slug}/topics/nowhere/signals`, MEMBER);
  assert.equal(topic.status, 404);
  assert.deepEqual(topic.body, { error: 'Topic not found' });
  assert.deepEqual(queries.at(-1).params, [APP.id, 'nowhere'], 'the same registry read as the figures');
  assert.equal(serviceCalls.length, 0, 'the service is not asked about what does not exist');
});

test('a retired topic has no open problems, and the service is not asked', async () => {
  serviceCalls.length = 0;
  for (const key of ['old', 'gone']) {
    const res = await get(`/${APP.slug}/topics/${key}/signals`, FULL_ADMIN);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { topic: key, signals: [] });
    assert.equal(res.cache, 'private, no-store');
  }
  assert.equal(serviceCalls.length, 0);
});

test('a live topic answers the service\'s list, private and never cached', async () => {
  serviceCalls.length = 0;
  serviceAnswer = async () => ({ signals: SIGNALS });
  const res = await get(`/${APP.slug}/topics/infra/signals`, FULL_ADMIN);
  assert.equal(res.status, 200);
  assert.equal(res.cache, 'private, no-store');
  assert.deepEqual(res.body, { topic: 'infra', signals: SIGNALS });
  assert.equal(serviceCalls.length, 1);
  assert.equal(serviceCalls[0].pool, fakePool);
  assert.deepEqual(serviceCalls[0].opts, { appId: APP.id, topicKey: 'infra', fullAdmin: true });
});

test('only a full admin is a full admin: a member and a view-only admin are not, and get no console section', async () => {
  serviceAnswer = async () => ({ signals: SIGNALS });
  for (const user of [MEMBER, VIEW_ONLY_ADMIN]) {
    serviceCalls.length = 0;
    const res = await get(`/${APP.slug}/topics/infra/signals`, user);
    assert.equal(res.status, 200);
    assert.equal(serviceCalls[0].opts.fullAdmin, false, user.username);
    // Even when the service sends one, the route sends no door.
    assert.deepEqual(res.body.signals.map((s) => s.adminSection), [null, null], user.username);
    assert.deepEqual(res.body.signals.map((s) => s.title), SIGNALS.map((s) => s.title));
  }
  serviceCalls.length = 0;
  await get(`/${APP.slug}/topics/infra/signals`, undefined);
  assert.equal(serviceCalls[0].opts.fullAdmin, false, 'nobody signed in');
});

test('a service with nothing to say, or one that fails, costs the channel nothing more than the section', async () => {
  serviceAnswer = async () => ({});
  assert.deepEqual((await get(`/${APP.slug}/topics/infra/signals`, MEMBER)).body, { topic: 'infra', signals: [] });
  serviceAnswer = async () => { throw new Error('relation "platform_signals" does not exist'); };
  const failed = await get(`/${APP.slug}/topics/infra/signals`, MEMBER);
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: 'Failed to load the open problems' });
  serviceAnswer = async () => ({ signals: [] });
});

test('the service is required where it is used, so the figures answer without it', () => {
  const src = read('src/routes/topic-figures.js');
  assert.doesNotMatch(src.slice(0, src.indexOf('function topicFiguresRoutes')), /platform-signals'\)/);
  assert.match(src, /router\.get\('\/api\/apps\/:slug\/topics\/:key\/signals'[\s\S]*?const platformSignals = require\('\.\.\/services\/platform-signals'\);[\s\S]*?const fullAdmin = !!req\.user\?\.canAdminWrite;/);
});

// ── The section, rendered ────────────────────────────────────────────────

const SECTION = 'frontend/src/features/dev-board/workshop/topic-signals.tsx';
const HOURS = 60 * 60 * 1000;

function section(signals, slug = APP.slug) {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { TopicSignalsView } = loadTsx(SECTION);
  return renderToHtml(createElement(TopicSignalsView, { slug, handle: 'infra', signals }));
}

function fresh() {
  const now = Date.now();
  return [
    { ...SIGNALS[0], since: new Date(now - 3 * HOURS).toISOString() },
    { ...SIGNALS[1], since: new Date(now - 30 * HOURS).toISOString() },
  ];
}

test('an empty list draws nothing, and nothing is drawn before the list arrives', () => {
  assert.equal(section([]), '');
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { TopicSignals } = loadTsx(SECTION);
  const topic = { id: 1, kind: 'topic', key: 'infra', handle: 'infra', aliases: [], name: 'Infra', about: '', icon: '', state: 'live', merged_into: null, merged_at: null, requests: 0, unread: 0 };
  assert.equal(renderToHtml(createElement(TopicSignals, { slug: APP.slug, topic })), '', 'the first render is empty: the list is read in an effect');
  const src = read(SECTION);
  assert.match(src, /if \(!live \|\| !signals \|\| !signals\.length\) return null;/);
  assert.match(src, /if \(!signals\.length\) return null;/);
});

test('the section: its label over a card, a row per problem saying who has it, since when and how often', () => {
  const html = section(fresh());
  assert.match(html, /^<section class="[^"]*" data-topic-signals="infra" aria-label="Open problems"><h2 class="[^"]*">Open problems<\/h2>/);
  assert.deepEqual([...html.matchAll(/data-topic-signal="(\d+)" data-topic-signal-kind="([^"]+)" data-topic-signal-state="([^"]+)"/g)].map((m) => [m[1], m[2], m[3]]),
    [['4', 'release_stalled', 'open'], ['9', 'limits_filled', 'clearing']]);
  const [first, second] = html.split('data-topic-signal="').slice(1);
  // A row with a request opens it, by its title's link.
  assert.match(first, /<a href="#app\/usernode-2d5619\/dev\/issues\/5512" class="[^"]*after:absolute[^"]*" data-topic-signal-issue="5512">Release stalled: the deploy workflow failed<\/a>/);
  assert.match(first, />Homeroom bot is on it · <time dateTime="[^"]+" title="[^"]+">first seen 3h ago<\/time> · 4 times</);
  // Stopped and waiting says so in place of when; once is not said at all.
  assert.match(second, />Project limits keep filling</);
  assert.doesNotMatch(second, /dev\/issues/, 'no request yet: nothing to open');
  assert.match(second, />Waiting on infra · Stopped, waiting to be sure</);
  assert.doesNotMatch(second, /first seen|times/);
  // No status dot and no pill on any row.
  assert.doesNotMatch(html, /rounded-full/);
});

test('a full admin\'s rows link to the admin console\'s section; nobody else\'s do', () => {
  const html = section(fresh());
  assert.deepEqual([...html.matchAll(/<a href="([^"]+)" class="relative z-\[1\][^"]*" aria-label="([^"]+)" data-topic-signal-admin="([^"]+)">Details<\/a>/g)].map((m) => [m[1], m[2], m[3]]), [
    ['#admin/workflows', 'Details of Release stalled: the deploy workflow failed in the admin console', 'workflows'],
    ['#admin/limits', 'Details of Project limits keep filling in the admin console', 'limits'],
  ]);
  const plain = section(fresh().map((s) => ({ ...s, adminSection: null })));
  assert.doesNotMatch(plain, /data-topic-signal-admin|#admin\/|>Details</);
  // Without Details, a row that opens its request shows the chevron.
  assert.equal([...plain.matchAll(/<svg[^>]*aria-hidden="true"/g)].length, 1);
});

test('where the list is read from', () => {
  const { loadTsx } = require('./lib/render-tsx');
  const { signalsUrl, adminHref } = loadTsx(SECTION);
  assert.equal(signalsUrl('usernode-2d5619', 'infra'), '/api/apps/usernode-2d5619/topics/infra/signals');
  assert.equal(signalsUrl('a b', 'c/d'), '/api/apps/a%20b/topics/c%2Fd/signals');
  assert.equal(adminHref('homeroom-bot'), '#admin/homeroom-bot');
});

test('the channel mounts the section after the figures and before the room', () => {
  const src = read('frontend/src/features/dev-board/workshop/project-discussion.tsx');
  assert.match(src, /import \{ TopicSignals \} from '\.\/topic-signals';/);
  const head = src.indexOf('<TopicHead');
  const figures = src.indexOf('<TopicFigures slug={slug} topic={topic} />');
  const signals = src.indexOf('<TopicSignals slug={slug} topic={topic} />');
  const host = src.indexOf('className="dev-ws-discussion-host dev-ws-topic-host"');
  assert.ok(head > 0 && head < figures && figures < signals && signals < host);
  // The channel's declared check finds the figures right after the line.
  const between = src.slice(src.indexOf('/>', head), figures);
  assert.doesNotMatch(between, /<[A-Z]/, 'nothing is drawn between the line and the figures');
});

test('the section steps aside while a reply thread is open, and takes no more room than its rows', () => {
  const html = section(fresh());
  const cls = html.match(/^<section class="([^"]*)"/)[1].replace(/&gt;/g, '>').replace(/&amp;/g, '&').split(' ');
  assert.ok(cls.includes('flex-none'));
  assert.ok(cls.includes('[.dev-ws-discussion-threaded>&]:hidden'));
});

test('the section\'s own words are catalog entries', () => {
  const catalog = JSON.parse(read('frontend/locales/en/project.json'));
  for (const key of ['label', 'since', 'clearing', 'times_one', 'times_other', 'details', 'detailsLabel']) {
    const entry = catalog[`places.topicSignals.${key}`];
    assert.ok(entry && entry.text && entry.description, key);
  }
  assert.equal(catalog['places.topicSignals.since'].text, 'first seen {{when}}');
  assert.equal(catalog['places.topicSignals.times_other'].text, '{{count}} times');
});
