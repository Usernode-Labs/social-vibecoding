'use strict';

// services/main-watch: the flaky tests a paused main leaves behind.
//
// From 26 September to 10 October 2026 main paused nine times and an admin
// ended every pause by hand. Three were flaky tests. What a paused main does
// by itself (its rechecks, and a red of known flakes alone that pauses
// nothing) is the main-check machine's, pinned against PostgreSQL in
// tests/workflow-main-check-postgres.test.js. Pinned here is the record it
// asks main-watch to keep:
//
//   * a test that failed and then passed on the same commit is remembered
//     as flaky (main_test_flakes, noteFlakes) and a request to fix it is
//     filed as Homeroom bot, once per test per window (fileFlakeRequest);
//   * the machine's two rules that read the tests by name: two reds with no
//     test in common are flakes (disjointReds), and a red is of known flakes
//     alone only when it named every failure (knownFlakeNames).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.NODE_ENV = 'test';
delete process.env.MAIN_WATCH_FLAKE_REQUESTS;

// The lazily-required collaborators, stubbed before main-watch loads them.
const created = [];
const woke = [];
const stub = (rel, exports) => {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub('../src/services/ws', { sendSystemMessage: async () => {}, pushSessionUpdate: () => {}, pushIssueUpdate: () => {} });
const github = {
  enabled: true,
  fail: false,
  isEnabled: () => github.enabled,
  safeMention: (s) => s,
  createIssue: async (owner, repo, issue) => {
    if (github.fail) throw new Error('GitHub said no');
    created.push({ owner, repo, ...issue });
    return { number: 900 + created.length };
  },
  getFileContent: async () => null,
  getCloneUrl: async () => '',
};
stub('../src/services/github', github);
stub('../src/services/homeroom-bot', {
  ensureBotUser: async () => ({ id: 77, username: 'homeroom-bot' }),
  noteIssueActivity: (x) => { woke.push(x); return true; },
});
stub('../src/services/notifications', { notifyIssueFiled: () => {} });

const mainWatch = require('../src/services/main-watch');
const { disjointReds, knownFlakeNames } = require('../src/workflow/main-check/machine.ts');
const { testKey } = require('../src/workflow/main-check/facts.ts');

const SHA = 'c'.repeat(40);
const APP = { id: 12, slug: 'demo', repo_url: 'https://github.com/org/demo' };
const config = { workerRuntime: 'docker' };

// A pool that keeps main_test_flakes and issues in memory. `known` seeds the
// flakes table; `openIssues` are request numbers still open.
function flakePool({ known = [], openIssues = [] } = {}) {
  const flakes = new Map(known.map((t) => [`${t.file || ''}\u0000${t.test}`, {
    file: t.file || '', test: t.test, seen_count: t.seen_count || 1, first_seen_at: new Date('2026-10-03T00:00:00Z'),
    request_issue_number: t.request_issue_number || null, request_filed_at: t.request_filed_at || null,
  }]));
  const issues = [];
  const calls = [];
  return {
    calls, flakes, issues,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/INSERT INTO main_test_flakes/.test(sql)) {
        const [, file, name, sha] = params;
        const k = `${file}\u0000${name}`;
        const row = flakes.get(k);
        if (row) { row.seen_count += 1; row.last_sha = sha; } else {
          flakes.set(k, { file, test: name, seen_count: 1, first_seen_at: new Date('2026-10-10T00:00:00Z'), last_sha: sha, request_issue_number: null, request_filed_at: null });
        }
        return { rows: [], rowCount: 1 };
      }
      if (/SET request_filed_at = NOW\(\)/.test(sql)) {
        const row = flakes.get(`${params[1]}\u0000${params[2]}`);
        if (!row || row.request_filed_at || openIssues.includes(row.request_issue_number)) return { rows: [], rowCount: 0 };
        row.request_filed_at = new Date();
        return { rows: [{ seen_count: row.seen_count, first_seen_at: row.first_seen_at }], rowCount: 1 };
      }
      if (/SET request_filed_at = NULL/.test(sql)) {
        const row = flakes.get(`${params[1]}\u0000${params[2]}`);
        if (row) row.request_filed_at = null;
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO issues/.test(sql)) {
        issues.push({ app_id: params[0], github_issue_number: params[1], title: params[2], created_by: params[4] });
        return { rows: [{ id: 500 + issues.length }], rowCount: 1 };
      }
      if (/SET request_issue_number = \$4/.test(sql)) {
        const row = flakes.get(`${params[1]}\u0000${params[2]}`);
        if (row) row.request_issue_number = params[3];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const FLAKY = { file: 'tests/bot-clock.test.js', test: 'the clock reads the next whole minute' };
const OTHER = { file: 'tests/persona.test.js', test: 'persona listener hears the reply' };
const REAL = { file: 'tests/sessions.test.js', test: 'shared-sessions returns linked_issues per row' };
const DB = { file: 'tests/db-export-service.test.js', test: 'backpressure pauses the child instead of buffering the dump' };
const PUSH = { file: 'tests/social-push-web.test.js', test: 'tap retries are bounded and pagehide cancels a scheduled retry' };

const pass = { row: { status: 'pass', failureReason: '', summary: { tests: 40, pass: 40, fail: 0 } } };
// A red the way unit-suite shapes it: the row, and the failing tests by name beside it.
const red = (tests, { complete = true, excerpts = [] } = {}) => ({
  row: {
    status: 'fail',
    failureReason: tests.map((t) => `${t.file} (1): ${t.test}`).join(' | '),
    summary: { tests: 40, pass: 40 - tests.length, fail: tests.length },
    ...(excerpts.length ? { failureDetails: excerpts } : {}),
  },
  failingTests: { tests, complete },
});
// The same red as a verdict's detail (classify), as the machine hands it on.
const redDetail = (tests, o) => mainWatch.classify(red(tests, o)).detail;

test.beforeEach(() => {
  created.length = 0; woke.length = 0;
  github.enabled = true; github.fail = false;
  delete process.env.MAIN_WATCH_FLAKE_REQUESTS;
});

// ── classify ─────────────────────────────────────────────────────────────

test('classify: a red keeps its failing tests by name, and whether they are all of them', () => {
  const v = mainWatch.classify(red([FLAKY, REAL], { excerpts: [{ ...FLAKY, excerpt: 'boom' }] }));
  assert.equal(v.state, 'failing');
  assert.deepEqual(v.detail.failingTests, [FLAKY, REAL]);
  assert.equal(v.detail.failingTestsComplete, true);
  assert.deepEqual(v.excerpts, [{ ...FLAKY, excerpt: 'boom' }], 'beside the verdict, for a request');
  assert.equal(v.detail.excerpts, undefined, 'never stored on the apps row');
  // Twenty at most, and a list cut short is not complete.
  const many = Array.from({ length: 25 }, (_, i) => ({ file: 'tests/x.test.js', test: `t${i}` }));
  const cut = mainWatch.classify(red(many)).detail;
  assert.equal(cut.failingTests.length, 20);
  assert.equal(cut.failingTestsComplete, false);
  // A green run keeps none.
  assert.equal(mainWatch.classify({ ...pass, failingTests: { tests: [FLAKY], complete: true } }).detail.failingTests, undefined);
});

// ── flakes ───────────────────────────────────────────────────────────────

test('red then green on one commit: the test is remembered as flaky and a request is filed as Homeroom bot', async () => {
  const pool = flakePool();
  const recorded = await mainWatch.noteFlakes(config, pool, APP, SHA, [redDetail([FLAKY])],
    [{ ...FLAKY, excerpt: 'expected 12:01, got 12:00' }]);
  assert.deepEqual(recorded, [FLAKY]);
  const row = pool.flakes.get(`${FLAKY.file}\u0000${FLAKY.test}`);
  assert.ok(row, 'recorded');
  assert.equal(row.last_sha, SHA);
  assert.equal(created.length, 1);
  assert.equal(created[0].owner, 'org');
  assert.equal(created[0].repo, 'demo');
  assert.equal(created[0].title, `Flaky test: ${FLAKY.test}`);
  assert.match(created[0].body, /failed on main and then passed on the same commit \(ccccccccc\)/);
  assert.match(created[0].body, /expected 12:01, got 12:00/, 'with what it printed');
  assert.deepEqual(pool.issues, [{ app_id: 12, github_issue_number: 901, title: created[0].title, created_by: 77 }]);
  assert.equal(row.request_issue_number, 901);
  assert.deepEqual(woke, [{ appId: 12, issueNumber: 901, reason: 'created' }], 'the bot hears of it');
});

test('a second sighting while the request is open files nothing new', async () => {
  const pool = flakePool({ known: [{ ...FLAKY, request_issue_number: 901, request_filed_at: new Date() }], openIssues: [901] });
  await mainWatch.noteFlakes(config, pool, APP, SHA, [redDetail([FLAKY])]);
  assert.equal(pool.flakes.get(`${FLAKY.file}\u0000${FLAKY.test}`).seen_count, 2, 'seen again');
  assert.equal(created.length, 0);
});

test('a red of many tests that then passes is the run, not each test: nothing is recorded', async () => {
  const pool = flakePool();
  const four = [FLAKY, OTHER, REAL, { file: 'tests/d.test.js', test: 'd' }];
  assert.deepEqual(await mainWatch.noteFlakes(config, pool, APP, SHA, [redDetail(four)]), []);
  assert.equal(pool.flakes.size, 0);
  assert.equal(created.length, 0);
});

test('a red that did not name all of its failures records no flake', async () => {
  const pool = flakePool();
  await mainWatch.noteFlakes(config, pool, APP, SHA, [redDetail([FLAKY], { complete: false })]);
  assert.equal(pool.flakes.size, 0);
});

test('a red of known flakes alone: a request for each, the first time', async () => {
  const pool = flakePool({ known: [FLAKY, OTHER] });
  const filed = await mainWatch.fileFlakeRequests(config, pool, APP, [FLAKY, OTHER], { mergeSha: SHA });
  assert.deepEqual(filed, [901, 902]);
  assert.deepEqual(created.map((c) => c.title), [`Flaky test: ${FLAKY.test}`, `Flaky test: ${OTHER.test}`]);
  assert.deepEqual(await mainWatch.fileFlakeRequests(config, pool, APP, [FLAKY, OTHER], { mergeSha: SHA }), [], 'not again within the window');
});

test('a request that GitHub refuses is not counted as filed, so the next sighting tries again', async () => {
  github.fail = true;
  const pool = flakePool({ known: [FLAKY] });
  const n = await mainWatch.fileFlakeRequest(config, pool, APP, FLAKY, { mergeSha: SHA });
  assert.equal(n, null);
  assert.equal(pool.flakes.get(`${FLAKY.file}\u0000${FLAKY.test}`).request_filed_at, null);
  assert.equal(pool.issues.length, 0);
  // And the switch, and a GitHub that is off, file nothing at all.
  github.fail = false;
  process.env.MAIN_WATCH_FLAKE_REQUESTS = '0';
  assert.equal(await mainWatch.fileFlakeRequest(config, pool, APP, FLAKY, { mergeSha: SHA }), null);
  delete process.env.MAIN_WATCH_FLAKE_REQUESTS;
  github.enabled = false;
  assert.equal(await mainWatch.fileFlakeRequest(config, pool, APP, FLAKY, { mergeSha: SHA }), null);
  assert.equal(created.length, 0);
});

test('the request text: the test, its file, how often, and a fence its excerpt cannot close', () => {
  const { title, body } = mainWatch.flakeRequestText(FLAKY, {
    mergeSha: SHA, seenCount: 3, firstSeenAt: '2026-10-03T08:00:00Z', excerpt: 'got ```weird``` output',
  });
  assert.equal(title, `Flaky test: ${FLAKY.test}`);
  assert.match(body, /"the clock reads the next whole minute" in `tests\/bot-clock\.test\.js`/);
  assert.match(body, /Seen flaking on main 3 times, first on 2026-10-03\./);
  assert.match(body, /````text\ngot ```weird``` output\n````/);
  assert.match(body, /does not pause merges/);
  const once = mainWatch.flakeRequestText({ file: null, test: 'x'.repeat(200) }, { seenCount: 1 });
  assert.equal(once.title.length, 'Flaky test: '.length + 120);
  assert.match(once.body, /Seen flaking on main once\./);
});

test('the request claim is once per window and never while the last one is open', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'main-watch.js'), 'utf8');
  const claim = src.slice(src.indexOf('async function fileFlakeRequest'));
  assert.match(claim, /f\.request_filed_at IS NULL OR f\.request_filed_at < NOW\(\) - \(\$4::int \* interval '1 day'\)/);
  assert.match(claim, /NOT EXISTS \(\s+SELECT 1 FROM issues i\s+WHERE i\.app_id = f\.app_id AND i\.github_issue_number = f\.request_issue_number\s+AND i\.status = 'open'\)/);
});

