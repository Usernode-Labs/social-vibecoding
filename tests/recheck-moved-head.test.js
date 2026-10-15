// A recheck judges the head a proposal is up for approval on, never the
// commit its checks were last pinned to (services/staging-recovery.js
// recheckHeadSha, approvedHeadSha, rebuildSessionStaging; the preview
// machine's recheck, reached through services/preview-workflow.js).
//
// Club Votes (newcomer run four, 12 October 2026). The review's fix turn
// pushed 394d7494, and its commit push pinned the checks to it and started
// a run. Restart recovery then rolled the branch back to 83d22f05, the
// commit before the fix, and proposed it. The promote route's kick asked
// the cluster for a run of the PIN (394d7494), found the fix's run, and
// left it to the harvest without marking the new head pending. That run
// passed, its verdict was stored against the pin, and the App tab read
// "Ready to try" about a commit nobody was voting on. Checks of 83d22f05
// itself then failed on the bug the fix had fixed.
//
// The recheck is the preview machine's now: it checks the head it holds
// (a preview of another commit is rebuilt at it first:
// tests/recheck-rebuilds-stale-preview.test.js), and a verdict is stored
// only for the commit the row is pinned to. A session it does not hold yet
// is enrolled with its head first.
//
// Run with: node --test tests/recheck-moved-head.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OLD = `394d7494${'b'.repeat(32)}`;
const NEW = `83d22f05${'a'.repeat(32)}`;
const TIP = `c0ffee00${'c'.repeat(32)}`;

// ── The head a recheck judges ────────────────────────────────────────────

test('the head: an imported PR\'s own head, a proposal\'s reviewed head, else the checks pin', () => {
  const rec = require('../src/services/staging-recovery');
  const promoted = { status: 'promoted', source: 'native', reviewed_head_sha: NEW, checks_commit_sha: OLD };
  assert.equal(rec.recheckHeadSha(promoted), NEW, 'the head people vote on, not the run\'s old commit');
  assert.equal(rec.recheckHeadSha({ ...promoted, status: 'merging' }), NEW);
  assert.equal(rec.recheckHeadSha({ ...promoted, reviewed_head_sha: null }), OLD, 'none recorded: the pin, as before');
  // Underway (or moved back to it): its reviewed head can be left over from
  // an earlier review, so the pin it is building is the head.
  assert.equal(rec.recheckHeadSha({ ...promoted, status: 'paused' }), OLD);
  assert.equal(rec.recheckHeadSha({ ...promoted, status: 'active' }), OLD);
  assert.equal(rec.recheckHeadSha({ source: 'cli_handoff', status: 'active', handoff_head_sha: 'h' }), 'h');
  assert.equal(rec.recheckHeadSha({ source: 'imported', status: 'promoted', imported_pr_head_sha: 'imp', reviewed_head_sha: NEW, checks_commit_sha: OLD }), 'imp');
  assert.equal(rec.recheckHeadSha({ source: 'imported', status: 'promoted', checks_commit_sha: OLD }), null);
  assert.equal(rec.approvedHeadSha({ ...promoted, status: 'paused' }), null);
  assert.equal(rec.approvedHeadSha(promoted), NEW);
});

// ── Run four, through the recheck ────────────────────────────────────────

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return () => { if (original) require.cache[id] = original; else delete require.cache[id]; };
}

