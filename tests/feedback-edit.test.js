// #4803: exercise the real HTTP edit route, including competing saves,
// remote/local failures, and byte-for-byte preservation of attachment markup.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { FEEDBACK_DESCRIPTION_MAX } = require('../src/services/issue-body-limit');

let user, report, secondsLeft, queries, patches, patch, failLocal;
let lockTail = Promise.resolve();
const suffix = '\n\n**Screenshot:**\n![Screenshot](https://test/issue-images/abc#pin=note)'
  + '\n\n**Video:**\nhttps://test/issue-videos/abc\n\n<details>App state: {"text":"typo"}</details>';
function read(row) {
  return { ...row, seconds_left: secondsLeft,
    has_body: row.body_prefix != null && row.body_suffix != null };
}
const pool = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/FROM feedback_reports/.test(sql)) {
      return { rows: report && Number(params[0]) === report.id && params[1] === report.user_id ? [read(report)] : [] };
    }
    if (/FROM apps/.test(sql)) return { rows: [{ id: 3, slug: 'demo-app', repo_url: 'https://github.com/owner/demo' }] };
    return { rows: [] };
  },
  async connect() {
    let local, unlock;
    return {
      async query(sql, params = []) {
        queries.push({ sql, params });
        if (/pg_advisory_xact_lock/.test(sql)) {
          const previous = lockTail;
          lockTail = new Promise(resolve => { unlock = resolve; });
          await previous;
          local = structuredClone(report);
        } else if (/FROM feedback_reports/.test(sql)) {
          return { rows: local && Number(params[0]) === local.id && params[1] === local.user_id ? [read(local)] : [] };
        } else if (/UPDATE feedback_reports/.test(sql)) {
          if (failLocal) throw new Error('database unavailable');
          local.title = params[2]; local.description = params[3]; local.edit_version++;
        } else if (sql === 'COMMIT') report = local;
        return { rows: [] };
      },
      release() { unlock?.(); },
    };
  },
};
require('../src/db/pool').getPool = () => pool;
const github = require('../src/services/github');
const realPatch = github.patchIssueContent;
github.patchIssueContent = async (...args) => { patches.push(args); await patch?.(...args); };
github.invalidateIssuesCache = () => {};
const wsId = require.resolve('../src/services/ws');
const announcements = [];
require.cache[wsId] = { id: wsId, filename: wsId, loaded: true,
  exports: { pushIssueUpdate: data => announcements.push(data) } };
