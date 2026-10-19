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
//
// Which red is sent to be fixed (a confirmed one, never a flake or a
// superseded one), every verdict's row and the pause's events are the
// main-check machine's (tests/workflow-main-check-postgres.test.js); its
// main.fixRequest work calls fileFixRequest, pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
delete process.env.MAIN_WATCH_FIX_REQUESTS;

const created = [];
const fronted = [];
const stub = (rel, exports) => {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub('../src/services/ws', { sendSystemMessage: async () => {}, pushSessionUpdate: () => {}, pushIssueUpdate: () => {} });
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

const mainWatch = require('../src/services/main-watch');
const redFix = require('../src/services/main-red-fix');

const APP = { id: 10, slug: 'usernode-2d5619', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' };
const PARSED = { owner: 'Usernode-Labs', repo: 'social-vibecoding' };
const KUDOS = { file: 'tests/standings-screen.test.js', test: 'the Kudos ranked lists say ranks move when other people act (#4782)' };

// A pool for the two tables main-red-fix reads and writes, in memory.
function redPool({ greens = [GREEN], openRequest = false } = {}) {
  const requests = [];
  const calls = [];
  return {
    calls, requests,
    async query(sql, params) {
      calls.push({ sql, params });
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
}

// The request as the machine's main.fixRequest work files it: the red's
// own account (redOf) and the failing tests' output.
const fileFor = (pool, { prNumber = 4826, excerpts = [] } = {}) => redFix.fileFixRequest({ workerRuntime: 'docker' }, pool, {
  app: APP, parsed: PARSED, redSha: RED, prNumber, excerpts, fileBotIssue: mainWatch.fileBotIssue,
  detail: mainWatch.classify(red([KUDOS])).detail,
});

const red = (tests, excerpts = []) => ({
  row: {
    status: 'fail',
    failureReason: tests.map((t) => `${t.file} (1): ${t.test}`).join(' | '),
    summary: { tests: 23760, pass: 23759, fail: 1 },
    ...(excerpts.length ? { failureDetails: excerpts } : {}),
  },
  failingTests: { tests, complete: true },
});

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
  const pool = redPool();
  const n = await fileFor(pool, { excerpts: [{ ...KUDOS, excerpt: "AssertionError: 'Ranks update as people…' !== 'Ranks update live…'" }] });
  assert.equal(n, 4841);
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
});

test('no second request while one is open or for the same red, and the switch turns it off', async () => {
  assert.equal(await fileFor(redPool({ openRequest: true })), null);
  assert.equal(created.length, 0, 'the open request stands for this red too');
  const pool = redPool();
  await fileFor(pool);
  assert.equal(await fileFor(pool), null, 'a work item retried after filing files nothing twice');
  assert.equal(created.length, 1);
  process.env.MAIN_WATCH_FIX_REQUESTS = '0';
  assert.equal(await fileFor(redPool()), null);
  assert.equal(created.length, 1);
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
  // The proposal-pipeline topic's "Reds that passed on a re-run" reads the
  // flag (services/topic-figures.js).
  assert.match(schema, /ALTER TABLE main_watch_verdicts ADD COLUMN IF NOT EXISTS flake BOOLEAN NOT NULL DEFAULT FALSE;/);
});