// staging-recovery and the real services/preview-workflow, with the
// workflow platform (the machine's front door) and GitHub stubbed. `held`:
// the head the machine holds the session on, or null when it does not.
function harness(t, { held = null, tip = NEW } = {}) {
  const calls = [];
  const restores = [];
  const svc = (name) => require.resolve(`../src/services/${name}`);
  restores.push(stubModule(require.resolve('../src/workflow/platform.ts'), {
    previewInstance: async () => (held ? { state: 'settled', data: { head: held } } : null),
    previewHeld: async () => !!held,
    submitRevision: async (r) => { calls.push(['revision', r.head, r.source]); return { status: 'accepted' }; },
    requestRecheck: async (r) => { calls.push(['recheck', r.reason, r.trigger]); return { status: 'accepted' }; },
    requestPreview: async (r) => { calls.push(['preview', r.head, r.reason]); return { status: 'accepted' }; },
  }));
  restores.push(stubModule(svc('ws'), {
    broadcastGlobal() {}, pushSessionUpdate() {}, sendSystemMessage: async () => {},
  }));
  restores.push(stubModule(svc('github'), {
    getReadOctokit: async () => ({ rest: { repos: { compareCommits: async () => ({ data: { ahead_by: 2, commits: [{ sha: OLD }, { sha: tip }] } }) } } }),
    getBranchSha: async () => tip,
  }));
  const recPath = svc('staging-recovery');
  const wfPath = svc('preview-workflow');
  delete require.cache[recPath];
  delete require.cache[wfPath];
  const rec = require('../src/services/staging-recovery');
  const log = require('../src/services/logger');
  const saved = { info: log.info, warn: log.warn };
  log.info = () => {};
  log.warn = () => {};
  const savedToken = process.env.GITHUB_BOT_TOKEN;
  process.env.GITHUB_BOT_TOKEN = 'test-token';
  t.after(() => {
    log.info = saved.info;
    log.warn = saved.warn;
    if (savedToken == null) delete process.env.GITHUB_BOT_TOKEN; else process.env.GITHUB_BOT_TOKEN = savedToken;
    delete require.cache[recPath];
    delete require.cache[wfPath];
    for (const restore of restores.reverse()) restore();
  });
  // The promote route's own copy: read before it promoted, its reviewed head
  // set in memory, its status still the one it was promoted from, its checks
  // still pinned to the fix's commit and its preview.
  const copy = {
    id: 8031, app_id: 77, app_slug: 'club-votes-0e42b6', app_name: 'Club Votes', repo_url: 'https://github.com/usernode-bot/club-votes-0e42b6',
    branch_name: 'dev/homeroom_bot-homeroom-bot-1-first-version', pr_number: 2, status: 'active', source: 'native',
    reviewed_head_sha: NEW, checks_commit_sha: OLD, check_state: 'pending',
    staging_url: 'https://preview.example/1', staging_container_id: 'c1', staging_commit_sha: OLD,
  };
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  return { rec, pool, copy, calls };
}

test('run four: a promote kick on a session the machine holds asks it to check the head it holds, and nothing else', async (t) => {
  const { rec, pool, copy, calls } = harness(t, { held: NEW });
  assert.equal(await rec.recheckSessionChecks({ pool, session: copy, reason: 'promote-kick' }), 'handed_off');
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['recheck', 'promote-kick']],
    'no revision of the old pin: the machine checks the head it holds');
});

test('run four: a promote kick on a session the machine does not hold yet enrolls the reviewed head, not the old pin', async (t) => {
  const { rec, pool, copy, calls } = harness(t, { held: null });
  assert.equal(await rec.recheckSessionChecks({ pool, session: { ...copy, status: 'promoted' }, reason: 'promote-kick' }), 'handed_off');
  assert.deepEqual(calls.find((c) => c[0] === 'revision'), ['revision', NEW, 'recheck'],
    'the head people vote on; enrolling the checks pin would check the fix\'s commit again');
  assert.deepEqual(calls.at(-1).slice(0, 2), ['recheck', 'promote-kick']);
});

test('a rebuild of a proposal builds its reviewed head, not a tip past it; an underway change builds its tip', async (t) => {
  const { rec, pool, copy, calls } = harness(t, { tip: TIP });
  assert.equal(await rec.rebuildSessionStaging({ config: null, pool, session: { ...copy, status: 'promoted' }, reason: 'stuck-checks-sweep' }), 'handed_off');
  assert.deepEqual(calls.find((c) => c[0] === 'revision'), ['revision', NEW, 'stuck-checks-sweep']);
  calls.length = 0;
  assert.equal(await rec.rebuildSessionStaging({ config: null, pool, session: { ...copy, status: 'paused' }, reason: 'stuck-checks-sweep' }), 'handed_off');
  assert.deepEqual(calls.find((c) => c[0] === 'revision'), ['revision', TIP, 'stuck-checks-sweep'],
    'recovery still claims the newest tip of a change underway');
});

test('the verdict store keeps to the pinned commit', () => {
  // A run of an old commit that finishes after the pin moved on stores
  // nothing: both verdict writes are guarded on the pinned commit.
  // (One copy, shared by every writer: src/workflow/rules/check-store.ts.)
  const visuals = fs.readFileSync(path.join(ROOT, 'src/workflow/rules/check-store.ts'), 'utf8');
  const store = visuals.slice(visuals.indexOf('async function storeChecks('), visuals.indexOf('async function storeChecksSkipped('));
  assert.equal((store.match(/AND checks_commit_sha IS NOT DISTINCT FROM \$3::text`/g) || []).length, 2);
});