const { feedbackRoutes } = require('../src/routes/feedback');
const { feedbackSubmitLimiter } = require('../src/middleware/rate-limits');
let server;
test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/platform/repo' }));
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
});
test.after(() => server.close());
test.beforeEach(() => {
  feedbackSubmitLimiter.resetKey('user:7');
  feedbackSubmitLimiter.resetKey('user:8');
  user = { id: 7 };
  report = { id: 12, user_id: 7, issue_owner: 'owner', issue_repo: 'demo', issue_number: 41,
    app_id: 3, title: 'Title', description: 'typo', source: null, edit_version: 0,
    body_prefix: '**Source:** Homeroom user\n**App:** Demo\n\n', body_suffix: suffix };
  secondsLeft = 299; queries = []; patches = []; patch = null; failLocal = false;
  announcements.length = 0; lockTail = Promise.resolve();
});
async function save(overrides = {}, id = '12') {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/feedback/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Correct title', description: 'corrected words', version: 0, ...overrides }),
  });
  return { status: res.status, body: await res.json() };
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('only the signed-in author can edit; another author sees a missing report', async () => {
  user = null;
  assert.equal((await save()).status, 401);
  assert.equal(queries.length, 0);
  user = { id: 8 };
  assert.equal((await save()).status, 404);
  assert.equal(patches.length, 0);
});
test('validates ids, required words, length and version before touching GitHub', async () => {
  for (const id of ['0', 'abc', '9007199254740992']) assert.equal((await save({}, id)).status, 400);
  for (const fields of [{ title: '' }, { description: '  ' }, { title: 'x'.repeat(201) },
    { description: 'x'.repeat(FEEDBACK_DESCRIPTION_MAX + 1) }, { version: -1 }, { version: '0' }]) {
    assert.equal((await save(fields)).status, 400);
  }
  assert.equal(patches.length, 0);
});
test('old and bot-filed reports cannot be edited, even with a guessed id', async () => {
  report.source = 'homeroom_bot';
  assert.equal((await save()).body.code, 'not_editable');
  report.source = null; report.body_prefix = null;
  assert.equal((await save()).body.code, 'not_editable');
  assert.equal(patches.length, 0);
});
test('expires on server time and rejects an outdated version', async () => {
  secondsLeft = 0;
  assert.equal((await save()).body.code, 'edit_window_closed');
  secondsLeft = 10; report.edit_version = 1;
  assert.equal((await save()).body.code, 'edit_conflict');
  assert.equal(patches.length, 0);
});
test('updates the same issue once, preserving headers, pins, video and state exactly', async () => {
  const { status, body } = await save({ description: '  typo corrected\n\nwith paragraphs  ' });
  assert.equal(status, 200);
  assert.deepEqual(patches, [['owner', 'demo', 41, {
    title: 'Correct title', body: report.body_prefix + 'typo corrected\n\nwith paragraphs' + suffix,
  }]]);
  assert.equal(report.description, 'typo corrected\n\nwith paragraphs');
  assert.equal(body.edit.version, 1);
  assert.equal(body.edit.secondsLeft, 299, 'saving does not restart the five minutes');
  assert.ok(queries.some(q => /DELETE FROM title_heal_queue/.test(q.sql)));
  assert.ok(queries.some(q => /UPDATE homeroom_bot_requesters/.test(q.sql)));
  assert.equal(announcements[0].issueNumber, 41);
});
test('description-only edits update pending title generation; unchanged saves do no write', async () => {
  const unchanged = await save({ title: 'Title', description: 'typo' });
  assert.equal(unchanged.body.unchanged, true);
  assert.equal(patches.length, 0);
  assert.equal((await save({ title: 'Title' })).status, 200);
  assert.ok(queries.some(q => /UPDATE title_heal_queue/.test(q.sql) && q.params[3] === 'corrected words'));
});
test('checks the complete body limit with attachments instead of truncating anything', async () => {
  report.body_suffix = 'x'.repeat(65536);
  assert.equal((await save()).status, 400);
  assert.equal(patches.length, 0);
});
test('a GitHub failure rolls back locally and leaves the same correction retryable', async () => {
  patch = async () => { throw new Error('remote refused'); };
  assert.equal((await save()).status, 502);
  assert.equal(report.description, 'typo');
  assert.equal(report.edit_version, 0);
  assert.ok(queries.some(q => q.sql === 'ROLLBACK'));
  patch = null;
  assert.equal((await save()).status, 200);
  assert.equal(report.edit_version, 1);
});
test('a local failure after GitHub accepted is reported; retry updates the same issue safely', async () => {
  failLocal = true;
  assert.equal((await save()).status, 502);
  assert.equal(report.edit_version, 0);
  failLocal = false;
  assert.equal((await save()).status, 200);
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[0], patches[1]);
  assert.equal(report.edit_version, 1);
});
test('competing saves cannot silently overwrite one another', async () => {
  const entered = deferred(), finish = deferred();
  patch = async () => { entered.resolve(); await finish.promise; };
  const first = save({ description: 'first correction' });
  await entered.promise;
  const second = save({ description: 'second correction' });
  finish.resolve();
  assert.equal((await first).status, 200);
  assert.equal((await second).body.code, 'edit_conflict');
  assert.equal(report.description, 'first correction');
  assert.equal(patches.length, 1);
});
test('a save queued behind another save checks expiry after obtaining the lock', async () => {
  const entered = deferred(), finish = deferred();
  patch = async () => { entered.resolve(); await finish.promise; };
  const first = save(); await entered.promise;
  const second = save();
  secondsLeft = 0; finish.resolve();
  assert.equal((await first).status, 200, 'already accepted before expiry');
  assert.equal((await second).body.code, 'edit_window_closed');
  assert.equal(patches.length, 1);
});
// The edit used to PATCH the GitHub issue, title and body together, through
// safeMention. A request is a row now (services/requests.js): the real
// helper writes both at once, as written, and sends nothing to GitHub.
test('the real request helper writes title and body together, and nothing reaches GitHub', async (t) => {
  const { installFakeRequests } = require('./helpers/fake-requests');
  const fake = installFakeRequests(t, { 'owner/demo': [{ number: 41, title: 'Helo', body: 'Wrods' }] });
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => { calls.push({ url, options }); return { ok: false, status: 599, headers: new Headers() }; };
  try {
    await realPatch('owner', 'demo', 41, { title: 'Hello @somebody', body: 'Words @somebody' });
    assert.equal(calls.length, 0);
    const [row] = fake.board('owner', 'demo');
    assert.deepEqual({ title: row.title, body: row.body }, { title: 'Hello @somebody', body: 'Words @somebody' });
  } finally {
    global.fetch = oldFetch;
  }
});
