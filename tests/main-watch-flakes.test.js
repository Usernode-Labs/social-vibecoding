'use strict';

// services/main-watch — what a paused main does by itself.
//
// From 26 September to 10 October 2026 main paused nine times and an admin
// ended every pause by hand. Three were flaky tests: twice the confirming
// re-run never happened and a red stood for hours, once a flake failed
// twice in a row. Three refinements, pinned here:
//
//   * a paused main is re-run by itself (recheckPaused): within minutes
//     when its confirmation could not run, every quarter hour when it was
//     confirmed, at most MAIN_WATCH_RECHECKS times; green lifts the pause;
//   * a test that failed and then passed on the same commit is remembered
//     as flaky (main_test_flakes) and a request to fix it is filed as
//     Homeroom bot, once per test per window;
//   * a red whose failures are ALL known flakes, named in full, is recorded
//     and pauses nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.NODE_ENV = 'test';
delete process.env.MAIN_WATCH_ENABLED;
delete process.env.MAIN_WATCH_CONFIRM;
delete process.env.MAIN_WATCH_RECHECKS;
delete process.env.MAIN_WATCH_FLAKE_REQUESTS;

// The lazily-required collaborators, stubbed before main-watch loads them.
const enqueued = [];
const created = [];
const woke = [];
const stub = (rel, exports) => {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub('../src/services/ws', { sendSystemMessage: async () => {}, pushSessionUpdate: () => {}, pushIssueUpdate: () => {} });
stub('../src/services/merge-queue', { enqueue: (config, appId) => { enqueued.push(appId); } });
const github = {
  enabled: true,
  fail: false,
  isEnabled: () => github.enabled,
  safeMention: (s) => s,
  noteIssueCreated: () => {},
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

const unitSuite = require('../src/services/unit-suite');
const mainWatch = require('../src/services/main-watch');

const SHA = 'c'.repeat(40);
const APP = { id: 12, slug: 'demo', repo_url: 'https://github.com/org/demo' };
const config = { workerRuntime: 'docker' };

// A pool that keeps main_test_flakes and issues in memory and answers the
// apps statements main-watch issues. `known` seeds the flakes table;
// `openIssues` are request numbers still open.
function flakePool({
  known = [], openIssues = [], claim = { was_state: null, was_sha: null, was_paused_sha: null },
  pausedRows = [], recheckClaim = 1, flakeReadFails = false,
} = {}) {
  const flakes = new Map(known.map((t) => [`${t.file || ''}\u0000${t.test}`, {
    file: t.file || '', test: t.test, seen_count: t.seen_count || 1, first_seen_at: new Date('2026-10-03T00:00:00Z'),
    request_issue_number: t.request_issue_number || null, request_filed_at: t.request_filed_at || null,
  }]));
  const issues = [];
  const calls = [];
  const pool = {
    calls, flakes, issues,
    writes() {
      return calls.filter((c) => /SET main_check_state = \$3/.test(c.sql))
        .map((c) => [c.params[2], JSON.parse(c.params[3]), c.params[4], c.params[5]]);
    },
    async query(sql, params) {
      calls.push({ sql, params });
      if (/main_check_state = 'running'/.test(sql)) return { rows: [claim], rowCount: 1 };
      if (/SET main_check_state = \$3/.test(sql)) return { rows: [], rowCount: 1 };
      if (/FROM apps\s+WHERE main_check_state = 'failing'/.test(sql)) return { rows: pausedRows, rowCount: pausedRows.length };
      if (/jsonb_build_object\('rechecks'/.test(sql)) return { rows: [], rowCount: recheckClaim };
      if (/SELECT file, test FROM main_test_flakes/.test(sql)) {
        if (flakeReadFails) throw new Error('relation does not exist');
        return { rows: [...flakes.values()].map(({ file, test }) => ({ file, test })) };
      }
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
  return pool;
}

function scripted(...answers) {
  const real = unitSuite.maybeRunUnitSuite;
  const calls = [];
  unitSuite.maybeRunUnitSuite = async (args) => { calls.push(args); return answers.shift(); };
  return { calls, restore: () => { unitSuite.maybeRunUnitSuite = real; } };
}

const FLAKY = { file: 'tests/bot-clock.test.js', test: 'the clock reads the next whole minute' };
const OTHER = { file: 'tests/persona.test.js', test: 'persona listener hears the reply' };
const REAL = { file: 'tests/sessions.test.js', test: 'shared-sessions returns linked_issues per row' };

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
const run = (pool) => mainWatch.afterMerge(config, pool, { app: APP, session: { id: 3, pr_number: 41 }, mergeSha: SHA });

test.beforeEach(() => {
  enqueued.length = 0; created.length = 0; woke.length = 0;
  github.enabled = true; github.fail = false;
  delete process.env.MAIN_WATCH_CONFIRM;
  delete process.env.MAIN_WATCH_RECHECKS;
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
  const suite = scripted(red([FLAKY], { excerpts: [{ ...FLAKY, excerpt: 'expected 12:01, got 12:00' }] }), pass);
  try {
    const out = await run(pool);
    assert.equal(out.state, 'passing');
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
    assert.deepEqual(enqueued, [12]);
  } finally { suite.restore(); }
});

test('a second sighting while the request is open files nothing new', async () => {
  const pool = flakePool({ known: [{ ...FLAKY, request_issue_number: 901, request_filed_at: new Date() }], openIssues: [901] });
  const suite = scripted(red([FLAKY]), pass);
  try {
    await run(pool);
    assert.equal(pool.flakes.get(`${FLAKY.file}\u0000${FLAKY.test}`).seen_count, 2, 'seen again');
    assert.equal(created.length, 0);
  } finally { suite.restore(); }
});

test('a red of many tests that then passes is the run, not each test: nothing is recorded', async () => {
  const pool = flakePool();
  const four = [FLAKY, OTHER, REAL, { file: 'tests/d.test.js', test: 'd' }];
  const suite = scripted(red(four), pass);
  try {
    await run(pool);
    assert.equal(pool.flakes.size, 0);
    assert.equal(created.length, 0);
  } finally { suite.restore(); }
});

test('a red that did not name all of its failures records no flake', async () => {
  const pool = flakePool();
  const suite = scripted(red([FLAKY], { complete: false }), pass);
  try {
    await run(pool);
    assert.equal(pool.flakes.size, 0);
  } finally { suite.restore(); }
});

test('a red of known flakes alone is recorded and pauses nothing, even confirmed', async () => {
  const pool = flakePool({ known: [FLAKY, OTHER], openIssues: [] });
  const suite = scripted(red([FLAKY]), red([FLAKY, OTHER]));
  try {
    const out = await run(pool);
    assert.equal(out.state, 'failing');
    assert.deepEqual(out.detail.flakesOnly, [FLAKY.test, OTHER.test]);
    // [state, clearPause, setPause]: neither the provisional hold nor the
    // verdict pauses, and each lifts an older pause like green would.
    assert.deepEqual(pool.writes().map(([state, , clear, set]) => [state, clear, set]),
      [['confirming', true, false], ['failing', true, false]]);
    assert.equal(pool.writes()[0][1].flakesOnly[0], FLAKY.test);
    // The requests exist (each test's first), so someone fixes them.
    assert.deepEqual(created.map((c) => c.title), [`Flaky test: ${FLAKY.test}`, `Flaky test: ${OTHER.test}`]);
  } finally { suite.restore(); }
});

test('a red of known flakes plus one other test pauses as always', async () => {
  const pool = flakePool({ known: [FLAKY] });
  const suite = scripted(red([FLAKY, REAL]), red([FLAKY, REAL]));
  try {
    const out = await run(pool);
    assert.equal(out.detail.flakesOnly, undefined);
    assert.deepEqual(pool.writes().map(([state, , clear, set]) => [state, clear, set]),
      [['confirming', false, true], ['failing', false, true]]);
    assert.equal(created.length, 0);
  } finally { suite.restore(); }
});

test('known flakes do not excuse a red whose list is incomplete, or a flake table that cannot be read', async () => {
  for (const [pool, answer] of [
    [flakePool({ known: [FLAKY] }), red([FLAKY], { complete: false })],
    [flakePool({ known: [FLAKY], flakeReadFails: true }), red([FLAKY])],
  ]) {
    const suite = scripted(answer, answer);
    try {
      const out = await run(pool);
      assert.equal(out.detail.flakesOnly, undefined);
      assert.deepEqual(pool.writes().map(([, , , set]) => set), [true, true]);
    } finally { suite.restore(); }
  }
});

test('MAIN_WATCH_CONFIRM=0: a first red of known flakes alone still pauses nothing', async () => {
  process.env.MAIN_WATCH_CONFIRM = '0';
  const pool = flakePool({ known: [FLAKY] });
  const suite = scripted(red([FLAKY]));
  try {
    const out = await run(pool);
    assert.deepEqual(out.detail.flakesOnly, [FLAKY.test]);
    assert.deepEqual(pool.writes().map(([state, , clear, set]) => [state, clear, set]), [['failing', true, false]]);
  } finally { suite.restore(); }
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

// ── rechecks ─────────────────────────────────────────────────────────────

const paused = (detail) => ({ id: 12, slug: 'demo', repo_url: APP.repo_url, main_check_sha: SHA, main_check_detail: detail });
const CONFIRMED_RED = {
  prNumber: 41, sessionId: 3, confirmed: true,
  failureReason: `${FLAKY.file} (1): ${FLAKY.test}`, failingTests: [FLAKY], failingTestsComplete: true,
  firstRun: { failureReason: `${FLAKY.file} (1): ${FLAKY.test}`, failingTests: [FLAKY], failingTestsComplete: true },
};

test('recheckPaused: a paused main that comes back green lifts the pause, records the flake, and lets the queue go', async () => {
  const pool = flakePool({ pausedRows: [paused(CONFIRMED_RED)] });
  const suite = scripted(pass);
  try {
    const out = await mainWatch.recheckPaused(config, { pool });
    assert.deepEqual(out.rechecked, [{ appId: 12, sha: SHA }]);
    await out.done;
    assert.equal(suite.calls.length, 1);
    assert.equal(suite.calls[0].ref, SHA);
    // The counter is the claim: 0 → 1, only from 0.
    const claim = pool.calls.find((c) => /jsonb_build_object\('rechecks'/.test(c.sql));
    assert.deepEqual(claim.params, [12, SHA, 1]);
    assert.match(claim.sql, /AND coalesce\(\(main_check_detail->>'rechecks'\)::int, 0\) = \$3::int - 1/);
    assert.match(claim.sql, /'recheckingAt', NOW\(\)/);
    const writes = pool.writes();
    assert.deepEqual(writes.map(([state, , clear, set]) => [state, clear, set]), [['passing', true, false]]);
    assert.equal(writes[0][1].rechecks, 1);
    assert.equal(writes[0][1].prNumber, 41);
    assert.equal(writes[0][1].flake.failureReason, CONFIRMED_RED.failureReason);
    assert.equal(writes[0][1].recheckingAt, undefined, 'the verdict replaces the in-flight mark');
    assert.deepEqual(enqueued, [12]);
    assert.ok(pool.flakes.has(`${FLAKY.file}\u0000${FLAKY.test}`));
    assert.equal(created.length, 1);
  } finally { suite.restore(); }
});

test('recheckPaused: red again stands, confirmed, with the count', async () => {
  const pool = flakePool({ pausedRows: [paused({ ...CONFIRMED_RED, rechecks: 1 })] });
  const suite = scripted(red([REAL]));
  try {
    await (await mainWatch.recheckPaused(config, { pool })).done;
    const claim = pool.calls.find((c) => /jsonb_build_object\('rechecks'/.test(c.sql));
    assert.deepEqual(claim.params, [12, SHA, 2]);
    const [[state, detail, clear, set]] = pool.writes();
    assert.deepEqual([state, clear, set], ['failing', false, true]);
    assert.equal(detail.confirmed, true);
    assert.equal(detail.rechecks, 2);
    assert.deepEqual(detail.failingTests, [REAL]);
    assert.deepEqual(detail.firstRun.failingTests, [FLAKY], 'the red it re-asked about');
    assert.deepEqual(enqueued, []);
    assert.equal(created.length, 0);
  } finally { suite.restore(); }
});

test('recheckPaused: a run that could not happen leaves the red as it was, one recheck spent', async () => {
  const unconfirmed = { prNumber: 41, sessionId: 3, confirmed: false, failureReason: 'x (1): y', confirmation: { failureReason: 'quota' } };
  const pool = flakePool({ pausedRows: [paused({ ...unconfirmed, recheckingAt: '2026-10-10T08:00:00Z' })] });
  const suite = scripted({ row: {
    name: unitSuite.UNIT_CHECK_NAME, path: unitSuite.UNIT_CHECK_PATH,
    status: 'fail', couldNotRun: true, failureReason: 'The unit suite could not start',
  } });
  try {
    await (await mainWatch.recheckPaused(config, { pool })).done;
    const [[state, detail]] = pool.writes();
    assert.equal(state, 'failing');
    assert.equal(detail.confirmed, false, 'still unconfirmed, so the next try comes soon');
    assert.equal(detail.failureReason, 'x (1): y');
    assert.equal(detail.rechecks, 1);
    assert.match(detail.recheckError.failureReason, /could not start/);
    assert.equal(detail.recheckingAt, undefined);
  } finally { suite.restore(); }
});

test('recheckPaused: a claim another process took runs nothing', async () => {
  const pool = flakePool({ pausedRows: [paused(CONFIRMED_RED)], recheckClaim: 0 });
  const suite = scripted(pass);
  try {
    await (await mainWatch.recheckPaused(config, { pool })).done;
    assert.equal(suite.calls.length, 0);
    assert.equal(pool.writes().length, 0);
  } finally { suite.restore(); }
});

test('recheckPaused: which rows are due, and the switch', async () => {
  const pool = flakePool();
  await mainWatch.recheckPaused(config, { pool });
  const sel = pool.calls.find((c) => /FROM apps\s+WHERE main_check_state = 'failing'/.test(c.sql));
  // Only the red the pause is about, under the limit, not in flight (or
  // in flight so long its process is gone), and due: a confirmation that
  // could not run after minutes, a confirmed red after a quarter hour.
  assert.match(sel.sql, /lower\(coalesce\(main_check_paused_sha, ''\)\) = lower\(main_check_sha\)/);
  assert.match(sel.sql, /coalesce\(\(main_check_detail->>'rechecks'\)::int, 0\) < \$1::int/);
  assert.match(sel.sql, /main_check_detail->>'recheckingAt' IS NULL\s+OR \(main_check_detail->>'recheckingAt'\)::timestamptz < NOW\(\) - \(\$4::int \* interval '1 millisecond'\)/);
  assert.match(sel.sql, /CASE WHEN main_check_detail->>'confirmed' = 'false'\s+THEN \$2::int ELSE \$3::int END \* interval '1 millisecond'/);
  assert.deepEqual(sel.params, [3, 3 * 60 * 1000, 15 * 60 * 1000, mainWatch.staleMs()]);

  process.env.MAIN_WATCH_RECHECKS = '0';
  const off = flakePool();
  const out = await mainWatch.recheckPaused(config, { pool: off });
  assert.deepEqual(out.rechecked, []);
  assert.equal(off.calls.length, 0);
});

test('the leader\'s timer runs the recheck sweep beside the interrupted-run sweep', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'main-watch.js'), 'utf8');
  const start = src.slice(src.indexOf('function start(config'));
  assert.match(start, /resumeInterrupted\(config\)\.catch/);
  assert.match(start, /recheckPaused\(config\)\.catch/);
});

test('the schema keeps the flakes per app, keyed by file and test', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS main_test_flakes'));
  assert.match(table, /app_id\s+INTEGER NOT NULL REFERENCES apps\(id\) ON DELETE CASCADE/);
  assert.match(table, /file\s+TEXT NOT NULL DEFAULT ''/);
  assert.match(table, /request_issue_number INTEGER/);
  assert.match(table, /PRIMARY KEY \(app_id, file, test\)/);
});