test('the schema keeps the flakes per app, keyed by file and test', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS main_test_flakes'));
  assert.match(table, /app_id\s+INTEGER NOT NULL REFERENCES apps\(id\) ON DELETE CASCADE/);
  assert.match(table, /file\s+TEXT NOT NULL DEFAULT ''/);
  assert.match(table, /request_issue_number INTEGER/);
  assert.match(table, /PRIMARY KEY \(app_id, file, test\)/);
});

// ── Two reds, no test in common ──────────────────────────────────────────
//
// 12 Oct 2026: a merge failed db-export-service's backpressure test, its
// confirming run failed social-push-web's tap retries instead, and merges
// stayed paused for 23 minutes on two flakes. Each test passed when the
// suite ran again, so each is flaky.

test('two reds on one commit with no test in common are flakes: both recorded, a request each', async () => {
  const first = redDetail([DB]);
  const second = redDetail([PUSH]);
  assert.deepEqual(disjointReds(first, second), [DB.test, PUSH.test]);
  const pool = flakePool();
  await mainWatch.noteFlakes(config, pool, APP, SHA, [first, second]);
  assert.ok(pool.flakes.has(`${DB.file}\u0000${DB.test}`) && pool.flakes.has(`${PUSH.file}\u0000${PUSH.test}`), 'both remembered');
  assert.deepEqual(created.map((c) => c.title), [`Flaky test: ${DB.test}`, `Flaky test: ${PUSH.test}`]);
});

