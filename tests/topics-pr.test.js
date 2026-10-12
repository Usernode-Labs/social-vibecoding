// #4417: topics change by proposal. POST /api/apps/:slug/topics-pr opens a
// pull request on the project's dapp.json — a new topic, a rename, a merge
// or an archive — and drops it into the vote panel, the way a rename does
// (services/topics-pr.js, on rename-pr.js's createManifestPR). Pinned here:
//
//   * the dapp.json edit for each change, made against main's file as it
//     is and validated with the deploy's own validator, so a PR that could
//     not apply is never opened (and the refusals say why);
//   * the gates: members only (403 join_required), people who may build
//     here, and a plain 503 when GitHub is not configured;
//   * what is opened: a `topics/` branch, the file written whole in
//     dapp.json's own formatting, a PR titled for the change, and a
//     promoted session.
//
// Run with: node --test tests/topics-pr.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({ query: (sql, params) => poolQueryHandler(sql, params) });

const github = require('../src/services/github');
let ghCalls;
let ghEnabled = true;
const MAIN = {
  name: 'Homeroom',
  topics: [
    { id: 'onboarding', handle: 'onboarding', name: 'Onboarding', icon: '\u{1F6AA}', about: 'Signing up and the first week' },
    { id: 'homeroom-bot', handle: 'homeroom-bot', name: 'Homeroom bot', icon: '\u{1F916}', about: 'How it plans, builds and answers' },
    { id: 'old-things', handle: 'old-things', name: 'Old things', archived: true },
  ],
  tests: [],
};
let ghManifestOnMain = JSON.stringify(MAIN, null, 2);
github.isEnabled = () => ghEnabled;
github.getFileContent = async () => ghManifestOnMain;
github.createBranch = async (owner, repo, branch) => { ghCalls.push({ op: 'branch', branch }); };
github.pushFiles = async (owner, repo, files, opts) => { ghCalls.push({ op: 'push', files, opts }); };
github.createPR = async (owner, repo, { branch, title, body }) => {
  ghCalls.push({ op: 'pr', branch, title, body });
  return { number: 777, html_url: 'https://github.com/o/r/pull/777' };
};
process.env.GITHUB_BOT_TOKEN = process.env.GITHUB_BOT_TOKEN || 'test-token';

const topicsPr = require('../src/services/topics-pr');
const { appRoutes } = require('../src/routes/apps');
const express = require('express');

const APP_ROW = {
  id: 11, slug: 'homeroom', name: 'Homeroom', created_by: 1, self_hosted: true, community_id: 3,
  repo_url: 'https://github.com/o/r', collab_visibility: 'public', view_visibility: 'public',
};
let currentUser;
let isMember;
let aliasRows;

function defaultHandler() {
  return async (sql) => {
    if (/FROM apps a WHERE a\.slug = \$1/.test(sql)) {
      return { rows: [{ ...APP_ROW, is_member: isMember }] };
    }
    if (/SELECT \* FROM apps WHERE slug = \$1/.test(sql)) return { rows: [APP_ROW] };
    if (/SELECT category_key, topic_aliases FROM app_category_registry/.test(sql)) return { rows: aliasRows };
    if (/INSERT INTO chat_sessions/.test(sql)) return { rows: [{ id: 4343 }] };
    if (/COUNT\(DISTINCT a\.user_id\) AS cnt/.test(sql)) return { rows: [{ cnt: '3' }] };
    return { rows: [] };
  };
}

