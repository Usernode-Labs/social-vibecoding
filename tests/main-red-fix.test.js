'use strict';

// services/main-red-fix — on a confirmed red main, which merge did it, and a
// request for the Homeroom bot to fix it; every verdict kept as evidence.
//
// 12 Oct 2026: eleven proposals merged between 09:03 and 09:08 UTC. Two of
// them, #4830 and #4826, fixed the same request (filed twice as #4782 and
// #4786); each added the Kudos rank note and the same text key, and together
// they failed #4830's test in tests/standings-screen.test.js. Main watch
// discarded the runs on the merges in between as superseded, said nothing
// about which merge broke it, and asked nobody to fix it: main stayed
// paused, admins resumed it twice, and each next merge paused it again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
delete process.env.MAIN_WATCH_ENABLED;
delete process.env.MAIN_WATCH_CONFIRM;
delete process.env.MAIN_WATCH_FIX_REQUESTS;

const created = [];
const fronted = [];
const stub = (rel, exports) => {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub('../src/services/ws', { sendSystemMessage: async () => {}, pushSessionUpdate: () => {}, pushIssueUpdate: () => {} });
stub('../src/workflow/platform.ts', { wantMerge: async () => {} });
stub('../src/services/notifications', { notifyIssueFiled: () => {} });
stub('../src/services/homeroom-bot', {
  ensureBotUser: async () => ({ id: 77, username: 'homeroom_bot' }),
  noteIssueActivity: () => true,
  enqueueFront: async (pool, args) => { fronted.push(args); return { id: 1 }; },
});

const sha = (c) => c.repeat(40);
const GREEN = sha('a');
const RED = sha('f');
// The burst, oldest first: the merge #4830 brought its test and its note;
// two unrelated ones; then #4826, which changed what the test reads.
const BURST = [
  { sha: sha('b'), subject: 'Homeroom bot: #4782 Rank jumped six places in an hour with no activity (#4830)',
    files: ['frontend/locales/en/leaderboard.json', 'frontend/src/features/leaderboard/kudos-pane.tsx', 'tests/standings-screen.test.js'] },
  { sha: sha('c'), subject: 'Search: an exact name or slug match comes first (#4793) (#4824)',
    files: ['src/routes/search.js', 'tests/search.test.js'] },
  { sha: sha('d'), subject: 'Profile: a failed session lookup is not "signed out" (#4808) (#4823)',
    files: ['frontend/src/features/profile/profile.tsx'] },
  { sha: RED, subject: 'Homeroom bot: #4786 Rank jumped six places in an hour with no activity (#4826)',
    files: ['frontend/locales/en/leaderboard.json', 'frontend/src/features/leaderboard/kudos-pane.tsx', 'tests/kudos-rank-note.test.js'] },
];
const STANDINGS = `const mod = loadTsx('frontend/src/features/leaderboard/kudos-pane.tsx', {});\nmessage('leaderboard:kudos.rankNote');`;
const github = {
  enabled: true,
  isEnabled: () => github.enabled,
  safeMention: (s) => s,
  noteIssueCreated: () => {},
  createIssue: async (owner, repo, issue) => { created.push({ owner, repo, ...issue }); return { number: 4840 + created.length }; },
  compareCommitAncestry: async (owner, repo, base, head) => ({ status: base === GREEN && head === RED ? 'ahead' : 'diverged' }),
  compareCommitSubjects: async () => ({ commits: BURST.map(({ sha: s, subject }) => ({ sha: s, subject })), totalCommits: BURST.length }),
  compareRefs: async (owner, repo, basehead) => {
    const head = basehead.split('...')[1];
    return { files: BURST.find((c) => c.sha === head).files };
  },
  getFileContent: async (owner, repo, file) => (file === 'tests/standings-screen.test.js' ? STANDINGS : null),
  getCloneUrl: async () => '',
};
stub('../src/services/github', github);

const unitSuite = require('../src/services/unit-suite');
const mainWatch = require('../src/services/main-watch');
const redFix = require('../src/services/main-red-fix');

const APP = { id: 10, slug: 'usernode-2d5619', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' };
const PARSED = { owner: 'Usernode-Labs', repo: 'social-vibecoding' };
const KUDOS = { file: 'tests/standings-screen.test.js', test: 'the Kudos ranked lists say ranks move when other people act (#4782)' };

// A pool for main watch's statements plus the two new tables, in memory.
function redPool({ greens = [GREEN], openRequest = false, paused = null } = {}) {
  const verdicts = [];
  const requests = [];
  const calls = [];
  const events = [];
  const pool = {
    calls, verdicts, requests, events,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/main_check_state = 'running'/.test(sql)) return { rows: [{ was_state: 'passing', was_sha: GREEN, was_paused_sha: paused }], rowCount: 1 };
      if (/SET main_check_state = \$3/.test(sql)) {
        // writeState's pause column, as its CASE moves it.
        const was = pool.paused;
        const [, mergeSha, , , clear, set] = params;
        pool.paused = clear ? null : set ? mergeSha : was;
        return { rows: [{ was_paused: was, now_paused: pool.paused }], rowCount: 1 };
      }
      if (/SET main_check_resumed_sha = main_check_paused_sha/.test(sql)) {
        const was = pool.paused;
        pool.paused = null;
        return { rows: was ? [{ main_check_state: 'failing', main_check_sha: was, main_check_resumed_sha: was, main_check_paused_sha: null }] : [] };
      }
      if (/INSERT INTO events/.test(sql)) { events.push([params[3], params[1], JSON.parse(params[4])]); return { rows: [], rowCount: 1 }; }
      if (/SELECT file, test FROM main_test_flakes/.test(sql)) return { rows: [] };
      if (/INSERT INTO main_watch_verdicts/.test(sql)) { verdicts.push(params); return { rows: [], rowCount: 1 }; }
      if (/FROM main_watch_verdicts/.test(sql)) return { rows: greens.map((s, i) => ({ sha: s, created_at: new Date(Date.now() - i * 60000) })) };
      if (/INSERT INTO main_red_requests/.test(sql)) {
        if (openRequest || requests.some((r) => r.app_id === params[0] && r.red_sha === params[1])) return { rows: [] };
        requests.push({ id: requests.length + 1, app_id: params[0], red_sha: params[1], issue_number: null });
        return { rows: [{ id: requests.length }] };
      }
      if (/UPDATE main_red_requests SET issue_number/.test(sql)) {
        requests.find((r) => r.id === params[0]).issue_number = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO issues/.test(sql)) return { rows: [{ id: 900 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  pool.paused = paused;
  return pool;
}

function scripted(...answers) {
  const real = unitSuite.maybeRunUnitSuite;
  unitSuite.maybeRunUnitSuite = async () => answers.shift();
  return () => { unitSuite.maybeRunUnitSuite = real; };
}
const red = (tests, excerpts = []) => ({
  row: {
    status: 'fail',
    failureReason: tests.map((t) => `${t.file} (1): ${t.test}`).join(' | '),
    summary: { tests: 23760, pass: 23759, fail: 1 },
    ...(excerpts.length ? { failureDetails: excerpts } : {}),
  },
  failingTests: { tests, complete: true },
});
const pass = { row: { status: 'pass', failureReason: '', summary: { tests: 23760, pass: 23760, fail: 0 } } };

test.beforeEach(() => {
  created.length = 0; fronted.length = 0; github.enabled = true;
  delete process.env.MAIN_WATCH_FIX_REQUESTS;
});

test('the merges the failing test reads are the suspects; the others are not', async () => {
  const found = await redFix.suspectsFor(redPool(), { app: APP, parsed: PARSED, redSha: RED, failingTests: [KUDOS] }, github);
  assert.equal(found.greenSha, GREEN);
  assert.deepEqual(found.merges.map((m) => [m.pr, m.suites]), [
    [4830, ['tests/standings-screen.test.js']],
    [4824, []],
    [4823, []],
    [4826, ['tests/standings-screen.test.js']],
  ]);
  assert.equal(found.complete, true);
});

test('the newest green that is an ancestor of the red is where the range starts; none found, no range', async () => {
  const found = await redFix.suspectsFor(redPool({ greens: [sha('9'), GREEN] }), { app: APP, parsed: PARSED, redSha: RED, failingTests: [KUDOS] }, github);
  assert.equal(found.greenSha, GREEN, 'a green on another line of history is passed over');
  assert.equal(await redFix.suspectsFor(redPool({ greens: [] }), { app: APP, parsed: PARSED, redSha: RED, failingTests: [KUDOS] }, github), null);
});

test('a confirmed red files one request as Homeroom bot, names the suspects, and puts it first in the bot\'s queue', async () => {
  const restore = scripted(red([KUDOS], [{ ...KUDOS, excerpt: "AssertionError: 'Ranks update as people…' !== 'Ranks update live…'" }]), red([KUDOS]));
  try {
    const pool = redPool();
    const out = await mainWatch.afterMerge({ workerRuntime: 'docker' }, pool, { app: APP, session: { id: 7894, pr_number: 4826 }, mergeSha: RED });
    assert.equal(out.state, 'failing');
    assert.equal(created.length, 1);
    const [req] = created;
    assert.equal(req.title, 'Main is failing: the Kudos ranked lists say ranks move when other people act (#4782)');
    assert.match(req.body, /fails on f{9} \(the merge of #4826\), and merges into this project are paused/);
    assert.match(req.body, /- #4830 Homeroom bot: #4782 Rank jumped six places in an hour with no activity \(reaches `tests\/standings-screen\.test\.js`\)/);
    assert.match(req.body, /- #4826 Homeroom bot: #4786 Rank jumped/);
    assert.doesNotMatch(req.body, /#4824|#4823/, 'the merges the test does not read are not named');
    assert.match(req.body, /Two or more of them together may be the cause/);
    assert.match(req.body, /AssertionError: 'Ranks update as people…'/);
    assert.match(req.body, /a fix level with main merges while merges are paused/);
    assert.deepEqual(fronted, [{ appId: 10, issueNumber: 4841, reason: 'main_red' }]);
    assert.deepEqual(pool.requests.map((r) => r.issue_number), [4841]);
    // The verdict is kept, confirmed.
    assert.deepEqual(pool.verdicts.map((v) => [v[2], v[3], v[4]]), [['failing', false, true]]);
  } finally { restore(); }
});

test('no second request while one is open, a first red the re-run clears files none, and the switch turns it off', async () => {
  let restore = scripted(red([KUDOS]), red([KUDOS]));
  try {
    await mainWatch.afterMerge({ workerRuntime: 'docker' }, redPool({ openRequest: true }), { app: APP, session: { id: 1, pr_number: 4832 }, mergeSha: RED });
    assert.equal(created.length, 0, 'the open request stands for this red too');
  } finally { restore(); }
  restore = scripted(red([KUDOS]), pass);
  try {
    await mainWatch.afterMerge({ workerRuntime: 'docker' }, redPool(), { app: APP, session: { id: 1, pr_number: 4832 }, mergeSha: RED });
    assert.equal(created.length, 0, 'a flake is not a broken main');
  } finally { restore(); }
  process.env.MAIN_WATCH_FIX_REQUESTS = '0';
  restore = scripted(red([KUDOS]), red([KUDOS]));
  try {
    await mainWatch.afterMerge({ workerRuntime: 'docker' }, redPool(), { app: APP, session: { id: 1, pr_number: 4832 }, mergeSha: RED });
    assert.equal(created.length, 0);
  } finally { restore(); }
});

test('a verdict a newer merge superseded is kept, with what it was', async () => {
  const restore = scripted(pass);
  try {
    const pool = redPool();
    const query = pool.query;
    pool.query = async (sql, params) => (/SET main_check_state = \$3/.test(sql) ? { rows: [], rowCount: 0 } : query(sql, params));
    assert.equal(await mainWatch.afterMerge({ workerRuntime: 'docker' }, pool, { app: APP, session: { id: 1, pr_number: 4830 }, mergeSha: sha('b') }), null);
    assert.deepEqual(pool.verdicts.map((v) => [v[1], v[2], v[3]]), [[sha('b'), 'passing', true]]);
  } finally { restore(); }
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/main-watch.js'), 'utf8');
  assert.match(src, /'Discarded a verdict for a superseded merge', \{ appId: app\.id, sha: mergeSha, state: verdict\.state \}/,
    'and the log says what it was');
});

// The proposal-pipeline topic's "Reds that passed on a re-run" reads the
// flag (services/topic-figures.js).
test('a red the confirm run clears is kept as a flake; a red twice is not', async () => {
  let restore = scripted(red([KUDOS]), pass);
  try {
    const pool = redPool();
    await mainWatch.afterMerge({ workerRuntime: 'docker' }, pool, { app: APP, session: { id: 1, pr_number: 4832 }, mergeSha: RED });
    assert.deepEqual(pool.verdicts.map((v) => [v[2], v[5]]), [['passing', true]]);
  } finally { restore(); }
  restore = scripted(red([KUDOS]), red([KUDOS]));
  try {
    const pool = redPool({ openRequest: true });
    await mainWatch.afterMerge({ workerRuntime: 'docker' }, pool, { app: APP, session: { id: 1, pr_number: 4832 }, mergeSha: RED });
    assert.deepEqual(pool.verdicts.map((v) => [v[2], v[5]]), [['failing', false]]);
  } finally { restore(); }
  assert.equal(mainWatch.flakedRed({ disjoint: true, confirmed: true }), true, 'red twice on tests that each passed the other time');
  assert.equal(mainWatch.flakedRed({ confirmed: true }), false);
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src/db/schema.sql'), 'utf8');
  assert.match(schema, /ALTER TABLE main_watch_verdicts ADD COLUMN IF NOT EXISTS flake BOOLEAN NOT NULL DEFAULT FALSE;/);
});

test('the request text without suspects lists the range, and too long a range is not attributed', () => {
  const { body } = redFix.fixRequestText({
    redSha: RED, failingTests: [KUDOS],
    found: { greenSha: GREEN, complete: false, total: 40, merges: BURST.map((c) => ({ sha: c.sha, pr: redFix.prOf(c.subject), subject: c.subject, suites: [] })) },
  });
  assert.match(body, /Too many to attribute one by one:/);
  assert.match(body, /- #4830 /);
  assert.match(body, /…and 25 more/);
  assert.equal(redFix.prOf('Fix the thing (#4818) (#4820)'), 4820, 'the merge\'s own number, the last one');
});

test('the schema keeps every verdict and one request per red', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src/db/schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS main_watch_verdicts \(/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS main_red_requests \([\s\S]*?UNIQUE \(app_id, red_sha\)/);
});

// The proposal-pipeline topic's "Merges paused by a red main" pairs these
// (services/topic-figures.js).
test('a pause of the merges is recorded where it starts and where it ends, with what ended it', async () => {
  const settle = () => new Promise((r) => setImmediate(r));
  let restore = scripted(red([KUDOS]), red([KUDOS]));
  const pool = redPool();
  try {
    await mainWatch.afterMerge({ workerRuntime: 'docker' }, pool, { app: APP, session: { id: 7894, pr_number: 4826 }, mergeSha: RED });
  } finally { restore(); }
  await settle();
  assert.deepEqual(pool.events, [['main_paused', 10, { sha: RED, confirming: true }]],
    'once, when the first red holds the merges; the confirmed red keeps the same pause');
  restore = scripted(pass);
  try {
    await mainWatch.afterMerge({ workerRuntime: 'docker' }, pool, { app: APP, session: { id: 7923, pr_number: 4843 }, mergeSha: sha('e') });
  } finally { restore(); }
  await settle();
  assert.deepEqual(pool.events.at(-1), ['main_resumed', 10, { sha: sha('e'), by: 'green' }]);

  const admin = redPool({ paused: RED });
  await mainWatch.resume({}, admin, 10, { by: { username: 'snait' } });
  await settle();
  assert.deepEqual(admin.events, [['main_resumed', 10, { sha: RED, by: 'admin' }]]);
});