test('two reds that share a test, or whose lists are long or incomplete, are no flakes', () => {
  for (const [why, first, second] of [
    ['one test failed both times', redDetail([DB, REAL]), redDetail([REAL])],
    ['the second list is incomplete', redDetail([DB]), redDetail([PUSH], { complete: false })],
    ['too many failures to be each test', redDetail([DB, FLAKY, OTHER, REAL]), redDetail([PUSH])],
  ]) {
    assert.equal(disjointReds(first, second), null, why);
  }
  assert.equal(disjointReds({ failingTests: [DB], failingTestsComplete: true }, { failingTests: [], failingTestsComplete: true }), null,
    'a red that named nothing is no evidence');
});

test('a red is of known flakes alone only when every failure is one, named in full', () => {
  const known = new Set([FLAKY, OTHER].map(testKey));
  assert.deepEqual(knownFlakeNames(known, redDetail([FLAKY, OTHER])), [FLAKY.test, OTHER.test]);
  assert.equal(knownFlakeNames(known, redDetail([FLAKY, REAL])), null, 'one other test is a red like any');
  assert.equal(knownFlakeNames(known, redDetail([FLAKY], { complete: false })), null, 'a list cut short excuses nothing');
  assert.equal(knownFlakeNames(known, mainWatch.classify(pass).detail), null);
  assert.equal(knownFlakeNames(new Set(), redDetail([FLAKY])), null);
});
