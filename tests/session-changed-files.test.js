'use strict';

// #3207: a proposal's page lists the files it changes, with line counts,
// so a reviewer need not leave for GitHub to see its reach.
//
// Pins GET /api/sessions/:id/changed-files — the same visibility rule as
// /checks and /details, paths and counts only, a 300-path cap, and failing
// open to `{ files: null }` — and the "Files changed" sheet it feeds.
//
// Run with: node --test tests/session-changed-files.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const poolMod = require('../src/db/pool');
const github = require('../src/services/github');

let session;
let queries;
poolMod.getPool = () => ({ query: async (sql) => {
  queries.push(sql);
  if (sql.includes('SELECT a.id, a.collab_visibility')) return { rows: [{ id: 1, view_visibility: 'public', collab_visibility: 'public' }] };
  if (sql.includes('FROM chat_sessions cs')) return { rows: session ? [session] : [] };
  return { rows: [] };
} });

let compare;
let compareCalls;
github.isEnabled = () => true;
github.listChangedFileStats = async (...args) => { compareCalls.push(args); return compare(...args); };

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

async function get(user, id = 123, qs = '') {
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(sessionRoutes({}));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${id}/changed-files${qs}`);
    return { status: response.status, body: await response.json() };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

let seq = 0;
const sha = (n) => n.toString(16).padStart(40, '0');
function reset(patch = {}) {
  queries = []; compareCalls = [];
  // A fresh reviewed head per test, so the route's short cache never answers
  // for an earlier test's compare.
  seq += 1;
  session = { id: 123, user_id: 42, status: 'promoted', shared_at: null, source: null,
    branch_name: `usernode/change-${seq}`, reviewed_head_sha: sha(seq),
    repo_url: 'https://github.com/acme/widgets', ...patch };
  compare = async () => ({
    files: [
      { filename: 'src/a.js', status: 'modified', additions: 3, deletions: 1 },
      { filename: 'README.md', status: 'added', additions: 10, deletions: 0 },
    ],
    additions: 13, deletions: 1, complete: true,
  });
}

test('a caller who may not view the session gets the same 404 as a missing one, and GitHub is never asked', async () => {
  reset({ status: 'active' });
  const result = await get({ id: 99 });
  assert.equal(result.status, 404);
  assert.equal(compareCalls.length, 0);
  reset(); session = null;
  assert.equal((await get({ id: 42 })).status, 404);
});

test('a viewer gets the paths and counts, compared against main at the reviewed commit', async () => {
  reset();
  const result = await get({ id: 99 });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.files.map((f) => f.filename), ['src/a.js', 'README.md']);
  assert.equal(result.body.additions, 13);
  assert.equal(result.body.deletions, 1);
  assert.equal(result.body.complete, true);
  assert.deepEqual(compareCalls[0], ['acme', 'widgets', `main...${session.reviewed_head_sha}`]);
  assert.doesNotMatch(JSON.stringify(result.body), /patch/);
  const projection = queries.find((sql) => sql.includes('FROM chat_sessions cs'));
  assert.doesNotMatch(projection, /cs\.\*|spec_md|chat_session_messages/);
});

test('a GitHub failure fails open to { files: null }', async () => {
  reset();
  compare = async () => { throw new Error('rate limited'); };
  const result = await get({ id: 42 });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { files: null });
});

test('the list stops at 300 files and says it is incomplete', async () => {
  reset();
  const many = Array.from({ length: 450 }, (_, i) => ({ filename: `f${i}.js`, status: 'modified', additions: 1, deletions: 0 }));
  compare = async () => ({ files: many, additions: 450, deletions: 0, complete: false });
  const result = await get({ id: 42 });
  assert.equal(result.body.files.length, 300);
  assert.equal(result.body.complete, false);
});

test('a new revision within the cache minute is compared afresh, against its own commit', async () => {
  reset();
  assert.equal((await get({ id: 42 })).status, 200);
  assert.equal((await get({ id: 42 })).status, 200);
  assert.equal(compareCalls.length, 1, 'the same commit reuses its compare');
  const moved = sha(10_000 + seq);
  session.reviewed_head_sha = moved;
  compare = async () => ({ files: [{ filename: 'new.js', status: 'added', additions: 1, deletions: 0 }], additions: 1, deletions: 0, complete: true });
  const result = await get({ id: 42 });
  assert.equal(compareCalls.length, 2);
  assert.deepEqual(compareCalls[1], ['acme', 'widgets', `main...${moved}`]);
  assert.deepEqual(result.body.files.map((f) => f.filename), ['new.js']);
});

test('without a reviewed head the checked commit pins it; only an underway change with no commit reads its branch, uncached', async () => {
  reset({ reviewed_head_sha: null, checks_commit_sha: sha(20_000 + seq) });
  await get({ id: 42 });
  assert.equal(compareCalls[0][2], `main...${session.checks_commit_sha}`);

  reset({ reviewed_head_sha: null });
  assert.deepEqual((await get({ id: 42 })).body, { files: null }, 'a proposal never falls back to its mutable branch');
  assert.equal(compareCalls.length, 0);

  reset({ status: 'active', reviewed_head_sha: null });
  await get({ id: 42 });
  await get({ id: 42 });
  assert.deepEqual(compareCalls.map((c) => c[2]), [`main...${session.branch_name}`, `main...${session.branch_name}`]);
});

test('staging: a native session without GitHub lists nothing; demo fixtures and imported PRs use the mock', async () => {
  const previous = process.env.USERNODE_ENV;
  const enabled = github.isEnabled;
  try {
    process.env.USERNODE_ENV = 'staging';
    github.isEnabled = () => false;
    reset();
    assert.deepEqual((await get({ id: 42 })).body, { files: null });
    assert.equal(compareCalls.length, 0);

    reset({ source: 'imported', reviewed_head_sha: null, imported_pr_head_sha: sha(30_000 + seq) });
    const imported = await get({ id: 42 });
    assert.deepEqual(imported.body.files.map((f) => f.filename), ['public/index.html', 'src/routes/example.js', 'README.md']);
    assert.equal(compareCalls.length, 0, 'the mock answered, not the real client');

    reset(); session = null;
    const demo = await get({ id: 42 }, 990101, '?demo=1');
    assert.equal(demo.status, 200);
    assert.equal(demo.body.files.length, 3);
    assert.equal((await get({ id: 42 }, 990101)).status, 404, 'without ?demo=1 a fixture id is just a missing session');
  } finally {
    github.isEnabled = enabled;
    if (previous === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = previous;
  }
});

test('the Files changed sheet: collapsed, counted, 50 rows, then a pointer to GitHub', () => {
  const { ChangedFilesView, CHANGED_FILES_SHOWN } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.equal(CHANGED_FILES_SHOWN, 50);
  assert.equal(renderToHtml(createElement(ChangedFilesView, { data: null })), '');
  assert.equal(renderToHtml(createElement(ChangedFilesView, { data: { files: [], additions: 0, deletions: 0, complete: true } })), '');

  const small = renderToHtml(createElement(ChangedFilesView, { data: {
    files: [{ filename: '<b>x</b>.js', status: 'added', additions: 4, deletions: 2 }],
    additions: 4, deletions: 2, complete: true,
  } }));
  assert.match(small, /<details class="dev-topic-details" data-changed-files="true">/);
  assert.doesNotMatch(small, /<details[^>]* open/);
  assert.match(small, /Files changed · 1 \(\+4 −2\)/);
  assert.match(small, /&lt;b&gt;x&lt;\/b&gt;\.js/, 'a path is escaped text');
  assert.doesNotMatch(small, /<a /, 'no path is a link');
  assert.doesNotMatch(small, /more on GitHub/);

  const files = Array.from({ length: 80 }, (_, i) => ({ filename: `f${i}.js`, status: 'modified', additions: 1, deletions: 1 }));
  const big = renderToHtml(createElement(ChangedFilesView, { data: { files, additions: 80, deletions: 80, complete: true } }));
  assert.equal((big.match(/data-changed-file="true"/g) || []).length, 50);
  assert.match(big, /and 30 more on GitHub/);
});