let server;
let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use(appRoutes({ jwtSecret: 'test' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
test.beforeEach(() => {
  ghCalls = [];
  ghEnabled = true;
  ghManifestOnMain = JSON.stringify(MAIN, null, 2);
  currentUser = { id: 7, username: 'maya', isAdmin: false };
  isMember = true;
  aliasRows = [];
  poolQueryHandler = defaultHandler();
});

const propose = (body) => fetch(`${base}/api/apps/homeroom/topics-pr`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const written = () => JSON.parse(ghCalls.find((c) => c.op === 'push').files[0].content);

// ── The edit itself ─────────────────────────────────────────────────────

test('add: the handle is the id, taken from the name unless given; about and icon ride along', () => {
  const out = topicsPr.applyTopicChange(MAIN, { op: 'add', name: 'Notifications', about: 'Pushes, emails and the bell', icon: '\u{1F514}' });
  assert.deepEqual(out.topics.at(-1), {
    id: 'notifications', handle: 'notifications', name: 'Notifications', icon: '\u{1F514}', about: 'Pushes, emails and the bell',
  });
  assert.equal(out.title, 'New topic #notifications');
  assert.equal(topicsPr.applyTopicChange(MAIN, { op: 'add', name: 'Release notes', handle: '#Release Notes' }).topics.at(-1).id, 'release-notes');
  assert.deepEqual(MAIN.topics.length, 3, 'the input is not edited in place');
  assert.throws(() => topicsPr.applyTopicChange(MAIN, { op: 'add', name: 'Onboarding again', handle: 'onboarding' }), /#onboarding is taken/);
  assert.throws(() => topicsPr.applyTopicChange(MAIN, { op: 'add', name: 'Old', handle: 'old-things' }), /#old-things is taken/,
    'an archived topic keeps its handle');
  assert.throws(() => topicsPr.applyTopicChange(MAIN, { op: 'add', name: 'Signing up', handle: 'signup' }, { aliases: { signup: 'onboarding' } }),
    /#signup is taken/, 'and so does an old handle another topic had');
  assert.throws(() => topicsPr.applyTopicChange(MAIN, { op: 'add', name: 'General', handle: 'general' }), /not "general"/);
  assert.throws(() => topicsPr.applyTopicChange(MAIN, { op: 'add', name: 'Ab' }), /3 to 48/, 'the deploy\'s own validator decides');
  assert.throws(() => topicsPr.applyTopicChange(MAIN, { op: 'add', name: 'Bell', icon: 'bell' }), /one emoji/);
});

test('rename: name, channel, about or icon; a new handle keeps the old one working', () => {
  const out = topicsPr.applyTopicChange(MAIN, { op: 'rename', id: 'onboarding', handle: 'first-week', name: 'The first week' });
  const t = out.topics.find((x) => x.id === 'onboarding');
  assert.deepEqual([t.id, t.handle, t.name], ['onboarding', 'first-week', 'The first week'], 'the id never changes');
  assert.equal(out.title, 'Rename #onboarding to #first-week');
  assert.match(out.summary, /#onboarding keeps working/);
  assert.equal(topicsPr.applyTopicChange(MAIN, { op: 'rename', id: 'onboarding', about: 'The first seven days' }).title, 'Rename topic #onboarding');
  assert.throws(() => topicsPr.applyTopicChange(MAIN, { op: 'rename', id: 'onboarding', name: 'Onboarding' }), /already/);
  assert.throws(() => topicsPr.applyTopicChange(MAIN, { op: 'rename', id: 'onboarding', handle: 'homeroom-bot' }), /taken/);
  assert.doesNotThrow(() => topicsPr.applyTopicChange(MAIN, { op: 'rename', id: 'onboarding', handle: 'signup' }, { aliases: { signup: 'onboarding' } }),
    'a topic may take back a handle it had');
  assert.throws(() => topicsPr.applyTopicChange(MAIN, { op: 'rename', id: 'old-things', name: 'Older things' }), /archived already/);
  assert.throws(() => topicsPr.applyTopicChange(MAIN, { op: 'rename', id: 'nope', name: 'Nope' }), /There is no topic "nope"/);
});

test('merge and archive: only live topics, never into itself', () => {
  const merged = topicsPr.applyTopicChange(MAIN, { op: 'merge', id: 'homeroom-bot', into: 'onboarding' });
  assert.equal(merged.topics.find((x) => x.id === 'homeroom-bot').mergedInto, 'onboarding');
  assert.equal(merged.title, 'Merge #homeroom-bot into #onboarding');
  assert.throws(() => topicsPr.applyTopicChange(MAIN, { op: 'merge', id: 'onboarding', into: 'onboarding' }), /into itself/);
  assert.throws(() => topicsPr.applyTopicChange(MAIN, { op: 'merge', id: 'onboarding', into: 'old-things' }), /archived already/);
  const archived = topicsPr.applyTopicChange(MAIN, { op: 'archive', id: 'homeroom-bot' });
  assert.equal(archived.topics.find((x) => x.id === 'homeroom-bot').archived, true);
  assert.equal(archived.title, 'Archive #homeroom-bot');
  // A file with no topics block yet takes its first.
  assert.deepEqual(topicsPr.applyTopicChange({ name: 'x' }, { op: 'add', name: 'Bugs and fixes' }).topics.map((x) => x.id), ['bugs-and-fixes']);
});

test('parseChange takes only what the op needs, and says what is missing', () => {
  assert.throws(() => topicsPr.parseChange({ op: 'delete', id: 'x' }), /one of add, rename, merge or archive/);
  assert.throws(() => topicsPr.parseChange({ op: 'add' }), /needs a name/);
  assert.throws(() => topicsPr.parseChange({ op: 'merge', id: 'a' }), /merge into/);
  assert.throws(() => topicsPr.parseChange({ op: 'rename', id: 'a' }), /changes the name/);
  assert.throws(() => topicsPr.parseChange({ op: 'add', name: 3 }), /must be a string/);
  assert.deepEqual(topicsPr.parseChange({ op: 'archive', id: 'a', extra: 'x' }), { op: 'archive', id: 'a' });
});

// ── The route ───────────────────────────────────────────────────────────

test('a member opens the PR: a topics/ branch, the whole file in its own format, a titled PR, a promoted session', async () => {
  const res = await propose({ op: 'add', name: 'Notifications', handle: 'notifications', about: 'Pushes, emails and the bell' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, sessionId: 4343, prNumber: 777, prUrl: 'https://github.com/o/r/pull/777', title: 'New topic #notifications' });
  assert.match(ghCalls.find((c) => c.op === 'branch').branch, /^topics\/homeroom-\d+$/);
  const push = ghCalls.find((c) => c.op === 'push');
  assert.equal(push.files[0].path, 'dapp.json');
  assert.equal(push.files[0].content, `${JSON.stringify(written(), null, 2)}\n`, 'dapp.json\'s own formatting');
  assert.deepEqual(written().topics.map((x) => x.id), ['onboarding', 'homeroom-bot', 'old-things', 'notifications']);
  assert.equal(written().name, 'Homeroom', 'the rest of the file is untouched');
  assert.equal(push.opts.message, 'New topic #notifications');
  const pr = ghCalls.find((c) => c.op === 'pr');
  assert.equal(pr.title, 'New topic #notifications');
  assert.match(pr.body, /adds the topic "Notifications" \(#notifications\)/);
});

test('a change that cannot apply is refused before anything is written to GitHub', async () => {
  const res = await propose({ op: 'merge', id: 'homeroom-bot', into: 'old-things' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /#old-things is archived already/);
  assert.deepEqual(ghCalls, []);
  const missing = await propose({ op: 'archive', id: 'nope' });
  assert.equal(missing.status, 404);
  const bad = await propose({ op: 'add' });
  assert.equal(bad.status, 400);
});

test('members only: a non-member is asked to join, and nothing is opened', async () => {
  isMember = false;
  const res = await propose({ op: 'archive', id: 'homeroom-bot' });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, 'join_required');
  assert.deepEqual(body.app, { slug: 'homeroom', name: 'Homeroom' });
  assert.deepEqual(ghCalls, []);
});

test('without GitHub configured the route says so, plainly', async () => {
  ghEnabled = false;
  const res = await propose({ op: 'archive', id: 'homeroom-bot' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /GitHub configured/);
  assert.deepEqual(ghCalls, []);
});
